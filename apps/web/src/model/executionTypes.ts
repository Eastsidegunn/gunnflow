/**
 * Execution-level wire shapes. The core snapshot/session/event shapes are the
 * contract's (@gunnflow/contract 0.3.0 — GET /execution + SSE snapshot
 * republish). The richer payload views the Execution Surface also renders
 * (tool/file/message/egress, policy, runtime, session capabilities, fork
 * lineage) have no upstream contract yet (BLOCKED.md): they remain
 * fake-contracts shapes, imported TYPE-ONLY, and only the fake upstream sends
 * them — the single point of change when those contracts land.
 */
import type {
  ExecutionEvent as WireExecutionEvent,
  ExecutionSession as WireExecutionSession,
  StreamRef,
} from '@gunnflow/contract';
import type {
  FakeEgressEvent,
  FakeFileDiff,
  FakePolicyView,
  FakeSessionCapabilities,
  FakeToolCall,
} from '@gunnflow-testing/fake-contracts';

export type { ExecutionSnapshot as ExecutionProjection } from '@gunnflow/contract';
export type {
  FakeEgressEvent as EgressEvent,
  FakeFileDiff as FileDiff,
  FakePolicyView as PolicyView,
  FakeSessionCapabilities as SessionCapabilities,
  FakeSessionIntent as SessionIntent,
  FakeToolCall as ToolCall,
} from '@gunnflow-testing/fake-contracts';

/** Contract event plus the fake-only payload views (absent on the direct wire). */
export type ExecutionEvent = WireExecutionEvent & {
  durationMs?: number;
  tool?: FakeToolCall;
  file?: FakeFileDiff;
  message?: { role: 'human' | 'agent' | 'system' | 'model'; content: string };
  egress?: FakeEgressEvent;
};

/** Contract session plus the fake-only enrichments (absent on the direct wire). */
export type SessionProjection = WireExecutionSession & {
  agentLabel?: string;
  model?: string;
  startedAt?: number;
  parentSessionId?: string;
  policy?: FakePolicyView;
  runtime?: { cwd?: string; currentCommand?: string; maskedEnv?: Record<string, string> };
  capabilities?: FakeSessionCapabilities;
  streams?: StreamRef[];
};
