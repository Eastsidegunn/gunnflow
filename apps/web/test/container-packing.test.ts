// Component packing inside containers (machine pref `packContainers`): a goal
// holding sibling missions of unconnected members must not lay out as one
// tall column. On: every container packs its disconnected children toward
// LAYOUT.aspect, deepest first. Off: exactly the old top-level-only packing.
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { NodeProjection } from '@gunnflow/contract';
import { largeFixture, normalFixture, projectNodes } from '@gunnflow-testing/fake-contracts';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { LAYOUT, fallbackLayout, layoutGraphOf, leafIds, type LayoutProvider, type Positions } from '../src/canvas/layoutGraph.js';
import { elkProvider } from '../src/canvas/elkLayout.js';
import { buildScene } from '../src/canvas/genericScene.js';
import { createLayoutState } from '../src/state/layoutState.js';

const elk = new ELK();
const inThreadElk = (): LayoutProvider => elkProvider((g) => elk.layout(g));

type R = { x: number; y: number; w: number; h: number };
const overlaps = (a: R, b: R) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (outer: R, r: R) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;

const node = (id: string, kind: string, relations: NodeProjection['relations'] = []): NodeProjection => ({
  id, kind, state: { value: 's' }, relations, capabilities: [], attention: [], artifacts: [],
});

/** The measured defect's shape: a goal ⊃ 6 missions ⊃ 7 members each, mostly unconnected; one mission has a chain. */
function nestedGoal(): NodeProjection[] {
  const out: NodeProjection[] = [node('goal', 'goal'), node('outside', 'task', [{ type: 'dependency', target: 'm0-a' }])];
  for (let m = 0; m < 6; m++) {
    out.push(node(`m${m}`, 'mission', [{ type: 'member-of', target: 'goal' }]));
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const rel: NodeProjection['relations'] = [{ type: 'member-of', target: `m${m}` }];
      // Flow inside mission 0 only: a → b → c, and d → e.
      if (m === 0 && (k === 'b' || k === 'c' || k === 'e')) rel.push({ type: 'dependency', target: `m0-${String.fromCharCode(k.charCodeAt(0) - 1)}` });
      out.push(node(`m${m}-${k}`, 'task', rel));
    }
  }
  return out;
}

const sceneOf = (nodes: NodeProjection[], pos: Positions, packContainers: boolean) =>
  buildScene(nodes, DEFAULT_WIRING, new Map(), pos, new Map(), { packContainers });

function assertNoOverlaps(scene: ReturnType<typeof buildScene>, label: string) {
  // Nesting by membership (members = every descendant leaf), never by geometry:
  // a foreign box lying wholly inside a group is an overlap too.
  const memberOf = new Map(scene.groups.map((g) => [g.id, new Set(g.members)]));
  const nested = (outer: (typeof scene.groups)[number], g: (typeof scene.groups)[number]) =>
    g.depth > outer.depth && g.members.length > 0 && g.members.every((m) => memberOf.get(outer.id)!.has(m));
  const leaves = [...scene.layout.nodes.values()];
  for (let i = 0; i < leaves.length; i++)
    for (let j = i + 1; j < leaves.length; j++)
      expect(overlaps(leaves[i]!, leaves[j]!), `${label}: leaves ${leaves[i]!.id}/${leaves[j]!.id}`).toBe(false);
  for (const a of scene.groups)
    for (const b of scene.groups) {
      if (a === b || nested(a, b) || nested(b, a)) continue;
      expect(overlaps(a, b), `${label}: groups ${a.id}/${b.id}`).toBe(false);
    }
  for (const leaf of leaves)
    for (const g of scene.groups) {
      if (memberOf.get(g.id)!.has(leaf.id)) {
        expect(inside(g, leaf), `${label}: ${leaf.id} outside its group ${g.id}`).toBe(true);
        continue;
      }
      expect(overlaps(leaf, g), `${label}: leaf ${leaf.id} vs group ${g.id}`).toBe(false);
    }
  for (const a of scene.groups)
    for (const b of scene.groups) if (a !== b && nested(a, b)) expect(inside(a, b), `${label}: ${b.id} outside ${a.id}`).toBe(true);
}

const layouts = async (nodes: NodeProjection[], packContainers: boolean): Promise<[string, Positions][]> => {
  const graph = layoutGraphOf(nodes, DEFAULT_WIRING, { packContainers });
  return [
    ['fallback', fallbackLayout(graph)],
    ['layered', await inThreadElk().layout(graph)],
  ];
};

