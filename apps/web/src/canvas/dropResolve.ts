/**
 * Drop resolution (GF-P1b B) — where a dragged node (or a dragged container's
 * members, as one rigid set) settles when the person lets go. Pure view
 * geometry: no meaning is read, nothing is sent.
 *
 * The canvas moves either one leaf or every leaf of one container (rigidly;
 * the container's own box then moves with them). The dropped set moves by a
 * NEARBY offset — searched nearest-first among edge-aligned candidates, with
 * bounded work — after which:
 *   - no moved node overlaps another node (with a minimum gap);
 *   - no node sits inside a container it is not a member of — the canvas
 *     never shows a containment the backend did not send;
 *   - the containers whose box follows the moved nodes (their ancestors) do
 *     not overlap a foreign node or a non-nested container.
 * Container-level overlaps that already existed before the drag are tolerated
 * (the drop is not blamed for them). When nothing fits nearer than where the
 * drag started, every moved leaf returns to its own starting rect (the
 * arrangement the person grabbed, valid or not — the drop adds no new overlap).
 */
import type { Rect } from './layoutGraph.js';

export interface DropInput {
  /** Containment child → parent (LayoutGraph.parentOf); containers are the parents. */
  parentOf: ReadonlyMap<string, string>;
  /** Every leaf node's rect; moved leaves at the place they were dropped. */
  rects: ReadonlyMap<string, Rect>;
  /** The leaves that moved together (one node, or a dragged container's members). */
  moved: ReadonlySet<string>;
  /** The moved leaves' rects when the drag started. */
  origin: ReadonlyMap<string, Rect>;
  /** Minimum clear space between boxes after the drop. */
  gap: number;
  /** Container box padding around its content, and the header band on top (theme geometry). */
  groupPad: number;
  groupHeader: number;
}

export interface Offset {
  dx: number;
  dy: number;
}

/**
 * Shift every moved leaf by the offset, or put each back at its starting rect;
 * 'unresolved' only when nothing fits and no origin was given (the caller keeps the drop as placed).
 */
export type DropResult = ({ kind: 'offset' } & Offset) | { kind: 'origin' } | { kind: 'unresolved' };

const near = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
const shift = (r: Rect, d: Offset): Rect => ({ x: r.x + d.dx, y: r.y + d.dy, w: r.w, h: r.h });
function union(rects: Iterable<Rect>): Rect | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return minX === Infinity ? undefined : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The first search band's radius (world units); each next band doubles it. */
const FIRST_BAND = 256;
/** Per band and axis, only this many nearest edge offsets are combined (bounds the x × y product). */
const AXIS_CANDIDATES = 96;
/** Moved sets up to this size also offer each leaf's own edges as candidates. */
const PER_LEAF_EDGES = 8;
/** Guard on the containment walk (cycles are excluded upstream; this only bounds a bad map). */
const MAX_DEPTH = 32;

