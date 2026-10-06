// Dynamic-view P3 (round-3 canon: GROWTH LIVES INSIDE LOCAL SLACK — SIZE
// YIELDS WHEN SPACE IS SHORT). Size is a layout input (tier × theme factor);
// geometry changes only at TRANSITION MOMENTS; between them only PERSON-caused
// tiers resize anything, and a grown node claims extension + margin out of
// genuinely free space: same-container siblings shift within their slack,
// pins/anchors/wraps are walls, the margin yields first and the size clamps —
// so overlap-freedom, locality and pin/focus inviolability hold BY
// CONSTRUCTION (no exemptions needed anywhere in this file).
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { NodeProjection } from '@gunnflow/contract';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { DEFAULT_THEME } from '../src/theme/defaultTheme.js';
import { computeSpatialTiers, computeTiers, sizeForTier, spatialNeighbors, type Tier } from '../src/state/relevance.js';
import {
  GENERIC_NODE_SIZE,
  containerRects,
  fallbackLayout,
  layoutGraphOf,
  leafIds,
  sizedGraph,
  type LayoutProvider,
  type Rect,
} from '../src/canvas/layoutGraph.js';
import { elkProvider } from '../src/canvas/elkLayout.js';
import { buildScene } from '../src/canvas/genericScene.js';
import { createLayoutState } from '../src/state/layoutState.js';
import {
  cubicBezierEase,
  defaultMaxShift,
  displaySizes,
  planSettled,
  planTransition,
  pushAside,
  rectMapEquals,
  rectsAt,
  spaceTargets,
  tierSizes,
  transitionCause,
  type TransitionKey,
} from '../src/canvas/space.js';

const GEO = DEFAULT_THEME.geometry;
const MOTION = DEFAULT_THEME.motion;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const r = (x: number, y: number, w = 100, h = 50): Rect => ({ x, y, w, h });
/** The rect a node takes when its FULL tier growth fits (centred on its allocated box). */
const grownAt = (p: { x: number; y: number }, tier: Tier): Rect => {
  const s = sizeForTier(tier, GEO.node, GEO.tierScale);
  return { x: p.x + (GEO.node.w - s.w) / 2, y: p.y + (GEO.node.h - s.h) / 2, w: s.w, h: s.h };
};
/** `outer` fully contains `inner` (a grown node never abandons its allocated box). */
const covers = (outer: Rect, inner: Rect) =>
  outer.x <= inner.x + 1e-6 && outer.y <= inner.y + 1e-6 && outer.x + outer.w >= inner.x + inner.w - 1e-6 && outer.y + outer.h >= inner.y + inner.h - 1e-6;

/** STRICT: no engine-made overlap of any kind — no exemptions. */
function expectOverlapFree(rects: ReadonlyMap<string, Rect>, label = '') {
  const entries = [...rects];
  for (const [ia, a] of entries) {
    for (const [ib, b] of entries) {
      if (ia >= ib) continue;
      expect(overlaps(a, b), `${label}: ${ia} overlaps ${ib}`).toBe(false);
    }
  }
}

const node = (id: string, relations: NodeProjection['relations'] = [], over: Partial<NodeProjection> = {}): NodeProjection => ({
  id, kind: 'task', state: { value: 'running' }, relations, capabilities: [], attention: [], artifacts: [], ...over,
});
const mission = (id: string) => node(id, [], { kind: 'mission', label: `Mission ${id}` });
const member = (id: string, m: string, extra: NodeProjection['relations'] = []) => node(id, [{ type: 'member-of', target: m }, ...extra]);
/** `missions` chains of `tasks` members each (the reviewers' repro shape). */
const chains = (missions: number, tasks: number): NodeProjection[] => {
  const out: NodeProjection[] = [];
  for (let m = 0; m < missions; m++) {
    out.push(mission(`m${m}`));
    for (let t = 0; t < tasks; t++) {
      out.push(member(`m${m}t${t}`, `m${m}`, t > 0 ? [{ type: 'dependency', target: `m${m}t${t - 1}` }] : []));
    }
  }
  return out;
};
/** Reviewer regression shape: 2-level nesting PLUS ungrouped nodes. */
const nestedPlus = (): NodeProjection[] => [
  mission('m0'), member('g0', 'm0'), member('m0t0', 'g0'), member('m0t1', 'g0', [{ type: 'dependency', target: 'm0t0' }]),
  member('m0t2', 'm0'),
  node('loose0'), node('loose1', [{ type: 'dependency', target: 'loose0' }]),
  mission('m1'), member('m1t0', 'm1'), member('m1t1', 'm1', [{ type: 'dependency', target: 'm1t0' }]),
];
/** Reviewer regression shape: one wide container, a small one, an ungrouped node. */
const wideShape = (): NodeProjection[] => [
  ...chains(1, 8),
  mission('mw'), member('mwt0', 'mw'), member('mwt1', 'mw', [{ type: 'dependency', target: 'mwt0' }]),
  node('solo'),
];
const ancestorsOf = (id: string, parentOf: ReadonlyMap<string, string>): Set<string> => {
  const out = new Set<string>();
  for (let p = parentOf.get(id); p !== undefined && !out.has(p); p = parentOf.get(p)) out.add(p);
  return out;
};

