/**
 * Layered layout (ELK) behind the layout port. The graph is compound: a
 * `contain` parent holds its children; `flow` relations are laid out
 * left-to-right across the hierarchy. With hints, ELK's interactive strategies
 * keep the previous order; per-component stabilization happens in the layout
 * state. Loaded lazily (its own chunk); the engine runs in a Web Worker.
 */
import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { MsgError, msg } from '../i18n/index.js';
import { LAYOUT, childrenOf, packLayout, type LayoutGraph, type LayoutProvider, type Point, type Positions } from './layoutGraph.js';

/** A layered pass that takes longer is abandoned (and its worker replaced). */
export const LAYERED_TIMEOUT_MS = 15_000;

const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.aspectRatio': String(LAYOUT.aspect),
  'elk.spacing.nodeNode': String(LAYOUT.rowGap),
  'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYOUT.colGap),
  'elk.spacing.componentComponent': String(LAYOUT.rowGap),
  // Edges need room of their own, or long flows hug and cross the node boxes.
  'elk.spacing.edgeNode': String(Math.round(LAYOUT.rowGap / 2)),
  'elk.spacing.edgeEdge': String(Math.round(LAYOUT.rowGap / 3)),
  'elk.layered.spacing.edgeNodeBetweenLayers': String(Math.round(LAYOUT.colGap / 3)),
  // Balanced placement with straighter long edges than the default.
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.padding': `[top=${LAYOUT.pad},left=${LAYOUT.pad},bottom=${LAYOUT.pad},right=${LAYOUT.pad}]`,
};
const INTERACTIVE_OPTIONS: Record<string, string> = {
  'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
  'elk.layered.layering.strategy': 'INTERACTIVE',
  'elk.layered.crossingMinimization.strategy': 'INTERACTIVE',
};
// Fresh passes are deterministic without help: ELK runs a fixed seed and the
// graph is built in id order. (`considerModelOrder` would make the order
// meaningful rather than merely stable, but elkjs 0.12 crashes with it on
// compound graphs with cross-hierarchy edges — ordered layout arrives with
// the sort stage instead.)
const GROUP_OPTIONS: Record<string, string> = {
  'elk.padding': `[top=${LAYOUT.groupPad + LAYOUT.groupHeader},left=${LAYOUT.groupPad},bottom=${LAYOUT.groupPad},right=${LAYOUT.groupPad}]`,
};

/** The graph as ELK input; hint coordinates are made relative to each parent. */
export function toElk(graph: LayoutGraph, hints?: Positions): ElkNode {
  const children = childrenOf(graph);
  const size = new Map(graph.nodes.map((n) => [n.id, n]));
  // A container's hinted origin: the top-left of its hinted content, minus its padding.
  const origin = new Map<string, Point>();
  const originOf = (id: string): Point | undefined => {
    if (origin.has(id)) return origin.get(id);
    const kids = children.get(id);
    let o: Point | undefined;
    if (!kids) {
      o = hints?.get(id);
    } else {
      let minX = Infinity;
      let minY = Infinity;
      for (const k of kids) {
        const p = originOf(k);
        if (!p) continue;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
      }
      if (minX !== Infinity) o = { x: minX - LAYOUT.groupPad, y: minY - LAYOUT.groupPad - LAYOUT.groupHeader };
    }
    if (o) origin.set(id, o);
    return o;
  };
  const build = (id: string, parentOrigin: Point): ElkNode => {
    const o = originOf(id);
    const at = o && hints ? { x: o.x - parentOrigin.x, y: o.y - parentOrigin.y } : {};
    const kids = children.get(id);
    if (!kids) return { id, width: size.get(id)!.w, height: size.get(id)!.h, ...at };
    // Hierarchy-aware strategies must match across levels, so groups carry the interactive ones too.
    const layoutOptions = hints ? { ...GROUP_OPTIONS, ...INTERACTIVE_OPTIONS } : GROUP_OPTIONS;
    return { id, layoutOptions, children: kids.map((k) => build(k, o ?? { x: 0, y: 0 })), ...at };
  };
  const edges: ElkExtendedEdge[] = graph.flow.map((e, i) => ({ id: `f${i}`, sources: [e.from], targets: [e.to] }));
  return {
    id: '__root',
    layoutOptions: hints ? { ...ROOT_OPTIONS, ...INTERACTIVE_OPTIONS } : ROOT_OPTIONS,
    children: (children.get(undefined) ?? []).map((id) => build(id, { x: 0, y: 0 })),
    edges,
  };
}

/** Absolute leaf positions from an ELK result; a missing coordinate stays NaN (the result is then refused). */
export function fromElk(result: ElkNode): Map<string, Point> {
  const out = new Map<string, Point>();
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? NaN);
      const y = oy + (c.y ?? NaN);
      if (c.children && c.children.length > 0) walk(c, x, y);
      else out.set(c.id, { x, y });
    }
  };
  walk(result, 0, 0);
  return out;
}

/** A provider over any ELK-compatible `layout` function (in-thread for tests, worker in the app). */
export function elkProvider(run: (graph: ElkNode) => Promise<ElkNode>): LayoutProvider {
  return {
    async layout(graph, hints) {
      return packLayout(graph, fromElk(await run(toElk(graph, hints))));
    },
  };
}

/** What the worker provider needs of an ELK engine (the real one, or a stand-in in tests). */
export interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
  terminateWorker(): void;
}

const workerEngine = (): ElkEngine => new ELK({ workerFactory: () => new Worker(elkWorkerUrl) });

/**
 * The app's provider: ELK's own worker script in a Web Worker, created on
 * first use. Calls run one at a time (a warm-up and a pass never overlap). A
 * call over the time limit, or a failed one, terminates the worker (elkjs
 * never settles a call whose worker is gone, so the limit is what ends it);
 * the next call starts a fresh one.
 */
export function createElkWorkerProvider(timeoutMs = LAYERED_TIMEOUT_MS, makeEngine: () => ElkEngine = workerEngine): LayoutProvider {
  let elk: ElkEngine | null = null;
  let disposed = false;
  let lane: Promise<unknown> = Promise.resolve();
  /** Rejects the call in flight (elkjs never settles a call whose worker was terminated). */
  let abortActive: ((err: Error) => void) | null = null;
  const drop = () => {
    elk?.terminateWorker();
    elk = null;
  };
  /** The one path every engine call takes: serialized, time-limited, the worker dropped on failure. */
  const run = (graph: ElkNode): Promise<ElkNode> => {
    const call = async () => {
      if (disposed) throw new Error('layout engine disposed');
      const current = (elk ??= makeEngine());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          current.layout(graph),
          new Promise<never>((_, reject) => {
            abortActive = reject;
            timer = setTimeout(() => reject(new MsgError(msg('layout.problem.timeout', { ms: timeoutMs }))), timeoutMs);
          }),
        ]);
      } catch (err) {
        if (elk === current) drop();
        throw err;
      } finally {
        abortActive = null;
        clearTimeout(timer);
      }
    };
    const result = lane.then(call, call);
    lane = result.catch(() => undefined);
    return result;
  };
  return {
    ...elkProvider(run),
    /** Starts the worker (its script loads now) through the same path as a pass: one empty graph. */
    async warm() {
      await run({ id: 'warm', children: [] });
    },
    /** Terminates the worker and rejects the call in flight at once; later calls refuse. */
    dispose() {
      disposed = true;
      abortActive?.(new Error('layout engine disposed'));
      drop();
    },
  };
}
