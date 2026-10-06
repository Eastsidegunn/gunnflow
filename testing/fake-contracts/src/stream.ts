/**
 * FakeWorkspaceStream — TEST-ONLY stand-in for an upstream projection stream
 * (BLOCKED.md #3). Simulates the real invariants:
 *
 *   intent → append-only event → derived-state recompute → new projection
 *
 * Past events are never updated or deleted (they are frozen on append).
 */
import type {
  FakeAppendedEvent,
  FakeIntent,
  FakeWorkspaceProjection,
} from './projection.js';
import type { IntentResult } from '@gunnflow/contract';
import { fakeBytesToBase64, fakeSha256Hex } from './artifacts.js';
import { fakeIntentText } from './projection.js';

type Listener = (projection: FakeWorkspaceProjection) => void;

export class FakeWorkspaceStream {
  private projection: FakeWorkspaceProjection;
  private readonly events: FakeAppendedEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private seq = 0;

  constructor(initial: FakeWorkspaceProjection) {
    this.projection = initial;
  }

  current(): FakeWorkspaceProjection {
    return this.projection;
  }

  /** Read-only audit chain. Entries are frozen; the array itself is not exposed mutably. */
  auditChain(): readonly FakeAppendedEvent[] {
    return this.events;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Simulates the upstream accepting a human intent: append the event, recompute the
   * derived projection, notify subscribers. The projection is replaced, never
   * patched in place — downstream stores treat it as authoritative input.
   */
  acceptIntent(intent: FakeIntent, actor: string, intentKey?: string): IntentResult {
    // Check and apply in one synchronous step: no window for the state to move in between.
    const reason = refusalFor(this.projection, intent);
    if (reason !== undefined) return { accepted: false, reason };
    this.append({ actor, type: intent.intent, payload: { ...intent, ...(intentKey ? { intentKey } : {}) } });
    const next = applyIntentToProjection(this.projection, intent, actor);
    this.projection = intentKey ? echoKey(next, intentKey) : next;
    this.emit();
    return { accepted: true };
  }

  /** Push an arbitrary upstream-side state change (e.g. a task finishing). */
  replaceProjection(next: FakeWorkspaceProjection, cause: { actor: string; type: string }): void {
    this.append({ actor: cause.actor, type: cause.type, payload: { revision: next.revision } });
    this.projection = next;
    this.emit();
  }

  private append(e: Omit<FakeAppendedEvent, 'seq' | 'at'>): void {
    const event: FakeAppendedEvent = Object.freeze({
      seq: ++this.seq,
      at: Date.now(),
      ...e,
      payload: Object.freeze({ ...e.payload }),
    });
    this.events.push(event);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.projection);
  }
}

const APPLIED_KEYS_KEPT = 500;

/** The upstream echoes the intent's key on what it produced and in its applied-keys log. */
function echoKey(p: FakeWorkspaceProjection, intentKey: string): FakeWorkspaceProjection {
  const own = `act-${p.revision}`;
  return {
    ...p,
    activities: p.activities.map((a) => (a.id === own ? { ...a, intentKey } : a)),
    appliedIntentKeys: [...(p.appliedIntentKeys ?? []), intentKey].slice(-APPLIED_KEYS_KEPT),
  };
}

/** Fake upstream judgements that must see the same state the apply step sees. */
function refusalFor(p: FakeWorkspaceProjection, intent: FakeIntent): string | undefined {
  const needsText = intent.intent === 'mission.create' || intent.intent === 'task.instruct' || intent.intent === 'gate.requestChanges';
  if (needsText && !fakeIntentText(intent)?.trim()) return `upstream rejected: ${intent.intent} needs text (fake)`;
  if (intent.intent !== 'artifact.edit') return undefined;
  if (!intent.edit) return 'upstream rejected: artifact.edit carries no edit';
  const cap = p.declaredCapabilities?.[intent.taskId]?.find((c) => c.action === 'artifact.edit');
  if (!cap || cap.level !== 'enabled') return 'upstream rejected: edit capability is not enabled (fake)';
  const artifactId = cap.edit?.artifactId;
  if (!cap.edit || !artifactId) return 'upstream rejected: no editable artifact declared (fake)';
  if (!cap.edit.mediaTypes.includes(intent.edit.mediaType)) {
    return `upstream rejected: media type ${intent.edit.mediaType} is not editable (fake)`;
  }
  if (new TextEncoder().encode(intent.edit.body).length > cap.edit.maxBytes) {
    return `upstream rejected: body exceeds ${cap.edit.maxBytes} bytes (fake)`;
  }
  const current = p.tasks.find((t) => t.id === intent.taskId)?.artifacts?.find((a) => a.id === artifactId);
  if (!current?.digest) return 'upstream rejected: target artifact missing or has no digest (fake conflict check)';
  if (current.digest !== intent.edit.baseDigest) {
    return 'upstream rejected: base digest is no longer current (fake conflict check)';
  }
  return undefined;
}

