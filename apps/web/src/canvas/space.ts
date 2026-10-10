/**
 * Dynamic-view P3 — space (size) and transition animation. Everything here is
 * a pure function over view inputs (docs/design/p3-space-transitions.md, design
 * confirmed 2026-10-05, plus the review rulings of the same day):
 *
 *   - size = base × tier factor (theme geometry data; size is a LAYOUT input);
 *   - geometry changes only at TRANSITION MOMENTS (topology / lens / sort key
 *     [P4 seam] / explicit tidy) — `transitionCause` is the one gate;
 *   - BETWEEN moments only person-caused signals resize anything: the spatial
 *     tiers (selection/open/pending + 1-hop) and the sizes a transition baked
 *     (`displaySizes`). Attention, recency and lens matches change emphasis,
 *     never geometry, until the next moment bakes the full tiers in;
 *   - a person-caused tier change is LOCAL: the node resizes in place and
 *     `pushAside` clears a margin around it (design decision: margin, not minimal overlap
 *     resolution). The ripple stays INSIDE the node's own container; when the
 *     container must grow, sibling containers are pushed as whole units. Pins
 *     and person anchors never move, the focus never moves, displacement is
 *     capped (distant nodes never move), the margin COMPRESSES rather than
 *     fling anything far, and settled states are overlap-free — nodes, group
 *     boxes and groups against groups;
 *   - every geometry change animates (theme motion tokens — no durations live
 *     here), and input stays LIVE mid-animation (design decision): the canvas hit-tests
 *     the interpolated rects this module returns, never the targets.
 *
 * Being pure derivations of (layout positions, spatial tiers, pins), the
 * push-aside is symmetric by construction: on deselect the derivation returns
 * the base geometry and pushed neighbours come back.
 */
import type { Tier } from '../state/relevance.js';
import { sizeForTier } from '../state/relevance.js';
import { GENERIC_NODE_SIZE, LAYOUT, type Point, type Positions, type Rect } from './layoutGraph.js';

export type Size = { w: number; h: number };

/**
 * Chrome hook: dispatching this window event asks the canvas for an explicit
 * tidy — a TRANSITION MOMENT (full relayout with then-current tier sizes, then
 * a re-fit). The toolbar wires it; the canvas only listens.
 */
export const TIDY_EVENT = 'gunnflow:canvas-tidy';

/* ---- transition moments -------------------------------------------------- */

/** The explicit view inputs whose change IS a transition moment — nothing else moves geometry. */
export interface TransitionKey {
  /** The received topology's signature (layout-shaping relations only). */
  topology: string;
  lens: string;
  /** P4 seam: ViewState.sortKey. The sort UI that writes it lands in P4; until then this never fires. */
  sortKey: string | null;
  /** Explicit tidy counter (TIDY_EVENT). */
  tidy: number;
}

export type TransitionCause = 'topology' | 'lens' | 'sort' | 'tidy';

/** Pure gate: which transition moment separates `prev` from `next`, or null (geometry must not change). */
export function transitionCause(prev: TransitionKey | null, next: TransitionKey): TransitionCause | null {
  if (prev === null || prev.topology !== next.topology) return 'topology';
  if (prev.lens !== next.lens) return 'lens';
  if (prev.sortKey !== next.sortKey) return 'sort';
  if (prev.tidy !== next.tidy) return 'tidy';
  return null;
}

/* ---- size: the tier's spatial output ------------------------------------- */

/** Every node's box size from a tier map (theme geometry data). */
/** Every node's tier-1 size: one size for all, or per node (a kind's shape and size factor). */
export type BaseSize = Size | ((id: string) => Size);
const baseOf = (node: BaseSize, id: string): Size => (typeof node === 'function' ? node(id) : node);

export function tierSizes(
  tiers: ReadonlyMap<string, Tier>,
  geometry: { node: BaseSize; tierScale: readonly number[] },
): Map<string, Size> {
  const out = new Map<string, Size>();
  for (const [id, tier] of tiers) out.set(id, sizeForTier(tier, baseOf(geometry.node, id), geometry.tierScale));
  return out;
}

