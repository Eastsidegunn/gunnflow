/**
 * The layout port. Layout explains declared relations and nothing else: only
 * relations the wiring marks `flow` (layered left-to-right) or `contain`
 * (one end nested inside the other — the config's `direction` says which end
 * is the container; default: the source sits inside its target) shape
 * positions; the rest are drawn but do not move anything. Spacing, sizes and
 * limits are engine constants. Positions are view state — local-only, never
 * upstream data.
 *
 * Everything here is iterative and bounded (no recursion over the graph), so
 * a deep or huge topology cannot stall the main thread.
 */
import { WORKSPACE_ROOT_KIND, type NodeProjection } from '@gunnflow/contract';
import { relationArrangeFor, relationDirectionFor, type WiringConfig } from '@gunnflow/contract/wiring';

import { DEFAULT_THEME } from '../theme/defaultTheme.js';

/** Node size and spacing are theme data (density knobs); the algorithm's own guards stay here. */
export const GENERIC_NODE_SIZE = DEFAULT_THEME.geometry.node;
export const LAYOUT = {
  ...DEFAULT_THEME.geometry,
  /** Deeper containment is attached to its ancestor at this depth (still a true container). */
  maxNestDepth: 8,
  /** Nodes + flow relations above which the fallback switches to a plain block grid. */
  fallbackBudget: 20_000,
} as const;

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
/** Absolute top-left of leaf nodes (nodes that contain nothing). */
export type Positions = ReadonlyMap<string, Point>;

export interface LayoutNode {
  id: string;
  w: number;
  h: number;
}

export interface LayoutGraph {
  /** Canvas nodes in id order (containers included). */
  nodes: LayoutNode[];
  /** `flow` relations between canvas nodes, from → to. */
  flow: { from: string; to: string }[];
  /** `contain`: child → parent, only where the child has exactly one containing target and no cycle. */
  parentOf: Map<string, string>;
  /**
   * Nodes whose grouping is withheld: several containing targets, or part of
   * a containment cycle. They are drawn in no group; their containing
   * relations stay visible as ordinary edges.
   */
  withheld: string[];
  /** Collision-free topology signature: the cache key for "no recompute, no move". */
  signature: string;
  /**
   * Pack disconnected children inside every container into rows toward the
   * engine aspect, as at top level (machine pref `packContainers`). Absent =
   * on; `false` keeps top-level packing only. A layout input, so it joins the
   * signature (and every component signature): toggling re-lays everything.
   */
  packContainers?: boolean;
}

/** The packing mode's share of a signature (empty when on, the default). */
const packMark = (graph: { packContainers?: boolean }) => (graph.packContainers === false ? '|flat' : '');


export interface LayoutProvider {
  /** `hints`: previous positions, used to keep the existing order. */
  layout(graph: LayoutGraph, hints?: Positions): Promise<Positions>;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Length-preserving serialization (JSON escapes every string): distinct
 * topologies never collide. With `sizes`, node sizes join the signature: sizes
 * are a layout input (dynamic-view P3), so a transition-moment resize re-keys
 * the layout cache and marks its component changed for stabilization.
 */
export function topologySignature(
  ids: readonly string[],
  flow: readonly { from: string; to: string }[],
  parentOf: ReadonlyMap<string, string>,
  sizes?: ReadonlyMap<string, { w: number; h: number }>,
): string {
  const pairs = (xs: [string, string][]) => xs.sort((a, b) => byId(a[0], b[0]) || byId(a[1], b[1]));
  return JSON.stringify([
    sizes ? [...ids].map((id) => [id, sizes.get(id)?.w ?? 0, sizes.get(id)?.h ?? 0]) : [...ids],
    pairs(flow.map((e) => [e.from, e.to])),
    pairs([...parentOf].map(([c, p]) => [c, p])),
  ]);
}

/**
 * The same topology with per-node box sizes (dynamic-view P3: size = base ×
 * tier factor, captured at a TRANSITION MOMENT — never live-tracking tiers).
 * The signature carries the sizes, so the layout state recomputes exactly when
 * a transition locked new sizes in, and never on a mere tier flicker.
 */
export function sizedGraph(graph: LayoutGraph, sizes: ReadonlyMap<string, { w: number; h: number }>): LayoutGraph {
  if (sizes.size === 0) return graph;
  const nodes = graph.nodes.map((n) => {
    const s = sizes.get(n.id);
    return s && (s.w !== n.w || s.h !== n.h) ? { ...n, w: s.w, h: s.h } : n;
  });
  return {
    ...graph,
    nodes,
    signature: topologySignature(
      nodes.map((n) => n.id),
      graph.flow,
      graph.parentOf,
      new Map(nodes.map((n) => [n.id, { w: n.w, h: n.h }])),
    ) + packMark(graph),
  };
}

export function layoutGraphOf(
  all: readonly NodeProjection[],
  config: WiringConfig,
  options: { packContainers?: boolean } = {},
): LayoutGraph {
  const packContainers = options.packContainers ?? true;
  const nodes = all.filter((n) => n.kind !== WORKSPACE_ROOT_KIND).sort((a, b) => byId(a.id, b.id));
  const ids = new Set(nodes.map((n) => n.id));
  const flow: { from: string; to: string }[] = [];
  const targets = new Map<string, Set<string>>();
  for (const n of nodes) {
    for (const r of n.relations) {
      if (!ids.has(r.target) || r.target === n.id) continue;
      const arrange = relationArrangeFor(config, r.type);
      if (arrange === 'flow') flow.push({ from: n.id, to: r.target });
      else if (arrange === 'contain') {
        // The config's direction says which end is the container ('in': target, 'out': source).
        const [child, container] = relationDirectionFor(config, r.type) === 'out' ? [r.target, n.id] : [n.id, r.target];
        targets.set(child, (targets.get(child) ?? new Set()).add(container));
      }
    }
  }
  const withheld = new Set<string>();
  const parent = new Map<string, string>();
  for (const [child, ts] of targets) {
    if (ts.size > 1) withheld.add(child);
    else parent.set(child, [...ts][0]!);
  }
  // Cycles in the (single-parent) containment: every node on a cycle is withheld.
  const state = new Map<string, 1 | 2>();
  for (const start of parent.keys()) {
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && !state.has(cur)) {
      state.set(cur, 1);
      path.push(cur);
      cur = parent.get(cur);
    }
    if (cur !== undefined && state.get(cur) === 1) {
      for (let i = path.indexOf(cur); i < path.length; i++) withheld.add(path[i]!);
    }
    for (const p of path) state.set(p, 2);
  }
  for (const w of withheld) parent.delete(w);