/** The round-3 STRICT settled-state audit: leaves, groups, foreign intrusion, pins — no exemptions. */
function expectStrictSettled(
  graph: ReturnType<typeof layoutGraphOf>,
  out: ReadonlyMap<string, Rect>,
  pins: ReadonlyMap<string, { x: number; y: number }>,
  label: string,
) {
  expectOverlapFree(out, label);
  const groups = containerRects(graph, (id) => out.get(id));
  const list = [...groups];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [ga, ra] = list[i]!;
      const [gb, rb] = list[j]!;
      if (ancestorsOf(ga, graph.parentOf).has(gb) || ancestorsOf(gb, graph.parentOf).has(ga)) continue;
      expect(overlaps(ra, rb), `${label}: group ${ga} overlaps group ${gb}`).toBe(false);
    }
  }
  for (const [id, rect] of out) {
    const mine = ancestorsOf(id, graph.parentOf);
    for (const [gid, g] of groups) {
      if (mine.has(gid)) continue;
      expect(overlaps(rect, g), `${label}: node ${id} inside foreign group ${gid}`).toBe(false);
    }
  }
  for (const [id, p] of pins) expect(out.get(id), `${label}: pin ${id}`).toMatchObject({ x: p.x, y: p.y });
}

describe('size mapping (output ③)', () => {
  it('tier factors are theme geometry data: 1.6 / 1.25 / 1 / 1', () => {
    expect(sizeForTier(3, GEO.node, GEO.tierScale)).toEqual({ w: GEO.node.w * 1.6, h: GEO.node.h * 1.6 });
    expect(sizeForTier(2, GEO.node, GEO.tierScale)).toEqual({ w: GEO.node.w * 1.25, h: GEO.node.h * 1.25 });
    expect(sizeForTier(1, GEO.node, GEO.tierScale)).toEqual(GEO.node);
    // tier 0 recedes by dim only — never by size (§11: no hiding, no shrinking away).
    expect(sizeForTier(0, GEO.node, GEO.tierScale)).toEqual(GEO.node);
  });

  it('tierSizes covers every tiered node', () => {
    const tiers = new Map<string, Tier>([['a', 3], ['b', 2], ['c', 1], ['d', 0]]);
    const sizes = tierSizes(tiers, GEO);
    expect(sizes.get('a')).toEqual({ w: GEO.node.w * 1.6, h: GEO.node.h * 1.6 });
    expect(sizes.get('c')).toEqual(GEO.node);
    expect(sizes.size).toBe(4);
  });
});

describe('size responds only to person-caused signals between moments (ruling 2026-10-05)', () => {
  const NODES = [
    node('sel', [{ type: 'any-word', target: 'nb' }]),
    node('nb'),
    node('attn', [], { attention: [{ cause: 'whatever' }] }),
    node('plain'),
  ];
  const nobody = { focusIds: new Set<string>(), pendingIds: new Set<string>() };

  it('attention, recency and lens matches never reach size — emphasis keeps them, geometry does not', () => {
    const spatial = computeSpatialTiers(NODES, nobody);
    expect(spatial.get('attn')).toBe(1);
    expect(displaySizes(spatial, new Map(), GEO).get('attn')).toEqual(GEO.node);
    // Sanity: the FULL tiers (emphasis/detail pipeline) still mark it tier 2.
    const full = computeTiers(NODES, { ...nobody, lensVerdict: () => 'neutral', changedAt: () => undefined, now: 0 });
    expect(full.get('attn')).toBe(2);
  });

  it('selection, pending intents and their 1-hop received ripple resize at once', () => {
    const spatial = computeSpatialTiers(NODES, { focusIds: new Set(['sel']), pendingIds: new Set(['plain']) });
    expect(spatial.get('sel')).toBe(3);
    expect(spatial.get('plain')).toBe(3);
    expect(spatial.get('nb')).toBe(2); // 1-hop of the selection
    expect(spatial.get('attn')).toBe(1); // received-fact cause: no size
  });

  it('a transition bake floors the display size until the next moment; person growth still wins', () => {
    const baked = new Map([['attn', sizeForTier(2, GEO.node, GEO.tierScale)]]); // a lens change baked 1.25×
    const idle = displaySizes(computeSpatialTiers(NODES, nobody), baked, GEO);
    expect(idle.get('attn')).toEqual(sizeForTier(2, GEO.node, GEO.tierScale)); // recency decay cannot shrink it early
    const selected = displaySizes(
      computeSpatialTiers(NODES, { focusIds: new Set(['attn']), pendingIds: new Set() }),
      baked,
      GEO,
    );
    expect(selected.get('attn')).toEqual(sizeForTier(3, GEO.node, GEO.tierScale));
  });

  it('the 1-hop ripple is a SNAPSHOT: a backend-added relation cannot grow anything mid-flight', () => {
    const before = [node('sel', [{ type: 'x', target: 'nb' }]), node('nb'), node('late')];
    const after = [node('sel', [{ type: 'x', target: 'nb' }, { type: 'y', target: 'late' }]), node('nb'), node('late')];
    const person = { focusIds: new Set(['sel']), pendingIds: new Set<string>() };
    const snap = spatialNeighbors(before, person); // captured at the person-action moment
    const held = computeSpatialTiers(after, person, snap);
    expect(held.get('late')).toBe(1); // the new relation waits for the next person action / transition
    expect(held.get('nb')).toBe(2);
    expect(computeSpatialTiers(after, person).get('late')).toBe(2); // the re-capture picks it up
  });
});

