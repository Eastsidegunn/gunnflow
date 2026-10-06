/**
 * Model types. Contract-owned shapes come from @gunnflow/contract. The domain
 * projection the canvas still renders is the simulator's stand-in shape
 * (fake-contracts, imported type-only — nothing from it exists at runtime in
 * this app); moving the canvas onto NodeProjection is the single point of change.
 */
export type {
  ArtifactRef,
  Capability,
  CapabilityLevel,
  IntentResult,
} from '@gunnflow/contract';
export type {
  FakeWorkspaceProjection as WorkspaceProjection,
  FakeMissionProjection as MissionProjection,
  FakeTaskProjection as TaskProjection,
  FakeGateProjection as GateProjection,
  FakeDeliverableProjection as DeliverableProjection,
  FakeEdgeProjection as EdgeProjection,
  FakeEdgeKind as EdgeKind,
  FakeCanvasNode as CanvasNode,
  FakeNodeState as NodeState,
  FakeTaskActivity as TaskActivity,
  FakeSessionLink as SessionLink,
  FakeTaskCapabilities as TaskCapabilities,
  FakeGateState as GateState,
  FakeGateRequest as GateRequest,
  FakeGatePolicyContext as GatePolicyContext,
  FakeGateDecision as GateDecision,
  FakeGateCapabilities as GateCapabilities,
  FakeGateEffectStatus as GateEffectStatus,
} from '@gunnflow-testing/fake-contracts';

import type { Intent as ContractIntent } from '@gunnflow/contract';
import type { FakeIntentSlots, FakeSessionIntent, FakeTerminalIntent } from '@gunnflow-testing/fake-contracts';

/** A workspace intent as composed: the contract Intent; its idempotency key is minted at send. */
export type WorkspaceIntent = Omit<ContractIntent, 'idempotencyKey'>;

/**
 * Terminal and terminal-session intents keep their stand-in shape: sessions are
 * not nodes of the generic projection yet, and stdin is confirmed on the stream.
 */
export type SessionIntent = (FakeTerminalIntent | FakeSessionIntent) & FakeIntentSlots;

/** Every intent the pending store relays. */
export type Intent = WorkspaceIntent | SessionIntent;

/** On the wire every intent carries its idempotency key. */
export type WireIntent = Intent & { idempotencyKey: string };

export function isSessionIntent(i: Intent): i is SessionIntent {
  return 'intent' in i;
}

export function actionOf(i: Intent): string {
  return isSessionIntent(i) ? i.intent : i.action;
}

export function nodeOf(i: Intent): string {
  return isSessionIntent(i) ? i.sessionId : i.nodeId;
}

export function emptyProjection(): import('@gunnflow-testing/fake-contracts').FakeWorkspaceProjection {
  return {
    revision: 0,
    missions: [],
    tasks: [],
    gates: [],
    deliverables: [],
    edges: [],
    counts: { running: 0, needsYou: 0, blocked: 0 },
    activities: [],
    sessions: [],
    capabilities: {},
    gateCapabilities: {},
    effects: [],
  };
}