function applyIntentToProjection(
  prev: FakeWorkspaceProjection,
  intent: FakeIntent,
  actor: string,
): FakeWorkspaceProjection {
  const revision = prev.revision + 1;
  switch (intent.intent) {
    case 'mission.create': {
      const id = `m-${revision}`;
      return {
        ...prev,
        revision,
        missions: [...prev.missions, { kind: 'mission', id, name: fakeIntentText(intent)!, attention: false }],
      };
    }
    case 'edge.rewire': {
      return {
        ...prev,
        revision,
        edges: [
          ...prev.edges,
          { id: `e-${revision}`, from: intent.from, to: intent.to, edgeKind: intent.edgeKind },
        ],
      };
    }
    case 'task.delete': {
      // The write is authoritative here: the task, its edges and its capability entry leave the projection.
      const tasks = prev.tasks.filter((t) => t.id !== intent.taskId);
      const { [intent.taskId]: _dropped, ...capabilities } = prev.capabilities;
      return {
        ...prev,
        revision,
        tasks,
        edges: prev.edges.filter((e) => e.from !== intent.taskId && e.to !== intent.taskId),
        capabilities,
        counts: { ...prev.counts, running: tasks.filter((t) => t.state === 'running').length },
      };
    }
    case 'task.pause':
    case 'task.resume': {
      const paused = intent.intent === 'task.pause';
      const tasks = prev.tasks.map((t) =>
        t.id === intent.taskId ? { ...t, state: paused ? ('paused' as const) : ('running' as const) } : t,
      );
      return {
        ...prev,
        revision,
        tasks,
        counts: { ...prev.counts, running: tasks.filter((t) => t.state === 'running').length },
        activities: [
          ...prev.activities,
          {
            id: `act-${revision}`,
            taskId: intent.taskId,
            at: Date.now(),
            label: paused ? 'Paused by operator' : 'Resumed by operator',
            eventType: intent.intent,
            actor: 'human' as const,
          },
        ],
      };
    }
    case 'gate.approve':
    case 'gate.reject': {
      const approved = intent.intent === 'gate.approve';
      const gates = prev.gates.map((g) =>
        g.id === intent.gateId
          ? {
              ...g,
              state: approved ? ('approved' as const) : ('rejected' as const),
              decision: {
                by: actor,
                at: Date.now(),
                choice: approved ? ('approved' as const) : ('rejected' as const),
                reason: fakeIntentText(intent),
              },
            }
          : g,
      );
      const gate = prev.gates.find((g) => g.id === intent.gateId);
      // Approval of an external-effect gate starts a SEPARATE effect fact.
      const effects =
        approved && gate?.request?.externalEffect
          ? [
              ...prev.effects,
              { gateId: gate.id, label: gate.requestedAction, state: 'pending' as const },
            ]
          : prev.effects;
      return {
        ...prev,
        revision,
        gates,
        effects,
        counts: { ...prev.counts, needsYou: gates.filter((g) => g.state === 'waiting').length },
      };
    }
    case 'gate.requestChanges': {
      // The upstream decides the resulting state; this fake keeps the gate waiting
      // and lands the instruction on the gate-linked task as a human activity.
      const linkedTaskId = prev.edges
        .filter((e) => e.from === intent.gateId || e.to === intent.gateId)
        .map((e) => (e.from === intent.gateId ? e.to : e.from))
        .find((id) => prev.tasks.some((t) => t.id === id));
      return {
        ...prev,
        revision,
        activities: linkedTaskId
          ? [
              ...prev.activities,
              {
                id: `act-${revision}`,
                taskId: linkedTaskId,
                at: Date.now(),
                label: fakeIntentText(intent),
                eventType: 'human.changes-requested',
                actor: 'human' as const,
              },
            ]
          : prev.activities,
      };
    }
    case 'artifact.edit': {
      const artifactId = prev.declaredCapabilities?.[intent.taskId]
        ?.find((c) => c.action === 'artifact.edit')?.edit?.artifactId;
      if (!intent.edit || !artifactId) return prev; // unreachable: refusalFor guards
      const bytes = new TextEncoder().encode(intent.edit.body);
      const ref = {
        id: artifactId,
        mediaType: intent.edit.mediaType,
        digest: fakeSha256Hex(bytes),
        access: { kind: 'snapshot' as const },
      };
      return {
        ...prev,
        revision,
        tasks: prev.tasks.map((t) =>
          t.id === intent.taskId
            ? { ...t, artifacts: [...(t.artifacts ?? []).filter((a) => a.id !== artifactId), ref] }
            : t,
        ),
        artifactSnapshots: { ...prev.artifactSnapshots, [artifactId]: fakeBytesToBase64(bytes) },
        activities: [
          ...prev.activities,
          {
            id: `act-${revision}`,
            taskId: intent.taskId,
            at: Date.now(),
            label: `Edited ${artifactId}`,
            eventType: 'artifact.edit',
            actor: 'human' as const,
          },
        ],
      };
    }
    case 'task.instruct': {
      return {
        ...prev,
        revision,
        activities: [
          ...prev.activities,
          {
            id: `act-${revision}`,
            taskId: intent.taskId,
            at: Date.now(),
            label: fakeIntentText(intent),
            eventType: 'human.instruction',
            actor: 'human' as const,
          },
        ],
      };
    }
  }
}