describe('transition moments (the only gate for geometry)', () => {
  const key = (over: Partial<TransitionKey> = {}): TransitionKey => ({ topology: 't', lens: 'all', sortKey: null, tidy: 0, ...over });

  it('topology, lens, sort key (P4 seam) and tidy each open a transition; nothing else does', () => {
    expect(transitionCause(null, key())).toBe('topology');
    expect(transitionCause(key(), key({ topology: 't2' }))).toBe('topology');
    expect(transitionCause(key(), key({ lens: 'plan' }))).toBe('lens');
    expect(transitionCause(key(), key({ sortKey: 'label' }))).toBe('sort'); // P4 seam: declared now, fired when the sort UI lands
    expect(transitionCause(key(), key({ tidy: 1 }))).toBe('tidy');
    expect(transitionCause(key(), key())).toBeNull();
  });

  it('sizedGraph re-keys the layout cache only when the locked sizes change', () => {
    const g = layoutGraphOf([node('a'), node('b')], DEFAULT_WIRING);
    const base = new Map<string, { w: number; h: number }>([['a', { ...GENERIC_NODE_SIZE }], ['b', { ...GENERIC_NODE_SIZE }]]);
    const grown = new Map([['a', sizeForTier(3, GEO.node, GEO.tierScale)], ['b', { ...GENERIC_NODE_SIZE }]]);
    expect(sizedGraph(g, base).signature).toBe(sizedGraph(g, base).signature);
    expect(sizedGraph(g, grown).signature).not.toBe(sizedGraph(g, base).signature);
    const sized = sizedGraph(g, grown);
    expect(sized.nodes.find((n) => n.id === 'a')).toMatchObject({ w: GEO.node.w * 1.6, h: GEO.node.h * 1.6 });
  });

  it('a tier change outside a transition is LOCAL: the push stops at the margin boundary, distant rects are untouched', () => {
    const base = new Map([
      ['focus', { x: 300, y: 300 }],
      ['near', { x: 530, y: 300 }], // inside the grown box's claim
      ['boundary', { x: 300, y: 426 }], // its top edge sits just past the claim
      ['far', { x: 1200, y: 300 }],
    ]);
    const sizes = new Map([['focus', sizeForTier(3, GEO.node, GEO.tierScale)]]);
    const out = spaceTargets({
      base, lockedSizes: new Map(), sizes, pins: new Map(),
      baseSize: GEO.node, margin: GEO.focusMargin, hops: GEO.pushHops, anchors: new Set(['focus']),
    });
    // Free space on every side: the focus reaches its FULL tier size in place…
    expect(out.get('focus')).toEqual(grownAt({ x: 300, y: 300 }, 3));
    // …the near neighbour was shifted to exactly the margin boundary…
    const f = out.get('focus')!;
    expect(out.get('near')!.x).toBe(f.x + f.w + GEO.focusMargin);
    // …and a rect at the boundary, like a distant one, keeps its EXACT geometry.
    expect(out.get('boundary')).toEqual({ x: 300, y: 426, w: GEO.node.w, h: GEO.node.h });
    expect(out.get('far')).toEqual({ x: 1200, y: 300, w: GEO.node.w, h: GEO.node.h });
    expectOverlapFree(out);
  });

  it('deselect is symmetric: with the tiers reverted the derivation IS the base geometry again', () => {
    const base = new Map([
      ['focus', { x: 300, y: 300 }],
      ['near', { x: 530, y: 300 }],
    ]);
    const inputs = { base, lockedSizes: new Map(), pins: new Map(), baseSize: GEO.node, margin: GEO.focusMargin, hops: GEO.pushHops };
    const grown = spaceTargets({ ...inputs, sizes: new Map([['focus', sizeForTier(3, GEO.node, GEO.tierScale)]]) });
    const reverted = spaceTargets({ ...inputs, sizes: new Map() });
    expect(rectMapEquals(grown, reverted)).toBe(false);
    expect(reverted.get('focus')).toEqual({ x: 300, y: 300, w: GEO.node.w, h: GEO.node.h });
    expect(reverted.get('near')).toEqual({ x: 530, y: 300, w: GEO.node.w, h: GEO.node.h });
  });
});

