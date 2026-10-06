// Generic render path: config tokens → engine constants only, capabilities
// gate every part, unassembled actions fall back, empty config still shows
// everything undistorted, attention is an engine rule, dashes stay engine-only.
import { describe, expect, it } from 'vitest';
import type { Capability, NodeProjection } from '@gunnflow/contract';
import { WIRING_SCHEMA_VERSION, type WiringConfig } from '@gunnflow/contract/wiring';
import { gatesFixture, normalFixture, projectNodes } from '@gunnflow-testing/fake-contracts';
import { resolveParts } from '../src/canvas/parts.js';
import { buildScene, genericEmphasis } from '../src/canvas/genericScene.js';
import { drawGeneric } from '../src/canvas/draw.js';
import { CONFIG_EDGE_DASH, DEFAULT_EDGE_STROKE, EDGE_STROKE, NEUTRAL_GLYPH, NEUTRAL_TONE, PENDING_DASH } from '../src/canvas/tokens.js';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { EMPTY_WIRING } from '../src/wiring/loadWiring.js';
import type { InFlightEntry } from '../src/state/pendingIntents.js';

const node = (over: Partial<NodeProjection> = {}): NodeProjection => ({
  id: 'n1',
  kind: 'doc',
  state: { value: 'open' },
  relations: [],
  capabilities: [],
  attention: [],
  artifacts: [],
  ...over,
});

const config = (parts: NonNullable<WiringConfig['kinds']>[string]['parts']): WiringConfig => ({
  version: WIRING_SCHEMA_VERSION,
  kinds: { doc: { parts } },
});

