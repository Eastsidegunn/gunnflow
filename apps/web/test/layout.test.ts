// WP-L: layout port — arrange-driven graph, fallback, ELK (in-thread here), the
// signature cache, incremental stability, contain groups.
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { NodeProjection } from '@gunnflow/contract';
import { WIRING_SCHEMA_VERSION, relationArrangeFor, validateWiringConfig, type WiringConfig } from '@gunnflow/contract/wiring';
import { largeFixture, normalFixture, projectNodes } from '@gunnflow-testing/fake-contracts';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { EMPTY_WIRING } from '../src/wiring/loadWiring.js';
import { fallbackLayout, layoutGraphOf, leafIds, type LayoutProvider, type Positions } from '../src/canvas/layoutGraph.js';
import { elkProvider } from '../src/canvas/elkLayout.js';
import { buildScene } from '../src/canvas/genericScene.js';
import { createLayoutState } from '../src/state/layoutState.js';

const elk = new ELK();
const inThreadElk = (): LayoutProvider => elkProvider((g) => elk.layout(g));
const nodesOf = () => projectNodes(normalFixture());
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function withNewTask(nodes: NodeProjection[]): NodeProjection[] {
  const extra: NodeProjection = {
    id: 't-new',
    kind: 'task',
    label: 'New',
    state: { value: 'queued' },
    relations: [{ type: 'member-of', target: 'm1' }, { type: 'dependency', target: 't-build' }],
    capabilities: [],
    attention: [],
    artifacts: [],
  };
  return [...nodes, extra];
}

describe('layout graph', () => {
  it('only flow/contain relations shape layout; unregistered relations are none', () => {
    expect(relationArrangeFor(DEFAULT_WIRING, 'dependency')).toBe('flow');
    expect(relationArrangeFor(DEFAULT_WIRING, 'member-of')).toBe('contain');
    expect(relationArrangeFor(DEFAULT_WIRING, 'evidence')).toBe('none');
    expect(relationArrangeFor(DEFAULT_WIRING, 'unknown')).toBe('none');
    const g = layoutGraphOf(nodesOf(), DEFAULT_WIRING);
    expect(g.parentOf.get('t-build')).toBe('m1');
    expect(g.flow.length).toBeGreaterThan(0);
    const bare = layoutGraphOf(nodesOf(), EMPTY_WIRING);
    expect(bare.flow).toEqual([]);
    expect(bare.parentOf.size).toBe(0);
  });

  it('the signature ignores everything but ids and layout-shaping relations', () => {
    const a = layoutGraphOf(nodesOf(), DEFAULT_WIRING).signature;
    const restated = nodesOf().map((n) => ({ ...n, state: { value: 'something-else' }, label: 'x', attention: [{ cause: 'c' }] }));
    expect(layoutGraphOf(restated, DEFAULT_WIRING).signature).toBe(a);
    expect(layoutGraphOf(withNewTask(nodesOf()), DEFAULT_WIRING).signature).not.toBe(a);
  });

  it('contain cycles are withheld, never followed', () => {
    const cyc: NodeProjection[] = ['a', 'b'].map((id) => ({
      id, kind: 'k', state: { value: 's' }, relations: [{ type: 'member-of', target: id === 'a' ? 'b' : 'a' }],
      capabilities: [], attention: [], artifacts: [],
    }));
    const g = layoutGraphOf(cyc, DEFAULT_WIRING);
    expect(g.parentOf.size).toBe(0);
    expect(g.withheld).toEqual(['a', 'b']);
    expect(fallbackLayout(g).size).toBe(2);
  });
});

