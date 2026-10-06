/** SSE transport: snapshot + tail from the BFF, normalized into the store. */
import type { WorkspaceProjection } from '../model/types.js';
import { normalizeNodes, normalizeProjection } from '../model/normalize.js';
import type { ProjectionStore } from '../state/projectionStore.js';

interface Envelope {
  revision: number;
  body: unknown;
}

export interface WorkspaceStream {
  close(): void;
  /** Closes the browser's stream and opens a fresh one (its first event is a new snapshot). */
  reconnect(): void;
}

export function connectWorkspaceStream(
  store: ProjectionStore,
  onProjection?: (p: WorkspaceProjection) => void,
): () => void {
  const stream = openWorkspaceStream(store, onProjection);
  return () => stream.close();
}

export function openWorkspaceStream(store: ProjectionStore, onProjection?: (p: WorkspaceProjection) => void): WorkspaceStream {
  let source = open(store, onProjection);
  return {
    close: () => source.close(),
    reconnect() {
      source.close();
      source = open(store, onProjection);
    },
  };
}

/**
 * Manual refresh, both legs: the BFF re-opens its upstream connection and
 * re-broadcasts, then the browser re-opens its own stream. A pull — reads only.
 */
export async function refreshWorkspace(stream: WorkspaceStream): Promise<{ refreshed: boolean; reason?: string }> {
  let result: { refreshed: boolean; reason?: string } = { refreshed: false, reason: 'refresh request failed' };
  try {
    const res = await fetch('/api/workspace/refresh', { method: 'POST', signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => null)) as { refreshed?: unknown; reason?: unknown } | null;
    result = { refreshed: body?.refreshed === true, ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}) };
  } catch (err) {
    result = { refreshed: false, reason: err instanceof Error ? err.message : String(err) };
  }
  stream.reconnect();
  return result;
}

function open(store: ProjectionStore, onProjection?: (p: WorkspaceProjection) => void): EventSource {
  const source = new EventSource('/api/workspace/stream');
  const apply = (raw: MessageEvent) => {
    const envelope = JSON.parse(raw.data) as Envelope;
    const projection = normalizeProjection(envelope.body);
    // The wire may omit revision inside body; the envelope's is authoritative.
    projection.revision = envelope.revision ?? projection.revision;
    store.applyUpstream(projection, normalizeNodes(envelope.body));
    onProjection?.(projection);
  };
  source.addEventListener('snapshot', apply);
  source.addEventListener('projection', apply);
  // The BFF's own link to its upstream: shown as an instrument, never as node attention.
  source.addEventListener('upstream-status', (raw: MessageEvent) => {
    const s = JSON.parse(raw.data) as { connected?: unknown; since?: unknown };
    if (typeof s.connected === 'boolean' && typeof s.since === 'string') store.applyUpstreamStatus({ connected: s.connected, since: s.since });
  });
  source.onerror = () => store.markLost();
  return source;
}
