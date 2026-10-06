/**
 * Execution stores (brief §28), kept strictly separate:
 *   ExecutionProjectionState — sessions + append-only event window (upstream)
 *   LiveTailState            — connected/stale, auto-scroll, unseen count
 *   PendingExecutionIntentState — session controls in flight
 * View state (tab/filter/selection) lives with the component.
 */
import { createSignal } from 'solid-js';
import type {
  ExecutionEvent,
  SessionIntent,
  SessionProjection,
} from '../model/executionTypes.js';
import type { IntentResult } from '../model/types.js';

/** Window retention (§17): cap the in-memory tail; identity of kept events intact. */
export const EVENT_WINDOW = 5000;

export type PostSessionIntent = (intent: SessionIntent) => Promise<IntentResult>;

/** Execution v1 wire may omit label; the id stands in. Pure fill, no facts. */
function normalizeSession(s: SessionProjection): SessionProjection {
  return s.label ? s : { ...s, label: s.id };
}

export function createExecutionStore(post: PostSessionIntent) {
  const [sessions, setSessions] = createSignal<readonly SessionProjection[]>([]);
  const [events, setEvents] = createSignal<readonly ExecutionEvent[]>([]);
  const [truncated, setTruncated] = createSignal(0);
  /** Upstream-declared window cut (contract truncatedBefore): a received fact, distinct from the local window. */
  const [upstreamTruncatedBefore, setUpstreamTruncatedBefore] = createSignal<number | null>(null);
  // 'unsupported'/'none' are stated upstream conditions (불변식 2), never shown as a connection loss.
  const [connection, setConnection] = createSignal<'connecting' | 'live' | 'lost' | 'unsupported' | 'none'>('connecting');
  const [lastEventAt, setLastEventAt] = createSignal<number | null>(null);
  const [pendingControls, setPendingControls] = createSignal<readonly SessionIntent[]>([]);
  const [controlError, setControlError] = createSignal<string | null>(null);

  const reconcilePending = (session: SessionProjection) => {
    setPendingControls((p) =>
      p.filter((intent) => {
        if (intent.sessionId !== session.id) return true;
        if (intent.intent === 'session.pause') return session.state !== 'paused';
        if (intent.intent === 'session.resume') return session.state !== 'running';
        return true;
      }),
    );
  };

  return {
    sessions,
    events,
    truncated,
    upstreamTruncatedBefore,
    connection,
    lastEventAt,
    pendingControls,
    controlError,
    dismissControlError: () => setControlError(null),

    applySnapshot(p: { sessions: SessionProjection[]; events: ExecutionEvent[]; truncatedBefore?: number }) {
      setSessions((p.sessions ?? []).map(normalizeSession));
      setUpstreamTruncatedBefore(p.truncatedBefore ?? null);
      const events = p.events ?? [];
      setEvents(events.slice(-EVENT_WINDOW));
      setTruncated(Math.max(0, events.length - EVENT_WINDOW));
      const last = events[events.length - 1];
      if (last) setLastEventAt(last.at);
      setConnection('live');
    },
    applyEvents(batch: ExecutionEvent[]) {
      setEvents((prev) => {
        const next = [...prev, ...batch];
        if (next.length > EVENT_WINDOW) {
          setTruncated((t) => t + (next.length - EVENT_WINDOW));
          return next.slice(-EVENT_WINDOW);
        }
        return next;
      });
      const last = batch[batch.length - 1];
      if (last) setLastEventAt(last.at);
    },
    applySession(raw: SessionProjection) {
      const session = normalizeSession(raw);
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === session.id);
        return exists ? prev.map((s) => (s.id === session.id ? session : s)) : [...prev, session];
      });
      reconcilePending(session);
    },
    // A terminal upstream state is a stated fact and never downgrades to "lost".
    markLost: () => setConnection((c) => (c === 'unsupported' || c === 'none' ? c : 'lost')),
    /** The BFF said the stream ends for a stated reason: unsupported surface or no execution. */
    markEnded: (state: 'unsupported' | 'none') => setConnection(state),

    /** Session control: pending → relay → projection (never local mutation). */
    async submitControl(intent: SessionIntent): Promise<IntentResult> {
      setPendingControls((p) => [...p, intent]);
      let result: IntentResult;
      try {
        result = await post(intent);
      } catch (err) {
        result = { accepted: false, reason: `relay unreachable: ${String(err)}` };
      }
      if (!result.accepted) {
        setPendingControls((p) => p.filter((x) => x !== intent));
        setControlError(result.reason ?? 'rejected');
      } else if (intent.intent === 'session.fork') {
        // Fork resolves when the child session shows up; the fake upstream is
        // fast enough that we simply clear on acceptance here.
        setPendingControls((p) => p.filter((x) => x !== intent));
      }
      return result;
    },
    hasPending(sessionId: string, intentType?: SessionIntent['intent']): boolean {
      return pendingControls().some(
        (p) => p.sessionId === sessionId && (!intentType || p.intent === intentType),
      );
    },
  };
}

export type ExecutionStore = ReturnType<typeof createExecutionStore>;

/** SSE transport for one task's execution stream. */
export function connectExecutionStream(store: ExecutionStore, taskId: string): () => void {
  const source = new EventSource(`/api/execution/${encodeURIComponent(taskId)}/stream`);
  source.addEventListener('snapshot', (e) => store.applySnapshot(JSON.parse((e as MessageEvent).data)));
  source.addEventListener('events', (e) => store.applyEvents(JSON.parse((e as MessageEvent).data)));
  source.addEventListener('session', (e) => store.applySession(JSON.parse((e as MessageEvent).data)));
  // One terminal `end` frame = a stated upstream condition, not a loss; close
  // before the browser's auto-reconnect turns it into a fake outage.
  source.addEventListener('end', (e) => {
    let reason = '';
    try {
      reason = (JSON.parse((e as MessageEvent).data) as { reason?: string }).reason ?? '';
    } catch {
      // no reason carried: treated as 'none'
    }
    store.markEnded(reason === 'unsupported' ? 'unsupported' : 'none');
    source.close();
  });
  source.onerror = () => store.markLost();
  const drop = () => {
    source.close();
    store.markLost();
  };
  registerExecutionDrop(drop);
  return () => {
    unregisterExecutionDrop(drop);
    source.close();
  };
}

// Dev/e2e hook plumbing: lets __gunnflowDebug.dropStream cut execution streams too.
const drops = new Set<() => void>();
function registerExecutionDrop(fn: () => void) {
  drops.add(fn);
}
function unregisterExecutionDrop(fn: () => void) {
  drops.delete(fn);
}
export function dropAllExecutionStreams(): void {
  for (const fn of [...drops]) fn();
}