// `direction: 'out'`: the stored edge points at the member (contains-style
// vocabularies), so the relation holder is the container.
describe("contain direction 'out'", () => {
  const OUT: WiringConfig = {
    version: WIRING_SCHEMA_VERSION,
    relations: { contains: { style: 'solid', arrange: 'contain', direction: 'out' } },
  };
  const mk = (id: string, relations: NodeProjection['relations'] = []): NodeProjection => ({
    id, kind: 'k', state: { value: 's' }, relations, capabilities: [], attention: [], artifacts: [],
  });

  it('a parent holding several contains relations nests all of them — N relations are N children, not N parents', () => {
    const nodes = [mk('dom', [{ type: 'contains', target: 'a' }, { type: 'contains', target: 'b' }]), mk('a'), mk('b')];
    const g = layoutGraphOf(nodes, OUT);
    expect(g.withheld).toEqual([]);
    expect(g.parentOf.get('a')).toBe('dom');
    expect(g.parentOf.get('b')).toBe('dom');
  });

  it('a node two parents point at with contains is withheld (several containers), as with two member-of parents', () => {
    const nodes = [mk('p1', [{ type: 'contains', target: 'c' }]), mk('p2', [{ type: 'contains', target: 'c' }]), mk('c')];
    const g = layoutGraphOf(nodes, OUT);
    expect(g.withheld).toEqual(['c']);
    expect(g.parentOf.has('c')).toBe(false);
  });

  it("the nesting replaces the contains edge in the scene, exactly as it does for member-of under 'in'", () => {
    const nodes = [mk('dom', [{ type: 'contains', target: 'a' }]), mk('a')];
    const scene = buildScene(nodes, OUT);
    expect(scene.groups.map((g) => g.id)).toEqual(['dom']);
    expect(scene.edges).toEqual([]);
  });

  it("validator: direction is a contain word only", () => {
    expect(validateWiringConfig(OUT).ok).toBe(true);
    const bad = (relations: object) => validateWiringConfig({ version: WIRING_SCHEMA_VERSION, relations });
    expect(bad({ r: { style: 'solid', arrange: 'flow', direction: 'out' } }).ok).toBe(false);
    expect(bad({ r: { style: 'solid', direction: 'out' } }).ok).toBe(false);
    expect(bad({ r: { style: 'solid', arrange: 'contain', direction: 'down' } }).ok).toBe(false);
  });
});

// P1 invariants (dynamic-view-design.md): no layout output may overlap, and a
// fresh pass over the same snapshot always lays out the same.
describe('P1: no-overlap invariant and fresh-pass determinism', () => {
  type R = { x: number; y: number; w: number; h: number };
  const inside = (outer: R, r: R) =>
    r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;
  const assertNoOverlaps = (scene: ReturnType<typeof buildScene>, label: string) => {
    const leaves = [...scene.layout.nodes.values()];
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        expect(overlaps(leaves[i]!, leaves[j]!), `${label}: leaves ${leaves[i]!.id}/${leaves[j]!.id}`).toBe(false);
      }
    }
    const groups = scene.groups;
    for (const a of groups) {
      for (const b of groups) {
        if (a === b || inside(a, b) || inside(b, a)) continue;
        expect(overlaps(a, b), `${label}: groups ${a.id}/${b.id}`).toBe(false);
      }
    }
    for (const leaf of leaves) {
      for (const g of groups) {
        if (inside(g, leaf)) continue;
        expect(overlaps(leaf, g), `${label}: leaf ${leaf.id} vs group ${g.id}`).toBe(false);
      }
    }
  };

  const graphs: [string, NodeProjection[]][] = [
    ['normal fixture', nodesOf()],
    ['normal + new task', withNewTask(nodesOf())],
  ];

  it('fallback layout: no two leaves, sibling groups or foreign leaf/group pairs overlap', () => {
    for (const [label, nodes] of graphs) assertNoOverlaps(buildScene(nodes, DEFAULT_WIRING), label);
  });

  it('layered layout (ELK in-thread): same invariant', async () => {
    for (const [label, nodes] of graphs) {
      const pos = await inThreadElk().layout(layoutGraphOf(nodes, DEFAULT_WIRING));
      assertNoOverlaps(buildScene(nodes, DEFAULT_WIRING, new Map(), pos), label);
    }
  });

  it('a fresh pass is deterministic: the same snapshot lays out identically twice', async () => {
    const nodes = nodesOf();
    const graph = layoutGraphOf(nodes, DEFAULT_WIRING);
    expect(fallbackLayout(graph)).toEqual(fallbackLayout(graph));
    const a = await inThreadElk().layout(graph);
    const b = await inThreadElk().layout(graph);
    expect(a).toEqual(b);
  });
});

