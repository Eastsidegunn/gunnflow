/**
 * The BFF's single upstream wiring port. Transport-shaped only: snapshot,
 * subscribe, relay. No policy, risk, progress, or "blocked" reasoning lives
 * here or anywhere in the BFF — it carries and reduces information, it never
 * creates facts. Two built-ins implement it — the simulator and the client of
 * the contract's direct wire — and the BFF's composition root chooses one.
 */
import type { IntentResult, NodeDetail } from '@gunnflow/contract';

export interface UpstreamProjectionEnvelope {
  revision: number;
  body: unknown;
}

export type UpstreamIntentResult = IntentResult;

/**
 * A surface this upstream does not provide. Returned instead of an empty
 * stand-in, so the BFF can say "unsupported" rather than show "nothing".
 */
export interface UpstreamUnsupported {
  unsupported: string;
}

export type Unsubscribe = () => void;

/**
 * Thrown by `nodeDetail` when the upstream turns out not to serve the detail
 * surface at all (the direct wire answering 501). Distinct from `undefined`,
 * which means "this upstream serves detail, but has none for that node".
 */
export class UnsupportedDetail extends Error {}

/** Whether the BFF currently reaches its upstream, and since when (ISO). A transport fact, not a judgment. */
export interface UpstreamStatus {
  connected: boolean;
  since: string;
}

/** What a manual refresh achieved: the fresh snapshot, or why not (the reconnect loop keeps trying). */
export type UpstreamRefreshResult = { ok: true } | { ok: false; reason: string };

export interface WorkspaceUpstream {
  snapshot(): UpstreamProjectionEnvelope;
  subscribe(listener: (p: UpstreamProjectionEnvelope) => void): () => void;
  /** The upstream connection's current state (optional: an upstream without it is taken as connected). */
  status?(): UpstreamStatus;
  subscribeStatus?(listener: (s: UpstreamStatus) => void): Unsubscribe;
  /**
   * A manual pull: drop and re-open the upstream connection now (even one that
   * looks alive), re-fetch the snapshot and broadcast it. Optional.
   */
  refresh?(): Promise<UpstreamRefreshResult>;
  relayIntent(intent: unknown, actor: string): Promise<UpstreamIntentResult>;
  /**
   * Execution telemetry transport (snapshot + tail), per task.
   * `UpstreamUnsupported` = this upstream serves no execution surface at all
   * (the BFF answers 501, stated — never an empty stand-in; the direct wire
   * answering 501 latches here). `undefined` = the surface exists but holds no
   * execution for that task (the BFF answers 404). Anything else is the
   * snapshot, carried verbatim; transport or contract failure rejects (the
   * BFF answers a reasoned 502).
   */
  executionSnapshot(
    taskId: string,
  ): unknown | undefined | UpstreamUnsupported | Promise<unknown | undefined | UpstreamUnsupported>;
  /**
   * Execution tail. Deltas are carried as-is: the simulator's
   * `{ type: 'events' | 'session', … }` increments, or a direct-wire full
   * republish `{ type: 'snapshot', snapshot: ExecutionSnapshot }` — the BFF
   * re-emits whichever arrives, never diffing.
   */
  subscribeExecution(taskId: string, listener: (delta: unknown) => void): Unsubscribe;
  /** PTY transport (snapshot + tail), per session. Relay only — never a shell. */
  terminalSnapshot(sessionId: string): unknown | UpstreamUnsupported;
  subscribeTerminal(sessionId: string, listener: (delta: unknown) => void): Unsubscribe | UpstreamUnsupported;
  /**
   * Stream channel: resumes after `lastSeenSeq` or starts with a resync
   * bundle — the upstream decides which. Events are carried as-is.
   */
  subscribeStream(
    nodeId: string,
    streamId: string,
    lastSeenSeq: number | null,
    listener: (event: unknown) => void,
  ): Unsubscribe | UpstreamUnsupported;
  /**
   * The bytes of one artifact version, addressed by its digest, for the
   * isolated viewer origin. Absent when the upstream offers no snapshot fetch;
   * undefined when it does not hold that version.
   */
  artifactSnapshot?(
    artifactId: string,
    digest: string,
  ): UpstreamArtifactSnapshot | undefined | Promise<UpstreamArtifactSnapshot | undefined>;
  /**
   * One node's on-demand detail. `undefined` = the upstream serves the surface
   * but holds no detail for that node (the BFF answers 404). A missing method
   * = the surface is unsupported (the BFF answers 501, stated — never an empty
   * stand-in). An upstream that only discovers support at call time throws
   * UnsupportedDetail, which the BFF also answers with 501.
   */
  nodeDetail?(nodeId: string): Promise<NodeDetail | undefined>;
}

export interface UpstreamArtifactSnapshot {
  mediaType: string;
  bytesBase64: string;
}

/** Only the settings the composition root hands over — never the whole environment. */
export interface UpstreamFactoryOptions {
  /** Backend address, when the operator configured one. */
  url?: string;
}

export type UpstreamFactory = (
  options: UpstreamFactoryOptions,
) => Promise<WorkspaceUpstream & { close?(): void }>;