describe('growth inside local slack (round-3 canon)', () => {
  const grow = (boxes: Map<string, Rect>, desired: Map<string, { w: number; h: number }>, pins: Set<string>, over: Record<string, unknown> = {}) =>
    pushAside(boxes, desired, pins, { margin: 20, hops: 3, ...over });

  it('a sibling shifts within its slack and the margin boundary holds exactly', () => {
    const out = grow(
      new Map([['a', r(0, 0)], ['b', r(110, 0)]]),
      new Map([['a', { w: 160, h: 80 }]]),
      new Set(),
    );
    expect(out.get('a')).toEqual(r(-30, -15, 160, 80)); // full growth about the centre
    expect(out.get('b')).toEqual(r(150, 0)); // shifted to exactly ext + margin
    expectOverlapFree(out);
  });

  it('margin yields FIRST: a pin inside the claim costs the margin before the size', () => {
    const out = grow(
      new Map([['a', r(0, 0)], ['p', r(120, 0)]]),
      new Map([['a', { w: 160, h: 80 }]]),
      new Set(['p']),
    );
    const a = out.get('a')!;
    expect(a.x + a.w).toBe(120); // full 20px extension right, zero margin, touching the pin
    expect(a.x).toBe(-30); // the free left side still grows fully
    expect(a.w).toBe(150); // 100 + 30 (left) + 20 (right, clamped)
    expect(out.get('p')).toEqual(r(120, 0)); // the pin never moves
    expectOverlapFree(out);
  });

  it('SIZE yields when even the margin cannot: a cramped band clamps the growth', () => {
    const out = grow(
      new Map([['a', r(0, 100)], ['up', r(0, 40)], ['down', r(0, 160)]]),
      new Map([['a', { w: 160, h: 80 }]]),
      new Set(['up', 'down']),
      { margin: 24 },
    );
    const a = out.get('a')!;
    expect(a.h).toBe(70); // wanted 80: each side granted only the 10px gap
    expect(a.y).toBe(90);
    expect(a.w).toBe(160); // the free axis still grows fully
    expect(out.get('up')).toEqual(r(0, 40));
    expect(out.get('down')).toEqual(r(0, 160));
    expectOverlapFree(out);
  });

  it('a pin under the box means the focus simply clamps — no overlap is ever created', () => {
    const boxes = new Map([['a', r(0, 0)], ['p', r(90, 70)]]); // pin just below-right of a's corner
    const out = grow(boxes, new Map([['a', { w: 160, h: 80 }]]), new Set(['p']), { margin: 24 });
    const a = out.get('a')!;
    expect(out.get('p')).toEqual(r(90, 70));
    expect(overlaps(a, out.get('p')!)).toBe(false); // growth never reaches INTO the pin
    expect(covers(a, r(0, 0))).toBe(true); // the allocated box is never abandoned
  });

  it('the chain cap bounds the ripple: siblings beyond `hops` never move, growth still fits before them', () => {
    const shift = defaultMaxShift(2);
    const out = grow(
      new Map([['a', r(0, 0)], ['b1', r(110, 0)], ['b2', r(220, 0)], ['b3', r(330, 0)], ['b4', r(440, 0)]]),
      new Map([['a', { w: 160, h: 80 }]]),
      new Set(),
      { hops: 2, maxShift: shift },
    );
    const a = out.get('a')!;
    expect(a.x + a.w).toBe(130); // full 30px extension right; the margin yielded at the cap
    expect(out.get('b1')!.x).toBe(130); // shifted 20, touching
    expect(out.get('b2')!.x).toBe(230); // shifted 10
    expect(out.get('b3')).toEqual(r(330, 0)); // beyond the cap: EXACT
    expect(out.get('b4')).toEqual(r(440, 0));
    expectOverlapFree(out);
  });

  it('a STRADDLING neighbour widens the span: whatever sits in ITS way is seen too (reviewer minimal repro)', () => {
    // W straddles G's growth edge; X hides outside the halo strip but inside W's way.
    const boxes = new Map<string, Rect>([
      ['W', { x: 0, y: 30, w: 300, h: 60 }],
      ['X', { x: 310, y: -10, w: 200, h: 60 }],
      ['G', { x: 0, y: 130, w: 200, h: 78 }],
    ]);
    const out = pushAside(boxes, new Map([['G', sizeForTier(3, GEO.node, GEO.tierScale)]]), new Set(), {
      margin: GEO.focusMargin, hops: GEO.pushHops, anchors: new Set(['G']),
    });
    expectOverlapFree(out, 'straddling'); // before the fix: W was pushed 84 onto X
    expect(out.get('G')!.w).toBe(GEO.node.w * 1.6); // X shifts along, so the growth still fits
    expect(covers(out.get('G')!, boxes.get('G')!)).toBe(true);
  });

  it('with nothing grown the input comes back untouched (identity outside a ripple)', () => {
    const boxes = new Map([['a', r(0, 0)], ['b', r(500, 500)]]);
    const out = pushAside(boxes, new Map(), new Set(), { margin: 24, hops: 3 });
    expect(rectMapEquals(out, boxes)).toBe(true);
  });

  it('a tight grid: full growth through capped sibling shifts; cells outside the claim strip keep exact rects', () => {
    const boxes = new Map<string, Rect>();
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 5; col++) boxes.set(`n${row}-${col}`, r(col * 110, row * 60));
    }
    const pins = new Set(['n3-4']); // far corner, outside every claim strip
    const out = pushAside(boxes, new Map([['n1-2', { w: 160, h: 80 }]]), pins, {
      margin: GEO.focusMargin, hops: GEO.pushHops, anchors: new Set(['n1-2']),
    });
    expect(covers(out.get('n1-2')!, boxes.get('n1-2')!)).toBe(true);
    expect(out.get('n1-2')).toMatchObject({ w: 160, h: 80 }); // full size: the grid had enough slack
    expect(out.get('n3-4')).toEqual(r(4 * 110, 3 * 60)); // the pin held its ground
    expect(out.get('n3-0')).toEqual(r(0, 3 * 60)); // outside the strips: untouched
    expectOverlapFree(out);
  });

  it('the slack returns at the next transition moment: a relayout at full tier sizes needs no clamp', () => {
    // After the transition the layout allocated the full box — the derivation is the identity.
    const full = sizeForTier(3, GEO.node, GEO.tierScale);
    const out = spaceTargets({
      base: new Map([['focus', { x: 100, y: 100 }], ['near', { x: 100 + full.w + GEO.colGap, y: 100 }]]),
      lockedSizes: new Map([['focus', full]]),
      sizes: new Map([['focus', full]]),
      pins: new Map(),
      baseSize: GEO.node,
      margin: GEO.focusMargin,
      hops: GEO.pushHops,
      anchors: new Set(['focus']),
    });
    expect(out.get('focus')).toEqual({ x: 100, y: 100, w: full.w, h: full.h });
    expect(out.get('near')).toEqual({ x: 100 + full.w + GEO.colGap, y: 100, w: GEO.node.w, h: GEO.node.h });
  });
});

