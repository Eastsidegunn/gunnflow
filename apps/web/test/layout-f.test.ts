// WP-L review round: budgets, honest grouping, group endpoints and headers,
// collision-free signatures, per-component anchoring, interim placement,
// accurate source, result validation, worker lifecycle, framing restraint.
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { NodeProjection } from '@gunnflow/contract';
import { WIRING_SCHEMA_VERSION } from '@gunnflow/contract/wiring';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { loadWiringFiles } from '../src/wiring/loadWiring.js';
import {
  GENERIC_NODE_SIZE,
  LAYOUT,
  containerRects,
  fallbackLayout,
  interimLayout,
  layoutGraphOf,
  leafIds,
  topologySignature,
  type LayoutProvider,
  type Positions,
  type Rect,
} from '../src/canvas/layoutGraph.js';
import { elkProvider } from '../src/canvas/elkLayout.js';
import { buildScene, endpointBox } from '../src/canvas/genericScene.js';
import { drawGeneric } from '../src/canvas/draw.js';
import { ATTENTION_COLOR } from '../src/canvas/tokens.js';
import { createLayoutState } from '../src/state/layoutState.js';
import { createViewState } from '../src/state/viewState.js';

const elk = new ELK();
const inThreadElk = (): LayoutProvider => elkProvider((g) => elk.layout(g));
const n = (id: string, relations: NodeProjection['relations'] = [], over: Partial<NodeProjection> = {}): NodeProjection => ({
  id, kind: 'task', state: { value: 'running' }, relations, capabilities: [], attention: [], artifacts: [], ...over,
});
const mission = (id: string, over: Partial<NodeProjection> = {}) => n(id, [], { kind: 'mission', label: `Mission ${id}`, ...over });
const member = (id: string, m: string, extra: NodeProjection['relations'] = []) => n(id, [{ type: 'member-of', target: m }, ...extra]);
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rectOf = (p: { x: number; y: number }): Rect => ({ ...p, w: GENERIC_NODE_SIZE.w, h: GENERIC_NODE_SIZE.h });

/** Two missions, each with a small flow chain. */
const twoMissions = () => [
  mission('m1'), member('a1', 'm1'), member('a2', 'm1', [{ type: 'dependency', target: 'a1' }]),
  mission('m2'), member('b1', 'm2'), member('b2', 'm2', [{ type: 'dependency', target: 'b1' }]),
];

describe('F1 fallback budget', () => {
  it('a very deep containment chain completes without recursion and is capped at the nesting limit', () => {
    const chain = Array.from({ length: 5000 }, (_, i) => (i === 0 ? n('c0') : n(`c${i}`, [{ type: 'member-of', target: `c${i - 1}` }])));
    const t = performance.now();
    const g = layoutGraphOf(chain, DEFAULT_WIRING);
    const pos = fallbackLayout(g);
    expect(performance.now() - t).toBeLessThan(2000);
    let deepest = 0;
    for (const id of g.parentOf.keys()) {
      let d = 0;
      for (let p = g.parentOf.get(id); p !== undefined; p = g.parentOf.get(p)) d++;
      deepest = Math.max(deepest, d);
    }
    expect(deepest).toBeLessThanOrEqual(LAYOUT.maxNestDepth);
    expect(pos.size).toBe(leafIds(g).length);
  });

  it('a long flow chain is layered iteratively; over the budget the block grid is used', () => {
    const flowChain = Array.from({ length: 6000 }, (_, i) => n(`f${i}`, i === 0 ? [] : [{ type: 'dependency', target: `f${i - 1}` }]));
    expect(fallbackLayout(layoutGraphOf(flowChain, DEFAULT_WIRING)).size).toBe(6000);
    const huge = Array.from({ length: LAYOUT.fallbackBudget + 10 }, (_, i) => n(`h${i}`));
    const t = performance.now();
    const pos = fallbackLayout(layoutGraphOf(huge, DEFAULT_WIRING));
    expect(performance.now() - t).toBeLessThan(2000);
    expect(pos.size).toBe(huge.length);
  });
});

