/**
 * Relevance tiers (dynamic-view P2, docs/recharter/dynamic-view-design.md).
 * One pipeline: (received projection, config, explicit view inputs) → a tier
 * 0–3 per node → emphasis and per-node detail. Every input is an explicit
 * signal (selection, open surfaces, pending intents, received attention,
 * received-change recency, the lens verdict) — no dwell/frequency tracking,
 * no backend words. Tiers are a derived VIEW: they never hide a node, never
 * reorder anything, and never leave the browser.
 *
 *   3 focus      selected / open in a surface / carrying a pending intent
 *   2 nearby     1-hop received neighbour of focus · has attention ·
 *                recently changed in the received stream (decays) · lens match
 *   1 ordinary   everything else
 *   0 receded    what the lens dims (dim, never hidden — §11; hiding is an open decision)
 */
import { createSignal } from 'solid-js';
import type { NodeProjection } from '@gunnflow/contract';

export type Tier = 0 | 1 | 2 | 3;

/** Engine constants (design: weights are not config — opened only if needed). */
export const RELEVANCE = {
  /** How long a received change keeps a node in tier 2. */
  recentChangeMs: 60_000,
} as const;

/** The lens's verdict for a node, from the existing emphasis path. */
export type LensVerdict = 'match' | 'neutral' | 'dim';

export interface TierInputs {
  /** Selected node, open inspector/gate targets. */
  focusIds: ReadonlySet<string>;
  /** Nodes addressed by pending (in-flight or rejected) intents. */
  pendingIds: ReadonlySet<string>;
  lensVerdict: (id: string) => LensVerdict;
  /** Received-change log timestamps (ms), absent = never noted. */
  changedAt: (id: string) => number | undefined;
  now: number;
}

/** Pure: one tier per received node. The map always covers every node (nothing hides). */
export function computeTiers(nodes: readonly NodeProjection[], inputs: TierInputs): Map<string, Tier> {
  // Focus neighbourhood: 1 hop over received relations, either direction.
  const nearFocus = new Set<string>();
  if (inputs.focusIds.size > 0) {
    for (const n of nodes) {
      for (const r of n.relations) {
        if (inputs.focusIds.has(n.id)) nearFocus.add(r.target);
        if (inputs.focusIds.has(r.target)) nearFocus.add(n.id);
      }
    }
  }
  const out = new Map<string, Tier>();
  for (const n of nodes) {
    let tier: Tier;
    if (inputs.focusIds.has(n.id) || inputs.pendingIds.has(n.id)) {
      tier = 3;
    } else if (inputs.lensVerdict(n.id) === 'dim') {
      tier = 0;
    } else {
      const changed = inputs.changedAt(n.id);
      const recent = changed !== undefined && inputs.now - changed < RELEVANCE.recentChangeMs;
      tier =
        nearFocus.has(n.id) || n.attention.length > 0 || recent || inputs.lensVerdict(n.id) === 'match'
          ? 2
          : 1;
    }
    out.set(n.id, tier);
  }
  return out;
}

/** Tier → mirror emphasis ("why does this node look like this" in one sentence). */
export function tierEmphasis(tier: Tier): 'highlight' | 'normal' | 'dim' {
  return tier === 0 ? 'dim' : tier >= 2 ? 'highlight' : 'normal';
}

/**
 * Per-node detail step (①): a tier nudges the node's semantic zoom one step —
 * tier ≥ 2 always shows detail, tier 0 never does, tier 1 follows the camera.
 * Pure presentation: geometry does not change here (sizes are P3).
 */
export function detailOn(tier: Tier, zoom: number, detailZoom: number): boolean {
  if (tier >= 2) return true;
  if (tier === 0) return false;
  return zoom >= detailZoom;
}

