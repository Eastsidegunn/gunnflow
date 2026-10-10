/**
 * Wire → internal projection. The body arrives in the cockpit's shape (a
 * direct-wire backend sends only `nodes`); this only fills absent collections
 * with empty ones. Omitted upstream values stay omitted — never inferred.
 */
import { snapshotNodeProblem, type NodeProjection } from '@gunnflow/contract';
import type { WorkspaceProjection } from './types.js';

export function normalizeProjection(raw: unknown): WorkspaceProjection {
  // The contract's generic nodes, when present, are kept apart from the domain shape.
  const { nodes: _nodes, ...body } = (raw ?? {}) as Partial<WorkspaceProjection> & { nodes?: unknown };
  return {
    ...body,
    revision: body.revision ?? 0,
    missions: body.missions ?? [],
    tasks: body.tasks ?? [],
    gates: body.gates ?? [],
    deliverables: body.deliverables ?? [],
    edges: body.edges ?? [],
    counts: body.counts ?? { running: 0, needsYou: 0, blocked: 0 },
    activities: body.activities ?? [],
    sessions: body.sessions ?? [],
    capabilities: body.capabilities ?? {},
    gateCapabilities: body.gateCapabilities ?? {},
    effects: body.effects ?? [],
  };
}

/** Whether the upstream body carries its own `counts` (a direct-wire body never does). */
export function countsReceived(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && 'counts' in raw;
}

export interface GenericNodes {
  nodes: NodeProjection[];
  /** Received nodes that fail the contract's node checks, with the first reason each. */
  invalid: { index: number; problem: string }[];
}

/**
 * The generic NodeProjection collection the upstream sends in the body.
 * Well-formed nodes are kept as received; malformed ones are listed with
 * their reason, never repaired. `revision` is the carrying snapshot's: a node
 * also answers to the snapshot rule (changedAtRevision ≤ revision).
 */
export function normalizeNodes(raw: unknown, revision: number): GenericNodes | null {
  const nodes = (raw as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return null;
  const valid: NodeProjection[] = [];
  const invalid: GenericNodes['invalid'] = [];
  nodes.forEach((n, index) => {
    const problem = snapshotNodeProblem(n, revision);
    if (problem) invalid.push({ index, problem });
    else valid.push(n as NodeProjection);
  });
  return { nodes: valid, invalid };
}
