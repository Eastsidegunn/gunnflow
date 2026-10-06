// The simulator is the first backend to pass the contract's conformance suite:
// it projects canonical nodes, validates before acting, and maps canonical
// intents onto its own domain.
import {
  CONTRACT_VERSION,
  lookupCapability,
  validateIntent,
  type StreamEvent,
} from '@gunnflow/contract';
import { defineConformanceSuite, type ConformanceNode, type ConformanceTarget } from '@gunnflow/contract/conformance';
import {
  FAKE_EXECUTIONS,
  FakePtyStream,
  FakeWorkspaceStream,
  NullIntentRelay,
  buildExecutionFixture,
  fakePtyBuffer,
  fakePtyFeed,
  normalFixture,
  projectNodes,
  toExecutionSnapshot,
} from '../src/index.js';
import { detailOf } from '../src/details.js';

function simulatorTarget(): ConformanceTarget {
  const workspace = new FakeWorkspaceStream(normalFixture());
  const relay = new NullIntentRelay(workspace);
  const session = buildExecutionFixture().sessions[0]!;
  const pty = new FakePtyStream(session, fakePtyBuffer(session.id));
  const feed = fakePtyFeed(pty, session.id);

  const nodes = (): ConformanceNode[] => {
    const p = workspace.current();
    const declared = p.declaredCapabilities ?? {};
    // The simulator's own domain → contract translation; tasks that declare capabilities.
    const tasks = projectNodes(p).filter((n) => n.kind === 'task' && declared[n.id]);
    const sessionNode: ConformanceNode = {
      id: session.id,
      kind: 'session',
      state: { value: pty.snapshot().session?.state ?? session.state },
      relations: [],
      capabilities: [],
      attention: [],
      artifacts: [],
      streams: [feed.ref],
    };
    return [...tasks, sessionNode];
  };

  return {
    contractVersion: CONTRACT_VERSION,
    detail: (nodeId) => detailOf(workspace.current(), nodeId),
    // The execution surface serves the contract's wire view of the fixture executions.
    execution: (taskId) => {
      const make = FAKE_EXECUTIONS[taskId];
      return make ? toExecutionSnapshot(make()) : undefined;
    },
    features: { edit: true, streams: true },
    nodes,
    async relay(intent) {
      // The contract's structure checks run before anything reaches the simulator.
      const check = validateIntent(intent, lookupCapability(nodes().find((n) => n.id === intent.nodeId), intent.action));
      if (!check.ok) return { accepted: false, reason: check.reason };
      return relay.send(intent, 'fake-actor:conformance');
    },
    streams: {
      open(_nodeId, _streamId, lastSeenSeq) {
        const events: StreamEvent[] = [];
        const close = feed.subscribe(lastSeenSeq, (e) => events.push(e));
        return { events, close };
      },
      produce(_nodeId, _streamId, count) {
        pty.appendOutput(Array.from({ length: count }, (_, i) => ({ channel: 'stdout' as const, text: `line ${i}` })));
      },
      declareLoss(_nodeId, _streamId, count) {
        feed.declareGap(count, 'simulated upstream loss');
      },
    },
  };
}

defineConformanceSuite('fake-contracts simulator', simulatorTarget);
