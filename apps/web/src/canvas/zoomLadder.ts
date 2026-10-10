/**
 * Zoom ladder (GF-P1b C) — the view's zoom moves in close geometric steps,
 * so the person can always come back to the same view. Pure view math: no
 * meaning is read, nothing is sent.
 *
 *   - steps: ×RATIO apart around 1.0, inside [ZOOM_MIN, ZOOM_MAX] (12–16 steps);
 *   - anchors: "fits on screen" zooms of the containment levels under the
 *     cursor (depth 0 = everything, 1 and 2 = the containers there). Each
 *     anchor takes the place of its nearest step, so stepping lands on it;
 *   - stickiness: passing an anchor costs one extra notch (it holds two slots);
 *   - free zoom (pinch, Alt+wheel) leaves the ladder; the next notch goes to
 *     the nearest step in its direction;
 *   - the detail threshold is moved to the midpoint between the two steps
 *     around it, so stepping flips detail exactly once and no step sits on it.
 */

/**
 * Chrome hook: dispatching this window event (detail `{ id }`) asks the canvas
 * to frame that node the way a canvas double-click does — the stage uses it
 * when a double-click that began on the canvas ends on the stage.
 */
export const FRAME_NODE_EVENT = 'gunnflow:frame-node';

export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 2.5;
export const ZOOM_RATIO = 1.22;

/** Two zooms closer than this (relative) are the same step. */
const SAME = 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) <= SAME * Math.max(a, b);

/** The plain geometric steps (no anchors), ascending. */
export function baseSteps(min = ZOOM_MIN, max = ZOOM_MAX, ratio = ZOOM_RATIO): number[] {
  const out: number[] = [];
  const lo = Math.ceil(Math.log(min) / Math.log(ratio) - SAME);
  const hi = Math.floor(Math.log(max) / Math.log(ratio) + SAME);
  for (let k = lo; k <= hi; k++) out.push(ratio ** k);
  return out;
}

export interface Ladder {
  /** Ascending zoom values. */
  steps: number[];
  /** The values among `steps` that are anchors. */
  anchors: number[];
}

/**
 * The ladder with anchors: each anchor (clamped to the range) replaces the
 * step nearest to it in log space; an anchor whose nearest step another
 * anchor already took is added beside it.
 */