  // Depth (iterative, memoized); containment deeper than the limit attaches to its ancestor at the limit.
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const chain: string[] = [];
    let cur: string | undefined = id;
    while (cur !== undefined && !depth.has(cur)) {
      chain.push(cur);
      cur = parent.get(cur);
    }
    let d = cur === undefined ? -1 : depth.get(cur)!;
    for (let i = chain.length - 1; i >= 0; i--) depth.set(chain[i]!, ++d);
    return depth.get(id)!;
  };
  for (const n of nodes) depthOf(n.id);
  const parentOf = new Map<string, string>();
  // atLimit(n): for a node at or below the depth limit, its ancestor one level above the limit.
  const atLimit = new Map<string, string>();
  for (const n of [...nodes].sort((a, b) => depth.get(a.id)! - depth.get(b.id)!)) {
    const p = parent.get(n.id);
    if (p === undefined) continue;
    const d = depth.get(n.id)!;
    if (d === LAYOUT.maxNestDepth) atLimit.set(n.id, p);
    else if (d > LAYOUT.maxNestDepth) atLimit.set(n.id, atLimit.get(p)!);
    parentOf.set(n.id, d <= LAYOUT.maxNestDepth ? p : atLimit.get(p)!);
  }
  return {
    nodes: nodes.map((n) => ({ id: n.id, w: GENERIC_NODE_SIZE.w, h: GENERIC_NODE_SIZE.h })),
    flow,
    parentOf,
    withheld: [...withheld].sort(byId),
    signature: topologySignature(
      nodes.map((n) => n.id),
      flow,
      parentOf,
    ) + packMark({ packContainers }),
    packContainers,
  };
}

/** Children per parent (undefined key = top level), in node order. */
export function childrenOf(graph: LayoutGraph): Map<string | undefined, string[]> {
  const out = new Map<string | undefined, string[]>();
  for (const n of graph.nodes) {
    const p = graph.parentOf.get(n.id);
    const list = out.get(p);
    if (list) list.push(n.id);
    else out.set(p, [n.id]);
  }
  return out;
}

/** Leaf ids: nodes that contain no other node. */
export function leafIds(graph: LayoutGraph): string[] {
  const parents = new Set(graph.parentOf.values());
  return graph.nodes.filter((n) => !parents.has(n.id)).map((n) => n.id);
}

function nestDepths(graph: LayoutGraph): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of graph.nodes) {
    let d = 0;
    for (let p = graph.parentOf.get(n.id); p !== undefined && d <= LAYOUT.maxNestDepth + 1; p = graph.parentOf.get(p)) d++;
    out.set(n.id, d);
  }
  return out;
}

/** The top-level unit containing a node. */
function unitOf(graph: LayoutGraph, id: string): string {
  let cur = id;
  for (let p = graph.parentOf.get(cur), guard = 0; p !== undefined && guard <= LAYOUT.maxNestDepth + 1; p = graph.parentOf.get(cur), guard++) cur = p;
  return cur;
}