describe('F2 honest grouping', () => {
  const nodes = [
    mission('m1'), mission('m2'),
    member('solo', 'm1'),
    n('both', [{ type: 'member-of', target: 'm1' }, { type: 'member-of', target: 'm2' }]),
    n('x', [{ type: 'member-of', target: 'y' }]), n('y', [{ type: 'member-of', target: 'x' }]),
  ];

  it('a node with several containers, or on a containment cycle, is grouped nowhere', () => {
    const g = layoutGraphOf(nodes, DEFAULT_WIRING);
    expect(g.withheld).toEqual(['both', 'x', 'y']);
    expect(g.parentOf.has('both')).toBe(false);
    const scene = buildScene(nodes, DEFAULT_WIRING);
    expect(scene.groups.find((gr) => gr.id === 'm1')!.members).toEqual(['solo']);
    expect(scene.groups.some((gr) => gr.members.includes('both'))).toBe(false);
    expect(scene.withheld).toEqual(['both', 'x', 'y']);
  });

  it('the withheld containing relations stay visible as ordinary edges', () => {
    const scene = buildScene(nodes, DEFAULT_WIRING);
    const drawn = scene.edges.map((e) => `${e.from}>${e.to}:${e.type}`);
    expect(drawn).toEqual(expect.arrayContaining(['both>m1:member-of', 'both>m2:member-of', 'x>y:member-of', 'y>x:member-of']));
    expect(drawn).not.toContain('solo>m1:member-of');
  });

  it('the count reaches the layout state (debug summary)', () => {
    const s = createLayoutState({ loadProvider: () => Promise.reject(new Error('off')) });
    s.update(layoutGraphOf(nodes, DEFAULT_WIRING));
    expect(s.withheld()).toBe(3);
  });
});