describe('component packing', () => {
  it('unconnected groups are packed into rows toward the engine aspect ratio, not one tall column', async () => {
    const mk = (id: string, relations: NodeProjection['relations'] = []): NodeProjection => ({
      id, kind: relations.length ? 'task' : 'mission', state: { value: 's' }, relations, capabilities: [], attention: [], artifacts: [],
    });
    const nodes = Array.from({ length: 6 }, (_, m) => [
      mk(`m${m}`),
      mk(`m${m}-a`, [{ type: 'member-of', target: `m${m}` }]),
      mk(`m${m}-b`, [{ type: 'member-of', target: `m${m}` }, { type: 'dependency', target: `m${m}-a` }]),
    ]).flat();
    for (const pos of [fallbackLayout(layoutGraphOf(nodes, DEFAULT_WIRING)), await inThreadElk().layout(layoutGraphOf(nodes, DEFAULT_WIRING))]) {
      const scene = buildScene(nodes, DEFAULT_WIRING, new Map(), pos);
      const top = scene.groups.filter((g) => g.depth === 0);
      expect(new Set(top.map((g) => Math.round(g.x))).size).toBeGreaterThan(1);
      for (const a of top) for (const b of top) if (a !== b) expect(overlaps(a, b), `${a.id}/${b.id}`).toBe(false);
    }
  });
});

describe('contain groups in the scene', () => {
  it('a contain parent becomes a labelled group box around its members; the nesting replaces its edges', () => {
    const scene = buildScene(nodesOf(), DEFAULT_WIRING);
    const m1 = scene.groups.find((g) => g.id === 'm1')!;
    expect(m1.name).toBe(normalFixture().missions.find((m) => m.id === 'm1')!.name);
    expect(m1.members).toContain('t-build');
    for (const id of m1.members) {
      const b = scene.layout.nodes.get(id)!;
      expect(b.x >= m1.x && b.y >= m1.y && b.x + b.w <= m1.x + m1.w && b.y + b.h <= m1.y + m1.h, id).toBe(true);
    }
    expect(scene.layout.nodes.has('m1')).toBe(false);
    expect(scene.edges.some((e) => e.type === 'member-of' && e.to === 'm1')).toBe(false);
  });

  it('user drags win over computed positions, and the group follows its members', () => {
    const scene = buildScene(nodesOf(), DEFAULT_WIRING, new Map([['t-build', { x: 5000, y: 4000 }]]));
    expect(scene.layout.nodes.get('t-build')).toMatchObject({ x: 5000, y: 4000 });
    const m1 = scene.groups.find((g) => g.id === 'm1')!;
    expect(m1.x + m1.w).toBeGreaterThanOrEqual(5000 + 200);
  });
});

