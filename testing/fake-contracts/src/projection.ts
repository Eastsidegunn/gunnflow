/**
 * TEST-ONLY domain projection the simulator emits. These shapes stand in for
 * what the cockpit does not yet consume through the contract's NodeProjection;
 * every name is Fake-prefixed on purpose — do not let them harden into the
 * contract. Contract-owned pieces (Capability, ArtifactRef, intent slots) are
 * imported from @gunnflow/contract, never redefined here.
 *
 * Rule of the charter: the UI renders exactly what these carry. Optional fields
 * (progress, blockedReason, urgency, aggregateState) exist ONLY when upstream
 * provides them; the UI must never compute a substitute.
 */
import type { ArtifactRef, Capability, CapabilityLevel, Intent } from '@gunnflow/contract';


export type FakeNodeState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed';

export interface FakeMissionProjection {
  kind: 'mission';
  id: string;
  name: string;
  /** Only present when upstream explicitly provides an aggregate state. */
  aggregateState?: FakeNodeState;
  attention: boolean;
}

export interface FakeTaskProjection {
  kind: 'task';
  id: string;
  missionId: string;
  name: string;
  state: FakeNodeState;
  /** One-line current action, upstream-provided. */
  currentAction?: string;
  startedAt?: number;
  updatedAt?: number;
  /** 0..1 — only when upstream explicitly provides it (acceptance B3). */
  progress?: number;
  /** Only when upstream provides it (acceptance B4). Shown at the Inspector entry point. */
  blockedReason?: string;
  attention: boolean;
  artifacts?: ArtifactRef[];
}

/** TEST-ONLY snapshot bytes by artifact id, base64. Stands in for a snapshot fetch. */
export type FakeArtifactStore = Record<string, string>;

/** TEST-ONLY request detail behind a gate (Human Gate brief §7). All upstream-authored. */
export interface FakeGateRequest {
  target?: string;
  destination?: string;
  scope?: string;
  /** Provenance: who/what created this request. */
  requestedBy?: string;
  requestedAt?: number;
  /** Why a human decision is required — upstream-provided, never invented. */
  reason?: string;
  /** Expected downstream effect. */
  impact?: string;
  /** Whether approval causes an external effect (egress). */
  externalEffect?: boolean;
  /** Only when the contract provides an expiration. */
  expiresAt?: number;
}

/** TEST-ONLY policy context shown on the gate (never evaluated client-side). */
export interface FakeGatePolicyContext {
  policyLabel?: string;
  ceiling?: string;
  requiredAuthority?: string;
  /** Credential METADATA only — raw values never exist in any shape. */
  credentialLabel?: string;
  credentialScope?: string;
  credentialExpiresIn?: string;
}

/** Upstream-recorded human decision (audit attribution comes from upstream). */
export interface FakeGateDecision {
  by: string;
  at: number;
  choice: 'approved' | 'rejected' | 'changes-requested';
  reason?: string;
}

export type FakeGateState =
  | 'waiting'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'canceled';

export interface FakeGateProjection {
  kind: 'gate';
  id: string;
  missionId: string;
  name: string;
  gateType: string;
  /** The human action this gate is asking for. */
  requestedAction: string;
  state: FakeGateState;
  /** Only when upstream provides urgency. */
  urgency?: 'low' | 'high';
  /** Upstream-declared risk tier — Gunnflow never computes risk. */
  riskTier?: 'logged' | 'privileged';
  /** Whether a decision reason is mandatory — upstream policy decides. */
  reasonRequired?: boolean;
  request?: FakeGateRequest;
  policy?: FakeGatePolicyContext;
  /** Evidence: a linked deliverable id, when declared upstream. */
  deliverableId?: string;
  decision?: FakeGateDecision;
  /** Set when a newer request replaced this one. */
  supersededBy?: string;
}

/** TEST-ONLY separate effect outcome: approval ≠ effect (Human Gate brief §26). */
export interface FakeGateEffectStatus {
  gateId: string;
  label: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  detail?: string;
}

/** TEST-ONLY per-gate decision capabilities, upstream-provided (brief §19). */
export interface FakeGateCapabilities {
  approve?: CapabilityLevel;
  reject?: CapabilityLevel;
  requestChanges?: CapabilityLevel;
  /** Upstream-provided reason for a disabled action. */
  disabledReason?: string;
}

export interface FakeDeliverableProjection {
  kind: 'deliverable';
  id: string;
  missionId: string;
  title: string;
  deliverableType: string;
  /** Omitted when upstream provides no lifecycle state. */
  state?: 'draft' | 'completed';
  /** Non-executable preview hint (text/emoji). Executable previews live on the isolated origin. */
  previewHint?: string;
  /** Snapshot artifacts of the deliverable (bytes in `artifactSnapshots`). */
  artifacts?: ArtifactRef[];
}

export type FakeCanvasNode =
  | FakeTaskProjection
  | FakeGateProjection
  | FakeDeliverableProjection;

/** Edge kinds are upstream-declared. The UI never infers a relation (charter §9). */
export type FakeEdgeKind = 'dependency' | 'spawn' | 'produces' | 'gate';

export interface FakeEdgeProjection {
  id: string;
  from: string;
  to: string;
  edgeKind: FakeEdgeKind;
}

/**
 * TEST-ONLY task activity summary (Task Inspector brief §5). The summaries are
 * upstream-authored — Gunnflow never summarizes raw events itself.
 */
