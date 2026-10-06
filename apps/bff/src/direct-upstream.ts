/**
 * Built-in `direct` upstream: a backend that speaks the contract natively over
 * the direct wire (packages/contract/WIRE.md). Pure pass-through — snapshots
 * are carried as `{ revision, body: { nodes } }`, intents are posted as-is,
 * artifact bytes are fetched by digest address. No translation, synthesis or
 * judgment. Surfaces the wire does not define answer UpstreamUnsupported.
 */
import {
  DIRECT_WIRE,
  validateExecutionSnapshot,
  type DirectSnapshot,
  type ExecutionSnapshot,
  type NodeDetail,
} from '@gunnflow/contract';
import {
  UnsupportedDetail,
  type UpstreamFactory,
  type UpstreamIntentResult,
  type UpstreamProjectionEnvelope,
  type UpstreamRefreshResult,
  type UpstreamStatus,
  type UpstreamUnsupported,
  type WorkspaceUpstream,
} from '@gunnflow/upstream-port';
import { SseDecoder } from './sse.js';

const NOT_ON_WIRE = (surface: string): UpstreamUnsupported => ({
  unsupported: `the direct wire defines no ${surface} surface`,
});

export interface DirectOptions {
  reconnectMs?: number;
  /** Called once when the stream endpoint is absent (404/501): the snapshot stays static. */
  onStreamUnsupported?(status: number): void;
}

const envelopeOf = (s: DirectSnapshot): UpstreamProjectionEnvelope => ({ revision: s.revision, body: { nodes: s.nodes } });

/** The upstream's own text from an error response, verbatim when present. */
async function responseReason(res: Response): Promise<string | undefined> {
  const text = (await res.text().catch(() => '')).trim();
  if (!text) return undefined;
  try {
    const reason = (JSON.parse(text) as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason) return reason;
  } catch {
    // not JSON: the text itself is the upstream's message
  }
  return text;
}

