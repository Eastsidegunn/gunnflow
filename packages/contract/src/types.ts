/**
 * The Gunnflow backend contract (recharter contract §1). Gunnflow owns it;
 * a backend speaks it natively over the direct wire (WIRE.md) and passes the
 * conformance suite.
 * Vocabulary fields (kind, state.value, relation type, action, cause) are
 * opaque strings: the cockpit maps them for display, never interprets them.
 */

export type CapabilityLevel = 'enabled' | 'disabled' | 'hidden';

/** Which decision payloads an action accepts. */
export interface CapabilityDecision {
  options?: string[];
  input?: { required: boolean };
  evidence?: string[];
}

/** Declares that an action accepts a whole-body edit of one artifact. */
export interface CapabilityEdit {
  /** Base artifact; null = a new body (not yet supported by the cockpit). */
  artifactId: string | null;
  mediaTypes: string[];
  maxBytes: number;
}

export interface Capability {
  action: string;
  level: CapabilityLevel;
  decision?: CapabilityDecision;
  edit?: CapabilityEdit;
}

export interface ArtifactRef {
  id: string;
  mediaType: string;
  /** sha256 hex of the original bytes. */
  digest?: string;
  access: { kind: 'snapshot' } | { kind: 'live'; url: string };
}

/** A stream channel; content is carried on the BFF rule path, never by URL here. */
export interface StreamRef {
  id: string;
  role?: string;
  mediaType: string;
  sequence: 'contiguous';
  encoding: 'utf-8' | 'base64';
  framing: 'line' | 'chunk';
}

/**
 * Kind of the workspace root node. A projection may carry one: its
 * capabilities are workspace-level actions (creating top-level nodes follows
 * the "creation is a parent capability" convention).
 */
export const WORKSPACE_ROOT_KIND = 'workspace';

export interface NodeProjection {
  id: string;
  kind: string;
  /** Display name, as the upstream states it; absent → the cockpit shows the id. */
  label?: string;
  state: { value: string };
  relations: { type: string; target: string }[];
  capabilities: Capability[];
  /** `since` is absent when the upstream does not know when attention began. */
  attention: { cause: string; since?: string; refs?: string[] }[];
  artifacts: ArtifactRef[];
  /** Mutually exclusive with artifacts for the same data. */
  streams?: StreamRef[];
  /*
   * Optional decorations (0.6.0). Each is an upstream-stated fact; absent
   * means only that decoration is omitted — the cockpit never fills one in.
   */
  /** Far-zoom name: 1..32 code points, no line breaks (LF VT FF CR NEL U+2028 U+2029). Absent → the engine shortens the label (first 24 chars). */
  shortName?: string;
  /** One-line upstream summary: 1..200 code points, no line breaks. Plain text, same status as the label. */
  summary?: string;
  /** The upstream says the node is active now. Absent = unknown, never false. */
  active?: boolean;
  /** ms epoch (integer > 0) of the node's last activity, as the upstream reports it. */
  lastActivityTs?: number;
  /**
   * Revision (integer ≥ 1, ≤ the snapshot revision) at which this node's own
   * projection last changed. Containers do not roll up: "changed inside" is a
   * cockpit view computed from received containment.
   */
  changedAtRevision?: number;
  /** The node this one originated from (not its own id). Draws no edge; may name a node absent from the snapshot. */
  originNodeId?: string;
  /** Upstream-counted steps: integers, 0 ≤ done ≤ total, total ≥ 1. Display only — the engine never computes progress. */
  steps?: { done: number; total: number };
}

/** One on-demand detail item. The label is upstream vocabulary, opaque to the engine. Exactly one body. */
export interface DetailItem {
  label: string;
  text?: string;
  artifact?: ArtifactRef;
}

/** GET detail response. Revision ties the detail to a projection generation. */
export interface NodeDetail {
  revision: number;
  items: DetailItem[];
}

/* ---- execution surface (GET /execution on the direct wire) ---- */

/** Transport lifecycle of one execution session, as upstream states it. */
export type ExecutionSessionState = 'running' | 'paused' | 'ended' | 'killed';

/** One live or finished agent session under a task. Everything is an upstream-authored fact. */
export interface ExecutionSession {
  id: string;
  taskId: string;
  state: ExecutionSessionState;
  /** Display name, as the upstream states it; absent → the cockpit shows the id. */
  label?: string;
  /**
   * The upstream's own, richer session-state word, verbatim. The engine never
   * interprets it — display only. (Backends map their native state field here.)
   */
  upstreamSessionState?: string;
  /** Cumulative usage counters as upstream reports them; units are the upstream's. */
  usageInTotal?: number;
  usageOutTotal?: number;
  /** ms epoch of the session's last reported activity. */
  lastActivityTs?: number;
}

/**
 * One execution event. `kind` is OPEN upstream vocabulary (e.g.
 * 'subagent/spawn', 'session/end') and `label` is the upstream's own summary —
 * the cockpit renders both verbatim and never re-summarizes. There is no
 * payload field: richer bodies are not part of this surface.
 */
export interface ExecutionEvent {
  /** Strictly increasing within a snapshot. */
  seq: number;
  /** ms epoch. */
  at: number;
  sessionId: string;
  kind: string;
  label: string;
  /** Upstream vocabulary, verbatim (the cockpit's failed-only view matches 'failed'/'denied' literally). */
  status?: string;
}

/**
 * GET /execution/:taskId response, and the data of every execution `snapshot`
 * stream event. `events` MAY be a recent window (the backend's choice);
 * `truncatedBefore` states the cut honestly without counting what the wire
 * does not carry.
 */
export interface ExecutionSnapshot {
  sessions: ExecutionSession[];
  events: ExecutionEvent[];
  /**
   * Events with seq < this value exist upstream but are not carried in this
   * snapshot. Absent = nothing was cut (or the backend does not say).
   */
  truncatedBefore?: number;
}

export interface StreamChunk {
  seq: number;
  /** Upstream time value, opaque to the cockpit. */
  at: string;
  /** Opaque upstream channel label. */
  channel?: string;
  data: string;
}

/** Initial or reconnect bundle of the retained tail. No continuity with anything shown before. */
export interface StreamResync {
  type: 'resync';
  streamId: string;
  chunks: StreamChunk[];
}

/** The range is defined by the chunks' seqs alone. */
export interface StreamAppend {
  type: 'append';
  streamId: string;
  chunks: StreamChunk[];
}

/** Loss declared by upstream only; relays never create one. */
export interface StreamGap {
  type: 'gap';
  streamId: string;
  fromSeq: number;
  toSeq: number;
  /** Upstream text, verbatim. */
  reason: string;
  origin: 'upstream';
}

export type StreamEvent = StreamResync | StreamAppend | StreamGap;

export interface IntentDecision {
  option?: string;
  text?: string;
}

export interface IntentEdit {
  baseDigest: string | null;
  mediaType: string;
  body: string;
}

/** Snapshots the cockpit displayed untransformed, with their digests. */
export interface IntentAttestation {
  displayed: { artifactId: string; digest: string; at: string }[];
}

/**
 * A human intent. Pairing: `decision.option` only if the capability declares
 * `decision.options`; `decision.text` only with `decision.input`; `edit` only
 * with `edit`. No provenance fields exist: relay is human-only.
 */
export interface Intent {
  nodeId: string;
  action: string;
  decision?: IntentDecision;
  edit?: IntentEdit;
  attestation?: IntentAttestation;
  idempotencyKey: string;
}

export interface IntentResult {
  accepted: boolean;
  /** Upstream text, verbatim; absent when upstream gave none. */
  reason?: string;
}
