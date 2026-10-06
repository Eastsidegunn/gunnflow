/**
 * TEST-ONLY detail sources: the simulator's on-demand node detail (direct
 * wire GET /detail/:nodeId). Items restate fixture values in the simulator's
 * own vocabulary — the engine never interprets the labels. Nodes without a
 * source here have no detail (the 404 path).
 */
import type { DetailItem, NodeDetail } from '@gunnflow/contract';
import type { FakeWorkspaceProjection } from './projection.js';
import { WORKSPACE_NODE_ID } from './projectNodes.js';

export function detailOf(p: FakeWorkspaceProjection, nodeId: string): NodeDetail | undefined {
  const items = detailItems(p, nodeId);
  return items ? { revision: p.revision, items } : undefined;
}

function detailItems(p: FakeWorkspaceProjection, nodeId: string): DetailItem[] | undefined {
  // The workspace root surfaces its status counts, verbatim from the fixture.
  if (nodeId === WORKSPACE_NODE_ID && p.workspaceCapabilities) {
    return Object.entries(p.counts).map(([label, n]) => ({ label, text: String(n) }));
  }
  // The publish gate restates its request plus the backend's recommendation.
  if (nodeId === 'g-publish') {
    const gate = p.gates.find((g) => g.id === nodeId);
    if (!gate) return undefined;
    return [
      ...(gate.requestedAction ? [{ label: 'requested', text: gate.requestedAction }] : []),
      ...(gate.request?.impact ? [{ label: 'impact', text: gate.request.impact }] : []),
      { label: 'recommendation', text: 'Approve after reviewing the evidence.' },
    ];
  }
  // The build task carries a progress slot the projection does not.
  if (nodeId === 't-build' && p.tasks.some((t) => t.id === nodeId)) {
    return [{ label: 'progress', text: '41/42 tests' }];
  }
  return undefined;
}
