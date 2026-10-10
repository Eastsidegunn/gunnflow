// GF-P1b B: a dropped node (or a dragged container's members) settles at the
// nearest place that overlaps no other node and no container it does not
// belong to. Opaque ids: the resolver reads geometry and containment only.
import { describe, expect, it } from 'vitest';
import { resolveDrop as resolveRaw, type DropInput } from '../src/canvas/dropResolve.js';
import type { Rect } from '../src/canvas/layoutGraph.js';

const W = 200;
const H = 80;
const GAP = 16;
const PAD = 20;
const HEADER = 30;
const box = (x: number, y: number, w = W, h = H): Rect => ({ x, y, w, h });
const near = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
function wrapOf(rects: Rect[]): Rect {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  return { x: minX - PAD, y: minY - PAD - HEADER, w: maxX - minX + 2 * PAD, h: maxY - minY + 2 * PAD + HEADER };
}

function input(rects: Record<string, Rect>, moved: string[], origin: Record<string, Rect>, parentOf: Record<string, string> = {}): DropInput {
  return {
    parentOf: new Map(Object.entries(parentOf)),
    rects: new Map(Object.entries(rects)),
    moved: new Set(moved),
    origin: new Map(Object.entries(origin)),
    gap: GAP,
    groupPad: PAD,
    groupHeader: HEADER,
  };
}
const apply = (r: Rect, d: { dx: number; dy: number }) => ({ ...r, x: r.x + d.dx, y: r.y + d.dy });
/** The resolver's offset; fails the test when it fell back to the origin instead. */
function resolveDrop(i: DropInput): { dx: number; dy: number } {
  const r = resolveRaw(i);
  if (r.kind !== 'offset') throw new Error('expected an offset, got a return to the origin');
  return { dx: r.dx, dy: r.dy };
}

