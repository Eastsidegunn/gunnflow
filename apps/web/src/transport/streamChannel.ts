/**
 * Stream channel transport (stream review §3.2) on the BFF rule path
 * `/api/stream/{nodeId}/{streamId}`. EventSource resends Last-Event-ID on its
 * own reconnects; a fresh connection passes the last applied seq explicitly.
 */
import type { StreamEvent } from '../model/streamTypes.js';
import { acquireStreamSlot, type StreamConnection } from '../state/streamStore.js';
import { unsupportedReason } from '../state/terminalStore.js';

const drops = new Set<() => void>();

export function connectStream(
  nodeId: string,
  streamId: string,
  lastSeq: number | null,
  onEvent: (event: StreamEvent) => void,
  onState: (state: StreamConnection) => void,
): () => void {
  const release = acquireStreamSlot();
  if (!release) {
    onState('limited');
    return () => undefined;
  }
  onState('connecting');
  const query = lastSeq !== null ? `?lastEventId=${lastSeq}` : '';
  const url = `/api/stream/${encodeURIComponent(nodeId)}/${encodeURIComponent(streamId)}${query}`;
  const source = new EventSource(url);
  source.onopen = () => onState('live');
  source.addEventListener('stream', (e) => onEvent(JSON.parse((e as MessageEvent).data) as StreamEvent));
  source.onerror = () => {
    onState('disconnected');
    // A refused connection (501) is "unsupported", not a transient loss.
    if (source.readyState === EventSource.CLOSED) {
      void unsupportedReason(url).then((reason) => {
        if (reason) onState('unsupported');
      });
    }
  };
  const close = () => {
    drops.delete(drop);
    source.close();
    release();
  };
  const drop = () => {
    close();
    onState('disconnected');
  };
  drops.add(drop);
  return close;
}

/** Dev/e2e: simulate transport loss on every open stream channel. */
export function dropAllStreams(): void {
  for (const fn of [...drops]) fn();
}