/**
 * The size a node DISPLAYS between transition moments (ruling 2026-10-05):
 * the person-caused spatial tier, floored by whatever the last transition
 * moment baked for received-fact causes. Attention arriving or recency
 * decaying after the bake changes nothing until the next moment; selection
 * and deselection act at once and symmetrically.
 */
export function displaySizes(
  spatial: ReadonlyMap<string, Tier>,
  ambientBaked: ReadonlyMap<string, Size>,
  geometry: { node: BaseSize; tierScale: readonly number[] },
): Map<string, Size> {
  const out = new Map<string, Size>();
  for (const [id, tier] of spatial) {
    const person = sizeForTier(tier, baseOf(geometry.node, id), geometry.tierScale);
    const baked = ambientBaked.get(id);
    out.set(id, baked && baked.w > person.w ? { ...baked } : person);
  }
  return out;
}

/* ---- target rects: growth lives inside local slack ----------------------- */

export interface SpaceInputs {
  /** Settled layout positions (top-left corners at the transition-locked sizes). */
  base: Positions;
  /** The sizes the layout was computed with (locked at the last transition moment). */
  lockedSizes: ReadonlyMap<string, Size>;
  /** Current display sizes (person-caused changes over the baked baseline). */
  sizes: ReadonlyMap<string, Size>;
  /** User-dragged positions: a pin holds POSITION — never pushed, never overridden. Its size follows tier (clamped like any). */
  pins: ReadonlyMap<string, Point>;
  baseSize: BaseSize;
  /** Theme geometry: the breathing margin a grown node claims — the first thing to yield when space is short. */
  margin: number;
  /** Theme geometry: how many siblings a growth may shift aside per direction. */
  hops: number;
  /** Person anchors (spatial tier 3: selection/open/pending): walls — push-aside never moves them. */
  anchors?: ReadonlySet<string>;
  /** Containment (LayoutGraph.parentOf): only same-container siblings may shift; wraps grow only into free space. */
  parentOf?: ReadonlyMap<string, string>;
  /** Per-axis displacement cap on shifted siblings (locality). */
  maxShift?: { x: number; y: number };
}

/**
 * The settled target rect of every laid-out node (round-3 ruling: GROWTH
 * LIVES INSIDE LOCAL SLACK — SIZE YIELDS WHEN SPACE IS SHORT). Every node
 * starts at its allocated (transition-locked) box; shrinking is free; growth
 * is clamped to the space `pushAside` can actually clear. Pure: recomputing
 * with reverted tiers IS the symmetric return, and the full size arrives at
 * the next transition moment's relayout.
 */
export function spaceTargets(i: SpaceInputs): Map<string, Rect> {
  const boxes = new Map<string, Rect>();
  const desired = new Map<string, Size>();
  const pinned = new Set<string>();
  for (const [id, p] of i.base) {
    const alloc = i.lockedSizes.get(id) ?? baseOf(i.baseSize, id);
    const want = i.sizes.get(id) ?? baseOf(i.baseSize, id);
    const pin = i.pins.get(id);
    if (pin) pinned.add(id);
    boxes.set(id, { x: pin?.x ?? p.x, y: pin?.y ?? p.y, w: alloc.w, h: alloc.h });
    if (want.w !== alloc.w || want.h !== alloc.h) desired.set(id, want);
  }
  return pushAside(boxes, desired, pinned, {
    margin: i.margin,
    hops: i.hops,
    anchors: i.anchors,
    parentOf: i.parentOf,
    maxShift: i.maxShift ?? defaultMaxShift(i.hops, typeof i.baseSize === 'function' ? GENERIC_NODE_SIZE : i.baseSize),
  });
}

