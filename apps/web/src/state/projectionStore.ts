/**
 * WorkspaceProjectionStore — holds the latest AUTHORITATIVE upstream projection
 * plus transport health. It never computes new business state (acceptance B2):
 * everything here is either upstream-provided or pure transport bookkeeping.
 */
import { createSignal } from 'solid-js';
import { emptyProjection, type WorkspaceProjection } from '../model/types.js';
import type { GenericNodes } from '../model/normalize.js';

export type ConnectionState = 'connecting' | 'live' | 'lost';

/** The BFF's own connection to its upstream, as the BFF reports it (transport fact). */
export interface UpstreamLink {
  connected: boolean;
  since: string;
}

/**
 * The bottom instrument (a warranty-grade reading of the cockpit's own links):
 *   live        — browser stream up, BFF reaches the upstream
 *   unreachable — browser stream up, the BFF lost the upstream: data is from before `since`
 *   lost        — the browser stream itself is down
 *   connecting  — nothing yet
 */
export type Instrument =
  | { kind: 'live' }
  | { kind: 'unreachable'; since: string }
  | { kind: 'lost'; lastSeenAt: number | null }
  | { kind: 'connecting' };

export function connectionInstrument(connection: ConnectionState, upstream: UpstreamLink | null, lastSeenAt: number | null): Instrument {
  if (connection === 'lost') return { kind: 'lost', lastSeenAt };
  if (connection === 'connecting') return { kind: 'connecting' };
  if (upstream && !upstream.connected) return { kind: 'unreachable', since: upstream.since };
  return { kind: 'live' };
}

export function createProjectionStore() {
  const [projection, setProjection] = createSignal<WorkspaceProjection>(emptyProjection());
  const [connection, setConnection] = createSignal<ConnectionState>('connecting');
  const [lastSeenAt, setLastSeenAt] = createSignal<number | null>(null);
  const [hasSnapshot, setHasSnapshot] = createSignal(false);
  /** Contract NodeProjection collection, kept apart from the domain projection; null when not sent. */
  const [genericNodes, setGenericNodes] = createSignal<GenericNodes | null>(null);
  /** null until the BFF reports it (an upstream without status reporting counts as reachable). */
  const [upstream, setUpstream] = createSignal<UpstreamLink | null>(null);

  return {
    projection,
    connection,
    lastSeenAt,
    hasSnapshot,
    genericNodes,
    upstream,
    instrument: () => connectionInstrument(connection(), upstream(), lastSeenAt()),
    /** Called only by the stream transport with the BFF's upstream-status events. */
    applyUpstreamStatus(s: UpstreamLink) {
      setUpstream(s);
    },
    /** Called only by the stream transport with upstream envelopes. */
    applyUpstream(next: WorkspaceProjection, nodes: GenericNodes | null = null) {
      setProjection(next);
      setGenericNodes(nodes);
      setHasSnapshot(true);
      setLastSeenAt(Date.now());
      setConnection('live');
    },
    markLost() {
      setConnection('lost');
    },
    markConnecting() {
      setConnection('connecting');
    },
  };
}

export type ProjectionStore = ReturnType<typeof createProjectionStore>;