describe('pins: position held, size follows tier within slack (rulings 2026-10-05)', () => {
  it('a pinned focus keeps its box under the hand and grows right/down into free space', () => {
    const out = spaceTargets({
      base: new Map([['p', { x: 100, y: 100 }], ['other', { x: 900, y: 900 }]]),
      lockedSizes: new Map(),
      sizes: new Map([['p', sizeForTier(3, GEO.node, GEO.tierScale)]]),
      pins: new Map([['p', { x: 500, y: 500 }]]),
      baseSize: GEO.node, margin: GEO.focusMargin, hops: GEO.pushHops, anchors: new Set(['p']),
    });
    expect(out.get('p')).toEqual({ x: 500, y: 500, w: GEO.node.w * 1.6, h: GEO.node.h * 1.6 });
    expect(out.get('other')).toEqual({ x: 900, y: 900, w: GEO.node.w, h: GEO.node.h });
  });
});

/* ---- real ELK bases: the reviewers' shapes, strict audit, no exemptions ---- */

const elk = new ELK();
const inThreadElk = (): LayoutProvider => elkProvider((g) => elk.layout(g));
const elkBase = (nodes: NodeProjection[]) => inThreadElk().layout(layoutGraphOf(nodes, DEFAULT_WIRING));

describe('ELK-base regressions (strict audit)', () => {
  it('reviewer repro (a): one pinned-in-place leaf in a FOREIGN container — every focus × pin combo stays strictly clean', async () => {
    const nodes = chains(3, 4);
    const graph = layoutGraphOf(nodes, DEFAULT_WIRING);
    const base = await elkBase(nodes);
    const m0Leaves = leafIds(graph).filter((id) => id.startsWith('m0'));
    const m1Leaves = leafIds(graph).filter((id) => id.startsWith('m1'));
    for (const focus of m0Leaves) {
      for (const pin of m1Leaves) {
        const pins = new Map([[pin, base.get(pin)!]]);
        const spatial = computeSpatialTiers(nodes, { focusIds: new Set([focus]), pendingIds: new Set() });
        const out = spaceTargets({
          base, lockedSizes: new Map(), sizes: tierSizes(spatial, GEO), pins,
          baseSize: GEO.node, margin: GEO.focusMargin, hops: GEO.pushHops,
          anchors: new Set([focus]), parentOf: graph.parentOf,
        });
        // The foreign pin never constrains this mission: the focus reaches FULL size.
        expect(out.get(focus)).toEqual(grownAt(base.get(focus)!, 3));
        expectStrictSettled(graph, out, pins, `focus ${focus}, pin ${pin}`);
      }
    }
  });

  it('reviewer repro (b): two foci in different containers — both grow in their own slack, strictly clean', async () => {
    const nodes = chains(3, 4);
    const graph = layoutGraphOf(nodes, DEFAULT_WIRING);
    const base = await elkBase(nodes);
    const m0Leaves = leafIds(graph).filter((id) => id.startsWith('m0'));
    const m2Leaves = leafIds(graph).filter((id) => id.startsWith('m2'));
    for (const a of m0Leaves) {
      for (const b of m2Leaves) {
        const person = { focusIds: new Set([a]), pendingIds: new Set([b]) };
        const spatial = computeSpatialTiers(nodes, person);
        const out = spaceTargets({
          base, lockedSizes: new Map(), sizes: tierSizes(spatial, GEO), pins: new Map(),
          baseSize: GEO.node, margin: GEO.focusMargin, hops: GEO.pushHops,
          anchors: new Set([a, b]), parentOf: graph.parentOf,
        });
        expect(out.get(a)).toEqual(grownAt(base.get(a)!, 3));
        expect(out.get(b)).toEqual(grownAt(base.get(b)!, 3));
        expectStrictSettled(graph, out, new Map(), `foci ${a}+${b}`);
      }
    }
  });

  for (const [name, make] of [
    ['2-level nesting + ungrouped nodes', nestedPlus],
    ['wide container + small + ungrouped', wideShape],
  ] as const) {
    it(`reviewer shape — ${name}: a single focus with no pins stays strictly clean for every leaf`, async () => {
      const nodes = make();
      const graph = layoutGraphOf(nodes, DEFAULT_WIRING);
      const base = await elkBase(nodes);
      const shift = defaultMaxShift(GEO.pushHops, GEO.node);
      for (const focus of leafIds(graph)) {
        const spatial = computeSpatialTiers(nodes, { focusIds: new Set([focus]), pendingIds: new Set() });
        const out = spaceTargets({
          base, lockedSizes: new Map(), sizes: tierSizes(spatial, GEO), pins: new Map(),
          baseSize: GEO.node, margin: GEO.focusMargin, hops: GEO.pushHops,
          anchors: new Set([focus]), parentOf: graph.parentOf,
        });
        // The focus never moves off its allocated box and never exceeds the full tier size.
        const f = out.get(focus)!;
        expect(covers(f, { ...base.get(focus)!, w: GEO.node.w, h: GEO.node.h }), `${name}/${focus} abandoned its box`).toBe(true);
        expect(f.w).toBeLessThanOrEqual(GEO.node.w * 1.6 + 1e-6);
        expect(f.h).toBeLessThanOrEqual(GEO.node.h * 1.6 + 1e-6);
        // Locality: nothing moved beyond the cap.
        for (const id of leafIds(graph)) {
          if (id === focus) continue;
          const d = out.get(id)!;
          const b0 = base.get(id)!;
          expect(Math.abs(d.x + d.w / 2 - (b0.x + GEO.node.w / 2)), `${name}/${focus}: ${id} beyond x cap`).toBeLessThanOrEqual(shift.x + GEO.node.w);
          expect(Math.abs(d.y + d.h / 2 - (b0.y + GEO.node.h / 2)), `${name}/${focus}: ${id} beyond y cap`).toBeLessThanOrEqual(shift.y + GEO.node.h);
        }
        expectStrictSettled(graph, out, new Map(), `${name}, focus ${focus}`);
      }
    });
  }

  it('mixed locked sizes: a transition baked one focus, then a DIFFERENT anchor grows — strictly clean for every leaf', async () => {
    // Flat grid of short chains (the reviewer's flatgrid path): a transition
    // with p0 selected locks mixed sizes (1.6/1.25/1) into the layout, then
    // the person selects each other node in turn — the old focus shrinks in
    // place, the new one grows, all amid non-uniform allocated boxes.
    const nodes: NodeProjection[] = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(node(`p${String(i).padStart(2, '0')}`, i % 4 === 0 ? [] : [{ type: 'dependency', target: `p${String(i - 1).padStart(2, '0')}` }]));
    }
    const graph = layoutGraphOf(nodes, DEFAULT_WIRING);
    const first = { focusIds: new Set(['p00']), pendingIds: new Set<string>() };
    const locked = tierSizes(computeSpatialTiers(nodes, first), GEO);
    const base = await inThreadElk().layout(sizedGraph(graph, locked));
    for (const focus of leafIds(graph)) {
      const person = { focusIds: new Set([focus]), pendingIds: new Set<string>() };
      const sizes = tierSizes(computeSpatialTiers(nodes, person), GEO);
      const out = spaceTargets({
        base, lockedSizes: locked, sizes, pins: new Map(),
        baseSize: GEO.node, margin: GEO.focusMargin, hops: GEO.pushHops,
        anchors: new Set([focus]), parentOf: graph.parentOf,
      });
      expectStrictSettled(graph, out, new Map(), `mixed-lock focus ${focus}`);
      const f = out.get(focus)!;
      expect(f.w).toBeLessThanOrEqual(GEO.node.w * 1.6 + 1e-6);
      expect(f.w).toBeGreaterThanOrEqual(GEO.node.w - 1e-6);
    }
  });

  it('multi-shape fuzz: multi-focus + foreign pins — strict audit everywhere', async () => {
    const shapes: [string, NodeProjection[]][] = [
      ['chains3x4', chains(3, 4)],
      ['chains2x6', chains(2, 6)],
      ['nestedPlus', nestedPlus()],
      ['wide', wideShape()],
    ];
    let seed = 20261006;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32);
    const containerOf = (id: string, parentOf: ReadonlyMap<string, string>) => {
      let top = id;
      for (let p = parentOf.get(top); p !== undefined; p = parentOf.get(top)) top = p;
      return top;
    };
    for (const [name, nodes] of shapes) {
      const graph = layoutGraphOf(nodes, DEFAULT_WIRING);
      const base = await elkBase(nodes);
      const leaves = leafIds(graph);
      for (let run = 0; run < 12; run++) {
        const a0 = leaves[Math.floor(rnd() * leaves.length)]!;
        const a1 = rnd() < 0.5 ? leaves[Math.floor(rnd() * leaves.length)]! : null;
        const sources = new Set(a1 && a1 !== a0 ? [a0, a1] : [a0]);
        const person = { focusIds: new Set([a0]), pendingIds: new Set(a1 && a1 !== a0 ? [a1] : []) };
        const ripple = spatialNeighbors(nodes, person);
        const pins = new Map<string, { x: number; y: number }>();
        for (const id of leaves) {
          const foreign = [...sources].every((s) => containerOf(id, graph.parentOf) !== containerOf(s, graph.parentOf));
          if (!sources.has(id) && !ripple.has(id) && foreign && rnd() < 0.25) pins.set(id, base.get(id)!);
        }
        const spatial = computeSpatialTiers(nodes, person, ripple);
        const out = spaceTargets({
          base, lockedSizes: new Map(), sizes: tierSizes(spatial, GEO), pins,
          baseSize: GEO.node, margin: GEO.focusMargin, hops: GEO.pushHops,
          anchors: sources, parentOf: graph.parentOf,
        });
        const label = `${name} run ${run}`;
        for (const s of sources) {
          const f = out.get(s)!;
          expect(covers(f, { ...base.get(s)!, w: GEO.node.w, h: GEO.node.h }), `${label}: anchor ${s} moved`).toBe(true);
          expect(f.w).toBeLessThanOrEqual(GEO.node.w * 1.6 + 1e-6);
        }
        expectStrictSettled(graph, out, pins, label);
      }
    }
  });
});

