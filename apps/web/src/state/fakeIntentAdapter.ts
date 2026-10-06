/**
 * TEST-ONLY adapter binding PendingIntentState to the simulator (BLOCKED.md #3).
 * Workspace intents are contract Intents (nodeId + action); only terminal and
 * session intents keep their stand-in shape.
 *
 * Capabilities come from the contract's generic nodes when the upstream sends
 * them; otherwise from the stand-in projection (declared, else its legacy
 * maps read in the same terms the simulator translates them).
 *
 * Confirmation: when the upstream echoes the idempotency keys it applied, an
 * in-flight intent is satisfied by its key alone. Otherwise the stand-in's
 * observable effects are matched (an estimate, kept for upstreams without echo).
 */
import { lookupCapability, WORKSPACE_ROOT_KIND, type Capability, type NodeProjection } from '@gunnflow/contract';
import {
  actionOf,
  isSessionIntent,
  type SessionIntent,
  type WorkspaceIntent,
  type WorkspaceProjection,
} from '../model/types.js';
import type { InFlightEntry, PendingIntentAdapter } from './pendingIntents.js';
import { workspaceRoot } from './workspaceRoot.js';

/** Keys a stand-in session intent carries besides the shared slots. */
const SESSION_KIND_KEYS: Record<SessionIntent['intent'], readonly string[]> = {
  'session.stdin': ['sessionId', 'input', 'inputRef'],
  'session.kill': ['sessionId', 'reason'],
  'session.pause': ['sessionId'],
  'session.resume': ['sessionId'],
  'session.fork': ['sessionId'],
};

const textOf = (i: WorkspaceIntent) => i.decision?.text;

/** Observable-effect match for upstreams that do not echo applied keys. */
function estimated(entry: InFlightEntry, i: WorkspaceIntent, p: WorkspaceProjection): boolean {
  switch (i.action) {
    case 'edge.rewire':
      return p.edges.some((e) => e.from === i.nodeId && e.to === i.decision?.option && e.edgeKind === 'dependency');
    case 'mission.create':
      return p.missions.some((m) => m.name === textOf(i));
    case 'task.pause':
      return p.tasks.some((t) => t.id === i.nodeId && t.state !== 'running');
    case 'task.resume':
      return p.tasks.some((t) => t.id === i.nodeId && t.state === 'running');
    case 'task.delete':
      return p.tasks.every((t) => t.id !== i.nodeId);
    case 'task.instruct':
      return p.activities.some((a) => a.taskId === i.nodeId && a.actor === 'human' && a.label === textOf(i));
    case 'artifact.edit':
      return (
        entry.editDigest !== undefined &&
        p.tasks.some((t) => t.id === i.nodeId && t.artifacts?.some((a) => a.digest === entry.editDigest))
      );
    case 'gate.approve':
      return p.gates.some((g) => g.id === i.nodeId && g.state === 'approved');
    case 'gate.reject':
      return p.gates.some((g) => g.id === i.nodeId && g.state === 'rejected');
    case 'gate.requestChanges': {
      const linked = new Set(
        p.edges.filter((e) => e.from === i.nodeId || e.to === i.nodeId).map((e) => (e.from === i.nodeId ? e.to : e.from)),
      );
      return p.activities.some(
        (a) => a.actor === 'human' && a.eventType === 'human.changes-requested' && linked.has(a.taskId) && a.label === textOf(i),
      );
    }
    default:
      return false;
  }
}

const TASK_ACTION: Record<string, string> = {
  pause: 'task.pause',
  resume: 'task.resume',
  instruct: 'task.instruct',
  cancel: 'task.cancel',
  forceReplan: 'task.forceReplan',
};
const TEXT_TASK_ACTIONS = new Set(['instruct', 'cancel', 'forceReplan']);

/** The stand-in node an id names, with its capabilities in contract terms; undefined when absent. */
function standInNode(nodeId: string, p: WorkspaceProjection): { capabilities?: Capability[] } | undefined {
  const declared = p.declaredCapabilities?.[nodeId];
  const task = p.tasks.find((t) => t.id === nodeId);
  if (task) {
    const map = p.capabilities[nodeId];
    const legacy: Capability[] | undefined = map
      ? Object.entries(map).flatMap(([k, level]) =>
          level && TASK_ACTION[k]
            ? [{ action: TASK_ACTION[k]!, level, ...(TEXT_TASK_ACTIONS.has(k) ? { decision: { input: { required: true } } } : {}) }]
            : [],
        )
      : undefined;
    return { capabilities: declared ?? legacy };
  }
  const gate = p.gates.find((g) => g.id === nodeId);
  if (gate) {
    const map = p.gateCapabilities[nodeId];
    const legacy: Capability[] | undefined = map
      ? (['approve', 'reject', 'requestChanges'] as const).flatMap((k) => {
          const level = map[k];
          return level
            ? [{ action: `gate.${k}`, level, decision: { input: { required: k === 'requestChanges' || gate.reasonRequired === true } } }]
            : [];
        })
      : undefined;
    return { capabilities: declared ?? legacy };
  }
  if (p.missions.some((m) => m.id === nodeId) || p.deliverables.some((d) => d.id === nodeId)) {
    return { capabilities: declared };
  }
  return undefined;
}