describe('ELK provider (in-thread)', () => {
  it('lays out the compound graph: every leaf placed, groups of different parents do not overlap', async () => {
    const nodes = nodesOf();
    const graph = layoutGraphOf(nodes, DEFAULT_WIRING);
    const pos = await inThreadElk().layout(graph);
    expect(new Set(pos.keys())).toEqual(new Set(leafIds(graph)));
    const scene = buildScene(nodes, DEFAULT_WIRING, new Map(), pos);
    const top = scene.groups.filter((g) => g.depth === 0);
    for (const a of top) for (const b of top) if (a !== b) expect(overlaps(a, b), `${a.id}/${b.id}`).toBe(false);
    const boxes = [...scene.layout.nodes.values()];
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(overlaps(a, b), `${a.id}/${b.id}`).toBe(false);
  });

  it('an added node barely moves the existing ones (interactive hints + per-component stabilization)', async () => {
    const s = createLayoutState({ loadProvider: async () => inThreadElk() });
    s.update(layoutGraphOf(nodesOf(), DEFAULT_WIRING));
    await s.settled();
    const before = s.positions();
    s.update(layoutGraphOf(withNewTask(nodesOf()), DEFAULT_WIRING));
    await s.settled();
    const after = s.positions();
    expect(after.has('t-new')).toBe(true);
    const moves = [...before].map(([id, q]) => Math.hypot(after.get(id)!.x - q.x, after.get(id)!.y - q.y));
    const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
    // Most nodes stay put; the mean movement stays under one node height.
    expect(mean).toBeLessThan(78);
  });
});

describe('layout state: signature cache, fallback, stale results', () => {
  const counting = (inner: LayoutProvider = inThreadElk()) => {
    const calls: number[] = [];
    const provider: LayoutProvider = { layout: (g, h) => (calls.push(g.nodes.length), inner.layout(g, h)) };
    return { calls, loadProvider: async () => provider };
  };

  it('the same snapshot re-sent recomputes nothing and moves nothing', async () => {
    const c = counting();
    const s = createLayoutState({ loadProvider: c.loadProvider });
    s.update(layoutGraphOf(nodesOf(), DEFAULT_WIRING));
    await s.settled();
    expect(s.source()).toBe('layered');
    const first = s.positions();
    for (let i = 0; i < 3; i++) s.update(layoutGraphOf(nodesOf(), DEFAULT_WIRING));
    await s.settled();
    expect(c.calls).toHaveLength(1);
    expect(s.positions()).toBe(first);
  });

  it('a topology change keeps existing nodes in place at once, then re-lays out with hints', async () => {
    const c = counting();
    const s = createLayoutState({ loadProvider: c.loadProvider });
    s.update(layoutGraphOf(nodesOf(), DEFAULT_WIRING));
    await s.settled();
    const before = s.positions();
    s.update(layoutGraphOf(withNewTask(nodesOf()), DEFAULT_WIRING));
    const interim = s.positions();
    for (const [id, q] of before) expect(interim.get(id)).toEqual(q);
    expect(interim.has('t-new')).toBe(true);
    await s.settled();
    expect(c.calls).toHaveLength(2);
  });

  it('without the layered engine (load fails) the fallback stands', async () => {
    const s = createLayoutState({ loadProvider: () => Promise.reject(new Error('no worker')) });
    const graph = layoutGraphOf(nodesOf(), DEFAULT_WIRING);
    s.update(graph);
    await s.settled();
    expect(s.source()).toBe('fallback');
    expect(s.positions()).toEqual(fallbackLayout(graph));
  });

  it('a result for an outdated topology is dropped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: LayoutProvider = {
      async layout(g, h) {
        if (g.nodes.some((n) => n.id === 't-new')) return inThreadElk().layout(g, h);
        await gate;
        return new Map(leafIds(g).map((id) => [id, { x: -9999, y: -9999 }])) as Positions;
      },
    };
    const s = createLayoutState({ loadProvider: async () => slow });
    s.update(layoutGraphOf(nodesOf(), DEFAULT_WIRING));
    s.update(layoutGraphOf(withNewTask(nodesOf()), DEFAULT_WIRING));
    await s.settled();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect([...s.positions().values()].some((p) => p.x === -9999)).toBe(false);
  });

  it('over the size limit only the fallback runs', async () => {
    const c = counting();
    const s = createLayoutState({ loadProvider: c.loadProvider, maxNodes: 10 });
    s.update(layoutGraphOf(projectNodes(largeFixture()), DEFAULT_WIRING));
    await s.settled();
    expect(c.calls).toHaveLength(0);
    expect(s.source()).toBe('fallback');
  });
});