/* ---- full relayout at a transition moment, with then-current tier sizes ---- */

const twoMissions = () => [
  mission('m1'), member('a1', 'm1'), member('a2', 'm1', [{ type: 'dependency', target: 'a1' }]),
  mission('m2'), member('b1', 'm2'), member('b2', 'm2', [{ type: 'dependency', target: 'b1' }]),
];

describe('transition relayout with tier sizes', () => {
  it('no transition → no geometry: an unchanged signature leaves the positions signal untouched', async () => {
    const s = createLayoutState({ loadProvider: async () => inThreadElk() });
    const sizes = new Map(twoMissions().map((n) => [n.id, { ...GENERIC_NODE_SIZE }]));
    s.update(sizedGraph(layoutGraphOf(twoMissions(), DEFAULT_WIRING), sizes));
    await s.settled();
    const before = s.positions();
    // The same topology and the same locked sizes again (a tier flickered, no moment opened).
    s.update(sizedGraph(layoutGraphOf(twoMissions(), DEFAULT_WIRING), sizes));
    await s.settled();
    expect(s.positions()).toBe(before);
  });

  it('a transition locks the then-current tier sizes: the grown component re-lays out overlap-free, the untouched one keeps its exact positions', async () => {
    const s = createLayoutState({ loadProvider: async () => inThreadElk() });
    const graph = layoutGraphOf(twoMissions(), DEFAULT_WIRING);
    const base = new Map<string, { w: number; h: number }>(twoMissions().map((n) => [n.id, { ...GENERIC_NODE_SIZE }]));
    s.update(sizedGraph(graph, base));
    await s.settled();
    const before = s.positions();
    const grownSizes = new Map(base);
    grownSizes.set('a1', sizeForTier(3, GEO.node, GEO.tierScale));
    grownSizes.set('a2', sizeForTier(2, GEO.node, GEO.tierScale));
    const grownGraph = sizedGraph(graph, grownSizes);
    s.update(grownGraph);
    await s.settled();
    expect(s.source()).toBe('layered');
    const after = s.positions();
    // The other component's size signature did not change: exact positions kept.
    for (const id of ['b1', 'b2']) expect(after.get(id)).toEqual(before.get(id));
    // Overlap-free with the ACTUAL (grown) sizes — leaves and group boxes.
    const size = new Map(grownGraph.nodes.map((n) => [n.id, n]));
    const rectOf = (id: string): Rect | undefined => {
      const p = after.get(id);
      const sz = size.get(id);
      return p && sz ? { x: p.x, y: p.y, w: sz.w, h: sz.h } : undefined;
    };
    const boxes = new Map(leafIds(grownGraph).map((id) => [id, rectOf(id)!]));
    expectOverlapFree(boxes);
    const groups = [...containerRects(grownGraph, rectOf).values()];
    expect(overlaps(groups[0]!, groups[1]!)).toBe(false);
  });

  it('the fallback honours per-node sizes too (overlap-free without the layered engine)', () => {
    const graph = layoutGraphOf(twoMissions(), DEFAULT_WIRING);
    const sizes = new Map([['a1', sizeForTier(3, GEO.node, GEO.tierScale)]]);
    const grownGraph = sizedGraph(graph, sizes);
    const pos = fallbackLayout(grownGraph);
    const size = new Map(grownGraph.nodes.map((n) => [n.id, n]));
    const boxes = new Map(leafIds(grownGraph).map((id) => [id, { x: pos.get(id)!.x, y: pos.get(id)!.y, w: size.get(id)!.w, h: size.get(id)!.h }]));
    expectOverlapFree(boxes);
  });
});