/** The locality window as a displacement cap: `hops` cells of the base grid, per axis. */
export function defaultMaxShift(hops: number, baseSize: Size = GENERIC_NODE_SIZE): { x: number; y: number } {
  return { x: hops * (baseSize.w + LAYOUT.colGap), y: hops * (baseSize.h + LAYOUT.rowGap) };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function union(rects: readonly Rect[]): Rect | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return minX === Infinity ? undefined : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
/** Guard on the span-widening walk (algorithm constant, not a density knob). */
const SPAN_PASS_LIMIT = 8;
const EPS = 1e-7;

export interface PushAsideOptions {
  margin: number;
  hops: number;
  /** Person anchors: walls, like pins. */
  anchors?: ReadonlySet<string>;
  /** Containment child→parent (LayoutGraph.parentOf). */
  parentOf?: ReadonlyMap<string, string>;
  /** Per-axis displacement cap for shifted siblings. */
  maxShift?: { x: number; y: number };
}

type Axis = 'x' | 'y';
type Dir = 'left' | 'right' | 'up' | 'down';

/**
 * Round-3 canon: GROWTH LIVES INSIDE LOCAL SLACK. For each node whose desired
 * size exceeds its allocated box, each side independently claims extension +
 * margin out of genuinely free space:
 *
 *   - only SAME-CONTAINER sibling leaves may shift, each within its own slack
 *     (displacement cap), at most `hops` of them per direction;
 *   - pins, anchors, already-grown nodes and sub-container wraps are WALLS;
 *   - the container's wrap may grow only into free space (no other wrap, no
 *     foreign node — checked on every ancestor), so nothing ever enters a
 *     foreign band;
 *   - when the claim does not fit, the MARGIN yields first, then the SIZE
 *     clamps — a focus in a cramped band simply grows less (or not at all);
 *     the full size arrives at the next transition moment's relayout.
 *
 * Overlap-freedom, locality and pin/anchor inviolability hold BY CONSTRUCTION:
 * nothing is ever placed into occupied space, so no overlap can be created
 * (a pin the person left under a node's base box stays exactly as they put it).
 * Shrinking (deselect) is applied first and is always free — the derivation
 * is symmetric.
 */
export function pushAside(
  boxes: ReadonlyMap<string, Rect>,
  desired: ReadonlyMap<string, Size>,
  pinnedIds: ReadonlySet<string>,
  opts: PushAsideOptions,
): Map<string, Rect> {
  const anchors = opts.anchors ?? new Set<string>();
  const parentOf = opts.parentOf ?? new Map<string, string>();
  const maxShift = opts.maxShift ?? defaultMaxShift(opts.hops);
  const out = new Map<string, Rect>();
  for (const [id, r] of boxes) out.set(id, { ...r });

  // Containment structure over the given leaves.
  const containers = new Set<string>();
  for (const id of boxes.keys()) {
    for (let p = parentOf.get(id), g = 0; p !== undefined && g <= LAYOUT.maxNestDepth + 1; p = parentOf.get(p), g++) containers.add(p);
  }
  const children = new Map<string | undefined, string[]>();
  for (const n of [...boxes.keys(), ...containers].sort()) {
    const p = parentOf.get(n);
    const key = p !== undefined && containers.has(p) ? p : undefined;
    children.set(key, [...(children.get(key) ?? []), n]);
  }
  const subtree = new Map<string, Set<string>>();
  const leavesUnder = (c: string): Set<string> => {
    const hit = subtree.get(c);
    if (hit) return hit;
    const got = new Set<string>();
    const stack = [...(children.get(c) ?? [])];
    while (stack.length > 0) {
      const k = stack.pop()!;
      if (containers.has(k)) stack.push(...(children.get(k) ?? []));
      else if (boxes.has(k)) got.add(k);
    }
    subtree.set(c, got);
    return got;
  };
  /** A container's current wrap extent, fresh from the working rects. */
  const extentOf = (c: string): Rect | undefined => {
    const parts: Rect[] = [];
    for (const k of children.get(c) ?? []) {
      const e = containers.has(k) ? extentOf(k) : boxes.has(k) ? out.get(k)! : undefined;
      if (e) parts.push(e);
    }
    const inner = union(parts);
    return inner
      ? {
          x: inner.x - LAYOUT.groupPad,
          y: inner.y - LAYOUT.groupPad - LAYOUT.groupHeader,
          w: inner.w + 2 * LAYOUT.groupPad,
          h: inner.h + 2 * LAYOUT.groupPad + LAYOUT.groupHeader,
        }
      : undefined;
  };
  const levelOf = (id: string): string | undefined => {
    const p = parentOf.get(id);
    return p !== undefined && containers.has(p) ? p : undefined;
  };
  const isWallLeaf = (id: string) => pinnedIds.has(id) || anchors.has(id);

  // 1) Shrinking frees space and is always safe: centred, or at the pin's corner.
  for (const [id, size] of desired) {
    const b = out.get(id);
    if (!b || size.w > b.w + EPS || size.h > b.h + EPS) continue;
    out.set(
      id,
      pinnedIds.has(id)
        ? { x: b.x, y: b.y, w: size.w, h: size.h }
        : { x: b.x + (b.w - size.w) / 2, y: b.y + (b.h - size.h) / 2, w: size.w, h: size.h },
    );
  }

  // 2) Growth: person anchors first, then larger targets; already-grown nodes
  //    become walls for the rest (first come, first grown).
  const grown = [...desired]
    .filter(([id, s]) => {
      const b = boxes.get(id);
      return b !== undefined && (s.w > b.w + EPS || s.h > b.h + EPS);
    })
    .sort(([ia, sa], [ib, sb]) => Number(anchors.has(ib)) - Number(anchors.has(ia)) || sb.w * sb.h - sa.w * sa.h || (ia < ib ? -1 : 1));
  const settled = new Set<string>();
  for (const [id, size] of grown) {
    growOne(id, size);
    settled.add(id);
  }
  return out;

  /** How far `c`'s wrap (and every ancestor wrap) can move outward into genuinely free space. */
  function bandSlack(level: string | undefined, axis: Axis, sign: 1 | -1): number {
    let slack = Infinity;
    for (let a = level, guard = 0; a !== undefined && guard <= LAYOUT.maxNestDepth + 1; a = levelOf(a), guard++) {
      const ext = extentOf(a);
      if (!ext) break;
      const mine = leavesUnder(a);
      const ancestorChain = new Set<string>();
      for (let up: string | undefined = a, g2 = 0; up !== undefined && g2 <= LAYOUT.maxNestDepth + 1; up = levelOf(up), g2++) ancestorChain.add(up);
      const obstacles: Rect[] = [];
      for (const [oid, orect] of out) if (!mine.has(oid)) obstacles.push(orect);
      for (const c of containers) {
        if (ancestorChain.has(c)) continue; // a itself / an ancestor: its wrap contains a's
        let foreign = false;
        for (const l of leavesUnder(c)) {
          if (!mine.has(l)) {
            foreign = true;
            break;
          }
        }
        if (!foreign) continue; // nested inside a: not a wall for a's own growth
        const e = extentOf(c);
        if (e) obstacles.push(e);
      }
      for (const o of obstacles) {
        if (!perpOverlaps(ext, o, axis)) continue;
        // Only obstacles AHEAD in the growth direction bound the slack; what
        // lies behind the wrap is someone else's side of the world.
        const ahead = sign > 0 ? hi(o, axis) > hi(ext, axis) + EPS : lo(o, axis) < lo(ext, axis) - EPS;
        if (!ahead) continue;
        const gap = sign > 0 ? lo(o, axis) - hi(ext, axis) : lo(ext, axis) - hi(o, axis);
        if (gap < slack) slack = Math.max(0, gap);
      }
    }
    return slack;
  }

  function growOne(g: string, want: Size): void {
    const level = levelOf(g);
    const siblings = (children.get(level) ?? []).filter((s) => s !== g);
    const pinnedG = pinnedIds.has(g);
    const b0 = out.get(g)!;
    // A pin anchors its top-left corner; everything else grows about its centre.
    const extWant: Record<Dir, number> = {
      left: pinnedG ? 0 : Math.max(0, (want.w - b0.w) / 2),
      right: pinnedG ? Math.max(0, want.w - b0.w) : Math.max(0, (want.w - b0.w) / 2),
      up: pinnedG ? 0 : Math.max(0, (want.h - b0.h) / 2),
      down: pinnedG ? Math.max(0, want.h - b0.h) : Math.max(0, (want.h - b0.h) / 2),
    };
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      const need = extWant[dir];
      if (need <= EPS) continue;
      const axis: Axis = dir === 'left' || dir === 'right' ? 'x' : 'y';
      const sign: 1 | -1 = dir === 'right' || dir === 'down' ? 1 : -1;
      const b = out.get(g)!;
      // The perpendicular span the final halo would occupy (full desired size + margin).
      const perpLo = axis === 'x' ? (pinnedG ? b.y : b.y - (want.h - b.h) / 2) - opts.margin : (pinnedG ? b.x : b.x - (want.w - b.w) / 2) - opts.margin;
      const perpHi = perpLo + (axis === 'x' ? want.h : want.w) + 2 * opts.margin;
      const { grant, movers } = probe(g, level, siblings, axis, sign, need + opts.margin, perpLo, perpHi);
      const ext = Math.min(need, grant);
      const used = ext + Math.min(opts.margin, Math.max(0, grant - ext)); // margin yields first, then size clamps
      for (const m of movers) {
        const shiftBy = used - m.cumGap;
        if (shiftBy <= EPS) continue;
        const r = out.get(m.id)!;
        out.set(m.id, axis === 'x' ? { ...r, x: r.x + sign * shiftBy } : { ...r, y: r.y + sign * shiftBy });
      }
      const after = out.get(g)!;
      out.set(
        g,
        axis === 'x'
          ? { ...after, x: sign > 0 ? after.x : after.x - ext, w: after.w + ext }
          : { ...after, y: sign > 0 ? after.y : after.y - ext, h: after.h + ext },
      );
    }
  }

  /** The free space one direction can yield (gaps + capped sibling shifts + band slack), and who shifts. */
  function probe(
    g: string,
    level: string | undefined,
    siblings: readonly string[],
    axis: Axis,
    sign: 1 | -1,
    claim: number,
    perpLo0: number,
    perpHi0: number,
  ): { grant: number; movers: { id: string; cumGap: number }[] } {
    const b = out.get(g)!;
    const edge = sign > 0 ? hi(b, axis) : -lo(b, axis); // outward-increasing coordinate
    const rectOf = (s: string): Rect | undefined => (containers.has(s) ? extentOf(s) : out.get(s));
    // Widen the perpendicular span over movers until stable: a shifted sibling
    // must clear everything in ITS OWN way too, not just the halo's strip.
    let perpLo = perpLo0;
    let perpHi = perpHi0;
    for (let pass = 0; pass < SPAN_PASS_LIMIT; pass++) {
      let widened = false;
      for (const s of siblings) {
        const r = rectOf(s);
        if (!r || containers.has(s) || isWallLeaf(s) || settled.has(s)) continue;
        // Same membership as the chain filter below (far edge past the growth
        // edge): a STRADDLING neighbour is a mover too, so its own path must
        // widen the span — otherwise what stands in its way is never walled.
        const far = sign > 0 ? hi(r, axis) : -lo(r, axis);
        if (far <= edge + EPS) continue;
        if (pLo(r, axis) < perpHi - EPS && pHi(r, axis) > perpLo + EPS) {
          const lo2 = Math.min(perpLo, pLo(r, axis));
          const hi2 = Math.max(perpHi, pHi(r, axis));
          if (lo2 < perpLo - EPS || hi2 > perpHi + EPS) {
            perpLo = lo2;
            perpHi = hi2;
            widened = true;
          }
        }
      }
      if (!widened) break;
    }
    // The outward chain inside the widened span.
    const chain = siblings
      .map((s) => ({ s, r: rectOf(s) }))
      .filter((e): e is { s: string; r: Rect } => e.r !== undefined)
      .filter(({ r }) => pLo(r, axis) < perpHi - EPS && pHi(r, axis) > perpLo + EPS)
      .map(({ s, r }) => ({ s, near: sign > 0 ? lo(r, axis) : -hi(r, axis), far: sign > 0 ? hi(r, axis) : -lo(r, axis) }))
      .filter((e) => e.far > edge + EPS)
      .sort((a, b2) => a.near - b2.near || (a.s < b2.s ? -1 : 1));
    let grant = claim;
    const movers: { id: string; cumGap: number }[] = [];
    let cursor = edge;
    let cum = 0;
    let wallHit = false;
    // Hops count DISTANCE RANKS, not individual rects: siblings standing
    // abreast (same near edge) are one hop of the ripple together.
    let hopCount = 0;
    let hopNear = Number.NEGATIVE_INFINITY;
    for (const item of chain) {
      cum += Math.max(0, item.near - cursor);
      cursor = Math.max(cursor, item.far);
      if (cum >= claim - EPS) break;
      if (item.near > hopNear + EPS) {
        hopCount += 1;
        hopNear = item.near;
      }
      const wall = containers.has(item.s) || isWallLeaf(item.s) || settled.has(item.s) || hopCount > opts.hops;
      if (wall) {
        grant = Math.min(grant, cum);
        wallHit = true;
        break;
      }
      // A mover's shift (= grant − gap before it) must fit what remains of its
      // displacement cap, measured as NET outward displacement from its
      // original box (a prior opposite shift gives room back).
      const orig = boxes.get(item.s)!;
      const cur = out.get(item.s)!;
      const shiftedAlready = sign * (lo(cur, axis) - lo(orig, axis));
      const capLeft = Math.max(0, (axis === 'x' ? maxShift.x : maxShift.y) - shiftedAlready);
      grant = Math.min(grant, cum + capLeft);
      movers.push({ id: item.s, cumGap: cum });
    }
    if (!wallHit && cum < claim - EPS) {
      // Past the chain lies the container boundary: the wrap grows only into free space.
      grant = Math.min(grant, cum + (level === undefined ? Infinity : bandSlack(level, axis, sign)));
    }
    return { grant: Math.max(0, Math.min(grant, claim)), movers };
  }

  function lo(r: Rect, axis: Axis): number {
    return axis === 'x' ? r.x : r.y;
  }
  function hi(r: Rect, axis: Axis): number {
    return axis === 'x' ? r.x + r.w : r.y + r.h;
  }
  function pLo(r: Rect, axis: Axis): number {
    return axis === 'x' ? r.y : r.x;
  }
  function pHi(r: Rect, axis: Axis): number {
    return axis === 'x' ? r.y + r.h : r.x + r.w;
  }
  function perpOverlaps(a: Rect, b: Rect, axis: Axis): boolean {
    return pLo(a, axis) < pHi(b, axis) - EPS && pLo(b, axis) < pHi(a, axis) - EPS;
  }
}


