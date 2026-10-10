/**
 * The simulator's translation of its domain projection into the contract's
 * NodeProjection. Translation is the backend's job: the domain vocabulary
 * (task states, edge kinds, capability names) passes through as opaque
 * strings; nothing is scored or inferred.
 */
import { WORKSPACE_ROOT_KIND, type ArtifactRef, type Capability, type CapabilityLevel, type NodeProjection } from '@gunnflow/contract';
import type {
  FakeEdgeProjection,
  FakeGateCapabilities,
  FakeGateProjection,
  FakeTaskCapabilities,
  FakeWorkspaceProjection,
} from './projection.js';

/** State value for a node whose upstream shape carries no state of its own. */
export const UNSTATED = 'unstated';
/** Relation type for mission membership, which the domain carries as `missionId`. */
export const MEMBER_OF = 'member-of';
/** Attention cause for the domain's boolean flag, which carries no cause. */
export const FLAGGED = 'flagged';
/** Id of the workspace root node. */
export const WORKSPACE_NODE_ID = 'workspace';
/** Attention cause for a gate the domain marks as waiting on a human decision. */
export const WAITING_FOR_HUMAN = 'waiting_for_human';

const TASK_ACTIONS: Record<keyof FakeTaskCapabilities, string> = {
  pause: 'task.pause',
  resume: 'task.resume',
  instruct: 'task.instruct',
  cancel: 'task.cancel',
  forceReplan: 'task.forceReplan',
  delete: 'task.delete',
};
const GATE_ACTIONS: Record<'approve' | 'reject' | 'requestChanges', string> = {
  approve: 'gate.approve',
  reject: 'gate.reject',
  requestChanges: 'gate.requestChanges',
};

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

function edgesFrom(id: string, edges: FakeEdgeProjection[]) {
  return edges.filter((e) => e.from === id).map((e) => ({ type: e.edgeKind, target: e.to }));
}

function membership(missionId: string) {
  return missionId ? [{ type: MEMBER_OF, target: missionId }] : [];
}

/**
 * Instructions carry text; cancel and force-replan are privileged and carry a
 * stated reason — so none of them can run from a label-only control.
 */
const TASK_TEXT_ACTIONS = new Set<keyof FakeTaskCapabilities>(['instruct', 'cancel', 'forceReplan']);

function taskCapabilities(caps: FakeTaskCapabilities | undefined): Capability[] {
  return Object.entries(caps ?? {}).flatMap(([key, level]) =>
    level
      ? [
          {
            action: TASK_ACTIONS[key as keyof FakeTaskCapabilities],
            level: level as CapabilityLevel,
            ...(TASK_TEXT_ACTIONS.has(key as keyof FakeTaskCapabilities) ? { decision: { input: { required: true } } } : {}),
          },
        ]
      : [],
  );
}

function gateCapabilities(
  gate: FakeGateProjection,
  caps: FakeGateCapabilities | undefined,
  evidence: readonly ArtifactRef[],
): Capability[] {
  const out: Capability[] = [];
  for (const key of ['approve', 'reject', 'requestChanges'] as const) {
    const level = caps?.[key];
    if (!level) continue;
    // requestChanges always carries text; approve/reject may carry a reason, required when the domain says so.
    const input = { input: { required: key === 'requestChanges' || gate.reasonRequired === true } };
    // Approving is conditioned on viewing the gate's evidence artifacts.
    const ev = key === 'approve' && evidence.length > 0 ? { evidence: evidence.map((a) => a.id) } : {};
    out.push({
      action: GATE_ACTIONS[key],
      level,
      decision: { ...input, ...ev },
    });
  }
  return out;
}