describe('F3/F4 groups as endpoints and headers', () => {
  it('a non-contain edge ending at a group parent gets the group box as its endpoint', () => {
    const nodes = [mission('m1'), member('a', 'm1'), n('outside', [{ type: 'dependency', target: 'm1' }])];
    const scene = buildScene(nodes, DEFAULT_WIRING);
    expect(scene.edges.some((e) => e.from === 'outside' && e.to === 'm1')).toBe(true);
    const box = endpointBox(scene, 'm1')!;
    expect(box).toMatchObject({ id: 'm1', kind: 'mission' });
    expect(box).toEqual(expect.objectContaining(scene.groups.find((g) => g.id === 'm1')!));
    expect(endpointBox(scene, 'a')).toBe(scene.layout.nodes.get('a'));
  });

  function recorder() {
    const ops: Array<{ op: string; text?: string; fill?: string; stroke?: string; alpha?: number }> = [];
    const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', globalAlpha: 1 };
    const target: Record<string, unknown> = {
      measureText: (t: string) => ({ width: t.length * 7 }),
      fillText: (t: string) => ops.push({ op: 'text', text: t, fill: String(state.fillStyle), alpha: Number(state.globalAlpha) }),
      arc: () => ops.push({ op: 'arc', fill: String(state.fillStyle) }),
      stroke: () => ops.push({ op: 'stroke', stroke: String(state.strokeStyle), alpha: Number(state.globalAlpha) }),
    };
    const ctx = new Proxy(target, {
      get: (t, k) => (k in t ? t[k as string] : k in state ? state[k as string] : () => undefined),
      set: (_t, k, v) => ((state[k as string] = v), true),
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
  }
  const frame = { camera: { x: 0, y: 0, zoom: 1 }, selectedId: null, focusAlpha: null, rewireDrag: null, now: 0, pending: [] };

  it('the group header renders the parent\'s glyph in its tone, the interrupt border, and a clipped title', () => {
    const long = 'A very long mission title that cannot possibly fit inside the group header width';
    const nodes = [
      mission('m1', { label: long, state: { value: 'running' }, attention: [{ cause: 'waiting_for_human' }] }),
      member('a', 'm1'),
    ];
    const scene = buildScene(nodes, DEFAULT_WIRING);
    const { ctx, ops } = recorder();
    drawGeneric(ctx, 800, 600, { ...frame, emphasis: new Map(), scene });
    const glyph = ops.find((o) => o.op === 'text' && o.text === '▶');
    expect(glyph?.fill).toBe('#4da3ff');
    expect(ops.some((o) => o.op === 'stroke' && o.stroke === ATTENTION_COLOR)).toBe(true);
    expect(ops.some((o) => o.op === 'text' && o.text === '!')).toBe(true);
    const title = ops.find((o) => o.op === 'text' && o.text?.startsWith('A very long'))!;
    expect(title.text!.endsWith('…')).toBe(true);
    expect(title.text!.length).toBeLessThan(long.length);
  });

  it('ambient attention is a dot; lens emphasis dims the header like any node', () => {
    const nodes = [mission('m1', { attention: [{ cause: 'flagged' }] }), member('a', 'm1')];
    const scene = buildScene(nodes, DEFAULT_WIRING);
    const { ctx, ops } = recorder();
    drawGeneric(ctx, 800, 600, { ...frame, emphasis: new Map([['m1', 'dim']]), scene });
    expect(ops.some((o) => o.op === 'arc' && o.fill === ATTENTION_COLOR)).toBe(true);
    const header = ops.find((o) => o.op === 'text' && o.text?.startsWith('Mission m1'))!;
    expect(header.alpha).toBeLessThan(1);
  });
});

describe('F5 signature', () => {
  it('is length-preserving: ids containing separators never collide with split ids', () => {
    expect(topologySignature(['a\u0001b'], [], new Map())).not.toBe(topologySignature(['a', 'b'], [], new Map()));
    expect(topologySignature(['a'], [{ from: 'b\u0002c', to: 'd' }], new Map())).not.toBe(
      topologySignature(['a'], [{ from: 'b', to: 'c\u0002d' }], new Map()),
    );
    expect(topologySignature(['x'], [], new Map([['a', 'b']]))).not.toBe(topologySignature(['x'], [{ from: 'a', to: 'b' }], new Map()));
  });
});

describe('F6/F7 per-component stability and interim placement', () => {
  it('an unchanged component keeps its exact positions when another component changes', async () => {
    const s = createLayoutState({ loadProvider: async () => inThreadElk() });
    s.update(layoutGraphOf(twoMissions(), DEFAULT_WIRING));
    await s.settled();
    const before = s.positions();
    const grown = [...twoMissions(), member('a3', 'm1', [{ type: 'dependency', target: 'a2' }]), member('a4', 'm1')];
    s.update(layoutGraphOf(grown, DEFAULT_WIRING));
    await s.settled();
    expect(s.source()).toBe('layered');
    const after = s.positions();
    for (const id of ['b1', 'b2']) expect(after.get(id)).toEqual(before.get(id));
    // Nothing overlaps after stabilization.
    const g = layoutGraphOf(grown, DEFAULT_WIRING);
    const boxes = leafIds(g).map((id) => rectOf(after.get(id)!));
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(overlaps(a, b)).toBe(false);
    const groups = [...containerRects(g, (id) => (after.get(id) ? rectOf(after.get(id)!) : undefined)).values()];
    expect(overlaps(groups[0]!, groups[1]!)).toBe(false);
  });

  it('a new node\'s interim position avoids existing nodes and groups', () => {
    const prevGraph = layoutGraphOf(twoMissions(), DEFAULT_WIRING);
    const previous = fallbackLayout(prevGraph);
    const next = layoutGraphOf([...twoMissions(), n('lonely')], DEFAULT_WIRING);
    // A fallback that would drop the new node right on top of an existing one.
    const collide = new Map([...fallbackLayout(next), ['lonely', previous.get('a1')!]]) as Positions;
    const interim = interimLayout(next, collide, prevGraph, previous);
    for (const id of leafIds(prevGraph)) expect(interim.get(id)).toEqual(previous.get(id));
    const r = rectOf(interim.get('lonely')!);
    for (const id of leafIds(prevGraph)) expect(overlaps(r, rectOf(previous.get(id)!))).toBe(false);
    const groups = containerRects(prevGraph, (id) => (previous.get(id) ? rectOf(previous.get(id)!) : undefined));
    for (const g of groups.values()) expect(overlaps(r, g)).toBe(false);
  });
});

describe('F8–F10 source, validation, lifecycle', () => {
  it('source is interim while a pass is pending, layered after it, and fallback (with the reason) over the limit', async () => {
    const s = createLayoutState({ loadProvider: async () => inThreadElk(), maxNodes: 7 });
    s.update(layoutGraphOf(twoMissions(), DEFAULT_WIRING));
    expect(s.source()).toBe('interim');
    await s.settled();
    expect(s.source()).toBe('layered');
    expect(s.reason()).toBeNull();
    s.update(layoutGraphOf([...twoMissions(), n('p'), n('q')], DEFAULT_WIRING));
    expect(s.source()).toBe('fallback');
    expect(s.reason()).toMatch(/over the layered limit/);
  });

  it('an invalid layered result (missing leaf, non-finite coordinate) is refused for an explicit fallback', async () => {
    for (const broken of [
      (g: Parameters<LayoutProvider['layout']>[0]) => new Map(leafIds(g).slice(1).map((id) => [id, { x: 1, y: 1 }])),
      (g: Parameters<LayoutProvider['layout']>[0]) => new Map(leafIds(g).map((id) => [id, { x: NaN, y: 1 }])),
    ]) {
      const s = createLayoutState({ loadProvider: async () => ({ layout: async (g) => broken(g) }) });
      const g = layoutGraphOf(twoMissions(), DEFAULT_WIRING);
      s.update(g);
      await s.settled();
      expect(s.source()).toBe('fallback');
      expect(s.reason()).toMatch(/invalid layered result/);
      expect(s.positions()).toEqual(fallbackLayout(g));
    }
  });

  it('a failed engine load is not cached: the next topology change retries', async () => {
    let calls = 0;
    const s = createLayoutState({
      loadProvider: async () => {
        calls++;
        if (calls === 1) throw new Error('chunk failed');
        return inThreadElk();
      },
    });
    s.update(layoutGraphOf(twoMissions(), DEFAULT_WIRING));
    await s.settled();
    expect(s.source()).toBe('fallback');
    expect(s.reason()).toMatch(/layered engine unavailable: chunk failed/);
    s.update(layoutGraphOf([...twoMissions(), n('z')], DEFAULT_WIRING));
    await s.settled();
    expect(calls).toBe(2);
    expect(s.source()).toBe('layered');
  });

  it('latest first: while a pass runs, only the newest topology is laid out next', async () => {
    const seen: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = inThreadElk();
    const s = createLayoutState({
      loadProvider: async () => ({
        async layout(g, h) {
          seen.push(g.nodes.length);
          if (seen.length === 1) await gate;
          return inner.layout(g, h);
        },
      }),
    });
    s.update(layoutGraphOf(twoMissions(), DEFAULT_WIRING));
    await new Promise((r) => setTimeout(r, 5));
    for (const extra of [['z1'], ['z1', 'z2'], ['z1', 'z2', 'z3']]) {
      s.update(layoutGraphOf([...twoMissions(), ...extra.map((id) => n(id))], DEFAULT_WIRING));
    }
    release();
    await s.settled();
    expect(seen).toEqual([6, 9]);
    expect(s.source()).toBe('layered');
  });
});

describe('F11 framing restraint', () => {
  it('pan, zoom and drag mark the view as user-moved; automatic centering does not', () => {
    const v = createViewState();
    v.centerOn(10, 10);
    expect(v.userMoved()).toBe(false);
    v.zoomAt(1.2);
    expect(v.userMoved()).toBe(true);
    for (const act of [(w: typeof v) => w.panBy(1, 1), (w: typeof v) => w.moveNode('a', 1, 1)]) {
      const w = createViewState();
      act(w);
      expect(w.userMoved()).toBe(true);
    }
  });
});

describe('wiring integration', () => {
  it('a wiring file with an unknown arrange value is rejected on the loadWiring path', () => {
    const r = loadWiringFiles(
      [{ file: 'x.json', config: { version: WIRING_SCHEMA_VERSION, relations: { r: { style: 'solid', arrange: 'radial' } } } }],
      DEFAULT_WIRING,
      () => undefined,
    );
    expect(r.files.rejected.map((f) => f.file)).toEqual(['x.json']);
  });
});
