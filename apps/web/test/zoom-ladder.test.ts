// GF-P1b C: zoom moves in close geometric steps with "fits on screen" anchors,
// so the person can come back to the same view. Pure view math.
import { describe, expect, it } from 'vitest';
import {
  anchorOut,
  fitZoomRelative,
  snapDown,
  baseSteps,
  fitZoom,
  ladderThreshold,
  ladderWith,
  stepZoom,
  wheelNotches,
  zoomAtPoint,
  NOTCH_PX,
  slots,
  wheelPixels,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_RATIO,
  type Slot,
} from '../src/canvas/zoomLadder.js';

describe('zoom ladder', () => {
  it('geometric steps ×1.2–1.25 apart, 12 to 16 of them, inside the zoom range, including 1', () => {
    const s = baseSteps();
    expect(s.length).toBeGreaterThanOrEqual(12);
    expect(s.length).toBeLessThanOrEqual(16);
    expect(ZOOM_RATIO).toBeGreaterThanOrEqual(1.2);
    expect(ZOOM_RATIO).toBeLessThanOrEqual(1.25);
    for (let i = 1; i < s.length; i++) expect(s[i]! / s[i - 1]!).toBeCloseTo(ZOOM_RATIO, 9);
    expect(s[0]!).toBeGreaterThanOrEqual(ZOOM_MIN);
    expect(s[s.length - 1]!).toBeLessThanOrEqual(ZOOM_MAX);
    expect(s.some((z) => Math.abs(z - 1) < 1e-12)).toBe(true);
  });

  it('an anchor takes the place of its nearest step (stepping lands on it); the step count stays', () => {
    const plain = baseSteps();
    const l = ladderWith([0.43]);
    expect(l.steps).toContain(0.43);
    expect(l.anchors).toEqual([0.43]);
    expect(l.steps.length).toBe(plain.length);
    // Ascending, no duplicates.
    for (let i = 1; i < l.steps.length; i++) expect(l.steps[i]!).toBeGreaterThan(l.steps[i - 1]!);
  });

  it('anchors outside the range are clamped; two anchors near one step both stay', () => {
    const l = ladderWith([0.01, 9, 0.5, 0.505]);
    expect(l.anchors).toEqual([ZOOM_MIN, 0.5, 0.505, ZOOM_MAX]);
    for (const a of l.anchors) expect(l.steps).toContain(a);
  });

  /** Applies notches in order from `z`, carrying the slot like the canvas does. */
  const walk = (l: ReturnType<typeof ladderWith>, z: number, dirs: readonly (1 | -1)[], slot: Slot | null = null) => {
    for (const d of dirs) ({ zoom: z, slot } = stepZoom(l, z, d, slot));
    return { zoom: z, slot };
  };

  it('a notch moves one step; the same number of notches back returns to the exact same zoom', () => {
    const l = ladderWith([]);
    const fwd = walk(l, 1, [1, 1, 1]);
    expect(fwd.zoom).toBeCloseTo(ZOOM_RATIO ** 3, 12);
    expect(walk(l, fwd.zoom, [-1, -1, -1], fwd.slot).zoom).toBe(1);
  });

  it('an anchor holds two slots: passing it costs one extra notch, in either direction', () => {
    const l = ladderWith([0.43]);
    expect(slots(l).filter((s) => s === 0.43)).toHaveLength(2);
    const below = l.steps[l.steps.indexOf(0.43) - 1]!;
    const above = l.steps[l.steps.indexOf(0.43) + 1]!;
    // Upward from below: arrive, held one notch, then on.
    expect(walk(l, below, [1]).zoom).toBe(0.43);
    expect(walk(l, below, [1, 1]).zoom).toBe(0.43);
    expect(walk(l, below, [1, 1, 1]).zoom).toBe(above);
    // Downward from above, the same.
    expect(walk(l, above, [-1, -1]).zoom).toBe(0.43);
    expect(walk(l, above, [-1, -1, -1]).zoom).toBe(below);
  });

  it('turning around on an anchor is exactly reversible (no absorbed notch on the way back)', () => {
    const l = ladderWith([0.43]);
    const above = l.steps[l.steps.indexOf(0.43) + 1]!;
    const there = walk(l, above, [-1]);
    expect(there.zoom).toBe(0.43);
    expect(walk(l, there.zoom, [1], there.slot).zoom).toBe(above);
  });

  it('any path of notches followed by its reverse returns to the start (anchored ladders, random walks)', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 200; t++) {
      const anchors = Array.from({ length: Math.floor(rnd() * 4) }, () => ZOOM_MIN + rnd() * (ZOOM_MAX - ZOOM_MIN));
      const l = ladderWith(anchors);
      const start = l.steps[Math.floor(rnd() * l.steps.length)]!;
      const dirs = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => (rnd() < 0.5 ? 1 : -1) as 1 | -1);
      // Walks where a ladder end absorbed a notch (the slot did not move) are skipped: no reverse can undo that.
      let z = start;
      let slot: Slot | null = null;
      let absorbedAtEnd = false;
      let startSlot: Slot | null = null;
      for (const d of dirs) {
        const before = slot;
        ({ zoom: z, slot } = stepZoom(l, z, d, slot));
        startSlot ??= { key: slot.key, index: slot.index - d };
        if (before && before.index === slot.index) absorbedAtEnd = true;
        if (!before && (slot.index === 0 || slot.index === slots(l).length - 1) && slots(l)[slot.index] === start) absorbedAtEnd = true;
      }
      if (absorbedAtEnd) continue;
      const fwd = { zoom: z, slot };
      const back = walk(l, fwd.zoom, dirs.map((d) => -d as 1 | -1).reverse(), fwd.slot);
      const what = `anchors ${anchors.map((a) => a.toFixed(3))} start ${start} path ${dirs}`;
      expect(back.zoom, what).toBe(start);
      // The hidden state too: the same slot as where the walk began (the next notch behaves the same).
      expect(back.slot!.index, what).toBe(startSlot!.index);
    }
  });

  it('a remembered slot from another ladder is not trusted: it is re-derived from the zoom', () => {
    const a = ladderWith([0.43]);
    const b = ladderWith([0.9]);
    const there = walk(a, 0.5, [-1]);
    expect(stepZoom(b, there.zoom, 1, there.slot).slot.key).not.toBe(there.slot!.key);
  });

  it('from a free zoom (off the ladder) a notch goes to the nearest step in its direction', () => {
    const l = ladderWith([]);
    const r = stepZoom(l, 1.1, 1, null);
    expect(r.zoom).toBeCloseTo(ZOOM_RATIO, 12);
    expect(stepZoom(l, 1.1, -1, null).zoom).toBe(1);
  });

  it('the ends of the ladder hold', () => {
    const l = ladderWith([]);
    const top = l.steps[l.steps.length - 1]!;
    expect(stepZoom(l, top, 1, null).zoom).toBe(top);
    expect(stepZoom(l, l.steps[0]!, -1, null).zoom).toBe(l.steps[0]!);
  });

  it('one anchor out: the largest anchor below the current zoom', () => {
    const l = ladderWith([0.3, 0.8, 1.6]);
    expect(anchorOut(l, 1.6)).toBe(0.8);
    expect(anchorOut(l, 1.0)).toBe(0.8);
    expect(anchorOut(l, 0.3)).toBeNull();
  });

  it('fit zoom fits the bounds with the margin, may zoom in past 1, and stays in range', () => {
    expect(fitZoom({ w: 904, h: 100 }, 1000, 800, 48)).toBeCloseTo(1, 9);
    expect(fitZoom({ w: 200, h: 100 }, 1000, 800, 48)).toBe(ZOOM_MAX);
    expect(fitZoom({ w: 100_000, h: 100 }, 1000, 800, 48)).toBe(ZOOM_MIN);
  });

  it('the detail threshold sits between two steps: stepping flips detail exactly once', () => {
    const l = ladderWith([0.43]);
    const t = ladderThreshold(l, 0.5);
    expect(l.steps).not.toContain(t);
    const flips = l.steps.reduce((n, s, i) => (i > 0 && s >= t !== l.steps[i - 1]! >= t ? n + 1 : n), 0);
    expect(flips).toBe(1);
  });

  it('zooming at a point keeps that world point under the same screen place', () => {
    const cam = { x: 100, y: 50, zoom: 1 };
    const p = { x: 300, y: -20 };
    const next = zoomAtPoint(cam, 2, p.x, p.y);
    // Screen offset of p from the view centre is (p - cam) × zoom before and after.
    expect((p.x - next.x) * next.zoom).toBeCloseTo((p.x - cam.x) * cam.zoom, 9);
    expect((p.y - next.y) * next.zoom).toBeCloseTo((p.y - cam.y) * cam.zoom, 9);
  });

  it('wheel notches: detents keep their count; small pixel deltas accumulate; a reversal drops the leftover', () => {
    expect(wheelNotches(0, -100, 0)).toEqual({ notches: 1, acc: 0 });
    expect(wheelNotches(40, 100, 0)).toEqual({ notches: -1, acc: 0 });
    // Coalesced: two mouse detents in one event.
    expect(wheelNotches(0, -200, 0)).toEqual({ notches: 2, acc: 0 });
    // Line mode: 3 lines per detent; page mode: one per page.
    expect(wheelNotches(0, -3, 1)).toEqual({ notches: 1, acc: 0 });
    expect(wheelNotches(0, 6, 1)).toEqual({ notches: -2, acc: 0 });
    expect(wheelNotches(0, -1, 1)).toEqual({ notches: 1, acc: 0 });
    expect(wheelNotches(0, 1, 2)).toEqual({ notches: -1, acc: 0 });
    expect(wheelPixels(3, 1)).toBe(99);
    let r = wheelNotches(0, -NOTCH_PX / 2, 0);
    expect(r.notches).toBe(0);
    r = wheelNotches(r.acc, -NOTCH_PX / 2, 0);
    expect(r.notches).toBe(1);
    expect(wheelNotches(-NOTCH_PX / 2, NOTCH_PX / 3, 0)).toEqual({ notches: 0, acc: NOTCH_PX / 3 });
    expect(wheelNotches(-0.5 * NOTCH_PX, -0.75 * NOTCH_PX, 0)).toEqual({ notches: 1, acc: -0.25 * NOTCH_PX });
  });

  it('framing snaps down onto the ladder (what was framed still fits); a relative margin fits inside it', () => {
    const l = ladderWith([0.43]);
    expect(snapDown(l, 0.5)).toBe(0.43);
    expect(snapDown(l, 1)).toBe(1);
    expect(snapDown(l, 1.1)).toBe(1);
    expect(snapDown(l, 0.01)).toBe(l.steps[0]);
    // 1000 × 800 view, 8 %: 840 × 672 usable.
    expect(fitZoomRelative({ w: 840, h: 100 }, 1000, 800, 0.08)).toBeCloseTo(1, 9);
    expect(fitZoomRelative({ w: 100, h: 672 }, 1000, 800, 0.08)).toBeCloseTo(1, 9);
  });
});