export async function createDirectUpstream(
  url: string,
  options: DirectOptions = {},
): Promise<WorkspaceUpstream & { close(): void }> {
  const base = url.replace(/\/+$/, '');
  const reconnectMs = options.reconnectMs ?? 2000;
  const res = await fetch(`${base}${DIRECT_WIRE.nodes}`);
  if (!res.ok) throw new Error(`direct upstream: GET ${DIRECT_WIRE.nodes} answered ${res.status}`);
  let current = envelopeOf((await res.json()) as DirectSnapshot);
  const listeners = new Set<(p: UpstreamProjectionEnvelope) => void>();
  let closed = false;
  let abort = new AbortController();
  // Reachable at start (GET /nodes answered). The stream loop records every change after that.
  let status: UpstreamStatus = { connected: true, since: new Date().toISOString() };
  const statusListeners = new Set<(s: UpstreamStatus) => void>();
  /** Set during a manual refresh: the stream is being replaced on purpose, not lost. */
  let replacing = false;
  /** Cleared the first time /detail answers 501: this wire serves no detail. */
  let detailSupported = true;
  /** Cleared the first time /execution answers 501: this wire serves no execution. */
  let executionSupported = true;
  const executionUnsupported = (): UpstreamUnsupported => ({
    unsupported: `the direct wire's ${DIRECT_WIRE.execution} answered 501`,
  });
  /** Live execution-tail connections, aborted when the upstream itself closes. */
  const executionAborts = new Set<AbortController>();
  /** A snapshot answering for another task is a contract failure, not data. */
  const executionTaskProblem = (s: ExecutionSnapshot, taskId: string): string | null => {
    const stray = s.sessions.find((x) => x.taskId !== taskId);
    return stray ? `session '${stray.id}' carries taskId '${stray.taskId}', not the requested '${taskId}'` : null;
  };
  let wake: (() => void) | null = null;
  const setConnected = (connected: boolean) => {
    if (status.connected === connected) return;
    status = { connected, since: new Date().toISOString() };
    for (const l of statusListeners) l(status);
  };

  const consume = async (): Promise<'again' | 'absent'> => {
    const r = await fetch(`${base}${DIRECT_WIRE.stream}`, {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (r.status === 404 || r.status === 501) {
      options.onStreamUnsupported?.(r.status);
      return 'absent';
    }
    if (!r.ok || !r.body) throw new Error(`direct upstream: stream answered ${r.status}`);
    setConnected(true);
    const reader = r.body.getReader();
    const text = new TextDecoder();
    const sse = new SseDecoder();
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) return 'again';
      for (const frame of sse.push(text.decode(value, { stream: true }))) {
        if (frame.event !== DIRECT_WIRE.snapshotEvent) continue;
        current = envelopeOf(JSON.parse(frame.data) as DirectSnapshot);
        for (const l of listeners) l(current);
      }
    }
    await reader.cancel().catch(() => undefined);
    return 'again';
  };
  // After any disconnect, a fresh connection's first snapshot is the resync.
  void (async () => {
    while (!closed) {
      try {
        abort = new AbortController();
        if ((await consume()) === 'absent') return;
      } catch {
        // fall through to the reconnect delay
      }
      if (replacing) {
        // A manual refresh dropped the stream: re-open it at once.
        replacing = false;
        continue;
      }
      // The stream ended or failed: the upstream is unreachable until a new stream is open.
      if (!closed) setConnected(false);
      if (!closed) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, reconnectMs);
          wake = () => (clearTimeout(t), r());
        });
        wake = null;
      }
    }
  })();

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => status,
    async refresh(): Promise<UpstreamRefreshResult> {
      // Drop the stream now — even one that looks alive — and have the loop re-open it without waiting.
      replacing = !wake;
      abort.abort();
      wake?.();
      try {
        const r = await fetch(`${base}${DIRECT_WIRE.nodes}`);
        if (!r.ok) return { ok: false, reason: `GET ${DIRECT_WIRE.nodes} answered ${r.status}` };
        current = envelopeOf((await r.json()) as DirectSnapshot);
        for (const l of listeners) l(current);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `upstream unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    subscribeStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    async relayIntent(intent, actor): Promise<UpstreamIntentResult> {
      let r: Response;
      try {
        r = await fetch(`${base}${DIRECT_WIRE.intent}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [DIRECT_WIRE.actorHeader]: actor },
          body: JSON.stringify(intent),
        });
      } catch (err) {
        return { accepted: false, reason: `direct upstream unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!r.ok) return { accepted: false, reason: (await responseReason(r)) ?? `direct upstream error (${r.status})` };
      const body = (await r.json().catch(() => ({}))) as { accepted?: unknown; reason?: unknown };
      return {
        accepted: body.accepted === true,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      };
    },
    async artifactSnapshot(artifactId, digest) {
      const r = await fetch(`${base}${DIRECT_WIRE.artifact(artifactId, digest)}`).catch(() => undefined);
      if (!r?.ok) return undefined;
      // The media type is the Content-Type's essence; parameters are HTTP framing.
      const mediaType = (r.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
      return { mediaType, bytesBase64: Buffer.from(await r.arrayBuffer()).toString('base64') };
    },
    // 404 → undefined (no detail for that node); 501 → UnsupportedDetail, remembered
    // so the surface keeps answering "unsupported" instead of re-asking the wire.
    async nodeDetail(nodeId): Promise<NodeDetail | undefined> {
      if (!detailSupported) throw new UnsupportedDetail(`the direct wire's ${DIRECT_WIRE.detail} answered 501`);
      const r = await fetch(`${base}${DIRECT_WIRE.detail}/${encodeURIComponent(nodeId)}`);
      if (r.status === 404) return undefined;
      if (r.status === 501) {
        detailSupported = false;
        throw new UnsupportedDetail(`the direct wire's ${DIRECT_WIRE.detail} answered 501`);
      }
      if (!r.ok) throw new Error(`direct upstream: GET ${DIRECT_WIRE.detail} answered ${r.status}`);
      return (await r.json()) as NodeDetail;
    },
    // 404 → undefined (no execution for that task); 501 → unsupported, remembered
    // so the surface keeps answering "unsupported" instead of re-asking the wire.
    // Transport or contract failure rejects — the BFF turns it into a reasoned 502.
    async executionSnapshot(taskId): Promise<ExecutionSnapshot | undefined | UpstreamUnsupported> {
      if (!executionSupported) return executionUnsupported();
      const r = await fetch(`${base}${DIRECT_WIRE.execution}/${encodeURIComponent(taskId)}`);
      if (r.status === 404) return undefined;
      if (r.status === 501) {
        executionSupported = false;
        return executionUnsupported();
      }
      if (!r.ok) throw new Error(`direct upstream: GET ${DIRECT_WIRE.execution} answered ${r.status}`);
      const checked = validateExecutionSnapshot(await r.json());
      if (!checked.ok) throw new Error(`upstream execution snapshot fails the contract: ${checked.problems.join('; ')}`);
      const stray = executionTaskProblem(checked.snapshot, taskId);
      if (stray) throw new Error(`upstream execution snapshot fails the contract: ${stray}`);
      return checked.snapshot;
    },
    // SSE tail of /execution/:taskId/stream: every `snapshot` frame is a full
    // ExecutionSnapshot, delivered as { type: 'snapshot', snapshot } — no deltas,
    // no diffing. Reconnects like the main /stream loop; after any disconnect
    // the first frame of a fresh connection is the resync. When the tail stops
    // FOR GOOD the listener gets one terminal { type: 'end', reason } — a dead
    // tail must never keep looking live downstream. Reasons: 'gone' (404),
    // 'unsupported' (501, latched), 'invalid' (persistently contract-breaking
    // frames), 'closed' (this upstream client closed).
    subscribeExecution(taskId, listener) {
      if (!executionSupported) {
        queueMicrotask(() => listener({ type: 'end', reason: 'unsupported' }));
        return () => undefined;
      }
      let stopped = false;
      const ac = new AbortController();
      executionAborts.add(ac);
      void (async () => {
        let end: string | null = null;
        // Persistently invalid frames (broken JSON, contract breaks, another
        // task's sessions) end the tail instead of silently starving it.
        let invalidRun = 0;
        const INVALID_RUN_LIMIT = 3;
        while (!stopped && !closed && end === null) {
          if (!executionSupported) {
            end = 'unsupported';
            break;
          }
          try {
            const r = await fetch(`${base}${DIRECT_WIRE.execution}/${encodeURIComponent(taskId)}/stream`, {
              headers: { accept: 'text/event-stream' },
              signal: ac.signal,
            });
            if (r.status === 404) {
              end = 'gone'; // no execution for this task: nothing to tail
              break;
            }
            if (r.status === 501) {
              executionSupported = false;
              end = 'unsupported';
              break;
            }
            if (!r.ok || !r.body) throw new Error(`direct upstream: execution stream answered ${r.status}`);
            const reader = r.body.getReader();
            const text = new TextDecoder();
            const sse = new SseDecoder();
            while (end === null) {
              const { value, done } = await reader.read();
              if (done || stopped || closed) break;
              for (const frame of sse.push(text.decode(value, { stream: true }))) {
                if (frame.event !== DIRECT_WIRE.snapshotEvent) continue;
                let delivered = false;
                try {
                  const checked = validateExecutionSnapshot(JSON.parse(frame.data));
                  if (checked.ok && executionTaskProblem(checked.snapshot, taskId) === null) {
                    delivered = true;
                    invalidRun = 0;
                    listener({ type: 'snapshot', snapshot: checked.snapshot });
                  }
                } catch {
                  // broken JSON counts as an invalid frame below
                }
                if (!delivered && ++invalidRun >= INVALID_RUN_LIMIT) {
                  end = 'invalid';
                  break;
                }
              }
            }
            await reader.cancel().catch(() => undefined);
          } catch {
            // transport loss: fall through to the reconnect delay
          }
          if (end === null && !stopped && !closed) {
            await new Promise((resolve) => setTimeout(resolve, reconnectMs));
          }
        }
        executionAborts.delete(ac);
        if (!stopped) listener({ type: 'end', reason: end ?? 'closed' });
      })();
      return () => {
        stopped = true;
        executionAborts.delete(ac);
        ac.abort();
      };
    },
    terminalSnapshot: () => NOT_ON_WIRE('terminal'),
    subscribeTerminal: () => NOT_ON_WIRE('terminal'),
    subscribeStream: () => NOT_ON_WIRE('stream channel'),
    close() {
      closed = true;
      abort.abort();
      for (const a of executionAborts) a.abort();
      executionAborts.clear();
    },
  };
}

export const createUpstream: UpstreamFactory = (options) => {
  if (!options.url) return Promise.reject(new Error("upstream 'direct' needs a url (config 'url' or GUNNFLOW_UPSTREAM_URL)"));
  return createDirectUpstream(options.url, {
    onStreamUnsupported: (status) =>
      console.warn(`direct upstream: ${DIRECT_WIRE.stream} answered ${status}; showing the initial snapshot without live updates`),
  });
};