/** A 2D context stand-in that records every style assignment, text and dash. */
function recordingContext() {
  const log = { styles: [] as string[], texts: [] as string[], dashes: [] as number[][] };
  const target: Record<string, unknown> = {
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: (t: string) => log.texts.push(t),
    setLineDash: (d: number[]) => log.dashes.push([...d]),
  };
  const ctx = new Proxy(target, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
    set: (t, k, v) => {
      if (k === 'fillStyle' || k === 'strokeStyle') log.styles.push(String(v));
      t[k as string] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

const frame = { camera: { x: 0, y: 0, zoom: 1 }, emphasis: new Map(), selectedId: null, focusAlpha: null, rewireDrag: null, now: 0 };

describe('parts are gated by capabilities (the assembly never widens authority)', () => {
  const parts = config([
    { id: 'reason', part: 'text', action: 'approve' },
    { id: 'choice', part: 'selector', action: 'approve' },
    { id: 'go', part: 'send', action: 'approve', requires: ['reason'] },
    { id: 'secret', part: 'send', action: 'secret.action', requires: [] },
  ]);

  it('an assembled send for an absent or hidden action does not appear', () => {
    expect(resolveParts(node(), parts).actions).toEqual([]);
    const hidden = node({ capabilities: [{ action: 'approve', level: 'hidden' }] });
    expect(resolveParts(hidden, parts).actions).toEqual([]);
  });

  it('inputs bind only to slots the capability declares; an unbindable precondition blocks the send', () => {
    const plain = node({ capabilities: [{ action: 'approve', level: 'enabled' }] });
    const [a] = resolveParts(plain, parts).actions;
    expect(a).toMatchObject({ kind: 'assembled', action: 'approve', inputs: [], blocked: expect.stringContaining('reason') });
    const withText: Capability = { action: 'approve', level: 'enabled', decision: { input: { required: true } } };
    expect(resolveParts(node({ capabilities: [withText] }), parts).actions[0]).toMatchObject({
      inputs: [{ partId: 'reason', part: 'text' }],
    });
    expect(resolveParts(node({ capabilities: [withText] }), parts).actions[0]).not.toHaveProperty('blocked');
  });

  it('a disabled action stays visible as disabled', () => {
    const disabled = node({ capabilities: [{ action: 'approve', level: 'disabled', decision: { input: { required: false } } }] });
    expect(resolveParts(disabled, parts).actions[0]).toMatchObject({ kind: 'assembled', level: 'disabled' });
  });

  it('uncovered enabled actions get a raw-label fallback, unusable when their decision needs UI', () => {
    const n = node({
      capabilities: [
        { action: 'archive', level: 'enabled' },
        { action: 'pick', level: 'enabled', decision: { options: ['a', 'b'] } },
        { action: 'ghost', level: 'hidden' },
      ],
    });
    const actions = resolveParts(n, EMPTY_WIRING).actions;
    expect(actions).toEqual([
      { kind: 'fallback', action: 'archive', level: 'enabled', usable: true, evidence: [] },
      { kind: 'fallback', action: 'pick', level: 'enabled', usable: false, reason: 'needs a choice among options', evidence: [] },
    ]);
  });

  it('evidence binds by artifact id from the capability; the viewer part index is display only', () => {
    const n = node({
      artifacts: [
        { id: 'first', mediaType: 'text/plain', access: { kind: 'snapshot' } },
        { id: 'proof', mediaType: 'text/plain', access: { kind: 'snapshot' } },
      ],
      capabilities: [{ action: 'approve', level: 'enabled', decision: { evidence: ['proof'] } }],
    });
    const r = resolveParts(n, config([{ id: 'v', part: 'viewer', source: { artifact: 0 } }, { id: 'go', part: 'send', action: 'approve', requires: [] }]));
    expect(r.display).toContainEqual({ partId: 'v', part: 'viewer', artifactId: 'first' });
    expect(r.actions[0]).toMatchObject({ action: 'approve', evidence: ['proof'] });
  });
});

describe('empty config shows everything undistorted', () => {
  it('unregistered kind/state/relation/cause: neutral glyph, raw text, default edge, ambient', () => {
    const nodes = [
      node({ id: 'a', relations: [{ type: 'unknown-rel', target: 'b' }], attention: [{ cause: 'unknown-cause' }] }),
      node({ id: 'b', kind: 'mystery', state: { value: 'weird-state' } }),
    ];
    const scene = buildScene(nodes, EMPTY_WIRING);
    const b = scene.nodes.get('b')!;
    expect(b).toMatchObject({ glyph: NEUTRAL_GLYPH, tone: NEUTRAL_TONE, state: 'weird-state', kind: 'mystery', labels: [] });
    expect(scene.edges).toEqual([{ from: 'a', to: 'b', type: 'unknown-rel', stroke: DEFAULT_EDGE_STROKE }]);
    expect(scene.nodes.get('a')!.attention).toEqual({ mechanism: 'ambient', causes: ['unknown-cause'] });
    const { ctx, log } = recordingContext();
    drawGeneric(ctx, 800, 600, { ...frame, pending: [], scene });
    expect(log.texts).toEqual(expect.arrayContaining(['a', 'b', 'mystery · weird-state']));
  });

  it('the simulator workspace renders with the default config and with an empty one', () => {
    for (const cfg of [DEFAULT_WIRING, EMPTY_WIRING]) {
      const nodes = projectNodes(gatesFixture());
      const scene = buildScene(nodes, cfg);
      // The workspace root belongs to the toolbar, not the canvas.
      const canvasNodes = nodes.filter((n) => n.kind !== 'workspace');
      expect(scene.nodes.size).toBe(canvasNodes.length);
      // Every canvas node is placed: as a node box, or (a `contain` parent) as a group box.
      expect(scene.layout.nodes.size + scene.groups.length).toBe(canvasNodes.length);
      expect(scene.groups.length > 0).toBe(cfg === DEFAULT_WIRING);
      expect(scene.nodes.get('t-draft')!.title).toBe('Draft');
      const { ctx } = recordingContext();
      expect(() => drawGeneric(ctx, 800, 600, { ...frame, pending: [], scene })).not.toThrow();
    }
    const scene = buildScene(projectNodes(gatesFixture()), DEFAULT_WIRING);
    expect(scene.nodes.get('g-review')!.attention?.mechanism).toBe('interrupt');
    expect(scene.nodes.get('t-draft')!.glyph).not.toBe(NEUTRAL_GLYPH);
  });
});

describe('the renderer never interprets config or received strings', () => {
  it('hostile strings stay text; styles come only from engine constants', () => {
    const hostile = ['<img src=x onerror=alert(1)>', '${alert(1)}', 'javascript:alert(1)', '__proto__', 'constructor'];
    const nodes = hostile.map((h, i) =>
      node({ id: `n${i}`, kind: h, state: { value: h }, attention: [{ cause: h }], relations: [{ type: h, target: 'n0' }] }),
    );
    const scene = buildScene(nodes, DEFAULT_WIRING);
    for (const [i, h] of hostile.entries()) {
      const s = scene.nodes.get(`n${i}`)!;
      expect(s.state).toBe(h);
      expect(s.glyph).toBe(NEUTRAL_GLYPH);
      expect(s.tone).toBe(NEUTRAL_TONE);
      expect(s.attention?.mechanism).toBe('ambient');
    }
    for (const e of scene.edges) expect(e.stroke).toBe(DEFAULT_EDGE_STROKE);
    const { ctx, log } = recordingContext();
    drawGeneric(ctx, 800, 600, { ...frame, pending: [], scene });
    // Drawn as plain text (clipped to the box), never parsed.
    expect(log.texts.some((t) => t.startsWith('<img src=x'))).toBe(true);
    expect(log.texts).toContain('${alert(1)} · ${alert(1)}');
    for (const style of log.styles) expect(style, style).toMatch(/^(#[0-9a-f]{6}|rgba\([\d.,\s]+\))$/);
  });
});

describe('dashes are engine-only', () => {
  it('no config edge style dashes; pending edges use the reserved pattern', () => {
    expect(CONFIG_EDGE_DASH).toEqual([]);
    expect(PENDING_DASH.length).toBeGreaterThan(0);
    for (const stroke of Object.values(EDGE_STROKE)) expect(Object.keys(stroke).sort()).toEqual(['color', 'double', 'width']);
    const nodes = projectNodes(normalFixture());
    const scene = buildScene(nodes, DEFAULT_WIRING);
    const pending = [
      { phase: 'in-flight', localId: 'l', idempotencyKey: 'k', sentAt: 0, intent: { nodeId: 't-draft', action: 'edge.rewire', decision: { option: 't-test' }, idempotencyKey: 'k' } },
    ] as unknown as InFlightEntry[];
    const { ctx, log } = recordingContext();
    drawGeneric(ctx, 800, 600, { ...frame, pending, scene });
    const configEdges = log.dashes.filter((d) => d.length === 0).length;
    expect(configEdges).toBeGreaterThanOrEqual(scene.edges.length);
    expect(log.dashes).toContainEqual([...PENDING_DASH]);
  });
});

describe('attention is an engine rule, independent of the assembly', () => {
  it('a kind without any assembly still shows attention, mapped by cause, and the lens keeps it', () => {
    const cfg: WiringConfig = {
      version: WIRING_SCHEMA_VERSION,
      attention: [{ match: { cause: 'urgent' }, mechanism: 'interrupt' }],
      lenses: [{ id: 'needs-you', label: 'Needs you', match: { attention: true } }],
    };
    const scene = buildScene([node({ id: 'a', attention: [{ cause: 'urgent' }] }), node({ id: 'b' })], cfg);
    expect(scene.nodes.get('a')!.attention).toEqual({ mechanism: 'interrupt', causes: ['urgent'] });
    const needsYou = genericEmphasis(scene, 'needs-you', cfg);
    expect(needsYou.get('a')).toBe('highlight');
    expect(needsYou.get('b')).toBe('dim');
    expect(genericEmphasis(scene, 'all', cfg).get('a')).toBe('highlight');
  });
});