describe('drop resolution', () => {
  it('a drop in free space stays exactly where it was put', () => {
    const d = resolveDrop(input({ a: box(0, 0), b: box(600, 0) }, ['a'], { a: box(-300, 0) }));
    expect(d).toEqual({ dx: 0, dy: 0 });
  });

  it('a drop onto another node moves the least: no overlap and the gap kept', () => {
    const rects = { a: box(150, 20), b: box(0, 0) };
    const d = resolveDrop(input(rects, ['a'], { a: box(900, 0) }));
    const placed = apply(rects.a, d);
    expect(near(placed, rects.b, GAP - 1e-9)).toBe(false);
    // The nearest side: a was mostly right of b, so it slides right to b's edge + gap, not around.
    expect(d).toEqual({ dx: W + GAP - 150, dy: 0 });
  });

  it('a node never settles inside a container it does not belong to', () => {
    // Container K holds k1, k2; node a (no container) is dropped in K's empty middle.
    const k1 = box(0, 0);
    const k2 = box(600, 0);
    const rects = { k1, k2, a: box(300, 0) };
    const parentOf = { k1: 'K', k2: 'K' };
    const d = resolveDrop(input(rects, ['a'], { a: box(300, 500) }, parentOf));
    const placed = apply(rects.a, d);
    expect(near(placed, wrapOf([k1, k2]), GAP - 1e-9)).toBe(false);
    expect(near(placed, k1, GAP)).toBe(false);
  });

  it('a member moved inside its own container may grow it, but the grown box overlaps no neighbour container', () => {
    // K = {k1, k2}, L = {l1} to the right of K. k2 dragged right, toward L.
    const k1 = box(0, 0);
    const k2 = box(700, 0);
    const l1 = box(900, 0);
    const parentOf = { k1: 'K', k2: 'K', l1: 'L' };
    const rects = { k1, k2, l1 };
    const d = resolveDrop(input(rects, ['k2'], { k2: box(250, 0) }, parentOf));
    const placedK = wrapOf([k1, apply(k2, d)]);
    expect(near(placedK, wrapOf([l1]), GAP - 1e-9)).toBe(false);
  });

  it('a crowded drop finds the nearest free place, never farther than its origin', () => {
    const ring: Record<string, Rect> = {};
    let n = 0;
    for (let x = -3; x <= 3; x++) for (let y = -3; y <= 3; y++) if (x !== 0 || y !== 0) ring[`r${n++}`] = box(x * (W + 4), y * (H + 4));
    const rects = { ...ring, a: box(10, 10) };
    const d = resolveDrop(input(rects, ['a'], { a: box(3000, 3000) }));
    const placed = apply(rects.a, d);
    for (const r of Object.values(ring)) expect(near(placed, r, GAP - 1e-9)).toBe(false);
    expect(Math.hypot(d.dx, d.dy)).toBeLessThan(Math.hypot(3000 - 10, 3000 - 10));
  });

  it('a drop onto a long wall of nodes settles just above or below it', () => {
    // 200-wide nodes every 216 units from x=-2160 to 2160: no gap-clear slot inside the row.
    const rects: Record<string, Rect> = {};
    for (let k = -10; k <= 10; k++) rects[`w${k}`] = box(k * 216, 0);
    // Dropped squarely on the middle node of the wall.
    rects.a = box(0, 0);
    // Origin far right on the same row; the nearest clear place is just past either end of the wall, or above/below.
    const d = resolveDrop(input(rects, ['a'], { a: box(3000, 0) }));
    const placed = apply(rects.a, d);
    for (const [id, r] of Object.entries(rects)) if (id !== 'a') expect(near(placed, r, GAP - 1e-9)).toBe(false);
    // Above or below the row is nearest (H + GAP), far nearer than the origin.
    expect(Math.abs(d.dy)).toBe(H + GAP);
    expect(d.dx).toBe(0);
  });

  it('when nothing fits nearer than the start, every moved node returns to its own starting rect', () => {
    // A tight row; the node started overlapping its neighbour already (a pre-existing overlap) and is dropped a little off.
    const rects: Record<string, Rect> = { l: box(-204, 0), r: box(204, 0), a: box(3, 2) };
    const r = resolveRaw(input(rects, ['a'], { a: box(0, 0) }));
    expect(r).toEqual({ kind: 'origin' });
  });

  it('a container overlap that existed before the drag does not block the drop', () => {
    // The boxes of K and L already touch (nodes 40 apart, boxes padded 20 each); moving k1 a little inside K is fine.
    const k1 = box(0, 0);
    const l1 = box(240, 0);
    const parentOf = { k1: 'K', l1: 'L' };
    const rects = { k1: box(0, 4), l1 };
    const d = resolveDrop(input(rects, ['k1'], { k1 }, parentOf));
    expect(d).toEqual({ dx: 0, dy: 0 });
  });

  it("a dragged container's members move as one rigid set and clear the other container", () => {
    const k1 = box(0, 0);
    const k2 = box(0, 120);
    const l1 = box(100, 60);
    const parentOf = { k1: 'K', k2: 'K', l1: 'L' };
    const rects = { k1, k2, l1 };
    const d = resolveDrop(input(rects, ['k1', 'k2'], { k1: box(-1000, 0), k2: box(-1000, 120) }, parentOf));
    const pk1 = apply(k1, d);
    const pk2 = apply(k2, d);
    // Rigid: the members keep their relative placement.
    expect(pk2.y - pk1.y).toBe(120);
    expect(near(wrapOf([pk1, pk2]), wrapOf([l1]), GAP - 1e-9)).toBe(false);
  });

  it('moved sibling containers that already overlapped do not block their parent from moving', () => {
    // P = {A = {a1}, B = {b1}}; A and B boxes touch (40 apart), P is dragged as a whole.
    const a1 = box(0, 0);
    const b1 = box(240, 0);
    const parentOf = { a1: 'A', b1: 'B', A: 'P', B: 'P' };
    const d = resolveDrop(input({ a1: box(10, 300), b1: box(250, 300) }, ['a1', 'b1'], { a1, b1 }, parentOf));
    expect(d).toEqual({ dx: 0, dy: 0 });
  });

  it('500 irregular nodes (every edge distinct): a crowded drop still resolves quickly', () => {
    const rects: Record<string, Rect> = {};
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 500; i++) rects[`n${i}`] = box(Math.floor(rnd() * 6000), Math.floor(rnd() * 4000), 120 + Math.floor(rnd() * 160), 60 + Math.floor(rnd() * 60));
    const origin = box(-2000, -2000);
    rects.drop = box(3000, 2000);
    const t0 = performance.now();
    const r = resolveRaw(input(rects, ['drop'], { drop: origin }));
    const ms = performance.now() - t0;
    if (r.kind === 'offset') {
      const placed = apply(rects.drop, r);
      for (const [id, q] of Object.entries(rects)) if (id !== 'drop') expect(near(placed, q, GAP - 1e-9)).toBe(false);
    }
    expect(ms).toBeLessThan(500);
  });

  it('a fit past the first search bands is found (a wide block of nodes, origin far away)', () => {
    // A 3000 × 1200 block packed tight; the drop lands in its middle, the origin is far right.
    const rects: Record<string, Rect> = {};
    for (let x = 0; x < 15; x++) for (let y = 0; y < 15; y++) rects[`b${x}-${y}`] = box(x * (W + 4), y * (H + 4));
    const mid = box(7 * (W + 4) + 10, 7 * (H + 4) + 10);
    rects.a = mid;
    const d = resolveDrop(input(rects, ['a'], { a: box(20_000, 7 * (H + 4)) }));
    const placed = apply(mid, d);
    for (const [id, r] of Object.entries(rects)) if (id !== 'a') expect(near(placed, r, GAP - 1e-9)).toBe(false);
    // Out of the block by its nearest side (vertical: 7 rows of 84 + gap), far short of the origin.
    expect(Math.hypot(d.dx, d.dy)).toBeGreaterThan(256);
    expect(Math.hypot(d.dx, d.dy)).toBeLessThan(1200);
  });

  it('without an origin, a drop that fits nowhere is reported unresolved, never as a fit', () => {
    // m overlaps its sibling s inside C; four walls sit exactly a gap from C, so clearing s would grow C into a wall.
    const rects = {
      m: box(25, 25, 10, 10),
      s: box(0, 0, 100, 100),
      left: box(-1000, -1000, 964, 2100),
      right: box(136, -1000, 1000, 2100),
      top: box(-1000, -1000, 2100, 934),
      bottom: box(-1000, 136, 2100, 1000),
    };
    expect(resolveRaw(input(rects, ['m'], {}, { m: 'C', s: 'C' }))).toEqual({ kind: 'unresolved' });
  });

  it('without an origin a huge mover still ends overlap-free', () => {
    const r = resolveRaw(input({ o: box(0, 0, 10, 10), a: box(-500_000, -500_000, 1_000_000, 1_000_000) }, ['a'], {}));
    expect(r.kind).toBe('offset');
    if (r.kind === 'offset') expect(near(apply(box(-500_000, -500_000, 1_000_000, 1_000_000), r), box(0, 0, 10, 10), GAP - 1e-9)).toBe(false);
  });

  it('500 densely packed nodes with distinct edges: a drop in the middle resolves within budget', () => {
    const rects: Record<string, Rect> = {};
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // Small nodes with jittered edges crowded into 1200 × 800: every edge offset is distinct.
    for (let i = 0; i < 500; i++) rects[`n${i}`] = box(rnd() * 1200, rnd() * 800, 20 + rnd() * 30, 12 + rnd() * 20);
    rects.drop = box(600, 400, 40, 24);
    const t0 = performance.now();
    const r = resolveRaw(input(rects, ['drop'], { drop: box(5000, 400, 40, 24) }));
    const ms = performance.now() - t0;
    if (r.kind === 'offset') {
      const placed = apply(rects.drop, r);
      for (const [id, q] of Object.entries(rects)) if (id !== 'drop') expect(near(placed, q, GAP - 1e-9)).toBe(false);
    }
    expect(ms).toBeLessThan(300);
  });

  it('500 nodes: a crowded drop resolves quickly', () => {
    const rects: Record<string, Rect> = {};
    const parentOf: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      const col = i % 25;
      const row = Math.floor(i / 25);
      rects[`n${i}`] = box(col * (W + 40), row * (H + 30));
      parentOf[`n${i}`] = `C${Math.floor(col / 5)}`;
    }
    const origin = { ...rects }.n0!;
    rects.n0 = box(5 * (W + 40) + 30, 3 * (H + 30) + 10);
    const t0 = performance.now();
    const d = resolveDrop(input(rects, ['n0'], { n0: origin }, parentOf));
    const ms = performance.now() - t0;
    const placed = apply(rects.n0, d);
    for (const [id, r] of Object.entries(rects)) if (id !== 'n0') expect(near(placed, r, GAP - 1e-9)).toBe(false);
    expect(ms).toBeLessThan(500);
  });
});
