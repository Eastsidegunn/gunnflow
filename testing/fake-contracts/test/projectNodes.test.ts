// The simulator's domain → NodeProjection translation passes the contract's
// node checks and carries domain vocabulary through as opaque strings.
import { describe, expect, it } from 'vitest';
import { nodeProblem } from '@gunnflow/contract';
import { CHORE_KIND, FAKE_CHORE_COMMAND, FLAGGED, MEMBER_OF, NEEDS_HANDS, UNSTATED, WAITING_FOR_HUMAN, WORKSPACE_NODE_ID, detailOf, emptyFixture, inboxFixture, blockedFixture, gatesFixture, largeFixture, normalFixture, projectNodes } from '../src/index.js';

describe('projectNodes', () => {
  it('every fixture translates into well-formed contract nodes: one per domain node plus the root', () => {
    for (const p of [normalFixture(), blockedFixture(), gatesFixture(), largeFixture(2, 5)]) {
      const nodes = projectNodes(p);
      expect(nodes).toHaveLength(1 + p.missions.length + p.tasks.length + p.gates.length + p.deliverables.length);
      for (const n of nodes) expect(nodeProblem(n), n.id).toBeNull();
    }
  });

  it('maps kinds, states, relations, capabilities, attention and artifacts', () => {
    const p = blockedFixture();
    const nodes = new Map(projectNodes(p).map((n) => [n.id, n]));
    const draft = nodes.get('t-draft')!;
    expect(draft.kind).toBe('task');
    expect(draft.state.value).toBe(p.tasks.find((t) => t.id === 't-draft')!.state);
    expect(draft.relations).toContainEqual({ type: MEMBER_OF, target: 'm1' });
    expect(draft.capabilities.map((c) => c.action)).toContain('artifact.edit');
    expect(draft.artifacts[0]?.id).toBe('art-landing-copy');
    // Legacy capability maps translate to namespaced actions.
    // Privileged actions carry a stated reason, so no label-only control can run them.
    expect(nodes.get('t-build')!.capabilities).toContainEqual({
      action: 'task.forceReplan',
      level: 'disabled',
      decision: { input: { required: true } },
    });
    expect(nodes.get('t-build')!.capabilities).toContainEqual({ action: 'task.pause', level: 'enabled' });
    expect(draft.label).toBe('Draft');
    // since only when the domain knows it (t-test carries no timestamps).
    expect(nodes.get('t-test')!.attention).toEqual([{ cause: FLAGGED }]);
    expect(nodes.get('m1')!.state.value).toBe(UNSTATED);
    const edge = p.edges[0]!;
    expect(nodes.get(edge.from)!.relations).toContainEqual({ type: edge.edgeKind, target: edge.to });
  });

  it('gates: optional reason on decisions, required where the domain says so; evidence on approval', () => {
    const nodes = new Map(projectNodes(gatesFixture()).map((n) => [n.id, n]));
    const deploy = nodes.get('g-deploy')!;
    const publish = nodes.get('g-publish')!;
    // Approval of g-publish is conditioned on viewing its evidence artifact.
    expect(publish.capabilities.find((c) => c.action === 'gate.approve')?.decision).toEqual({
      input: { required: false },
      evidence: ['art-research-report'],
    });
    expect(deploy.capabilities.find((c) => c.action === 'gate.approve')?.decision).toEqual({ input: { required: true } });
    expect(publish.artifacts.map((a) => a.id)).toEqual(['art-research-report']);
    expect(publish.capabilities.find((c) => c.action === 'gate.reject')?.decision).toEqual({ input: { required: false } });
    expect(publish.capabilities.find((c) => c.action === 'gate.requestChanges')?.decision).toEqual({ input: { required: true } });
    expect(publish.relations).toContainEqual({ type: 'evidence', target: 'd-report' });
    expect(nodes.get('g-old-publish')!.relations).toContainEqual({ type: 'superseded-by', target: 'g-publish' });
    expect(deploy.attention).toEqual([{ cause: WAITING_FOR_HUMAN, since: expect.any(String) }]);
    expect(nodes.get('g-upload')!.attention).toEqual([]);
  });

  it('the workspace root carries workspace-level creation, even on an empty workspace', () => {
    const [root] = projectNodes(emptyFixture());
    expect(root).toMatchObject({ id: WORKSPACE_NODE_ID, kind: 'workspace', label: 'Workspace' });
    expect(root!.capabilities).toEqual([{ action: 'mission.create', level: 'enabled', decision: { input: { required: true } } }]);
  });

  it('hands-on requests: own kind and cause, report actions only when declared, detail texts verbatim', () => {
    const p = inboxFixture();
    const nodes = new Map(projectNodes(p).map((n) => [n.id, n]));
    for (const n of nodes.values()) expect(nodeProblem(n), n.id).toBeNull();
    const chore = nodes.get('c-publish')!;
    expect(chore).toMatchObject({ kind: CHORE_KIND, state: { value: 'waiting' }, relations: [{ type: MEMBER_OF, target: 'm1' }] });
    expect(chore.attention).toEqual([{ cause: NEEDS_HANDS, since: expect.any(String) }]);
    expect(chore.capabilities.map((c) => [c.action, c.decision?.input?.required])).toEqual([
      ['chore.done', false],
      ['chore.cannot', true],
    ]);
    expect(nodes.get('c-silent')!.capabilities).toEqual([]);
    expect(nodes.get('c-silent')!.attention.map((a) => a.cause)).toEqual([NEEDS_HANDS]);
    const detail = detailOf(p, 'c-publish')!;
    expect(detail.items.map((i) => i.label)).toEqual(['why', 'where', 'command', 'afterwards']);
    expect(detail.items[2]!.text).toBe(FAKE_CHORE_COMMAND);
  });
});