/* ---- animation: every geometry change interpolates ----------------------- */

export interface TransitionPlan {
  startAt: number;
  duration: number;
  entries: ReadonlyMap<string, { from: Rect; to: Rect }>;
}

/**
 * Current → target rects as one plan. A node without a previous rect appears
 * in place (the existing entrance grammar stays); a `snapIds` node (direct
 * manipulation — an active pin drag) takes its position immediately and only
 * its size eases, so the box never trails the hand.
 */
export function planTransition(
  prev: ReadonlyMap<string, Rect>,
  targets: ReadonlyMap<string, Rect>,
  startAt: number,
  duration: number,
  snapIds: ReadonlySet<string> = new Set(),
): TransitionPlan {
  const entries = new Map<string, { from: Rect; to: Rect }>();
  let moving = false;
  for (const [id, to] of targets) {
    const p = prev.get(id);
    const from = p === undefined ? to : snapIds.has(id) ? { ...p, x: to.x, y: to.y } : p;
    if (!moving && (from.x !== to.x || from.y !== to.y || from.w !== to.w || from.h !== to.h)) moving = true;
    entries.set(id, { from, to });
  }
  return { startAt, duration: moving ? duration : 0, entries };
}

export function planSettled(plan: TransitionPlan, now: number): boolean {
  return now >= plan.startAt + plan.duration;
}