/** Where an artifact's current digest can be read in the stand-in projection. */
export function fakeArtifactDigest(artifactId: string, projection: WorkspaceProjection): string | undefined {
  for (const holder of [...projection.tasks, ...projection.deliverables]) {
    const a = holder.artifacts?.find((x) => x.id === artifactId);
    if (a) return a.digest;
  }
  return undefined;
}

export function createFakeIntentAdapter(genericNodes: () => readonly NodeProjection[] | null): PendingIntentAdapter {
  return {
    isSatisfied(entry, projection) {
      const i = entry.intent;
      if (isSessionIntent(i)) return false;
      if (projection.appliedIntentKeys !== undefined) return projection.appliedIntentKeys.includes(entry.idempotencyKey);
      return estimated(entry, i, projection);
    },
    kindKeys: (intent) => (Object.hasOwn(SESSION_KIND_KEYS, intent.intent) ? SESSION_KIND_KEYS[intent.intent] : undefined),
    reopenDraft(intent) {
      if (isSessionIntent(intent) || (intent.action !== 'gate.approve' && intent.action !== 'gate.reject')) return undefined;
      return { action: null, nodeId: intent.nodeId, text: intent.decision?.text ?? '' };
    },
    matchesChunk(entry, nodeId, chunk) {
      const i = entry.intent;
      return (
        isSessionIntent(i) &&
        i.intent === 'session.stdin' &&
        i.sessionId === nodeId &&
        chunk.channel === 'operator' &&
        chunk.data === `$ ${i.input}`
      );
    },
    isSatisfiedBySession(entry, session) {
      const i = entry.intent;
      if (!isSessionIntent(i) || i.sessionId !== session.id) return false;
      if (i.intent === 'session.kill') return session.state === 'killed';
      if (i.intent === 'session.pause') return session.state === 'paused';
      if (i.intent === 'session.resume') return session.state === 'running';
      // session.fork creates another session; this record cannot confirm it.
      return false;
    },
    editContext(intent, projection) {
      if (isSessionIntent(intent) || intent.action !== 'artifact.edit') return { capability: undefined, artifact: undefined };
      const nodes = genericNodes();
      const node = nodes?.find((n) => n.id === intent.nodeId);
      const capability = node
        ? node.capabilities.find((c) => c.action === 'artifact.edit')
        : projection.declaredCapabilities?.[intent.nodeId]?.find((c) => c.action === 'artifact.edit');
      const artifactId = capability?.edit?.artifactId;
      const artifact = artifactId
        ? (node?.artifacts ?? projection.tasks.find((t) => t.id === intent.nodeId)?.artifacts)?.find((a) => a.id === artifactId)
        : undefined;
      return { capability, artifact };
    },
    artifactDigest(artifactId, projection) {
      // Generic nodes first (the contract's view), then the stand-in projection.
      for (const n of genericNodes() ?? []) {
        const a = n.artifacts.find((x) => x.id === artifactId);
        if (a) return a.digest;
      }
      return fakeArtifactDigest(artifactId, projection);
    },
    capabilityFor(intent, projection) {
      // Session intents address the execution surface, outside the workspace: pairing only.
      if (isSessionIntent(intent)) return { declared: false };
      const nodes = genericNodes();
      if (nodes) {
        const node = nodes.find((n) => n.id === intent.nodeId);
        // A root that is not the unique root addresses nothing.
        if (node?.kind === WORKSPACE_ROOT_KIND && workspaceRoot(nodes).root?.id !== node.id) return { missing: 'node' };
        return lookupCapability(node, actionOf(intent));
      }
      if (intent.action === 'mission.create' && projection.workspaceCapabilities && !standInNode(intent.nodeId, projection)) {
        return { declared: true, capability: projection.workspaceCapabilities.find((c) => c.action === intent.action) };
      }
      return lookupCapability(standInNode(intent.nodeId, projection), intent.action);
    },
  };
}

/** The adapter over the stand-in projection alone (no generic nodes). */
export const fakeIntentAdapter: PendingIntentAdapter = createFakeIntentAdapter(() => null);

