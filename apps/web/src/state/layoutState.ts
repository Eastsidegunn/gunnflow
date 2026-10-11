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
import { msgOf, tm, type Msg } from '../i18n/index.js';

/** Why the fallback shows: a catalog message, rendered in the current language when read. */
type Why = Msg;

/** Above this many nodes the layered engine is not used; the fallback stands. */
export const LAYERED_MAX_NODES = 1500;

export type LayoutSource = 'interim' | 'fallback' | 'layered';

export interface LayoutStateOptions {
  /** Loads the layered provider (lazy chunk). A failure is retried on the next topology change. */
  loadProvider?: () => Promise<LayoutProvider>;
  maxNodes?: number;
}

const loadElkWorker = () => import('../canvas/elkLayout.js').then((m) => m.createElkWorkerProvider());

export function createLayoutState(options: LayoutStateOptions = {}) {
  const load = options.loadProvider ?? loadElkWorker;
  const maxNodes = options.maxNodes ?? LAYERED_MAX_NODES;
  const [positions, setPositions] = createSignal<Positions>(new Map());
  const [source, setSource] = createSignal<LayoutSource>('fallback');
  const [why, setReason] = createSignal<Why | null>(null);
  const reason = (): string | null => {
    const w = why();
    return tm(w);
  };
  const [withheld, setWithheld] = createSignal(0);

  let signature: string | null = null;
  let generation = 0;
  /** What is on screen, and the graph it was computed for. */
  let shown: { graph: LayoutGraph; positions: Positions } | null = null;
  /** The last layered result: the basis for hints and stabilization. */
  let basis: { graph: LayoutGraph; positions: Positions } | null = null;
  let provider: Promise<LayoutProvider> | null = null;
  /** The one in-flight preload (concurrent calls share it). */
  let preloading: Promise<void> | null = null;
  let disposed = false;
  /** The provider, loaded once; a failed load clears only its own attempt (a newer one stands). */
  const loadProvider = async (): Promise<LayoutProvider> => {
    if (disposed) throw new Error('layout state disposed');
    const mine = (provider ??= load());
    try {
      const p = await mine;
      // Disposed while loading: release what just arrived.
      if (disposed) p.dispose?.();
      return p;
    } catch (err) {
      if (provider === mine) provider = null; // retried on the next topology change
      throw err;
    }
  };
  let running = false;
  let queued: { graph: LayoutGraph; gen: number } | null = null;

  const show = (graph: LayoutGraph, next: Positions, from: LayoutSource, why: Why | null = null) => {
    shown = { graph, positions: next };
    setPositions(next);
    setSource(from);
    setReason(why);
  };

  const fail = (graph: LayoutGraph, gen: number, why: Why) => {
    if (disposed || gen !== generation) return;
    basis = null;
    show(graph, fallbackLayout(graph), 'fallback', why);
  };

  const pass = async (graph: LayoutGraph, gen: number) => {
    running = true;
    try {
      let p: LayoutProvider;
      try {
        p = await loadProvider();
      } catch (err) {
        return fail(graph, gen, { key: 'layout.reason.unavailable', params: { detail: msgOf(err) } });
      }
      if (disposed || gen !== generation) return;
      let result: Positions;
      try {
        result = await p.layout(graph, basis?.positions);
      } catch (err) {
        return fail(graph, gen, { key: 'layout.reason.failed', params: { detail: msgOf(err) } });
      }
      if (disposed || gen !== generation) return;
      const problem = positionsProblem(graph, result);
      if (problem) return fail(graph, gen, { key: 'layout.reason.invalid', params: { detail: problem } });
      const next = basis ? stabilize(graph, result, basis.graph, basis.positions) : result;
      basis = { graph, positions: next };
      show(graph, next, 'layered');
    } finally {
      running = false;
      const q = queued;
      queued = null;
      if (q && q.gen === generation && !disposed) void pass(q.graph, q.gen);
    }
  };

  return {
    /**
     * Loads the layered engine ahead of the first canvas (its code chunk and
     * worker script), so a later switch to the full view fetches nothing. The
     * warm-up goes through the provider's own pass path (serialized with
     * passes, same time limit); a failure leaves the next pass to retry.
     */
    preload(): Promise<void> {
      if (preloading) return preloading;
      const attempt = (async () => {
        const p = await loadProvider();
        await p.warm?.();
      })();
      preloading = attempt;
      attempt.catch(() => {
        if (preloading === attempt) preloading = null;
      });
      return attempt;
    },
    /**
     * Releases the engine: the pass in flight is rejected at once and its
     * result never applied, queued topology work is dropped, the worker is
     * terminated, and later updates and loads do nothing.
     */
    dispose() {
      disposed = true;
      generation++;
      queued = null;
      const p = provider;
      provider = null;
      void p?.then((x) => x.dispose?.(), () => undefined);
    },
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
      if (disposed) return;
      setWithheld(graph.withheld.length);
      if (graph.signature === signature) return;
      signature = graph.signature;
      const gen = ++generation;
      const fallback = fallbackLayout(graph);
      const layered = graph.nodes.length > 0 && graph.nodes.length <= maxNodes;
      if (!layered) {
        basis = null;
        show(graph, fallback, 'fallback', graph.nodes.length > maxNodes ? { key: 'layout.reason.overLimit', params: { count: graph.nodes.length, max: maxNodes } } : null);
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
