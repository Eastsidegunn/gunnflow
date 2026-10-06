// Dynamic-view P2: relevance tiers are a pure derivation of received facts
// and explicit view inputs — one tier per node, nothing hidden, no implicit
// history, tiers never touch order (there is no order output here at all).
import { describe, expect, it } from 'vitest';
import type { NodeProjection } from '@gunnflow/contract';
import { RELEVANCE, computeTiers, createChangeLog, detailOn, tierEmphasis, type TierInputs } from '../src/state/relevance.js';

const node = (id: string, over: Partial<NodeProjection> = {}): NodeProjection => ({
  id,
  kind: 'thing',
  state: { value: 'plain' },
  relations: [],
  capabilities: [],
  attention: [],
  artifacts: [],
  ...over,
});

const inputs = (over: Partial<TierInputs> = {}): TierInputs => ({
  focusIds: new Set(),
  pendingIds: new Set(),
  lensVerdict: () => 'neutral',
  changedAt: () => undefined,
  now: 1_000_000,
  ...over,
});

describe('computeTiers', () => {
  const NODES = [
    node('focus'),
    node('neighbour-out', { relations: [{ type: 'any-word', target: 'focus' }] }),
    node('plain'),
    node('attn', { attention: [{ cause: 'whatever' }] }),
  ];

  it('focus and pending are tier 3; 1-hop received neighbours are tier 2 (either direction)', () => {
    const focus = node('focus', { relations: [{ type: 'x', target: 'neighbour-in' }] });
    const t = computeTiers([focus, node('neighbour-in'), ...NODES.slice(1)], inputs({ focusIds: new Set(['focus']) }));
    expect(t.get('focus')).toBe(3);
    expect(t.get('neighbour-in')).toBe(2);
    expect(t.get('neighbour-out')).toBe(2);
    expect(t.get('plain')).toBe(1);
    const p = computeTiers(NODES, inputs({ pendingIds: new Set(['plain']) }));
    expect(p.get('plain')).toBe(3);
  });

  it('attention, lens match and a recent received change are tier 2; the rest tier 1', () => {
    const t = computeTiers(NODES, inputs({
      lensVerdict: (id) => (id === 'plain' ? 'match' : 'neutral'),
      changedAt: (id) => (id === 'neighbour-out' ? 1_000_000 - RELEVANCE.recentChangeMs + 1 : undefined),
    }));
    expect(t.get('attn')).toBe(2);
    expect(t.get('plain')).toBe(2);
    expect(t.get('neighbour-out')).toBe(2); // recent change, still inside the window
    expect(t.get('focus')).toBe(1);
    const decayed = computeTiers(NODES, inputs({ changedAt: () => 1_000_000 - RELEVANCE.recentChangeMs }));
    expect(decayed.get('neighbour-out')).toBe(1); // the window closed
  });

  it('the lens dim verdict recedes to tier 0 — dim, never hidden: every node keeps a tier', () => {
    const t = computeTiers(NODES, inputs({ lensVerdict: (id) => (id === 'plain' ? 'dim' : 'neutral') }));
    expect(t.get('plain')).toBe(0);
    expect(t.size).toBe(NODES.length);
  });

  it('focus and pending outrank a dim verdict; dim outranks nearby signals', () => {
    const t = computeTiers(NODES, inputs({ focusIds: new Set(['focus']), lensVerdict: () => 'dim' }));
    expect(t.get('focus')).toBe(3);
    expect(t.get('attn')).toBe(0); // the lens receded it even though it carries attention (its badge still draws)
  });
});

describe('detail step and mirror emphasis', () => {
  it('tier ≥ 2 always shows detail, tier 0 never, tier 1 follows the camera', () => {
    expect(detailOn(2, 0.1, 0.5)).toBe(true);
    expect(detailOn(3, 0.1, 0.5)).toBe(true);
    expect(detailOn(0, 2, 0.5)).toBe(false);
    expect(detailOn(1, 0.4, 0.5)).toBe(false);
    expect(detailOn(1, 0.6, 0.5)).toBe(true);
  });
  it('tier → emphasis is one sentence: 0 dim, ≥2 highlight, 1 normal', () => {
    expect(tierEmphasis(0)).toBe('dim');
    expect(tierEmphasis(1)).toBe('normal');
    expect(tierEmphasis(2)).toBe('highlight');
    expect(tierEmphasis(3)).toBe('highlight');
  });
});

describe('received-change log', () => {
  it('the first snapshot is the baseline; a changed node is noted and decays out', () => {
    const log = createChangeLog();
    const t0 = 1_000_000;
    log.note([node('a'), node('b')], t0);
    expect(log.changedAt('a')).toBeUndefined(); // baseline, not a change
    log.note([node('a', { state: { value: 'moved' } }), node('b')], t0 + 10);
    expect(log.changedAt('a')).toBe(t0 + 10);
    expect(log.changedAt('b')).toBeUndefined();
    // Past the window the entry is pruned on the next snapshot.
    log.note([node('a', { state: { value: 'moved' } }), node('b')], t0 + 10 + RELEVANCE.recentChangeMs);
    expect(log.changedAt('a')).toBeUndefined();
  });
});
