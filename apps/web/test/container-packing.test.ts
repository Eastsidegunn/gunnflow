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
  const leaves = [...scene.layout.nodes.values()];
  for (let i = 0; i < leaves.length; i++)
    for (let j = i + 1; j < leaves.length; j++)
      expect(overlaps(leaves[i]!, leaves[j]!), `${label}: leaves ${leaves[i]!.id}/${leaves[j]!.id}`).toBe(false);
  for (const a of scene.groups)
    for (const b of scene.groups) {
      if (a === b || inside(a, b) || inside(b, a)) continue;
      expect(overlaps(a, b), `${label}: groups ${a.id}/${b.id}`).toBe(false);
    }
  for (const leaf of leaves)
    for (const g of scene.groups) {
      if (inside(g, leaf)) continue;
      expect(overlaps(leaf, g), `${label}: leaf ${leaf.id} vs group ${g.id}`).toBe(false);
    }
  // Every member stays inside its own group box.
  for (const g of scene.groups)
    for (const m of g.members) {
      const r = scene.layout.nodes.get(m) ?? scene.groups.find((x) => x.id === m);
      if (r) expect(inside(g, r), `${label}: ${m} outside ${g.id}`).toBe(true);
    }
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
});