/** Where the moved leaves settle: an offset ({0,0} when the drop already fits), or back to their starting rects. */
export function resolveDrop(i: DropInput): DropResult {
  const zero = { dx: 0, dy: 0 };
  const stay: DropResult = { kind: 'offset', ...zero };
  const movedIds = [...i.moved].filter((id) => i.rects.has(id));
  if (movedIds.length === 0) return stay;

  // Containment over the leaves present.
  const ancestors = new Map<string, string[]>();
  const leavesOf = new Map<string, Set<string>>();
  for (const id of i.rects.keys()) {
    const chain: string[] = [];
    for (let p = i.parentOf.get(id), g = 0; p !== undefined && g < MAX_DEPTH; p = i.parentOf.get(p), g++) {
      chain.push(p);
      let set = leavesOf.get(p);
      if (!set) leavesOf.set(p, (set = new Set()));
      set.add(id);
    }
    ancestors.set(id, chain);
  }
  const containers = [...leavesOf.keys()];
  const isAncestor = (a: string, of: string) => {
    for (let p = i.parentOf.get(of), g = 0; p !== undefined && g < MAX_DEPTH; p = i.parentOf.get(p), g++) if (p === a) return true;
    return false;
  };
  const nested = (a: string, b: string) => a === b || isAncestor(a, b) || isAncestor(b, a);
  const dynamic = containers.filter((c) => movedIds.some((m) => leavesOf.get(c)!.has(m)));
  const dynamicSet = new Set(dynamic);
  const staticContainers = containers.filter((c) => !dynamicSet.has(c));
  const staticLeaves = [...i.rects.keys()].filter((id) => !i.moved.has(id));

  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of i.parentOf) {
    const list = childrenOf.get(parent);
    if (list) list.push(child);
    else childrenOf.set(parent, [child]);
  }
  /** Container boxes (padding + header around their content), with the moved leaves placed by `leaf`. */
  const wrapsWith = (leaf: (id: string) => Rect | undefined, only: readonly string[]) => {
    const memo = new Map<string, Rect | undefined>();
    const wrap = (c: string, depth = 0): Rect | undefined => {
      if (memo.has(c)) return memo.get(c);
      if (depth > MAX_DEPTH) return undefined;
      const inner = union(
        (childrenOf.get(c) ?? [])
          .map((k) => (leavesOf.has(k) ? wrap(k, depth + 1) : leaf(k)))
          .filter((r): r is Rect => r !== undefined),
      );
      const r = inner && {
        x: inner.x - i.groupPad,
        y: inner.y - i.groupPad - i.groupHeader,
        w: inner.w + 2 * i.groupPad,
        h: inner.h + 2 * i.groupPad + i.groupHeader,
      };
      memo.set(c, r);
      return r;
    };
    return new Map(only.map((c) => [c, wrap(c)] as const));
  };
  const staticWraps = wrapsWith((id) => i.rects.get(id), staticContainers);
  const dynamicWrapsAt = (d: Offset) =>
    wrapsWith((id) => {
      const r = i.rects.get(id);
      return r && i.moved.has(id) ? shift(r, d) : r;
    }, dynamic);

  // Container-level pairs already overlapping before the drag: tolerated.
  const originWraps = wrapsWith((id) => (i.moved.has(id) ? i.origin.get(id) ?? i.rects.get(id) : i.rects.get(id)), dynamic);
  const tolerated = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  for (const d of dynamic) {
    const w = originWraps.get(d);
    if (!w) continue;
    for (const s of staticLeaves) if (!leavesOf.get(d)!.has(s) && near(w, i.rects.get(s)!, i.gap)) tolerated.add(pairKey(d, s));
    for (const c of staticContainers) {
      const cw = staticWraps.get(c);
      if (cw && !nested(c, d) && near(w, cw, i.gap)) tolerated.add(pairKey(d, c));
    }
    for (const d2 of dynamic) {
      const w2 = originWraps.get(d2);
      if (d2 > d && w2 && !nested(d, d2) && near(w, w2, i.gap)) tolerated.add(pairKey(d, d2));
    }
  }

  const fits = (d: Offset): boolean => {
    // Container boxes first: few, and the usual reason a candidate fails.
    const wraps = dynamicWrapsAt(d);
    for (const [dc, w] of wraps) {
      if (!w) continue;
      for (const s of staticLeaves) {
        if (leavesOf.get(dc)!.has(s) || tolerated.has(pairKey(dc, s))) continue;
        if (near(w, i.rects.get(s)!, i.gap)) return false;
      }
      for (const c of staticContainers) {
        const cw = staticWraps.get(c);
        if (!cw || nested(c, dc) || tolerated.has(pairKey(dc, c))) continue;
        if (near(w, cw, i.gap)) return false;
      }
      for (const [dc2, w2] of wraps) {
        if (dc2 <= dc || !w2 || nested(dc, dc2) || tolerated.has(pairKey(dc, dc2))) continue;
        if (near(w, w2, i.gap)) return false;
      }
    }
    for (const m of movedIds) {
      const r = shift(i.rects.get(m)!, d);
      for (const s of staticLeaves) if (near(r, i.rects.get(s)!, i.gap)) return false;
      // A static container holds no moved leaf: being inside it would show a membership that does not exist.
      for (const c of staticContainers) {
        const cw = staticWraps.get(c);
        if (cw && near(r, cw, i.gap)) return false;
      }
    }
    return true;
  };

  if (fits(zero)) return stay;

  // The search never goes farther than the way back to where the drag started.
  const back = (() => {
    const m = movedIds.find((id) => i.origin.has(id));
    if (!m) return null;
    const o = i.origin.get(m)!;
    const r = i.rects.get(m)!;
    return { dx: o.x - r.x, dy: o.y - r.y };
  })();
  const limit = back ? Math.hypot(back.dx, back.dy) : Infinity;
  const fallback: DropResult = i.origin.size > 0 ? { kind: 'origin' } : { kind: 'unresolved' };

  // Candidate offsets: the moving shapes' edges laid against obstacle edges (gap apart).
  // Searched in widening bands; a band includes EVERY obstacle a candidate within its
  // radius could touch, so the first fit found in a band is the nearest one overall.
  const shapes: Rect[] = [];
  const movedBox = union(movedIds.map((id) => i.rects.get(id)!));
  if (movedBox) shapes.push(movedBox);
  if (movedIds.length <= PER_LEAF_EDGES) for (const m of movedIds) shapes.push(i.rects.get(m)!);
  // A growing ancestor's box moves only on the side its moved content controls: its moving part is the shape.
  for (const w of wrapsWith((id) => (i.moved.has(id) ? i.rects.get(id) : undefined), dynamic).values()) if (w) shapes.push(w);
  const allObstacles: Rect[] = [...staticLeaves.map((s) => i.rects.get(s)!), ...[...staticWraps.values()].filter((r): r is Rect => !!r)];
  const tried = new Set<string>();
  // Without an origin: far enough to clear everything there is, shapes included.
  const extent = union([...allObstacles, ...shapes]);
  const maxBand = Number.isFinite(limit) ? limit : extent ? 2 * (extent.w + extent.h) + i.gap : FIRST_BAND;
  const cands0: Offset[] = [];
  for (let band = FIRST_BAND; ; band *= 2) {
    const radius = Math.min(band, maxBand);
    const reach = radius + i.gap;
    const obstacles = allObstacles.filter((o) => shapes.some((sh) => near(sh, o, reach)));
    const xs = new Set<number>([0]);
    const ys = new Set<number>([0]);
    for (const sh of shapes) {
      for (const o of obstacles) {
        xs.add(o.x - i.gap - (sh.x + sh.w));
        xs.add(o.x + o.w + i.gap - sh.x);
        ys.add(o.y - i.gap - (sh.y + sh.h));
        ys.add(o.y + o.h + i.gap - sh.y);
      }
    }
    const axis = (vals: Set<number>) =>
      [...vals].filter((v) => Math.abs(v) <= radius).sort((a, b) => Math.abs(a) - Math.abs(b));
    const allX = axis(xs);
    const allY = axis(ys);
    // Pure single-axis moves are always tried; combinations use the nearest edges per axis.
    const sx = allX.slice(0, AXIS_CANDIDATES);
    const sy = allY.slice(0, AXIS_CANDIDATES);
    for (const dx of allX.slice(AXIS_CANDIDATES)) cands0.push({ dx, dy: 0 });
    for (const dy of allY.slice(AXIS_CANDIDATES)) cands0.push({ dx: 0, dy });
    const cands: Offset[] = cands0.filter((c) => {
      const dist = Math.hypot(c.dx, c.dy);
      const key = `${c.dx},${c.dy}`;
      if (dist >= limit || tried.has(key)) return false;
      tried.add(key);
      return true;
    });
    cands0.length = 0;
    for (const dx of sx) {
      for (const dy of sy) {
        const dist = Math.hypot(dx, dy);
        if (dist > radius) break;
        if (dist >= limit) continue;
        const key = `${dx},${dy}`;
        if (tried.has(key)) continue;
        tried.add(key);
        cands.push({ dx, dy });
      }
    }
    cands.sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
    for (const d of cands) if (fits(d)) return { kind: 'offset', ...d };
    if (radius >= maxBand) return fallback;
  }
}