/**
 * Spatial tiers (dynamic-view P3 ruling, 2026-10-05): between transition
 * moments only PERSON-caused signals may move geometry — selection, open
 * surfaces, pending intents, and their 1-hop received neighbourhood. The
 * received-fact causes (attention, recency, lens match) keep driving emphasis
 * and detail (computeTiers) but never size, until the next transition moment
 * bakes the full tiers into the layout. Pure, like computeTiers; the map
 * covers every node.
 */
export function spatialNeighbors(
  nodes: readonly NodeProjection[],
  person: Pick<TierInputs, 'focusIds' | 'pendingIds'>,
): Set<string> {
  const sources = new Set<string>([...person.focusIds, ...person.pendingIds]);
  const near = new Set<string>();
  if (sources.size > 0) {
    for (const n of nodes) {
      for (const r of n.relations) {
        if (sources.has(n.id)) near.add(r.target);
        if (sources.has(r.target)) near.add(n.id);
      }
    }
  }
  return near;
}

/**
 * `neighbors` is the 1-hop ripple SNAPSHOT (ruling, round 2): captured by
 * `spatialNeighbors` at the person-action moment (a focus/pending change) or
 * at a transition moment, then HELD — a backend adding a relation to the
 * focused node must not grow anything mid-flight. Omitting it derives the
 * ripple fresh (that IS the person-action capture).
 */
export function computeSpatialTiers(
  nodes: readonly NodeProjection[],
  person: Pick<TierInputs, 'focusIds' | 'pendingIds'>,
  neighbors: ReadonlySet<string> = spatialNeighbors(nodes, person),
): Map<string, Tier> {
  const sources = new Set<string>([...person.focusIds, ...person.pendingIds]);
  const out = new Map<string, Tier>();
  for (const n of nodes) out.set(n.id, sources.has(n.id) ? 3 : neighbors.has(n.id) ? 2 : 1);
  return out;
}

/**
 * Per-node box size (③, dynamic-view P3): a tier scales the node's base box so
 * a focused node has room for its detail. Size is a LAYOUT INPUT — the factors
 * are theme geometry data (DEFAULT_THEME.geometry.tierScale), never literals in
 * canvas code — and geometry itself still only changes at transition moments
 * or through the local push-aside (canvas/space.ts).
 */
export function sizeForTier(
  tier: Tier,
  base: { w: number; h: number },
  scale: readonly number[],
): { w: number; h: number } {
  const f = scale[tier] ?? 1;
  return { w: base.w * f, h: base.h * f };
}

/**
 * Received-change log: which nodes changed between snapshots, by comparing the
 * received bytes per node (a diff of received history — charter-permitted view
 * input). Local-only; entries decay out of tier 2 by RELEVANCE.recentChangeMs.
 */
export function createChangeLog() {
  let signatures = new Map<string, string>();
  const changedAt = new Map<string, number>();
  let primed = false;
  // A coarse tick so decaying entries leave tier 2 without a new snapshot.
  const [tick, setTick] = createSignal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleDecay = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      setTick((t) => t + 1);
      if (changedAt.size > 0) scheduleDecay();
    }, RELEVANCE.recentChangeMs / 4);
  };
  return {
    tick,
    /** Called with each received snapshot; the FIRST snapshot is the baseline, not a change. */
    note(nodes: readonly NodeProjection[], now = Date.now()) {
      const next = new Map<string, string>();
      for (const n of nodes) next.set(n.id, JSON.stringify(n));
      if (primed) {
        for (const [id, sig] of next) {
          if (signatures.get(id) !== sig) changedAt.set(id, now);
        }
        for (const id of [...changedAt.keys()]) {
          if (!next.has(id) || now - changedAt.get(id)! >= RELEVANCE.recentChangeMs) changedAt.delete(id);
        }
      }
      signatures = next;
      primed = true;
      if (changedAt.size > 0) scheduleDecay();
    },
    changedAt(id: string): number | undefined {
      return changedAt.get(id);
    },
  };
}

export type ChangeLog = ReturnType<typeof createChangeLog>;
