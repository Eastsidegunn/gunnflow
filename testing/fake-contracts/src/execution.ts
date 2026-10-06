/**
 * TEST-ONLY execution-level shapes (Execution Surface brief §31), standing in
 * for the unresolved upstream execution-telemetry contract (BLOCKED.md).
 * Everything here is upstream-authored fact; Gunnflow renders it verbatim and
 * never reinterprets events.
 */
import type { CapabilityLevel, ExecutionSnapshot, StreamRef } from '@gunnflow/contract';

export interface FakePolicyView {
  ceiling?: string;
  missionNarrowing?: string;
  sessionNarrowing?: string;
  activePolicies?: string[];
  decisions?: Array<{ at: number; label: string; outcome: 'allow' | 'deny' | 'pending' }>;
  remainingBudget?: string;
}

export interface FakeSessionCapabilities {
  /** Direct stdin injection authority (Live Terminal brief §8). */
  stdin?: CapabilityLevel;
  pause?: CapabilityLevel;
  resume?: CapabilityLevel;
  fork?: CapabilityLevel;
  kill?: CapabilityLevel;
  restart?: CapabilityLevel;
}

export interface FakeSessionProjection {
  id: string;
  taskId: string;
  label: string;
  /** Omitted when the upstream carries no agent identity. */
  agentLabel?: string;
  /** Only when upstream provides the model identity. */
  model?: string;
  state: 'running' | 'paused' | 'ended' | 'killed';
  /** Omitted when upstream provides no start time (execution v1). */
  startedAt?: number;
  parentSessionId?: string;
  policy?: FakePolicyView;
  runtime?: {
    cwd?: string;
    currentCommand?: string;
    /** Values arrive ALREADY masked upstream; raw secrets never exist here. */
    maskedEnv?: Record<string, string>;
  };
  capabilities?: FakeSessionCapabilities;
  /** Stream channels this session declares; content arrives on the BFF stream route. */
  streams?: StreamRef[];
}

export interface FakeToolCall {
  name: string;
  args: string;
  result?: string;
  durationMs?: number;
  costLabel?: string;
}

export interface FakeFileDiff {
  path: string;
  change: 'create' | 'modify' | 'delete';
  diff?: string;
}

export interface FakeEgressEvent {
  destination: string;
  outcome: 'allow' | 'deny' | 'pending';
  gateId?: string;
  effectResult?: string;
}

export type FakeExecutionEventKind =
  | 'session'
  | 'message'
  | 'tool.call'
  | 'file.change'
  | 'shell'
  | 'egress'
  | 'policy.decision'
  | 'human';

export interface FakeExecutionEvent {
  seq: number;
  at: number;
  sessionId: string;
  kind: FakeExecutionEventKind;
  /** Upstream-provided summary; the UI never re-summarizes. */
  label: string;
  status?: 'ok' | 'failed' | 'pending' | 'denied';
  durationMs?: number;
  tool?: FakeToolCall;
  file?: FakeFileDiff;
  message?: { role: 'human' | 'agent' | 'system' | 'model'; content: string };
  egress?: FakeEgressEvent;
}

export interface FakeExecutionProjection {
  taskId: string;
  sessions: FakeSessionProjection[];
  events: FakeExecutionEvent[];
}

/** Session control intents — relayed like every other human intent. */
export type FakeSessionIntent =
  | { intent: 'session.pause'; sessionId: string }
  | { intent: 'session.resume'; sessionId: string }
  | { intent: 'session.fork'; sessionId: string };

/**
 * The contract's wire view of a fake execution projection (contract 0.3.0,
 * GET /execution): sessions and events reduced to the contract fields. The
 * richer payload views (tool/file/message/egress, policy, runtime,
 * capabilities) have no upstream contract yet and stay fake-path-only.
 */
export function toExecutionSnapshot(p: FakeExecutionProjection): ExecutionSnapshot {
  return {
    sessions: p.sessions.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      state: s.state,
      ...(s.label ? { label: s.label } : {}),
    })),
    events: p.events.map((e) => ({
      seq: e.seq,
      at: e.at,
      sessionId: e.sessionId,
      kind: e.kind,
      label: e.label,
      ...(e.status !== undefined ? { status: e.status } : {}),
    })),
  };
}

export type FakeExecutionDelta =
  | { type: 'events'; events: FakeExecutionEvent[] }
  | { type: 'session'; session: FakeSessionProjection };

type Listener = (delta: FakeExecutionDelta) => void;

/**
 * FakeExecutionEventStream — snapshot + tail semantics like the real thing:
 * events are append-only (frozen), sessions update as whole records, and
 * session controls flow intent → append → new state → delta.
 */
export class FakeExecutionEventStream {
  private sessions: FakeSessionProjection[];
  private readonly events: FakeExecutionEvent[];
  private readonly listeners = new Set<Listener>();
  private seq: number;

  constructor(initial: FakeExecutionProjection) {
    this.sessions = initial.sessions;
    this.events = [...initial.events];
    this.seq = Math.max(0, ...initial.events.map((e) => e.seq));
  }

  snapshot(): FakeExecutionProjection {
    return {
      taskId: this.sessions[0]?.taskId ?? '',
      sessions: this.sessions,
      events: this.events,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Append upstream events (burst simulation, live activity). Append-only. */
  appendEvents(batch: Array<Omit<FakeExecutionEvent, 'seq' | 'at'> & { at?: number }>): void {
    const appended = batch.map((e) =>
      Object.freeze({ at: Date.now(), ...e, seq: ++this.seq }) as FakeExecutionEvent,
    );
    this.events.push(...appended);
    this.emit({ type: 'events', events: appended });
  }

  acceptSessionIntent(
    intent: FakeSessionIntent,
    actor: string,
  ): { accepted: boolean; reason?: string } {
    const session = this.sessions.find((s) => s.id === intent.sessionId);
    if (!session) return { accepted: false, reason: 'unknown session' };
    if (session.state === 'ended' || session.state === 'killed') {
      return { accepted: false, reason: `session already ${session.state}` };
    }
    switch (intent.intent) {
      case 'session.pause':
      case 'session.resume': {
        const next = {
          ...session,
          state: intent.intent === 'session.pause' ? ('paused' as const) : ('running' as const),
        };
        this.replaceSession(next);
        this.appendEvents([
          {
            sessionId: session.id,
            kind: 'human',
            label: `${intent.intent === 'session.pause' ? 'Paused' : 'Resumed'} by ${actor}`,
            status: 'ok',
          },
        ]);
        return { accepted: true };
      }
      case 'session.fork': {
        const forkId = `${session.id}-f${this.seq + 1}`;
        const fork: FakeSessionProjection = {
          ...session,
          id: forkId,
          label: `${session.label} fork`,
          parentSessionId: session.id,
          startedAt: Date.now(),
          state: 'running',
        };
        this.sessions = [...this.sessions, fork];
        this.emit({ type: 'session', session: fork });
        this.appendEvents([
          { sessionId: session.id, kind: 'human', label: `Forked to ${forkId} by ${actor}`, status: 'ok' },
        ]);
        return { accepted: true };
      }
    }
  }

  /** Apply an externally-caused session state change (e.g. a terminal kill). */
  applySessionRecord(next: FakeSessionProjection): void {
    this.replaceSession(next);
  }

  private replaceSession(next: FakeSessionProjection): void {
    this.sessions = this.sessions.map((s) => (s.id === next.id ? next : s));
    this.emit({ type: 'session', session: next });
  }

  private emit(delta: FakeExecutionDelta): void {
    for (const l of this.listeners) l(delta);
  }
}
