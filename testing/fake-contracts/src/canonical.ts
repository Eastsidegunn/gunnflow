/**
 * The simulator's intake of the contract Intent: `nodeId + action` addressed to
 * its domain. Translation is the simulator's (the backend's) job; an action the
 * addressed node does not know is refused, never guessed.
 */
import type { Intent } from '@gunnflow/contract';
import type { FakeIntent, FakeWorkspaceProjection } from './projection.js';
import { WORKSPACE_NODE_ID } from './projectNodes.js';

export function fakeIntentFromCanonical(p: FakeWorkspaceProjection, i: Intent): FakeIntent | { refused: string } {
  const slots = {
    ...(i.decision !== undefined ? { decision: i.decision } : {}),
    ...(i.edit !== undefined ? { edit: i.edit } : {}),
    ...(i.attestation !== undefined ? { attestation: i.attestation } : {}),
  };
  const isTask = p.tasks.some((t) => t.id === i.nodeId);
  const isGate = p.gates.some((g) => g.id === i.nodeId);
  const isNode = isTask || isGate || p.deliverables.some((d) => d.id === i.nodeId);
  const refuse = { refused: `upstream rejected: '${i.nodeId}' has no action '${i.action}' (fake)` };
  switch (i.action) {
    case 'mission.create':
      return i.nodeId === WORKSPACE_NODE_ID && p.workspaceCapabilities ? { intent: 'mission.create', ...slots } : refuse;
    case 'task.pause':
    case 'task.resume':
    case 'task.instruct':
    case 'task.delete':
    case 'artifact.edit':
      return isTask ? ({ intent: i.action, taskId: i.nodeId, ...slots } as FakeIntent) : refuse;
    case 'gate.approve':
    case 'gate.reject':
    case 'gate.requestChanges':
      return isGate ? ({ intent: i.action, gateId: i.nodeId, ...slots } as FakeIntent) : refuse;
    case 'edge.rewire':
      return isNode && i.decision?.option
        ? { intent: 'edge.rewire', from: i.nodeId, to: i.decision.option, edgeKind: 'dependency' }
        : refuse;
    default:
      return refuse;
  }
}
