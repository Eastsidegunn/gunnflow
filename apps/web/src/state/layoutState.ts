/**
 * Computed layout — view state, like camera and drag positions: local-only,
 * meaningless to upstream, never written into the projection.
 *
 * Stability: the topology signature is the cache key — an unchanged signature
 * (the same snapshot re-sent, a state change) recomputes nothing and moves
 * nothing. On a change, the interim layout shows at once (existing nodes stay,
 * new ones go to free space), then the layered engine runs with the previous
 * positions as hints and the result is stabilized per component. Only the
 * latest topology is ever laid out; results for older ones are dropped. User
 * drags stay on top (ViewState.positions()).
 *
 * `source` says what is on screen: `interim` (waiting for a layered pass),
 * `fallback` (no layered pass will come: over the limit, engine unavailable,
 * pass failed or invalid — with the reason) or `layered`.
 */
import { createSignal } from 'solid-js';
import {
  fallbackLayout,
  interimLayout,
  positionsProblem,
  stabilize,
  type LayoutGraph,
  type LayoutProvider,
  type Positions,
} from '../canvas/layoutGraph.js';

/** Above this many nodes the layered engine is not used; the fallback stands. */
export const LAYERED_MAX_NODES = 1500;

export type LayoutSource = 'interim' | 'fallback' | 'layered';

export interface LayoutStateOptions {
  /** Loads the layered provider (lazy chunk). A failure is retried on the next topology change. */
  loadProvider?: () => Promise<LayoutProvider>;
  maxNodes?: number;
}

const loadElkWorker = () => import('../canvas/elkLayout.js').then((m) => m.createElkWorkerProvider());
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createLayoutState(options: LayoutStateOptions = {}) {
  const load = options.loadProvider ?? loadElkWorker;
  const maxNodes = options.maxNodes ?? LAYERED_MAX_NODES;
  const [positions, setPositions] = createSignal<Positions>(new Map());
  const [source, setSource] = createSignal<LayoutSource>('fallback');
  const [reason, setReason] = createSignal<string | null>(null);
  const [withheld, setWithheld] = createSignal(0);

  let signature: string | null = null;
  let generation = 0;
  /** What is on screen, and the graph it was computed for. */
  let shown: { graph: LayoutGraph; positions: Positions } | null = null;
  /** The last layered result: the basis for hints and stabilization. */
  let basis: { graph: LayoutGraph; positions: Positions } | null = null;
  let provider: Promise<LayoutProvider> | null = null;
  let running = false;
  let queued: { graph: LayoutGraph; gen: number } | null = null;

  const show = (graph: LayoutGraph, next: Positions, from: LayoutSource, why: string | null = null) => {
    shown = { graph, positions: next };
    setPositions(next);
    setSource(from);
    setReason(why);
  };

  const fail = (graph: LayoutGraph, gen: number, why: string) => {
    if (gen !== generation) return;
    basis = null;
    show(graph, fallbackLayout(graph), 'fallback', why);
  };

  const pass = async (graph: LayoutGraph, gen: number) => {
    running = true;
    try {
      let p: LayoutProvider;
      try {
        provider ??= load();
        p = await provider;
      } catch (err) {
        provider = null; // retried on the next topology change
        return fail(graph, gen, `layered engine unavailable: ${message(err)}`);
      }
      if (gen !== generation) return;
      let result: Positions;
      try {
        result = await p.layout(graph, basis?.positions);
      } catch (err) {
        return fail(graph, gen, `layered pass failed: ${message(err)}`);
      }
      if (gen !== generation) return;
      const problem = positionsProblem(graph, result);
      if (problem) return fail(graph, gen, `invalid layered result: ${problem}`);
      const next = basis ? stabilize(graph, result, basis.graph, basis.positions) : result;
      basis = { graph, positions: next };
      show(graph, next, 'layered');
    } finally {
      running = false;
      const q = queued;
      queued = null;
      if (q && q.gen === generation) void pass(q.graph, q.gen);
    }
  };

  return {
    positions,
    source,
    reason,
    /** Nodes whose grouping is withheld (several containers, or a containment cycle). */
    withheld,
    /** Resolves once no layered pass is running or queued. */
    async settled() {
      while (running || queued) await new Promise((r) => setTimeout(r, 1));
    },
    update(graph: LayoutGraph) {
      setWithheld(graph.withheld.length);
      if (graph.signature === signature) return;
      signature = graph.signature;
      const gen = ++generation;
      const fallback = fallbackLayout(graph);
      const layered = graph.nodes.length > 0 && graph.nodes.length <= maxNodes;
      if (!layered) {
        basis = null;
        show(graph, fallback, 'fallback', graph.nodes.length > maxNodes ? `over the layered limit (${graph.nodes.length} > ${maxNodes} nodes)` : null);
        return;
      }
      const interim = shown && basis ? interimLayout(graph, fallback, shown.graph, shown.positions) : fallback;
      show(graph, interim, 'interim');
      // Latest first: while a pass runs, only the newest topology waits.
      if (running) queued = { graph, gen };
      else void pass(graph, gen);
    },
  };
}

export type LayoutState = ReturnType<typeof createLayoutState>;