export function ladderWith(anchors: readonly number[], min = ZOOM_MIN, max = ZOOM_MAX, ratio = ZOOM_RATIO): Ladder {
  const steps = baseSteps(min, max, ratio);
  const taken = new Set<number>();
  const extra: number[] = [];
  const kept: number[] = [];
  for (const raw of [...anchors].sort((a, b) => a - b)) {
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const a = Math.min(max, Math.max(min, raw));
    if (kept.some((k) => same(k, a))) continue;
    kept.push(a);
    let best = -1;
    let bestD = Infinity;
    steps.forEach((s, i) => {
      const d = Math.abs(Math.log(s) - Math.log(a));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && !taken.has(best)) {
      taken.add(best);
      steps[best] = a;
    } else extra.push(a);
  }
  const all = [...steps, ...extra].sort((x, y) => x - y);
  const uniq = all.filter((v, i) => i === 0 || !same(v, all[i - 1]!));
  return { steps: uniq, anchors: kept.filter((a) => uniq.some((s) => same(s, a))) };
}

/**
 * Stickiness by construction: on the slot list every anchor occupies TWO
 * adjacent slots (the same zoom), every notch moves exactly one slot. Passing
 * an anchor therefore costs one extra notch, and n notches back are always
 * the exact inverse of n notches forward (reversibility holds on any path).
 */
export function slots(l: Ladder): number[] {
  return l.steps.flatMap((s) => (l.anchors.some((a) => same(a, s)) ? [s, s] : [s]));
}

/** Identifies a ladder: a remembered slot is only valid on the ladder it was taken on. */
export function ladderKey(l: Ladder): string {
  return slots(l).map((s) => s.toPrecision(12)).join(',');
}

/** Where a zoom move stands: the slot index on the ladder `key`. */
export interface Slot {
  key: string;
  index: number;
}

/**
 * The zoom one notch away in `dir` (+1 = in). `slot` is where the last move
 * left off; when it does not describe `current` on this ladder (free zoom,
 * another ladder, an automatic fit), the slot is re-derived: on an anchor the
 * slot that makes this notch the absorbed one, between steps the slot just
 * behind `current` in the notch's direction.
 */
export function stepZoom(ladder: Ladder, current: number, dir: 1 | -1, slot: Slot | null): { zoom: number; slot: Slot } {
  const list = slots(ladder);
  const key = ladderKey(ladder);
  let i: number;
  if (slot && slot.key === key && slot.index >= 0 && slot.index < list.length && same(list[slot.index]!, current)) i = slot.index;
  else {
    const at = list.findIndex((s) => same(s, current));
    if (at >= 0) {
      // On a step or anchor: an anchor's two slots are at..at+1; the notch starts from the far one's twin.
      const twin = at + 1 < list.length && same(list[at + 1]!, current);
      i = twin ? (dir > 0 ? at : at + 1) : at;
    } else if (dir > 0) {
      i = list.reduce((k, s, idx) => (s < current ? idx : k), -1);
    } else {
      const above = list.findIndex((s) => s > current);
      i = above < 0 ? list.length : above;
    }
  }
  const j = Math.min(list.length - 1, Math.max(0, i + dir));
  const zoom = list[j]!;
  // Never a step against the notch's direction (a free zoom beyond the ladder's end stays).
  if ((dir > 0 && zoom < current && !same(zoom, current)) || (dir < 0 && zoom > current && !same(zoom, current))) {
    return { zoom: current, slot: { key, index: i } };
  }
  return { zoom, slot: { key, index: j } };
}

/**
 * A framing zoom snapped onto the ladder: the largest step at or below `zoom`
 * (so what was framed still fits), else the ladder's smallest step. Landing on
 * a step keeps every later notch reversible.
 */
export function snapDown(ladder: Ladder, zoom: number): number {
  const below = ladder.steps.filter((s) => s <= zoom || same(s, zoom));
  return below.length > 0 ? below[below.length - 1]! : ladder.steps[0]!;
}

/**
 * The zoom that fits `bounds` in a visible area with a relative margin on each
 * side (0.08 = 8 % of the width and of the height), clamped to the range.
 */
export function fitZoomRelative(bounds: { w: number; h: number }, viewW: number, viewH: number, margin: number, min = ZOOM_MIN, max = ZOOM_MAX): number {
  const z = Math.min((viewW * (1 - 2 * margin)) / Math.max(1, bounds.w), (viewH * (1 - 2 * margin)) / Math.max(1, bounds.h));
  return Math.min(max, Math.max(min, z));
}

/** The anchor one level out (the largest anchor below `current`); null when none. */
export function anchorOut(ladder: Ladder, current: number): number | null {
  const below = ladder.anchors.filter((a) => a < current && !same(a, current));
  return below.length > 0 ? below[below.length - 1]! : null;
}

/**
 * The zoom that fits `bounds` in the view with `margin` around it, clamped to
 * the range (unlike the initial fit, an anchor may zoom in past 1).
 */
export function fitZoom(bounds: { w: number; h: number }, viewW: number, viewH: number, margin = 48, min = ZOOM_MIN, max = ZOOM_MAX): number {
  const z = Math.min((viewW - margin * 2) / Math.max(1, bounds.w), (viewH - margin * 2) / Math.max(1, bounds.h));
  return Math.min(max, Math.max(min, z));
}

/**
 * The detail threshold as the ladder sees it: the geometric midpoint of the
 * two steps around `threshold` (unchanged outside the ladder).
 */
export function ladderThreshold(ladder: Ladder, threshold: number): number {
  const above = ladder.steps.findIndex((s) => s >= threshold);
  if (above <= 0) return threshold;
  return Math.sqrt(ladder.steps[above - 1]! * ladder.steps[above]!);
}

/** A camera zoomed to `zoom` with the world point (px, py) kept at the same screen place. */
export function zoomAtPoint(cam: { x: number; y: number; zoom: number }, zoom: number, px: number, py: number) {
  const k = cam.zoom / zoom;
  return { x: px - (px - cam.x) * k, y: py - (py - cam.y) * k, zoom };
}

/**
 * Wheel → notches. Line mode: one notch per 3 lines (one detent), at least
 * one; page mode: one per page. Pixel mode: an event of at least NOTCH_PX is
 * a mouse detent (≈100 px each, so coalesced events keep their count); smaller
 * deltas (trackpads) accumulate until NOTCH_PX. Returns the notches to apply
 * (signed, + = zoom in) and the remaining accumulator.
 */
export const NOTCH_PX = 60;
const DETENT_PX = 100;
export function wheelNotches(acc: number, deltaY: number, deltaMode: number): { notches: number; acc: number } {
  const sign = deltaY < 0 ? 1 : deltaY > 0 ? -1 : 0;
  if (deltaMode === 1) return { notches: sign * Math.max(1, Math.round(Math.abs(deltaY) / 3)), acc: 0 };
  if (deltaMode === 2) return { notches: sign * Math.max(1, Math.round(Math.abs(deltaY))), acc: 0 };
  if (Math.abs(deltaY) >= NOTCH_PX) return { notches: sign * Math.max(1, Math.round(Math.abs(deltaY) / DETENT_PX)), acc: 0 };
  // A direction change discards what was accumulated the other way.
  const next = Math.sign(acc) !== 0 && Math.sign(acc) !== Math.sign(deltaY) ? deltaY : acc + deltaY;
  const n = Math.trunc(next / NOTCH_PX);
  return { notches: n === 0 ? 0 : -n, acc: next - n * NOTCH_PX };
}

/** A wheel delta in pixels, whatever its mode (lines ≈ 33 px, pages ≈ 800 px). */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  return deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY;
}
