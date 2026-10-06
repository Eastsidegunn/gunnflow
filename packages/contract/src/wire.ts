/**
 * The direct wire (WIRE.md): the HTTP surface a backend opens to speak the
 * contract natively, with no adapter. Paths are relative to the backend's
 * base URL.
 */
import type { NodeProjection } from './types.js';

export const DIRECT_WIRE = {
  /** GET → 200 DirectSnapshot. Required. */
  nodes: '/nodes',
  /** GET → 200 text/event-stream of `snapshot` events (data: DirectSnapshot). Required. */
  stream: '/stream',
  /** SSE event name; every frame is a full snapshot. */
  snapshotEvent: 'snapshot',
  /** POST Intent (application/json) → 200 IntentResult. */
  intent: '/intent',
  /**
   * GET /detail/:nodeId → 200 NodeDetail | 404 (that node has no detail, or
   * no such node) | 501 (this wire serves no detail). Optional.
   */
  detail: '/detail',
  /**
   * GET /execution/:taskId → 200 ExecutionSnapshot | 404 (no execution for
   * that task) | 501 (this wire serves no execution). Optional.
   * GET /execution/:taskId/stream → 200 text/event-stream of `snapshot`
   * events, each a FULL ExecutionSnapshot (no deltas — the /stream republish
   * grammar); the first frame is the current snapshot. Same 404/501 rules.
   */
  execution: '/execution',
  /** GET → 200 bytes (Content-Type = media type) or 404. Optional. */
  artifact: (artifactId: string, digest: string) =>
    `/artifact/${encodeURIComponent(artifactId)}/${encodeURIComponent(digest)}`,
  /** Request header naming the relaying human actor (the Intent itself carries no provenance). */
  actorHeader: 'x-gunnflow-actor',
} as const;

/** Body of GET /nodes and data of every `snapshot` stream event. */
export interface DirectSnapshot {
  /** Non-decreasing upstream revision. */
  revision: number;
  nodes: NodeProjection[];
}
