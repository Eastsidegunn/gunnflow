// G3-F: the store refuses sends outside intervene; evidence requirements are
// re-read from the current capability; unconfirmable digests are refused;
// the workspace root must be unique; only decision.text carries human text.
import { describe, expect, it } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import {
  FakeWorkspaceStream,
  NullIntentRelay,
  attentionFixture,
  gatesFixture,
  normalFixture,
  projectNodes,
  type FakeWorkspaceProjection,
} from '@gunnflow-testing/fake-contracts';
import type { NodeProjection } from '@gunnflow/contract';
import { createPendingIntentState } from '../src/state/pendingIntents.js';
import { createFakeIntentAdapter, fakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import { guardPost } from '../src/state/intentValidator.js';
import { fixBase, markRendered } from '../src/state/editorLogic.js';
import { workspaceRoot } from '../src/state/workspaceRoot.js';
import type { Intent } from '../src/model/types.js';

function harness(initial: FakeWorkspaceProjection = normalFixture(), nodesOf = projectNodes) {
  return createRoot((dispose) => {
    const stream = new FakeWorkspaceStream(initial);
    const relay = new NullIntentRelay(stream);
    const adapter = createFakeIntentAdapter(() => nodesOf(stream.current()));
    const post = guardPost((i) => relay.send(i as never, 'fake-actor:test'), adapter, () => stream.current());
    const state = createPendingIntentState(post, adapter, () => stream.current());
    stream.subscribe((p) => state.reconcile(p));
    const node = (id: string) => nodesOf(stream.current()).find((n) => n.id === id)!;
    const change = (edit: (p: FakeWorkspaceProjection) => FakeWorkspaceProjection) =>
      stream.replaceProjection(edit(stream.current()), { actor: 'system', type: 'test.change' });
    return { stream, relay, state, node, change, dispose };
  });
}

async function evidenceToken(p: FakeWorkspaceProjection, id: string) {
  const ref = p.deliverables.flatMap((d) => d.artifacts ?? []).find((a) => a.id === id)!;
  const fixed = await fixBase(ref, p.artifactSnapshots![id], [ref.mediaType]);
  if (!fixed.ok) throw new Error(fixed.reason);
  return markRendered(fixed.pinned, { isConnected: true, textContent: fixed.text })!;
}

describe('F2/F3: evidence is re-read from the current capability at send', () => {
  it('a decision that requires evidence is refused when the entry carries no views at all', async () => {
    const h = harness(attentionFixture());
    const outcome = await h.state.submit({ nodeId: h.node('g-publish').id, action: 'gate.approve' });
    expect(outcome).toMatchObject({ invalid: true, reason: "evidence 'art-research-report' has not been viewed" });
    h.dispose();
  });

  it('evidence added to the requirement after viewing is refused until it too is viewed', async () => {
    const extra = { id: 'art-extra', mediaType: 'text/plain', digest: 'e'.repeat(64), access: { kind: 'snapshot' as const } };
    const nodesOf = (p: FakeWorkspaceProjection): NodeProjection[] =>
      projectNodes(p).map((n) =>
        n.id === 'g-publish' && (p as { extraEvidence?: boolean }).extraEvidence
          ? {
              ...n,
              artifacts: [...n.artifacts, extra],
              capabilities: n.capabilities.map((c) =>
                c.action === 'gate.approve' ? { ...c, decision: { ...c.decision, evidence: ['art-research-report', 'art-extra'] } } : c,
              ),
            }
          : n,
      );
    const h = harness(attentionFixture(), nodesOf);
    const token = await evidenceToken(h.stream.current(), 'art-research-report');
    const id = h.state.compose({ nodeId: h.node('g-publish').id, action: 'gate.approve' }, undefined, { displays: [token] });
    h.change((p) => ({ ...p, extraEvidence: true }) as FakeWorkspaceProjection);
    expect(await h.state.send(id)).toMatchObject({ invalid: true, reason: "evidence 'art-extra' has not been viewed" });
    expect(h.relay.sent).toHaveLength(0);
    h.dispose();
  });

  it('a view of a different artifact never satisfies the requirement', async () => {
    const h = harness(attentionFixture());
    const unrelated = await (async () => {
      const p = normalFixture();
      const ref = p.tasks.find((t) => t.id === 't-draft')!.artifacts![0]!;
      const fixed = await fixBase(ref, p.artifactSnapshots![ref.id], [ref.mediaType]);
      if (!fixed.ok) throw new Error(fixed.reason);
      return markRendered(fixed.pinned, { isConnected: true, textContent: fixed.text })!;
    })();
    const id = h.state.compose({ nodeId: h.node('g-publish').id, action: 'gate.approve' }, undefined, { displays: [unrelated] });
    expect(await h.state.send(id)).toMatchObject({ invalid: true, reason: "evidence 'art-research-report' has not been viewed" });
    h.dispose();
  });

  it('when the current digest cannot be read, a past view does not pass', async () => {
    const withoutDigest = (p: FakeWorkspaceProjection): NodeProjection[] =>
      projectNodes(p).map((n) => ({ ...n, artifacts: n.artifacts.map((a) => ({ ...a, digest: undefined })) }));
    const h = harness(attentionFixture(), withoutDigest);
    const token = await evidenceToken(h.stream.current(), 'art-research-report');
    const id = h.state.compose({ nodeId: h.node('g-publish').id, action: 'gate.approve' }, undefined, { displays: [token] });
    expect(await h.state.send(id)).toMatchObject({ invalid: true, reason: expect.stringContaining('cannot be confirmed') });
    h.dispose();
  });

  it('the digest lookup reads generic node artifacts, not only the stand-in projection', () => {
    const artifact = { id: 'only-generic', mediaType: 'text/plain', digest: 'a'.repeat(64), access: { kind: 'snapshot' as const } };
    const node: NodeProjection = { id: 'n', kind: 'doc', state: { value: 'x' }, relations: [], capabilities: [], attention: [], artifacts: [artifact] };
    const adapter = createFakeIntentAdapter(() => [node]);
    expect(adapter.artifactDigest?.('only-generic', normalFixture())).toBe('a'.repeat(64));
    expect(fakeIntentAdapter.artifactDigest?.('only-generic', normalFixture())).toBeUndefined();
  });
});

describe('F5: the workspace root must be unique, and its actions pass the capability check', () => {
  it('zero or several root nodes adopt no root', () => {
    const nodes = projectNodes(normalFixture());
    const root = nodes.find((n) => n.kind === 'workspace')!;
    expect(workspaceRoot(nodes).root?.id).toBe('workspace');
    expect(workspaceRoot(nodes.filter((n) => n !== root))).toEqual({ root: undefined, problem: null });
    expect(workspaceRoot([...nodes, { ...root, id: 'workspace-2' }])).toMatchObject({ root: undefined, problem: expect.stringContaining('2 nodes') });
  });

  it('with two roots, creation is refused as addressing no node', async () => {
    const twoRoots = (p: FakeWorkspaceProjection) => {
      const nodes = projectNodes(p);
      return [...nodes, { ...nodes.find((n) => n.kind === 'workspace')!, id: 'workspace-2' }];
    };
    const h = harness(normalFixture(), twoRoots);
    expect(await h.state.submit({ nodeId: 'workspace', action: 'mission.create', decision: { text: 'x' } })).toMatchObject({
      invalid: true,
      reason: 'addressed node is not in the projection',
    });
    h.dispose();
  });

  it('a disabled root action is refused by the ordinary capability check', async () => {
    const disabled = { ...normalFixture(), workspaceCapabilities: [{ action: 'mission.create', level: 'disabled' as const, decision: { input: { required: true } } }] };
    const h = harness(disabled);
    expect(await h.state.submit({ nodeId: 'workspace', action: 'mission.create', decision: { text: 'x' } })).toMatchObject({
      invalid: true,
      reason: expect.stringContaining('disabled'),
    });
    h.dispose();
  });
});

describe('F6: old keys are refused, alone or mixed with the new slot', () => {
  it('prompt, reason and instruction are unknown keys at the boundary', async () => {
    const h = harness(gatesFixture());
    const cases = [
      { nodeId: 't-draft', action: 'task.instruct', decision: { text: 'a' }, instruction: 'a' },
      { nodeId: 't-draft', action: 'task.instruct', decision: { text: 'a' }, reason: 'b' },
      { nodeId: 'workspace', action: 'mission.create', decision: { text: 'm' }, prompt: 'p' },
      { nodeId: 'g-review', action: 'gate.approve', reason: 'ok' },
      { nodeId: 'g-review', action: 'gate.approve', decision: { text: 'ok' }, reason: 'ok' },
    ];
    for (const c of cases) {
      expect(await h.state.submit(c as unknown as Intent), JSON.stringify(c)).toMatchObject({
        invalid: true,
        reason: expect.stringMatching(/^unknown key '(instruction|reason|prompt)'$/),
      });
    }
    expect(h.relay.sent).toHaveLength(0);
    h.dispose();
  });

  it('Restore of a refused gate decision brings back only decision.text', () => {
    expect(fakeIntentAdapter.reopenDraft?.({ nodeId: 'g', action: 'gate.approve', decision: { text: 'why' } })).toEqual({
      action: null,
      nodeId: 'g',
      text: 'why',
    });
  });
});

describe('F7: requestChanges confirmation matches the gate-linked task and event', () => {
  const entry = (text: string) =>
    ({ phase: 'in-flight', localId: 'l', idempotencyKey: 'k', sentAt: 0, intent: { nodeId: 'g-review', action: 'gate.requestChanges', decision: { text }, idempotencyKey: 'k' } }) as const;
  const withActivity = (taskId: string, label: string, eventType = 'human.changes-requested'): FakeWorkspaceProjection => {
    const p = gatesFixture();
    return { ...p, edges: [...p.edges, { id: 'e-review', from: 't-draft', to: 'g-review', edgeKind: 'gate' }], activities: [...p.activities, { id: 'x', taskId, at: 0, label, eventType, actor: 'human' }] };
  };

  it('an activity on an unlinked task or of another event type does not confirm', () => {
    expect(fakeIntentAdapter.isSatisfied(entry('Shorter.') as never, withActivity('t-build', 'Shorter.'))).toBe(false);
    expect(fakeIntentAdapter.isSatisfied(entry('Shorter.') as never, withActivity('t-draft', 'Shorter.', 'human.instruction'))).toBe(false);
    expect(fakeIntentAdapter.isSatisfied(entry('Shorter.') as never, withActivity('t-draft', 'Shorter.'))).toBe(true);
  });

  it('limit: an earlier identical request on the same linked task already reads as confirmation', () => {
    expect(fakeIntentAdapter.isSatisfied(entry('Shorter.') as never, withActivity('t-draft', 'Shorter.'))).toBe(true);
  });
});
