import { describe, expect, it } from 'vitest';
import {
  FIXTURES,
  FakeWorkspaceStream,
  NullIntentRelay,
  attentionFixture,
  blockedFixture,
  largeFixture,
  normalFixture,
} from '../src/index.js';

describe('fixtures (charter §19 screen states)', () => {
  it('normal has active, completed, deliverable, and a branch', () => {
    const p = normalFixture();
    expect(p.tasks.some((t) => t.state === 'running')).toBe(true);
    expect(p.tasks.some((t) => t.state === 'completed')).toBe(true);
    expect(p.deliverables.length).toBeGreaterThan(0);
    const outdegree = new Map<string, number>();
    for (const e of p.edges) outdegree.set(e.from, (outdegree.get(e.from) ?? 0) + 1);
    expect(Math.max(...outdegree.values())).toBeGreaterThan(1); // branch exists
  });

  it('attention has a waiting human gate', () => {
    const p = attentionFixture();
    expect(p.gates.some((g) => g.state === 'waiting')).toBe(true);
    expect(p.counts.needsYou).toBeGreaterThan(0);
  });

  it('blocked carries an upstream-provided reason', () => {
    const p = blockedFixture();
    const blocked = p.tasks.find((t) => t.state === 'blocked');
    expect(blocked?.blockedReason).toBeTruthy();
  });

  it('large fixture is actually large', () => {
    const p = largeFixture();
    expect(p.tasks.length).toBeGreaterThanOrEqual(400);
    expect(p.edges.length).toBeGreaterThanOrEqual(400);
  });

  it('every fixture is internally consistent (edges reference known nodes)', () => {
    for (const make of Object.values(FIXTURES)) {
      const p = make();
      // Missions are edge endpoints too: projectNodes carries a mission's edges as its relations.
      const ids = new Set([
        ...p.missions.map((m) => m.id),
        ...p.tasks.map((t) => t.id),
        ...p.gates.map((g) => g.id),
        ...p.deliverables.map((d) => d.id),
      ]);
      for (const e of p.edges) {
        expect(ids.has(e.from), `edge ${e.id} from`).toBe(true);
        expect(ids.has(e.to), `edge ${e.id} to`).toBe(true);
      }
    }
  });
});

describe('FakeWorkspaceStream append-only audit chain', () => {
  it('records who/when/what for every intent', async () => {
    const stream = new FakeWorkspaceStream(normalFixture());
    const relay = new NullIntentRelay(stream);
    await relay.send({ nodeId: 'workspace', action: 'mission.create', decision: { text: 'New Mission' }, idempotencyKey: 'k1' }, 'fake-actor:test-user');
    const chain = stream.auditChain();
    expect(chain).toHaveLength(1);
    expect(chain[0]!.actor).toBe('fake-actor:test-user');
    expect(chain[0]!.type).toBe('mission.create');
    expect(chain[0]!.at).toBeGreaterThan(0);
  });

  it('past events cannot be updated (frozen)', async () => {
    const stream = new FakeWorkspaceStream(normalFixture());
    const relay = new NullIntentRelay(stream);
    await relay.send({ nodeId: 'workspace', action: 'mission.create', decision: { text: 'X' }, idempotencyKey: 'k2' }, 'a');
    const event = stream.auditChain()[0]!;
    expect(() => {
      (event as { type: string }).type = 'tampered';
    }).toThrow();
    expect(() => {
      (event.payload as { intentKey: string }).intentKey = 'tampered';
    }).toThrow();
  });

  it('accepted intent produces a new projection revision via subscription', async () => {
    const stream = new FakeWorkspaceStream(normalFixture());
    const relay = new NullIntentRelay(stream);
    const seen: number[] = [];
    stream.subscribe((p) => seen.push(p.revision));
    await relay.send({ nodeId: 't-draft', action: 'edge.rewire', decision: { option: 't-test' }, idempotencyKey: 'k3' }, 'a');
    expect(seen).toHaveLength(1);
    // The upstream echoes the intent's key in its applied-intents log.
    expect(stream.current().appliedIntentKeys).toEqual(['k3']);
    expect(stream.current().edges.some((e) => e.from === 't-draft' && e.to === 't-test')).toBe(true);
  });

  it('a contract Intent is translated by nodeId + action; an unknown action is refused', async () => {
    const stream = new FakeWorkspaceStream(normalFixture());
    const relay = new NullIntentRelay(stream);
    await relay.send({ nodeId: 't-build', action: 'task.instruct', decision: { text: 'Go' }, idempotencyKey: 'k5' }, 'a');
    expect(stream.current().activities.at(-1)).toMatchObject({ taskId: 't-build', label: 'Go', intentKey: 'k5' });
    expect(await relay.send({ nodeId: 't-build', action: 'gate.approve', idempotencyKey: 'k6' }, 'a')).toMatchObject({
      accepted: false,
    });
    expect(await relay.send({ nodeId: 'nope', action: 'task.pause', idempotencyKey: 'k7' }, 'a')).toMatchObject({ accepted: false });
  });

  it('rejected intent appends nothing to derived state', async () => {
    const stream = new FakeWorkspaceStream(normalFixture());
    const before = stream.current();
    const relay = new NullIntentRelay(stream, {
      rejectWith: () => 'policy: rewiring across missions is not allowed',
    });
    const result = await relay.send(
      { nodeId: 't-draft', action: 'edge.rewire', decision: { option: 't-test' }, idempotencyKey: 'k4' },
      'a',
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('policy');
    expect(stream.current()).toBe(before);
    expect(relay.sent).toHaveLength(1); // the attempt itself is still recorded
  });
});
