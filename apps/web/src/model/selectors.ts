/**
 * Pure read-only selectors over the upstream projection. Everything here is a
 * lookup or a re-grouping of upstream-declared facts (edges, activities,
 * sessions, capabilities) — never an inference (Task Inspector brief §22).
 */
import type {
  ArtifactRef,
  Capability,
  DeliverableProjection,
  GateProjection,
  TaskProjection,
  WorkspaceProjection,
} from './types.js';
import type { FakeSessionLink, FakeTaskActivity, FakeTaskCapabilities } from '@gunnflow-testing/fake-contracts';
import { WORKSPACE_ROOT_KIND, type NodeProjection } from '@gunnflow/contract';

export function taskById(p: WorkspaceProjection, id: string): TaskProjection | null {
  return p.tasks.find((t) => t.id === id) ?? null;
}

/**
 * The workspace counts as empty only when both shapes say so: no domain
 * collections, and no generic nodes beyond the workspace root (an upstream
 * that speaks only the wire still always declares its root).
 */
export function workspaceEmpty(
  p: WorkspaceProjection,
  genericNodes: readonly NodeProjection[] | null,
): boolean {
  const domainEmpty =
    p.missions.length === 0 && p.tasks.length === 0 && p.gates.length === 0 && p.deliverables.length === 0;
  const genericEmpty = !genericNodes || genericNodes.every((n) => n.kind === WORKSPACE_ROOT_KIND);
  return domainEmpty && genericEmpty;
}

export function missionName(p: WorkspaceProjection, missionId: string): string | null {
  return p.missions.find((m) => m.id === missionId)?.name ?? null;
}

export interface TaskRelations {
  upstream: TaskProjection[];
  downstream: TaskProjection[];
  gates: GateProjection[];
  deliverables: DeliverableProjection[];
}

/** Direct relations as declared by upstream edges — no time/order inference. */
export function taskRelations(p: WorkspaceProjection, taskId: string): TaskRelations {
  const upstreamIds = p.edges.filter((e) => e.to === taskId).map((e) => e.from);
  const downstreamIds = p.edges.filter((e) => e.from === taskId).map((e) => e.to);
  const neighborIds = new Set([...upstreamIds, ...downstreamIds]);
  const pick = <T extends { id: string }>(items: T[], ids: string[]) =>
    ids.map((id) => items.find((x) => x.id === id)).filter((x): x is T => x !== undefined);
  return {
    upstream: pick(p.tasks, upstreamIds),
    downstream: pick(p.tasks, downstreamIds),
    gates: p.gates.filter((g) => neighborIds.has(g.id)),
    deliverables: p.deliverables.filter((d) => neighborIds.has(d.id)),
  };
}

/** Newest-first upstream activity summaries for one task. */
export function taskActivities(p: WorkspaceProjection, taskId: string): FakeTaskActivity[] {
  return p.activities.filter((a) => a.taskId === taskId).slice().reverse();
}

export function taskSessions(p: WorkspaceProjection, taskId: string): FakeSessionLink[] {
  return p.sessions.filter((s) => s.taskId === taskId);
}

export function taskCapabilities(p: WorkspaceProjection, taskId: string): FakeTaskCapabilities {
  return p.capabilities[taskId] ?? {};
}

/** Display label for an activity: upstream label, else its bare event type. */
export function activityLabel(a: FakeTaskActivity): string {
  return a.label ?? a.eventType;
}

/* ---------------------------- gates ---------------------------- */

export function gateById(p: WorkspaceProjection, id: string): GateProjection | null {
  return p.gates.find((g) => g.id === id) ?? null;
}

export interface GateRelations {
  tasks: TaskProjection[];
  deliverable: DeliverableProjection | null;
}

/** Tasks linked to the gate by upstream edges; evidence deliverable if declared. */
export function gateRelations(p: WorkspaceProjection, gateId: string): GateRelations {
  const gate = gateById(p, gateId);
  const linkedIds = p.edges
    .filter((e) => e.from === gateId || e.to === gateId)
    .map((e) => (e.from === gateId ? e.to : e.from));
  return {
    tasks: p.tasks.filter((t) => linkedIds.includes(t.id)),
    deliverable: gate?.deliverableId
      ? (p.deliverables.find((d) => d.id === gate.deliverableId) ?? null)
      : null,
  };
}

/** Effect outcomes for a gate — separate facts from the approval (brief §26). */
export function gateEffects(p: WorkspaceProjection, gateId: string) {
  return p.effects.filter((e) => e.gateId === gateId);
}

export function gateCapabilities(p: WorkspaceProjection, gateId: string) {
  return p.gateCapabilities[gateId] ?? {};
}

/** The node's declared `artifact.edit` capability, when upstream declares one. */
export function editCapability(p: WorkspaceProjection, taskId: string): Capability | undefined {
  return p.declaredCapabilities?.[taskId]?.find((c) => c.action === 'artifact.edit' && c.edit);
}

export function taskArtifact(p: WorkspaceProjection, taskId: string, artifactId: string): ArtifactRef | undefined {
  return taskById(p, taskId)?.artifacts?.find((a) => a.id === artifactId);
}