function union(rects: Iterable<Rect>): Rect | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return minX === Infinity ? undefined : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Container rects wrapping their content (padding + header), innermost first. */
export function containerRects(graph: LayoutGraph, leafRect: (id: string) => Rect | undefined): Map<string, Rect> {
  const children = childrenOf(graph);
  const depth = nestDepths(graph);
  const out = new Map<string, Rect>();
  const containers = [...children.keys()].filter((k): k is string => k !== undefined).sort((a, b) => depth.get(b)! - depth.get(a)!);
  for (const id of containers) {
    const inner = union(
      children
        .get(id)!
        .map((k) => out.get(k) ?? leafRect(k))
        .filter((r): r is Rect => r !== undefined),
    );
    if (!inner) continue;
    out.set(id, {
      x: inner.x - LAYOUT.groupPad,
      y: inner.y - LAYOUT.groupPad - LAYOUT.groupHeader,
      w: inner.w + 2 * LAYOUT.groupPad,
      h: inner.h + 2 * LAYOUT.groupPad + LAYOUT.groupHeader,
    });
  }
  return out;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Moves `r` down until it overlaps none of `obstacles`. */
export function placeFree(r: Rect, obstacles: readonly Rect[]): Rect {
  let cur = r;
  for (let guard = 0; guard <= obstacles.length; guard++) {
    let bottom = -Infinity;
    for (const o of obstacles) if (overlaps(cur, o)) bottom = Math.max(bottom, o.y + o.h);
    if (bottom === -Infinity) return cur;
    cur = { ...cur, y: bottom + LAYOUT.rowGap };
  }
  return cur;
}

/**
 * Top-level components: units linked by flow relations. Each carries a
 * signature over its own nodes and layout-shaping relations, so an unchanged
 * component can be recognised across topology changes.
 */
export function componentsOf(graph: LayoutGraph): { key: string; units: string[]; members: string[]; signature: string }[] {
  const units = graph.nodes.map((n) => n.id).filter((id) => !graph.parentOf.has(id));
  const root = new Map(units.map((u) => [u, u]));
  const find = (u: string) => {
    let r = u;
    while (root.get(r) !== r) r = root.get(r)!;
    for (let c = u; root.get(c) !== r; ) {
      const next = root.get(c)!;
      root.set(c, r);
      c = next;
    }
    return r;
  };
  const unit = new Map(graph.nodes.map((n) => [n.id, unitOf(graph, n.id)]));
  for (const e of graph.flow) {
    const a = find(unit.get(e.from)!);
    const b = find(unit.get(e.to)!);
    if (a !== b) root.set(byId(a, b) < 0 ? b : a, byId(a, b) < 0 ? a : b);
  }
  const comps = new Map<string, { units: string[]; members: string[] }>();
  for (const n of graph.nodes) {
    const key = find(unit.get(n.id)!);
    const c = comps.get(key) ?? { units: [], members: [] };
    c.members.push(n.id);
    if (!graph.parentOf.has(n.id)) c.units.push(n.id);
    comps.set(key, c);
  }
  const compOf = (id: string) => find(unit.get(id)!);
  // Sizes join the component signature: a component whose nodes were resized at
  // a transition moment counts as changed, so stabilization re-lays it out.
  const sizes = new Map(graph.nodes.map((n) => [n.id, { w: n.w, h: n.h }]));
  return [...comps].map(([key, c]) => {
    const inside = new Set(c.members);
    return {
      key,
      ...c,
      signature: topologySignature(
        c.members,
        graph.flow.filter((e) => inside.has(e.from) && compOf(e.from) === key),
        new Map([...graph.parentOf].filter(([child]) => inside.has(child))),
        sizes,
      ) + packMark(graph),
    };
  });
}

function componentRect(graph: LayoutGraph, members: readonly string[], positions: Positions): Rect | undefined {
  const size = new Map(graph.nodes.map((n) => [n.id, n]));
  const inside = new Set(members);
  const leafRect = (id: string): Rect | undefined => {
    const p = positions.get(id);
    return p && inside.has(id) ? { x: p.x, y: p.y, w: size.get(id)!.w, h: size.get(id)!.h } : undefined;
  };
  const groups = containerRects(graph, leafRect);
  return union(
    members.map((id) => (groups.get(id) ?? leafRect(id))!).filter((r) => r !== undefined),
  );
}

/**
 * The one row packer: boxes into rows toward the engine aspect ratio, in their
 * current top-to-bottom order, the first row starting at `origin`. Returns each
 * box's shift (by input index), or null when there is nothing to pack.
 *
 * `sides` (inside containers): the side each box's relations leave the
 * container toward (-1 left, 0 none, +1 right). Left-linked boxes go first
 * (the top-left), right-linked last, and a last row holding a right-linked
 * box is right-aligned — so a relation leaving the packed box starts at the
 * edge it leaves from, as in the unpacked column.
 */
function packRows(rects: readonly Rect[], origin: Point, sides?: readonly number[]): Point[] | null {
  if (rects.length <= 1) return null;
  const side = (i: number) => sides?.[i] ?? 0;
  const order = rects
    .map((_, i) => i)
    .sort((a, b) => side(a) - side(b) || rects[a]!.y - rects[b]!.y || rects[a]!.x - rects[b]!.x || a - b);
  // Row width from total area toward the engine aspect: W such that W : (area/W) ≈ aspect.
  let area = 0;
  let widest = 0;
  for (const r of rects) {
    area += (r.w + LAYOUT.colGap) * (r.h + LAYOUT.rowGap * 2);
    widest = Math.max(widest, r.w);
  }
  const rowWidth = Math.max(widest, Math.sqrt(area * LAYOUT.aspect));
  const shifts: Point[] = new Array(rects.length);
  let x = origin.x;
  let y = origin.y;
  let rowH = 0;
  let row: number[] = [];
  let right = origin.x;
  for (const i of order) {
    const r = rects[i]!;
    // Wrap at the nearest box boundary: a box whose midpoint still fits stays
    // in the row (rows quantize, the width target cannot be exact).
    if (x > origin.x && x + r.w / 2 > origin.x + rowWidth) {
      x = origin.x;
      y += rowH + LAYOUT.rowGap * 2;
      rowH = 0;
      row = [];
    }
    shifts[i] = { x: x - r.x, y: y - r.y };
    row.push(i);
    right = Math.max(right, x + r.w);
    x += r.w + LAYOUT.colGap;
    rowH = Math.max(rowH, r.h);
  }
  if (row.some((i) => side(i) > 0)) {
    const slack = right - (x - LAYOUT.colGap);
    if (slack > 0) for (const i of row) shifts[i] = { x: shifts[i]!.x + slack, y: shifts[i]!.y };
  }
  return shifts;
}

/**
 * Packs top-level components into rows toward the engine aspect ratio, in
 * their current top-to-bottom order — instead of one tall column of
 * unrelated groups.
 */
export function packComponents(graph: LayoutGraph, positions: Positions): Positions {
  // One pass over the container boxes serves every component (a container's
  // descendants all belong to its component).
  const size = new Map(graph.nodes.map((n) => [n.id, n]));
  const leafRect = (id: string): Rect | undefined => {
    const p = positions.get(id);
    return p ? { x: p.x, y: p.y, w: size.get(id)!.w, h: size.get(id)!.h } : undefined;
  };
  const groups = containerRects(graph, leafRect);
  const list = componentsOf(graph)
    .map((c) => ({ ...c, rect: union(c.members.map((id) => groups.get(id) ?? leafRect(id)).filter((r): r is Rect => r !== undefined)) }))
    .filter((c): c is typeof c & { rect: Rect } => c.rect !== undefined);
  const shifts = packRows(list.map((c) => c.rect), { x: LAYOUT.pad, y: LAYOUT.pad });
  if (!shifts) return positions;
  const shift = new Map<string, Point>();
  list.forEach((c, i) => {
    for (const m of c.members) shift.set(m, shifts[i]!);
  });
  return new Map([...positions].map(([id, p]) => {
    const d = shift.get(id) ?? { x: 0, y: 0 };
    return [id, { x: p.x + d.x, y: p.y + d.y }];
  }));
}

type SiblingLink = { level: string | undefined; from: string; to: string; edge: { from: string; to: string } };

/**
 * Flow relations lifted to the sibling pair under their lowest common
 * container (`level`; undefined = top level): a relation between descendants
 * counts for their sibling ancestors (`edge` keeps the real endpoints).
 * Relations within one unit's own chain lift to nothing.
 */
function siblingLinks(graph: LayoutGraph, depth: ReadonlyMap<string, number>): SiblingLink[] {
  const out: SiblingLink[] = [];
  for (const e of graph.flow) {
    let a: string | undefined = e.from;
    let b: string | undefined = e.to;
    let da = depth.get(a)!;
    let db = depth.get(b)!;
    while (da > db) (a = graph.parentOf.get(a!)), da--;
    while (db > da) (b = graph.parentOf.get(b!)), db--;
    while (a !== undefined && b !== undefined && graph.parentOf.get(a) !== graph.parentOf.get(b)) {
      a = graph.parentOf.get(a);
      b = graph.parentOf.get(b);
    }
    if (a === undefined || b === undefined || a === b) continue;
    out.push({ level: graph.parentOf.get(a), from: a, to: b, edge: e });
  }
  return out;
}

const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * Component packing inside every container, deepest first (a container's box
 * is final before its parent packs it). ELK puts edge-less siblings in one
 * layer, so unrelated children would otherwise stack into one column.
 *
 * At every level (each container's children, then the top-level units):
 *  1. Re-separation, per component of siblings linked by flow. A block whose
 *     box changed below (a packed container) is re-anchored at its original
 *     top-left; then every growth is inserted as space at the grown block's
 *     original right / bottom edge — a block starting at or past that line
 *     shifts by the growth. The shift is monotone in the original coordinate,
 *     so every pair keeps the axis it was separated on: no overlap, the ELK
 *     order (left-to-right layers, top-to-bottom within) is kept. Shrinks
 *     leave space, never pull anything (pulling could collide).
 *  2. Re-attachment (best effort, edge length): an unchanged block linked to
 *     a changed one is moved to restore its original offset to the linked
 *     endpoints (both axes, then y only, then x only) — the first of those
 *     spots that is free of every sibling box (with half the spacing gap)
 *     and shortens its flow edges. Otherwise it stays where step 1 put it.
 *  3. Inside a container, the components are row-packed toward the engine
 *     aspect from the content's top-left; the box is re-derived with the
 *     same padding and header. (Top level: packComponents does this.)
 */
function packWithinContainers(graph: LayoutGraph, positions: Positions): Positions {
  const children = childrenOf(graph);
  const depth = nestDepths(graph);
  const containers = [...children.keys()].filter((k): k is string => k !== undefined).sort((a, b) => depth.get(b)! - depth.get(a)!);
  if (containers.length === 0) return positions;
  const size = new Map(graph.nodes.map((n) => [n.id, n]));
  // `orig`: every box before packing (the reference frame); `rect`: the live boxes.
  const orig = new Map<string, Rect>();
  for (const [id, p] of positions) {
    const s = size.get(id);
    if (s) orig.set(id, { x: p.x, y: p.y, w: s.w, h: s.h });
  }
  for (const [id, r] of containerRects(graph, (id) => orig.get(id))) orig.set(id, r);
  const rect = new Map(orig);
  // Each node's subtree (itself included): what moves when the node moves.
  const under = new Map<string, string[]>();
  for (const n of graph.nodes) {
    for (let cur: string | undefined = n.id, guard = 0; cur !== undefined && guard <= LAYOUT.maxNestDepth + 1; cur = graph.parentOf.get(cur), guard++) {
      const list = under.get(cur);
      if (list) list.push(n.id);
      else under.set(cur, [n.id]);
    }
  }
  const shiftTree = (k: string, dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    for (const id of under.get(k) ?? [k]) {
      const r = rect.get(id);
      if (r) rect.set(id, { ...r, x: r.x + dx, y: r.y + dy });
    }
  };
  const linksAt = new Map<string | undefined, SiblingLink[]>();
  for (const l of siblingLinks(graph, depth)) {
    const list = linksAt.get(l.level);
    if (list) list.push(l);
    else linksAt.set(l.level, [l]);
  }
  const gap = Math.min(LAYOUT.rowGap, LAYOUT.colGap) / 2;
  // Which side each child's relations leave its container toward (original
  // frame): for every flow relation, every container holding one end but not
  // the other gets a vote for the child on that end's path.
  const votes = new Map<string, Map<string, number>>();
  const chain = (id: string) => {
    const out: string[] = [id];
    for (let p = graph.parentOf.get(id), guard = 0; p !== undefined && guard <= LAYOUT.maxNestDepth + 1; p = graph.parentOf.get(p), guard++) out.push(p);
    return out;
  };
  for (const e of graph.flow) {
    for (const [u, v] of [[e.from, e.to], [e.to, e.from]] as const) {
      const ov = orig.get(v);
      if (!ov) continue;
      const cu = chain(u);
      const cv = new Set(chain(v));
      for (let i = 1; i < cu.length; i++) {
        const box = cu[i]!;
        if (cv.has(box)) break;
        const ob = orig.get(box);
        if (!ob) continue;
        const m = votes.get(box) ?? new Map<string, number>();
        m.set(cu[i - 1]!, (m.get(cu[i - 1]!) ?? 0) + Math.sign(centre(ov).x - centre(ob).x));
        votes.set(box, m);
      }
    }
  }

  const reseparate = (comp: readonly string[], links: readonly SiblingLink[]) => {
    const changed = new Set(
      comp.filter((k) => {
        const o = orig.get(k)!;
        const n = rect.get(k)!;
        return o.x !== n.x || o.y !== n.y || o.w !== n.w || o.h !== n.h;
      }),
    );
    if (changed.size === 0) return;
    const cutsX: [number, number][] = [];
    const cutsY: [number, number][] = [];
    for (const k of changed) {
      const o = orig.get(k)!;
      const n = rect.get(k)!;
      shiftTree(k, o.x - n.x, o.y - n.y);
      if (n.w > o.w) cutsX.push([o.x + o.w, n.w - o.w]);
      if (n.h > o.h) cutsY.push([o.y + o.h, n.h - o.h]);
    }
    const along = (cuts: readonly [number, number][], v: number) => {
      let s = 0;
      for (const [c, amount] of cuts) if (c <= v) s += amount;
      return s;
    };
    for (const k of comp) {
      const o = orig.get(k)!;
      shiftTree(k, along(cutsX, o.x), along(cutsY, o.y));
    }
    // Re-attachment of unchanged blocks to the changed ones they link to.
    for (const k of comp) {
      if (changed.has(k)) continue;
      const mine = links.filter((l) => l.from === k || l.to === k);
      const toChanged = mine.filter((l) => changed.has(l.from === k ? l.to : l.from));
      if (toChanged.length === 0) continue;
      const ends = (l: SiblingLink) => (l.from === k ? [l.edge.from, l.edge.to] : [l.edge.to, l.edge.from]) as [string, string];
      let dx = 0;
      let dy = 0;
      for (const l of toChanged) {
        const [own, other] = ends(l);
        const now = { a: centre(rect.get(own)!), b: centre(rect.get(other)!) };
        const was = { a: centre(orig.get(own)!), b: centre(orig.get(other)!) };
        dx += now.b.x - now.a.x - (was.b.x - was.a.x);
        dy += now.b.y - now.a.y - (was.b.y - was.a.y);
      }
      dx /= toChanged.length;
      dy /= toChanged.length;
      const cost = (sx: number, sy: number) => {
        let s = 0;
        for (const l of mine) {
          const [own, other] = ends(l);
          const a = centre(rect.get(own)!);
          const b = centre(rect.get(other)!);
          s += Math.hypot(a.x + sx - b.x, a.y + sy - b.y);
        }
        return s;
      };
      const r = rect.get(k)!;
      const free = (sx: number, sy: number) => {
        const t = { x: r.x + sx - gap, y: r.y + sy - gap, w: r.w + 2 * gap, h: r.h + 2 * gap };
        return comp.every((o) => o === k || !overlaps(t, rect.get(o)!));
      };
      let best: [number, number] | null = null;
      let bestCost = cost(0, 0);
      for (const [sx, sy] of [[dx, dy], [0, dy], [dx, 0]] as const) {
        if ((sx === 0 && sy === 0) || !free(sx, sy)) continue;
        const c = cost(sx, sy);
        if (c < bestCost - 1e-6) {
          best = [sx, sy];
          bestCost = c;
        }
      }
      if (best) shiftTree(k, best[0], best[1]);
    }
  };

  /** Re-separates the level's components; returns them (children order). */
  const level = (parent: string | undefined): string[][] => {
    const kids = (children.get(parent) ?? []).filter((k) => rect.has(k));
    const links = (linksAt.get(parent) ?? []).filter((l) => rect.has(l.from) && rect.has(l.to) && rect.has(l.edge.from) && rect.has(l.edge.to));
    const root = new Map(kids.map((k) => [k, k]));
    const find = (k: string) => {
      let r = k;
      while (root.get(r) !== r) r = root.get(r)!;
      root.set(k, r);
      return r;
    };
    for (const l of links) {
      const ra = find(l.from);
      const rb = find(l.to);
      if (ra !== rb) root.set(byId(ra, rb) < 0 ? rb : ra, byId(ra, rb) < 0 ? ra : rb);
    }
    const groups = new Map<string, string[]>();
    for (const k of kids) {
      const r = find(k);
      const g = groups.get(r);
      if (g) g.push(k);
      else groups.set(r, [k]);
    }
    const comps = [...groups.values()];
    for (const comp of comps) {
      if (comp.length < 2) continue;
      const inside = new Set(comp);
      reseparate(comp, links.filter((l) => inside.has(l.from)));
    }
    return comps;
  };

  for (const c of containers) {
    const comps = level(c);
    const kids = comps.flat();
    const content = union(kids.map((k) => rect.get(k)!));
    if (!content) continue;
    const vote = votes.get(c);
    const sides = comps.map((g) => Math.sign(g.reduce((s, k) => s + (vote?.get(k) ?? 0), 0)));
    const shifts = packRows(comps.map((g) => union(g.map((k) => rect.get(k)!))!), { x: content.x, y: content.y }, sides);
    if (shifts) comps.forEach((g, i) => g.forEach((k) => shiftTree(k, shifts[i]!.x, shifts[i]!.y)));
    const inner = union(kids.map((k) => rect.get(k)!))!;
    rect.set(c, {
      x: inner.x - LAYOUT.groupPad,
      y: inner.y - LAYOUT.groupPad - LAYOUT.groupHeader,
      w: inner.w + 2 * LAYOUT.groupPad,
      h: inner.h + 2 * LAYOUT.groupPad + LAYOUT.groupHeader,
    });
  }
  level(undefined);
  return new Map([...positions].map(([id, p]) => {
    const r = rect.get(id);
    return [id, r ? { x: r.x, y: r.y } : p];
  }));
}

/**
 * The packing stage every layout result passes: inside containers (unless the
 * graph opts out), then the top-level components.
 */
export function packLayout(graph: LayoutGraph, positions: Positions): Positions {
  return packComponents(graph, graph.packContainers === false ? positions : packWithinContainers(graph, positions));
}

/**
 * Synchronous longest-path layout, iterative and budgeted: shown at once, and
 * whenever the layered engine is unavailable or the graph is over its limit.
 * Siblings are layered by flow relations among them (a relation between
 * descendants counts for their sibling ancestors); a container is sized by its
 * content. Over the budget, each unit becomes a plain block grid.
 */
export function fallbackLayout(graph: LayoutGraph): Positions {
  if (graph.nodes.length + graph.flow.length > LAYOUT.fallbackBudget) return blockGrid(graph);
  const children = childrenOf(graph);
  const depth = nestDepths(graph);
  const size = new Map(graph.nodes.map((n) => [n.id, { w: n.w, h: n.h }]));

  // Flow relations lifted to the sibling pair under their lowest common container.
  const levelEdges = new Map<string | undefined, Map<string, Set<string>>>();
  for (const { level, from: a, to: b } of siblingLinks(graph, depth)) {
    const m = levelEdges.get(level) ?? new Map<string, Set<string>>();
    m.set(b, (m.get(b) ?? new Set()).add(a));
    levelEdges.set(level, m);
  }

  // Relative placement of each level's members, innermost containers first.
  const relative = new Map<string, Point>();
  const layoutLevel = (level: string | undefined) => {
    const members = children.get(level) ?? [];
    const incoming = levelEdges.get(level) ?? new Map<string, Set<string>>();
    // Kahn layering; members left on a cycle go one column past the rest.
    const indeg = new Map(members.map((m) => [m, 0]));
    const out = new Map<string, string[]>();
    for (const [to, froms] of incoming) {
      for (const f of froms) {
        indeg.set(to, indeg.get(to)! + 1);
        out.set(f, [...(out.get(f) ?? []), to]);
      }
    }
    const col = new Map<string, number>();
    const queue = members.filter((m) => indeg.get(m) === 0);
    for (const m of queue) col.set(m, 0);
    for (let i = 0; i < queue.length; i++) {
      const m = queue[i]!;
      for (const t of out.get(m) ?? []) {
        col.set(t, Math.max(col.get(t) ?? 0, col.get(m)! + 1));
        indeg.set(t, indeg.get(t)! - 1);
        if (indeg.get(t) === 0) queue.push(t);
      }
    }
    let maxCol = 0;
    for (const c of col.values()) maxCol = Math.max(maxCol, c);
    for (const m of members) if (!col.has(m) || indeg.get(m)! > 0) col.set(m, maxCol + 1);
    const columns = new Map<number, string[]>();
    for (const m of members) columns.set(col.get(m)!, [...(columns.get(col.get(m)!) ?? []), m]);
    let x = 0;
    let maxH = 0;
    for (const ci of [...columns.keys()].sort((a, b) => a - b)) {
      const ids = columns.get(ci)!;
      let colW = 0;
      let y = 0;
      for (const m of ids) {
        const s = size.get(m)!;
        relative.set(m, { x, y });
        y += s.h + LAYOUT.rowGap;
        colW = Math.max(colW, s.w);
      }
      maxH = Math.max(maxH, y - LAYOUT.rowGap);
      x += colW + LAYOUT.colGap;
    }
    return { w: Math.max(0, x - LAYOUT.colGap), h: maxH };
  };
  const containers = [...children.keys()].filter((k): k is string => k !== undefined).sort((a, b) => depth.get(b)! - depth.get(a)!);
  for (const c of containers) {
    const inner = layoutLevel(c);
    size.set(c, { w: inner.w + 2 * LAYOUT.groupPad, h: inner.h + 2 * LAYOUT.groupPad + LAYOUT.groupHeader });
  }
  layoutLevel(undefined);

  // Absolute positions, top-down.
  const absolute = new Map<string, Point>();
  const order = [...graph.nodes].sort((a, b) => depth.get(a.id)! - depth.get(b.id)!);
  for (const n of order) {
    const r = relative.get(n.id)!;
    const p = graph.parentOf.get(n.id);
    const base = p === undefined ? { x: LAYOUT.pad, y: LAYOUT.pad } : absolute.get(p)!;
    const inset = p === undefined ? { x: 0, y: 0 } : { x: LAYOUT.groupPad, y: LAYOUT.groupPad + LAYOUT.groupHeader };
    absolute.set(n.id, { x: base.x + inset.x + r.x, y: base.y + inset.y + r.y });
  }
  const out = new Map<string, Point>();
  for (const id of leafIds(graph)) out.set(id, absolute.get(id)!);
  return packLayout(graph, out);
}

/** Over-budget fallback: each unit's leaves as a square block, blocks in rows. O(n). */
function blockGrid(graph: LayoutGraph): Positions {
  const perUnit = new Map<string, string[]>();
  for (const id of leafIds(graph)) {
    const u = unitOf(graph, id);
    const list = perUnit.get(u);
    if (list) list.push(id);
    else perUnit.set(u, [id]);
  }
  // Cells fit the largest box in the graph, so grown (tiered) nodes never overlap here either.
  let maxW: number = GENERIC_NODE_SIZE.w;
  let maxH: number = GENERIC_NODE_SIZE.h;
  for (const n of graph.nodes) {
    if (n.w > maxW) maxW = n.w;
    if (n.h > maxH) maxH = n.h;
  }
  const cellW = maxW + LAYOUT.colGap / 2;
  const cellH = maxH + LAYOUT.rowGap / 2;
  const total = graph.nodes.length;
  const rowWidth = Math.sqrt(total * cellW * cellH * LAYOUT.aspect);
  const out = new Map<string, Point>();
  let x = LAYOUT.pad;
  let y = LAYOUT.pad;
  let rowH = 0;
  for (const leaves of perUnit.values()) {
    const cols = Math.ceil(Math.sqrt(leaves.length));
    const w = cols * cellW + 2 * LAYOUT.groupPad;
    const h = Math.ceil(leaves.length / cols) * cellH + 2 * LAYOUT.groupPad + LAYOUT.groupHeader;
    if (x > LAYOUT.pad && x + w > LAYOUT.pad + rowWidth) {
      x = LAYOUT.pad;
      y += rowH + LAYOUT.rowGap;
      rowH = 0;
    }
    leaves.forEach((id, i) => {
      out.set(id, {
        x: x + LAYOUT.groupPad + (i % cols) * cellW,
        y: y + LAYOUT.groupPad + LAYOUT.groupHeader + Math.floor(i / cols) * cellH,
      });
    });
    x += w + LAYOUT.colGap;
    rowH = Math.max(rowH, h);
  }
  return out;
}

/**
 * Stabilizes a fresh layout against the previous one, per component: a
 * component whose own topology did not change keeps its previous positions
 * exactly; a changed or new component takes the fresh layout, shifted by the
 * mean displacement of the nodes it shares with the previous layout, then
 * moved down out of anything it would overlap.
 */
export function stabilize(graph: LayoutGraph, next: Positions, prevGraph: LayoutGraph, previous: Positions): Positions {
  const before = new Set(componentsOf(prevGraph).map((c) => c.signature));
  const out = new Map<string, Point>();
  const placed: Rect[] = [];
  const moving: { members: string[]; leaves: string[] }[] = [];
  const leaves = new Set(leafIds(graph));
  for (const c of componentsOf(graph)) {
    const own = c.members.filter((m) => leaves.has(m));
    if (before.has(c.signature) && own.every((id) => previous.has(id))) {
      for (const id of own) out.set(id, previous.get(id)!);
      const r = componentRect(graph, c.members, previous);
      if (r) placed.push(r);
    } else {
      moving.push({ members: c.members, leaves: own });
    }
  }
  const pending = moving.map((c) => {
    let dx = 0, dy = 0, n = 0;
    for (const id of c.leaves) {
      const p = next.get(id);
      const q = previous.get(id);
      if (!p || !q) continue;
      dx += q.x - p.x;
      dy += q.y - p.y;
      n++;
    }
    const d = n > 0 ? { x: dx / n, y: dy / n } : { x: 0, y: 0 };
    const pos = new Map(c.leaves.map((id) => [id, { x: next.get(id)!.x + d.x, y: next.get(id)!.y + d.y }]));
    return { ...c, pos, rect: componentRect(graph, c.members, pos) };
  });
  pending.sort((a, b) => (a.rect?.y ?? 0) - (b.rect?.y ?? 0));
  for (const c of pending) {
    if (!c.rect) continue;
    const free = placeFree(c.rect, placed);
    const dy = free.y - c.rect.y;
    for (const [id, p] of c.pos) out.set(id, { x: p.x, y: p.y + dy });
    placed.push(free);
  }
  return out;
}

/**
 * The positions shown the moment the topology changes, before the layered
 * pass: existing leaves keep their positions; a new leaf takes its fallback
 * position, moved out of any existing node or group it would overlap.
 */
export function interimLayout(graph: LayoutGraph, fallback: Positions, prevGraph: LayoutGraph, previous: Positions): Positions {
  const prevSize = new Map(prevGraph.nodes.map((n) => [n.id, n]));
  const leafRect = (id: string): Rect | undefined => {
    const p = previous.get(id);
    const s = prevSize.get(id);
    return p && s ? { x: p.x, y: p.y, w: s.w, h: s.h } : undefined;
  };
  const obstacles: Rect[] = [...containerRects(prevGraph, leafRect).values()];
  for (const id of previous.keys()) {
    const r = leafRect(id);
    if (r) obstacles.push(r);
  }
  const out = new Map<string, Point>();
  const fresh: string[] = [];
  for (const id of leafIds(graph)) {
    const q = previous.get(id);
    if (q) out.set(id, q);
    else fresh.push(id);
  }
  const size = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const id of fresh) {
    const p = fallback.get(id)!;
    const s = size.get(id) ?? GENERIC_NODE_SIZE;
    const r = placeFree({ x: p.x, y: p.y, w: s.w, h: s.h }, obstacles);
    out.set(id, { x: r.x, y: r.y });
    obstacles.push(r);
  }
  return out;
}

/** Why a layered result cannot be used, or null: every leaf, nothing else, finite coordinates. */
export function positionsProblem(graph: LayoutGraph, positions: Positions): string | null {
  const leaves = leafIds(graph);
  if (positions.size !== leaves.length) return `expected ${leaves.length} leaf positions, got ${positions.size}`;
  for (const id of leaves) {
    const p = positions.get(id);
    if (!p) return `no position for '${id}'`;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return `non-finite position for '${id}'`;
  }
  return null;
}