describe('container packing (packContainers)', () => {
  it('on: the nested goal is packed toward the engine aspect, not one tall column', async () => {
    const nodes = nestedGoal();
    for (const [label, pos] of await layouts(nodes, true)) {
      const goal = sceneOf(nodes, pos, true).groups.find((g) => g.id === 'goal')!;
      const ratio = goal.w / goal.h;
      expect(goal.h, `${label}: goal ${goal.w}×${goal.h}`).toBeLessThanOrEqual(2.5 * goal.w);
      expect(ratio, `${label}: goal ${goal.w}×${goal.h}`).toBeGreaterThan(LAYOUT.aspect / 2.5);
      expect(ratio, `${label}: goal ${goal.w}×${goal.h}`).toBeLessThan(LAYOUT.aspect * 2.5);
      // Missions sit side by side somewhere, and unconnected members share rows.
      const missions = sceneOf(nodes, pos, true).groups.filter((g) => g.id.startsWith('m'));
      expect(new Set(missions.map((g) => Math.round(g.x))).size, label).toBeGreaterThan(1);
    }
  });

  it('off: the old column shape stays exactly as before (top-level packing only)', async () => {
    const nodes = nestedGoal();
    for (const [label, pos] of await layouts(nodes, false)) {
      const goal = sceneOf(nodes, pos, false).groups.find((g) => g.id === 'goal')!;
      expect(goal.h, `${label}: goal ${goal.w}×${goal.h}`).toBeGreaterThan(4 * goal.w);
    }
  });

  it('the internal arrangement of a connected component is kept (rigid shift)', async () => {
    const nodes = nestedGoal();
    const graph = layoutGraphOf(nodes, DEFAULT_WIRING);
    const flat = await inThreadElk().layout(layoutGraphOf(nodes, DEFAULT_WIRING, { packContainers: false }));
    const packed = await inThreadElk().layout(graph);
    const rel = (p: Positions, a: string, b: string) => ({ x: p.get(b)!.x - p.get(a)!.x, y: p.get(b)!.y - p.get(a)!.y });
    expect(rel(packed, 'm0-a', 'm0-b')).toEqual(rel(flat, 'm0-a', 'm0-b'));
    expect(rel(packed, 'm0-b', 'm0-c')).toEqual(rel(flat, 'm0-b', 'm0-c'));
    expect(rel(packed, 'm0-d', 'm0-e')).toEqual(rel(flat, 'm0-d', 'm0-e'));
  });

  it('overlap-freedom (node-node, node-group, group-group), on and off, across fixtures', async () => {
    const fixtures: [string, NodeProjection[]][] = [
      ['nested goal', nestedGoal()],
      ['normal fixture', projectNodes(normalFixture())],
      ['large fixture', projectNodes(largeFixture())],
    ];
    for (const [name, nodes] of fixtures)
      for (const on of [true, false])
        for (const [label, pos] of await layouts(nodes, on)) {
          expect(new Set(pos.keys())).toEqual(new Set(leafIds(layoutGraphOf(nodes, DEFAULT_WIRING))));
          assertNoOverlaps(sceneOf(nodes, pos, on), `${name} ${label} pack=${on}`);
        }
  });

  it('determinism: the same input lays out identically', async () => {
    const graph = layoutGraphOf(nestedGoal(), DEFAULT_WIRING);
    expect(fallbackLayout(graph)).toEqual(fallbackLayout(graph));
    expect(await inThreadElk().layout(graph)).toEqual(await inThreadElk().layout(graph));
  });

  it('the flag is a layout input: it re-keys the signature, so flipping it relayouts once', async () => {
    const nodes = nestedGoal();
    const on = layoutGraphOf(nodes, DEFAULT_WIRING);
    const off = layoutGraphOf(nodes, DEFAULT_WIRING, { packContainers: false });
    expect(on.signature).not.toBe(off.signature);
    expect(layoutGraphOf(nodes, DEFAULT_WIRING, { packContainers: true }).signature).toBe(on.signature);
    const s = createLayoutState({ loadProvider: async () => inThreadElk() });
    s.update(off);
    await s.settled();
    const before = s.positions();
    s.update(on);
    await s.settled();
    // Stabilization must not hold the old (column) positions: the component re-lays out.
    expect(s.positions()).not.toEqual(before);
    const goal = sceneOf(nodes, s.positions(), true).groups.find((g) => g.id === 'goal')!;
    expect(goal.h).toBeLessThanOrEqual(2.5 * goal.w);
  });

  /* ---- review repros: a packed (grown) group must not swallow a flow-linked neighbour ---- */

  const member = (id: string, of: string, extra: NodeProjection['relations'] = []) =>
    node(id, 'task', [{ type: 'member-of', target: of }, ...extra]);
  /** Group g of n unconnected children, the first linked out to a top-level node (inside → outside). */
  const insideOut = (n: number): NodeProjection[] => [
    node('g', 'mission'),
    node('outside', 'task'),
    ...Array.from({ length: n }, (_, i) =>
      member(`c${String(i).padStart(2, '0')}`, 'g', i === 0 ? [{ type: 'dependency', target: 'outside' }] : []),
    ),
  ];
  /** outer ⊃ inner ⊃ 8 leaves; outer ⊃ s; an inner leaf links to s (inner → outer sibling). */
  const threeLevel = (): NodeProjection[] => [
    node('outer', 'goal'),
    node('inner', 'mission', [{ type: 'member-of', target: 'outer' }]),
    member('s', 'outer'),
    ...Array.from({ length: 8 }, (_, i) => member(`l${i}`, 'inner', i === 0 ? [{ type: 'dependency', target: 's' }] : [])),
  ];
  /** Gap between two rects (0 when touching or overlapping). */
  const rectGap = (a: R, b: R) =>
    Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w), Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  const maxGap = Math.max(LAYOUT.rowGap, LAYOUT.colGap);

  const repros: [string, NodeProjection[], string, string, string][] = [
    ['inside→outside edge (3 children)', insideOut(3), 'outside', 'g', 'c00'],
    ['inside→outside edge (24 children)', insideOut(24), 'outside', 'g', 'c00'],
    ['3-level, inner leaf → outer sibling', threeLevel(), 's', 'inner', 'l0'],
  ];
  const edgeLength = (scene: ReturnType<typeof buildScene>, a: string, b: string) => {
    const p = scene.layout.nodes.get(a)!;
    const q = scene.layout.nodes.get(b)!;
    return Math.hypot(p.x + p.w / 2 - q.x - q.w / 2, p.y + p.h / 2 - q.y - q.h / 2);
  };

  it('review repros: overlap-free and members inside their groups, ELK and fallback', async () => {
    for (const [name, nodes] of repros)
      for (const on of [true, false])
        for (const [label, pos] of await layouts(nodes, on)) assertNoOverlaps(sceneOf(nodes, pos, on), `${name} ${label} pack=${on}`);
  });

  it('review repros (ELK): the linked outside node stays adjacent to the packed group', async () => {
    for (const [name, nodes, ext, group, end] of repros) {
      const pos = await inThreadElk().layout(layoutGraphOf(nodes, DEFAULT_WIRING));
      const scene = sceneOf(nodes, pos, true);
      const g = scene.groups.find((x) => x.id === group)!;
      const e = scene.layout.nodes.get(ext)!;
      const a = scene.layout.nodes.get(end)!;
      expect(rectGap(g, e), `${name}: ${ext} ${JSON.stringify(e)} vs ${group} ${JSON.stringify(g)}`).toBeLessThanOrEqual(2 * maxGap);
      // The relation itself stays short: its ends are neighbours across the group edge.
      expect(edgeLength(scene, ext, end), name).toBeLessThanOrEqual(2 * maxGap + 2 * LAYOUT.groupPad + (a.w + e.w) / 2 + (a.h + e.h) / 2);
    }
  });

  it('relations leaving a packed group are no longer than in the unpacked column (ELK and fallback)', async () => {
    const cases: [string, NodeProjection[], string, string][] = [
      ...repros.map(([n, nodes, ext, , end]) => [n, nodes, ext, end] as [string, NodeProjection[], string, string]),
      ['nested goal', nestedGoal(), 'outside', 'm0-a'],
    ];
    for (const [name, nodes, ext, end] of cases) {
      const off = await layouts(nodes, false);
      const on = await layouts(nodes, true);
      for (let i = 0; i < on.length; i++) {
        const before = edgeLength(sceneOf(nodes, off[i]![1], false), ext, end);
        const after = edgeLength(sceneOf(nodes, on[i]![1], true), ext, end);
        expect(after, `${name} ${on[i]![0]}: ${Math.round(before)} → ${Math.round(after)}`).toBeLessThanOrEqual(before + 1);
      }
    }
  });

  it('the nested goal (ELK): the outside node stays adjacent to the packed goal', async () => {
    const nodes = nestedGoal();
    const scene = sceneOf(nodes, await inThreadElk().layout(layoutGraphOf(nodes, DEFAULT_WIRING)), true);
    const goal = scene.groups.find((g) => g.id === 'goal')!;
    expect(rectGap(goal, scene.layout.nodes.get('outside')!)).toBeLessThanOrEqual(2 * maxGap);
  });

  it('seeded nested fuzz: random containment + random flow, overlap-free on both paths', async () => {
    let seed = 20261008;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32);
    for (let run = 0; run < 16; run++) {
      const n = 20 + Math.floor(rnd() * 40);
      const nodes: NodeProjection[] = [];
      for (let i = 0; i < n; i++) {
        const id = `n${String(i).padStart(2, '0')}`;
        const rel: NodeProjection['relations'] = [];
        // Parent among earlier nodes (acyclic), so nesting goes up to a few levels.
        if (i > 0 && rnd() < 0.75) rel.push({ type: 'member-of', target: `n${String(Math.floor(rnd() * Math.min(i, 8))).padStart(2, '0')}` });
        if (i > 0 && rnd() < 0.3) rel.push({ type: 'dependency', target: `n${String(Math.floor(rnd() * i)).padStart(2, '0')}` });
        nodes.push(node(id, 'task', rel));
      }
      for (const [label, pos] of await layouts(nodes, true)) assertNoOverlaps(sceneOf(nodes, pos, true), `fuzz run ${run} ${label}`);
    }
  });
});