/** The on-screen rects at `now`: pure interpolation. Hit-testing MUST read these (design choice (c)). */
export function rectsAt(plan: TransitionPlan, now: number, ease: (t: number) => number = (t) => t): Map<string, Rect> {
  const t = plan.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - plan.startAt) / plan.duration));
  const e = t >= 1 ? 1 : ease(t);
  const out = new Map<string, Rect>();
  for (const [id, { from, to }] of plan.entries) {
    out.set(
      id,
      e >= 1
        ? to
        : {
            x: from.x + (to.x - from.x) * e,
            y: from.y + (to.y - from.y) * e,
            w: from.w + (to.w - from.w) * e,
            h: from.h + (to.h - from.h) * e,
          },
    );
  }
  return out;
}

/**
 * A numeric easing from a theme motion token ('cubic-bezier(a,b,c,d)'), so the
 * canvas animates with the SAME curves the DOM chrome gets as CSS variables.
 * Anything unparsable degrades to linear.
 */
export function cubicBezierEase(token: string): (t: number) => number {
  const m = /cubic-bezier\(\s*([^,\s]+)\s*,\s*([^,\s]+)\s*,\s*([^,\s]+)\s*,\s*([^)\s]+)\s*\)/.exec(token);
  if (!m) return (t) => t;
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (![x1, y1, x2, y2].every(Number.isFinite)) return (t) => t;
  const coeff = (p1: number, p2: number) => {
    const c = 3 * p1;
    const b = 3 * (p2 - p1) - c;
    return { a: 1 - c - b, b, c };
  };
  const X = coeff(x1, x2);
  const Y = coeff(y1, y2);
  const at = (k: { a: number; b: number; c: number }, u: number) => ((k.a * u + k.b) * u + k.c) * u;
  const solve = (x: number): number => {
    // Newton, then bisection as the safety net.
    let u = x;
    for (let i = 0; i < 8; i++) {
      const dx = at(X, u) - x;
      const slope = (3 * X.a * u + 2 * X.b) * u + X.c;
      if (Math.abs(dx) < 1e-6) return u;
      if (Math.abs(slope) < 1e-6) break;
      u -= dx / slope;
    }
    let lo = 0;
    let hi = 1;
    u = x;
    while (hi - lo > 1e-6) {
      u = (lo + hi) / 2;
      if (at(X, u) < x) lo = u;
      else hi = u;
    }
    return u;
  };
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : at(Y, solve(t)));
}

/* ---- value equality (memo guards: replan only on real change) ------------ */

export function rectMapEquals(a: ReadonlyMap<string, Rect>, b: ReadonlyMap<string, Rect>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, r] of a) {
    const o = b.get(id);
    if (!o || o.x !== r.x || o.y !== r.y || o.w !== r.w || o.h !== r.h) return false;
  }
  return true;
}

export function sizeMapEquals(a: ReadonlyMap<string, Size>, b: ReadonlyMap<string, Size>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, s] of a) {
    const o = b.get(id);
    if (!o || o.w !== s.w || o.h !== s.h) return false;
  }
  return true;
}

export function tierMapEquals(a: ReadonlyMap<string, Tier>, b: ReadonlyMap<string, Tier>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, t] of a) if (b.get(id) !== t) return false;
  return true;
}