describe('the scene (and so every hit test) follows the on-screen rects', () => {
  it('buildScene takes interpolated geometry verbatim; nodes it does not cover keep the base path', () => {
    const nodes = [node('a'), node('b')];
    const mid = { x: 10, y: 20, w: 263.5, h: 101.2 }; // a mid-animation rect
    const scene = buildScene(nodes, DEFAULT_WIRING, new Map(), new Map(), new Map([['a', mid]]));
    expect(scene.layout.nodes.get('a')).toMatchObject(mid);
    expect(scene.layout.nodes.get('b')).toMatchObject({ w: GEO.node.w, h: GEO.node.h });
  });
});

describe('animation stepping (theme motion tokens; input stays live on the interpolated rects)', () => {
  const standard = cubicBezierEase(MOTION.easings.standard);

  it('interpolates current → target and reaches the target exactly at the token duration', () => {
    const dur = MOTION.durations.moderate02;
    const plan = planTransition(new Map([['a', r(0, 0, 100, 50)]]), new Map([['a', r(100, 40, 160, 80)]]), 1000, dur);
    expect(plan.duration).toBe(dur);
    expect(rectsAt(plan, 1000, standard).get('a')).toEqual(r(0, 0, 100, 50));
    const mid = rectsAt(plan, 1000 + dur / 2, standard).get('a')!;
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(100);
    expect(mid.w).toBeGreaterThan(100);
    expect(mid.w).toBeLessThan(160);
    expect(planSettled(plan, 1000 + dur - 1)).toBe(false);
    expect(rectsAt(plan, 1000 + dur, standard).get('a')).toEqual(r(100, 40, 160, 80));
    expect(planSettled(plan, 1000 + dur)).toBe(true);
  });

  it('a snapped id (active pin drag) takes its position at once; only its size eases', () => {
    const dur = MOTION.durations.moderate02;
    const plan = planTransition(
      new Map([['a', r(0, 0, 100, 50)]]),
      new Map([['a', r(300, 300, 160, 80)]]),
      0, dur, new Set(['a']),
    );
    const start = rectsAt(plan, 0, standard).get('a')!;
    expect(start.x).toBe(300);
    expect(start.y).toBe(300);
    expect(start.w).toBe(100); // size still eases
  });

  it('a node without a previous rect appears in place (the existing entrance grammar stays)', () => {
    const plan = planTransition(new Map(), new Map([['fresh', r(50, 60)]]), 0, MOTION.durations.slow01);
    expect(rectsAt(plan, 0).get('fresh')).toEqual(r(50, 60));
    expect(plan.duration).toBe(0); // nothing moves → settled at once
    expect(planSettled(plan, 0)).toBe(true);
  });

  it('easing comes from the theme token: endpoints exact, monotone in between; garbage degrades to linear', () => {
    expect(standard(0)).toBe(0);
    expect(standard(1)).toBe(1);
    let prev = 0;
    for (let t = 0.05; t < 1; t += 0.05) {
      const e = standard(t);
      expect(e).toBeGreaterThanOrEqual(prev);
      expect(e).toBeGreaterThan(0);
      expect(e).toBeLessThan(1 + 1e-9);
      prev = e;
    }
    const linear = cubicBezierEase('not-a-curve');
    expect(linear(0.3)).toBe(0.3);
  });
});