export interface FakeTaskActivity {
  id: string;
  taskId: string;
  at: number;
  /** Upstream-provided human-readable summary (may be absent → show eventType). */
  label?: string;
  eventType: string;
  actor: 'human' | 'agent' | 'system';
  /** Idempotency key of the human intent that caused this activity, echoed by the upstream. */
  intentKey?: string;
}

/** TEST-ONLY linked-session summary (Task Inspector brief §7). L1 level only. */
export interface FakeSessionLink {
  taskId: string;
  label: string;
  state: 'running' | 'idle' | 'ended';
  startedAt?: number;
  forkCount?: number;
}

/**
 * TEST-ONLY per-task write capabilities (Task Inspector brief §19): authority
 * comes from upstream, never from a frontend role string. A task with no entry
 * for an action treats it as 'hidden' — absence never widens authority.
 */
export interface FakeTaskCapabilities {
  pause?: CapabilityLevel;
  resume?: CapabilityLevel;
  instruct?: CapabilityLevel;
  cancel?: CapabilityLevel;
  forceReplan?: CapabilityLevel;
  /** Removing the task is a backend fact like any other write. */
  delete?: CapabilityLevel;
}

/** Upstream-provided status-line numbers (charter §13: the strip's numbers come from upstream). */
export interface FakeStatusCounts {
  running: number;
  needsYou: number;
  blocked: number;
}

export interface FakeWorkspaceProjection {
  revision: number;
  missions: FakeMissionProjection[];
  tasks: FakeTaskProjection[];
  gates: FakeGateProjection[];
  deliverables: FakeDeliverableProjection[];
  edges: FakeEdgeProjection[];
  counts: FakeStatusCounts;
  /** Task-level upstream event summaries, newest last. */
  activities: FakeTaskActivity[];
  sessions: FakeSessionLink[];
  /** Per-task write capabilities keyed by task id. Missing task/action → hidden. */
  capabilities: Record<string, FakeTaskCapabilities>;
  /** Per-gate decision capabilities keyed by gate id. Missing → hidden. */
  gateCapabilities: Record<string, FakeGateCapabilities>;
  /** Effect outcomes, separate facts from approvals (brief §26). */
  effects: FakeGateEffectStatus[];
  /**
   * Slot declarations keyed by node id (task/gate). Missing node/action → no
   * slot declared, so decision/edit payloads for it are refused at the relay.
   */
  declaredCapabilities?: Record<string, Capability[]>;
  /** Snapshot bytes for `access: snapshot` artifacts. */
  artifactSnapshots?: FakeArtifactStore;
  /** Workspace-level capabilities (creation of top-level nodes), carried by the root node. */
  workspaceCapabilities?: Capability[];
  /** Idempotency keys of the intents the upstream has applied, most recent last (bounded). */
  appliedIntentKeys?: string[];
}

/* ------------------------------------------------------------------ */
/* Append-only event log (simulates the upstream's audit chain)       */
/* ------------------------------------------------------------------ */

export interface FakeAppendedEvent {
  seq: number;
  at: number;
  /** Who caused this event — human intents carry the fake actor. */
  actor: string;
  type: string;
  payload: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Human intents (the write path — relay only, never local mutation)   */
/* ------------------------------------------------------------------ */

/**
 * The stand-in upstream's intents address nodes by domain keys (`intent` +
 * taskId/gateId/…) instead of the contract's nodeId/action, but carry the
 * contract's value slots unchanged.
 */
export type FakeIntentSlots = Pick<Intent, 'decision' | 'edit' | 'attestation'>;

export type FakeIntentKind =
  /** The mission's name travels in `decision.text`. @deprecated `name` (accepted during the transition). */
  | { intent: 'mission.create'; name?: string; prompt?: string }
  | { intent: 'edge.rewire'; from: string; to: string; edgeKind: FakeEdgeKind }
  | { intent: 'task.pause'; taskId: string }
  | { intent: 'task.delete'; taskId: string }
  | { intent: 'task.resume'; taskId: string }
  /** Whole-body replacement of the artifact named by the task's `artifact.edit` capability. */
  | { intent: 'artifact.edit'; taskId: string }
  /**
   * Human intent added to the task's future execution — not a chat message.
   * The text travels in `decision.text`. @deprecated `instruction` (accepted during the transition).
   */
  | { intent: 'task.instruct'; taskId: string; instruction?: string; reason?: string }
  /** Human gate decisions — attributed, append-only, first-class events. */
  | { intent: 'gate.approve'; gateId: string; reason?: string }
  | { intent: 'gate.reject'; gateId: string; reason?: string }
  /** The requested change travels in `decision.text`. @deprecated `instruction` (see task.instruct). */
  | { intent: 'gate.requestChanges'; gateId: string; instruction?: string };

export type FakeIntent = FakeIntentKind & FakeIntentSlots;

/** The human's text for an intent: `decision.text`, else the transitional legacy field. */
export function fakeIntentText(intent: FakeIntent): string | undefined {
  if (intent.decision?.text !== undefined) return intent.decision.text;
  if ('instruction' in intent && intent.instruction !== undefined) return intent.instruction;
  if (intent.intent === 'mission.create') return intent.name;
  if ((intent.intent === 'gate.approve' || intent.intent === 'gate.reject') && intent.reason !== undefined) return intent.reason;
  return undefined;
}
