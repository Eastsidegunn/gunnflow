// G3: workspace root creation, evidence viewing condition, decision.text for
// human text, and generic parts that depend on capabilities (default wiring
// over the simulator's generic nodes).
import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import {
  FakeWorkspaceStream,
  NullIntentRelay,
  attentionFixture,
  normalFixture,
  projectNodes,
  type FakeWorkspaceProjection,
} from '@gunnflow-testing/fake-contracts';
import { WORKSPACE_ROOT_KIND } from '@gunnflow/contract';
import { createPendingIntentState } from '../src/state/pendingIntents.js';
import { createFakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import { guardPost } from '../src/state/intentValidator.js';
import { fixBase, markRendered } from '../src/state/editorLogic.js';
import { resolveParts } from '../src/canvas/parts.js';
import { actionGate, opensPanel } from '../src/state/genericActions.js';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';

function harness(initial: FakeWorkspaceProjection = normalFixture()) {
  return createRoot((dispose) => {
    const stream = new FakeWorkspaceStream(initial);
    const relay = new NullIntentRelay(stream);
    const adapter = createFakeIntentAdapter(() => projectNodes(stream.current()));
    const post = guardPost((i) => relay.send(i as never, 'fake-actor:test'), adapter, () => stream.current());
    const state = createPendingIntentState(post, adapter, () => stream.current());
    stream.subscribe((p) => state.reconcile(p));
    const nodes = () => new Map(projectNodes(stream.current()).map((n) => [n.id, n]));
    return { stream, relay, state, nodes, dispose };
  });
}

describe('workspace root node: creation is its capability', () => {
  it('the toolbar reads mission.create from the root; it needs text, so it opens a panel', () => {
    const root = projectNodes(normalFixture()).find((n) => n.kind === WORKSPACE_ROOT_KIND)!;
    const [create] = resolveParts(root, DEFAULT_WIRING).actions;
    expect(create).toMatchObject({ kind: 'assembled', action: 'mission.create', inputs: [{ part: 'text' }] });
    expect(opensPanel(create!)).toBe(true);
  });

  it('creating through the root relays decision.text; without text it is refused before sending', async () => {
    const h = harness();
    const root = h.nodes().get('workspace')!;
    expect(await h.state.submit({ nodeId: root.id, action: 'mission.create' })).toMatchObject({
      invalid: true,
      reason: expect.stringContaining('decision.text required'),
    });
    await h.state.submit({ nodeId: root.id, action: 'mission.create', decision: { text: 'Launch site' } });
    expect(h.relay.sent.at(-1)!.intent).toEqual({ nodeId: 'workspace', action: 'mission.create', decision: { text: 'Launch site' }, idempotencyKey: expect.any(String) });
    expect(h.stream.current().missions.some((m) => m.name === 'Launch site')).toBe(true);
    h.dispose();
  });
});

describe('evidence viewing condition (bound by artifact id)', () => {
  const evidenceToken = async (p: FakeWorkspaceProjection, id: string) => {
    const ref = p.deliverables.flatMap((d) => d.artifacts ?? []).find((a) => a.id === id)!;
    const fixed = await fixBase(ref, p.artifactSnapshots![id], [ref.mediaType]);
    if (!fixed.ok) throw new Error(fixed.reason);
    return markRendered(fixed.pinned, { isConnected: true, textContent: fixed.text })!;
  };

  it('approval of g-publish is refused until its evidence is viewed, then attests exactly that view', async () => {
    const h = harness(attentionFixture());
    const gate = h.nodes().get('g-publish')!;
    const approve = resolveParts(gate, DEFAULT_WIRING).actions.find((a) => a.action === 'gate.approve')!;
    expect(approve.evidence).toEqual(['art-research-report']);

    const blind = h.state.compose({ nodeId: gate.id, action: 'gate.approve' }, undefined, { displays: [] });
    expect(await h.state.send(blind)).toMatchObject({ invalid: true, reason: "evidence 'art-research-report' has not been viewed" });
    expect(h.relay.sent).toHaveLength(0);

    const token = await evidenceToken(h.stream.current(), 'art-research-report');
    h.state.setEvidence(blind, { displays: [token] });
    expect(await h.state.send(blind)).toEqual({ accepted: true });
    const sent = h.relay.sent.at(-1)!.intent;
    expect(sent.attestation?.displayed).toEqual([
      { artifactId: 'art-research-report', digest: expect.stringMatching(/^[0-9a-f]{64}$/), at: expect.any(String) },
    ]);
    expect(h.stream.current().gates.find((g) => g.id === 'g-publish')!.state).toBe('approved');
    h.dispose();
  });

  it('a view of an older version of the evidence does not count', async () => {
    const h = harness(attentionFixture());
    const gate = h.nodes().get('g-publish')!;
    const token = await evidenceToken(h.stream.current(), 'art-research-report');
    h.stream.replaceProjection(
      {
        ...h.stream.current(),
        deliverables: h.stream.current().deliverables.map((d) =>
          d.id === 'd-report' ? { ...d, artifacts: d.artifacts!.map((a) => ({ ...a, digest: 'f'.repeat(64) })) } : d,
        ),
      },
      { actor: 'system', type: 'test.change' },
    );
    const id = h.state.compose({ nodeId: gate.id, action: 'gate.approve' }, undefined, { displays: [token] });
    expect(await h.state.send(id)).toMatchObject({ invalid: true, reason: expect.stringContaining('changed since it was viewed') });
    h.dispose();
  });
});

describe('human text travels in decision.text', () => {
  it('instructions and change requests carry decision.text; the legacy field is refused at the boundary', async () => {
    const h = harness(attentionFixture());
    await h.state.submit({ nodeId: 't-build', action: 'task.instruct', decision: { text: 'Prefer the fix over the test.' } });
    expect(h.stream.current().activities.at(-1)).toMatchObject({ taskId: 't-build', label: 'Prefer the fix over the test.', actor: 'human' });
    await h.state.submit({ nodeId: 'g-publish', action: 'gate.requestChanges', decision: { text: 'Shorter intro.' } });
    expect(h.stream.current().activities.at(-1)).toMatchObject({ label: 'Shorter intro.' });
    const legacy = await h.state.submit({ nodeId: 't-build', action: 'task.instruct', instruction: 'old way' } as never);
    expect(legacy).toMatchObject({ invalid: true, reason: "unknown key 'instruction'" });
    // The old domain addressing is not an intent any more.
    const domain = await h.state.submit({ intent: 'task.instruct', taskId: 't-build', decision: { text: 'x' } } as never);
    expect(domain).toMatchObject({ invalid: true });
    h.dispose();
  });
});

describe('generic parts depend on capabilities', () => {
  it('the default assembly shows only what each node declares; privileged actions cannot run from a click', () => {
    const nodes = new Map(projectNodes(normalFixture()).map((n) => [n.id, n]));
    const actionsOf = (id: string) => resolveParts(nodes.get(id)!, DEFAULT_WIRING).actions;
    // t-research: instruct/pause/cancel are hidden upstream → absent, even though the task assembly declares them.
    // Declared delete and rewiring remain; rewiring needs a target choice, so it cannot run from a click.
    expect(actionsOf('t-research')).toEqual([
      expect.objectContaining({ kind: 'fallback', action: 'task.delete', level: 'enabled', usable: true }),
      expect.objectContaining({ kind: 'fallback', action: 'edge.rewire', usable: false, reason: 'needs a choice among options' }),
    ]);
    // t-test: pause is disabled upstream → shown disabled, not runnable.
    const pause = actionsOf('t-test').find((a) => a.action === 'task.pause')!;
    expect(pause).toMatchObject({ kind: 'assembled', level: 'disabled' });
    expect(actionGate(pause).runnable).toBe(false);
    // t-build: instruct declares required text → the assembled text part binds; cancel falls back, unusable.
    const build = actionsOf('t-build');
    expect(build.find((a) => a.action === 'task.instruct')).toMatchObject({ inputs: [{ part: 'text' }] });
    expect(build.find((a) => a.action === 'task.cancel')).toMatchObject({ kind: 'fallback', usable: false, reason: 'needs text input' });
  });
});
