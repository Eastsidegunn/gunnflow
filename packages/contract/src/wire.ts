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
  /**
   * Interactive terminals. Optional as a set; 404/501 on the collection = not served.
   * GET → 200 DirectTerminal[]. POST DirectTerminalOpen → 200 { terminalId } | 422 { reason }.
   * GET /terminals/:id/stream → text/event-stream: `snapshot` first (retained output),
   * then `data`, then `exit`; snapshot/data `data:` is the chunk's base64 verbatim,
   * exit `data:` is JSON { code: integer | null }. Every (re)connect starts with `snapshot`.
   * POST /terminals/:id/input { data: base64 }, POST /terminals/:id/resize { cols, rows },
   * DELETE /terminals/:id → 204 | 404 (no such terminal) | 409 (exited) | 501.
   */
  terminals: '/terminals',
  terminal: (terminalId: string) => `/terminals/${encodeURIComponent(terminalId)}`,
  terminalEvents: { snapshot: 'snapshot', data: 'data', exit: 'exit' },
} as const;

/** Columns and rows are integers in 1..TERMINAL_SIZE_MAX. */
export const TERMINAL_SIZE_MAX = 1000;

/** One element of GET /terminals. `attachable` = already running; `shell` = opened on request. */
export interface DirectTerminal {
  terminalId: string;
  label: string;
  kind: 'attachable' | 'shell';
  state: 'running' | 'exited';
  /** Binds the terminal to a node of the snapshot. */
  nodeId?: string;
}

/** Body of POST /terminals: join an offered terminal, or ask for a new shell in a folder. */
export interface DirectTerminalOpen {
  target: { attach: string } | { shell: { cwd: string } };
  cols: number;
  rows: number;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Standard base64 (padding allowed, no line breaks): the only byte encoding on the terminal wire. */
export function isWireBase64(s: unknown): s is string {
  return typeof s === 'string' && s.length % 4 === 0 && BASE64.test(s);
}

const TERMINAL_KEYS = new Set(['terminalId', 'label', 'kind', 'state', 'nodeId']);

/** Why a GET /terminals element breaks the wire, or null. Unknown keys are refused. */
export function directTerminalProblem(t: unknown): string | null {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'not an object';
  const o = t as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !TERMINAL_KEYS.has(k));
  if (extra) return `unknown key '${extra}'`;
  if (typeof o.terminalId !== 'string' || !o.terminalId) return 'terminalId must be a non-empty string';
  if (typeof o.label !== 'string') return 'label must be a string';
  if (o.kind !== 'attachable' && o.kind !== 'shell') return "kind must be 'attachable' or 'shell'";
  if (o.state !== 'running' && o.state !== 'exited') return "state must be 'running' or 'exited'";
  if (o.nodeId !== undefined && (typeof o.nodeId !== 'string' || !o.nodeId)) return 'nodeId must be a non-empty string';
  return null;
}

/** Body of GET /nodes and data of every `snapshot` stream event. */
export interface DirectSnapshot {
  /** Non-decreasing upstream revision. */
  revision: number;
  nodes: NodeProjection[];
}