export function projectNodes(p: FakeWorkspaceProjection): NodeProjection[] {
  const declared = p.declaredCapabilities ?? {};
  // Rewiring is offered from any node to the other nodes of its mission (the options are the targets).
  const members = [...p.tasks, ...p.gates, ...p.deliverables];
  const withRewire = (id: string, missionId: string, caps: Capability[]): Capability[] => {
    if (caps.some((c) => c.action === 'edge.rewire')) return caps;
    const options = members.filter((m) => m.missionId === missionId && m.id !== id).map((m) => m.id);
    return options.length > 0 ? [...caps, { action: 'edge.rewire', level: 'enabled', decision: { options } }] : caps;
  };
  const attentionOf = (flag: boolean, since: number | undefined) => {
    const at = iso(since);
    return flag ? [{ cause: FLAGGED, ...(at ? { since: at } : {}) }] : [];
  };

  const root: NodeProjection[] = p.workspaceCapabilities
    ? [
        {
          id: WORKSPACE_NODE_ID,
          kind: WORKSPACE_ROOT_KIND,
          label: 'Workspace',
          state: { value: UNSTATED },
          relations: [],
          capabilities: p.workspaceCapabilities,
          attention: [],
          artifacts: [],
        },
      ]
    : [];
  const missions: NodeProjection[] = p.missions.map((m) => ({
    id: m.id,
    kind: 'mission',
    label: m.name,
    state: { value: m.aggregateState ?? UNSTATED },
    relations: edgesFrom(m.id, p.edges),
    capabilities: declared[m.id] ?? [],
    attention: attentionOf(m.attention, undefined),
    artifacts: [],
  }));
  const tasks: NodeProjection[] = p.tasks.map((t) => ({
    id: t.id,
    kind: 'task',
    label: t.name,
    state: { value: t.state },
    relations: [...membership(t.missionId), ...edgesFrom(t.id, p.edges)],
    capabilities: withRewire(t.id, t.missionId, declared[t.id] ?? taskCapabilities(p.capabilities[t.id])),
    attention: attentionOf(t.attention, t.updatedAt ?? t.startedAt),
    artifacts: t.artifacts ?? [],
  }));
  const evidenceOf = (g: FakeGateProjection) =>
    (g.deliverableId ? p.deliverables.find((d) => d.id === g.deliverableId)?.artifacts : undefined) ?? [];
  const gates: NodeProjection[] = p.gates.map((g) => ({
    id: g.id,
    kind: 'gate',
    label: g.name,
    state: { value: g.state },
    relations: [
      ...membership(g.missionId),
      ...edgesFrom(g.id, p.edges),
      ...(g.deliverableId ? [{ type: 'evidence', target: g.deliverableId }] : []),
      ...(g.supersededBy ? [{ type: 'superseded-by', target: g.supersededBy }] : []),
    ],
    capabilities: withRewire(g.id, g.missionId, declared[g.id] ?? gateCapabilities(g, p.gateCapabilities[g.id], evidenceOf(g))),
    // A waiting gate is, in this domain, a request for a human decision.
    attention:
      g.state === 'waiting'
        ? [{ cause: WAITING_FOR_HUMAN, ...(g.request?.requestedAt ? { since: iso(g.request.requestedAt) } : {}) }]
        : [],
    artifacts: [...evidenceOf(g)],
  }));
  const deliverables: NodeProjection[] = p.deliverables.map((d) => ({
    id: d.id,
    kind: 'deliverable',
    label: d.title,
    state: { value: d.state ?? UNSTATED },
    relations: [...membership(d.missionId), ...edgesFrom(d.id, p.edges)],
    capabilities: withRewire(d.id, d.missionId, declared[d.id] ?? []),
    attention: [],
    artifacts: d.artifacts ?? [],
  }));
  const chores: NodeProjection[] = (p.chores ?? []).map((c) => ({
    id: c.id,
    kind: CHORE_KIND,
    label: c.name,
    state: { value: c.state },
    relations: membership(c.missionId),
    capabilities: declared[c.id] ?? (c.reportable && c.state === 'waiting' ? CHORE_CAPABILITIES : []),
    attention:
      c.state === 'waiting' ? [{ cause: NEEDS_HANDS, ...(c.requestedAt ? { since: iso(c.requestedAt) } : {}) }] : [],
    artifacts: [],
  }));
  const all = [...root, ...missions, ...tasks, ...gates, ...deliverables, ...chores];
  // Decorations are upstream-stated facts carried verbatim; a node without an entry carries none.
  const decorations = p.nodeDecorations ?? {};
  return all.map((n) => (Object.hasOwn(decorations, n.id) ? { ...n, ...decorations[n.id] } : n));
}

/** Node kind of a hands-on request (the simulator's word). */
export const CHORE_KIND = 'chore';
/** Attention cause for a hands-on request waiting on a person. */
export const NEEDS_HANDS = 'needs_hands';
/** Report actions: done carries an optional note; cannot requires the reason. */
const CHORE_CAPABILITIES: Capability[] = [
  { action: 'chore.done', level: 'enabled', decision: { input: { required: false } } },
  { action: 'chore.cannot', level: 'enabled', decision: { input: { required: true } } },
];
