// PendingIntentState phases (push-stage §0.2), the relay-boundary validator
// (contract Intent on the wire), and key-based confirmation.
import { describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { gatesFixture, normalFixture } from '@gunnflow-testing/fake-contracts';
import {
  createPendingIntentState,
  type PendingIntentAdapter,
  type PostIntent,
} from '../src/state/pendingIntents.js';
import { fakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import { checkIntent, guardPost } from '../src/state/intentValidator.js';
import type { Capability, Intent, WireIntent, WorkspaceIntent, WorkspaceProjection } from '../src/model/types.js';

const PAUSE: WorkspaceIntent = { nodeId: 't-draft', action: 'task.pause' };
const keyed = (i: Intent, k = 'k-1'): WireIntent => ({ ...i, idempotencyKey: k });

function withCapabilities(caps: Record<string, Capability[]>): WorkspaceProjection {
  return { ...normalFixture(), declaredCapabilities: caps };
}

function harness(opts: {
  post?: PostIntent;
  adapter?: PendingIntentAdapter;
  projection?: WorkspaceProjection;
} = {}) {
  return createRoot((dispose) => {
    const [projection] = createSignal(opts.projection ?? normalFixture());
    const post = vi.fn(opts.post ?? (async () => ({ accepted: true })));
    const state = createPendingIntentState(post, opts.adapter ?? fakeIntentAdapter, projection);
    return { state, post, dispose };
  });
}

const paused = (keys?: string[]) => {
  const p = normalFixture();
  p.tasks = p.tasks.map((t) => (t.id === 't-draft' ? { ...t, state: 'paused' as const } : t));
  if (keys) p.appliedIntentKeys = keys;
  return p;
};

describe('phases', () => {
  it('composing never reaches the network and has no idempotency key', () => {
    const h = harness();
    const id = h.state.compose(PAUSE);
    expect(h.state.composing()).toHaveLength(1);
    expect(h.state.inFlight()).toHaveLength(0);
    expect(h.post).not.toHaveBeenCalled();
    expect('idempotencyKey' in h.state.composing()[0]!.draft).toBe(false);
    h.state.update(id, { nodeId: 't-draft', action: 'task.resume' });
    expect(h.state.composing()[0]!.draft).toEqual({ nodeId: 't-draft', action: 'task.resume' });
    expect(h.post).not.toHaveBeenCalled();
    h.dispose();
  });

  it('send: composing → in-flight; the wire intent carries the fresh key; confirmation removes it', async () => {
    const h = harness();
    const id = h.state.compose(PAUSE);
    const sent = h.state.send(id);
    const [entry] = h.state.inFlight();
    expect(entry?.localId).toBe(id);
    expect(entry?.idempotencyKey).toMatch(/[0-9a-f-]{36}/);
    expect(entry?.intent).toEqual({ ...PAUSE, idempotencyKey: entry!.idempotencyKey });
    expect(h.state.composing()).toHaveLength(0);
    await sent;
    expect(h.post).toHaveBeenCalledWith({ ...PAUSE, idempotencyKey: entry!.idempotencyKey });
    // Accepted is not authoritative: still in-flight until the projection shows it.
    expect(h.state.inFlight()).toHaveLength(1);
    h.state.reconcile(normalFixture());
    expect(h.state.inFlight()).toHaveLength(1);
    h.state.reconcile(paused());
    expect(h.state.entries()).toHaveLength(0);
    h.dispose();
  });

  it('each send gets its own idempotency key', async () => {
    const h = harness();
    await h.state.submit(PAUSE);
    await h.state.submit(PAUSE);
    const [a, b] = h.state.inFlight();
    expect(a!.idempotencyKey).not.toBe(b!.idempotencyKey);
    h.dispose();
  });

  it('in-flight → rejected keeps the reason verbatim; reopen → composing keeps the values, not the key', async () => {
    const h = harness({ post: async () => ({ accepted: false, reason: 'Upstream: task is locked.' }) });
    const draft: Intent = { nodeId: 't-draft', action: 'task.instruct', decision: { text: 'Cite sources.' } };
    const id = h.state.compose(draft);
    const result = await h.state.send(id);
    expect(result.accepted).toBe(false);
    const [rejected] = h.state.rejected();
    expect(rejected?.reason).toBe('Upstream: task is locked.');
    expect(h.state.errors()).toMatchObject([{ localId: id, kind: 'rejected', reason: 'Upstream: task is locked.' }]);

    h.state.reopen(id);
    const [back] = h.state.composing();
    expect(back?.draft).toEqual(draft);
    expect(back?.priorRejection?.reason).toBe('Upstream: task is locked.');
    expect(h.state.rejected()).toHaveLength(0);
    expect(h.state.errors()).toHaveLength(0);
    h.dispose();
  });

  it('send only moves composing entries; reopen only rejected; in-flight cannot be discarded', async () => {
    const h = harness({ post: () => new Promise(() => undefined) });
    const id = h.state.compose(PAUSE);
    void h.state.send(id);
    const again = await h.state.send(id);
    expect(again).toMatchObject({ accepted: false, invalid: true });
    h.state.reopen(id);
    h.state.discard(id);
    expect(h.state.inFlight()).toHaveLength(1);
    expect(h.post).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it('discard drops composing and rejected entries', async () => {
    const h = harness({ post: async () => ({ accepted: false, reason: 'no' }) });
    const draft = h.state.compose(PAUSE);
    const rejected = h.state.compose(PAUSE);
    await h.state.send(rejected);
    h.state.discard(draft);
    h.state.discard(rejected);
    expect(h.state.entries()).toHaveLength(0);
    h.dispose();
  });
});

describe('reconcile adapter injection', () => {
  it('the store asks the injected adapter, not its own semantics', async () => {
    const isSatisfied = vi.fn<PendingIntentAdapter['isSatisfied']>(
      (entry) => 'action' in entry.intent && entry.intent.action === 'task.pause',
    );
    const adapter: PendingIntentAdapter = { ...fakeIntentAdapter, isSatisfied };
    const h = harness({ adapter });
    await h.state.submit(PAUSE);
    await h.state.submit({ nodeId: 't-draft', action: 'task.resume' });
    h.state.compose(PAUSE);
    const projection = normalFixture();
    h.state.reconcile(projection);
    // Only in-flight entries are offered to the adapter.
    expect(isSatisfied).toHaveBeenCalledTimes(2);
    expect(isSatisfied.mock.calls[0]![1]).toBe(projection);
    expect(h.state.inFlight().map((e) => ('action' in e.intent ? e.intent.action : ''))).toEqual(['task.resume']);
    expect(h.state.composing()).toHaveLength(1);
    h.dispose();
  });
});

describe('key-based confirmation', () => {
  it('when the upstream echoes applied keys, only the entry\'s own key confirms it', async () => {
    const h = harness();
    await h.state.submit(PAUSE);
    const key = h.state.inFlight()[0]!.idempotencyKey;
    // The effect is visible, but the upstream's applied-keys log does not carry this key.
    h.state.reconcile(paused(['someone-else']));
    expect(h.state.inFlight()).toHaveLength(1);
    h.state.reconcile(paused([key]));
    expect(h.state.inFlight()).toHaveLength(0);
    h.dispose();
  });

  it('a key echo confirms even when the effect is indistinguishable from an earlier one', async () => {
    const h = harness({ projection: paused() });
    await h.state.submit(PAUSE);
    const key = h.state.inFlight()[0]!.idempotencyKey;
    h.state.reconcile(paused([]));
    expect(h.state.inFlight()).toHaveLength(1);
    h.state.reconcile(paused([key]));
    expect(h.state.inFlight()).toHaveLength(0);
    h.dispose();
  });

  it('without an echo log the effect is matched (estimate): an already-paused task clears on any projection', async () => {
    const h = harness({ projection: paused() });
    await h.state.submit(PAUSE);
    h.state.reconcile(paused());
    expect(h.state.inFlight()).toHaveLength(0);
    h.dispose();
  });
});

describe('relay-boundary validator (contract Intent)', () => {
  const p = normalFixture();

  it('refuses unknown keys, a missing key, and addressing a node that is not there', () => {
    expect(checkIntent(keyed({ ...PAUSE, draftId: 'd1' } as unknown as Intent), fakeIntentAdapter, p)).toEqual({
      ok: false,
      reason: "unknown key 'draftId'",
    });
    expect(checkIntent(PAUSE as unknown as WireIntent, fakeIntentAdapter, p)).toMatchObject({ ok: false, reason: expect.stringContaining('idempotencyKey') });
    expect(checkIntent(keyed({ nodeId: 't-ghost', action: 'task.pause' }), fakeIntentAdapter, p)).toMatchObject({
      ok: false,
      reason: 'addressed node is not in the projection',
    });
    expect(checkIntent(keyed({ intent: 'task.pause', taskId: 't-draft' } as unknown as Intent), fakeIntentAdapter, p).ok).toBe(false);
  });

  it('pairing and enabled checks come from the addressed capability', () => {
    expect(checkIntent(keyed(PAUSE), fakeIntentAdapter, p)).toEqual({ ok: true });
    expect(checkIntent(keyed({ ...PAUSE, decision: { text: 'x' } }), fakeIntentAdapter, p).ok).toBe(false);
    const withInput = withCapabilities({ 't-draft': [{ action: 'task.pause', level: 'enabled', decision: { input: { required: true } } }] });
    expect(checkIntent(keyed({ ...PAUSE, decision: { text: 'x' } }), fakeIntentAdapter, withInput)).toEqual({ ok: true });
    expect(checkIntent(keyed(PAUSE), fakeIntentAdapter, withInput).ok).toBe(false);
    const disabled = withCapabilities({ 't-draft': [{ action: 'task.pause', level: 'disabled' }] });
    expect(checkIntent(keyed(PAUSE), fakeIntentAdapter, disabled).ok).toBe(false);
  });

  it('stand-in session intents are checked against their kind keys and still need a key', () => {
    const stdin = { intent: 'session.stdin', sessionId: 's', input: 'ls', inputRef: 'in-1' } as const;
    expect(checkIntent(keyed(stdin), fakeIntentAdapter, p)).toEqual({ ok: true });
    expect(checkIntent(stdin as unknown as WireIntent, fakeIntentAdapter, p).ok).toBe(false);
    expect(checkIntent(keyed({ ...stdin, shell: 'bash' } as unknown as Intent), fakeIntentAdapter, p).ok).toBe(false);
  });

  it('capabilities resolve by nodeId and action', () => {
    const cap: Capability = { action: 'gate.approve', level: 'enabled', decision: { options: ['ship'] } };
    const g = { ...gatesFixture(), declaredCapabilities: { 'g-review': [cap] } };
    expect(fakeIntentAdapter.capabilityFor({ nodeId: 'g-review', action: 'gate.approve' }, g)).toEqual({ declared: true, capability: cap });
    expect(fakeIntentAdapter.capabilityFor({ nodeId: 'g-review', action: 'gate.reject' }, g)).toEqual({ declared: true, capability: undefined });
    // Undeclared nodes read their legacy capability map in contract terms.
    expect(fakeIntentAdapter.capabilityFor({ nodeId: 'g-deploy', action: 'gate.approve' }, g)).toMatchObject({
      declared: true,
      capability: { action: 'gate.approve', decision: { input: { required: true } } },
    });
  });
});

describe('validation at send', () => {
  it('a failed check stays composing with a local reason and is never posted', async () => {
    const h = harness();
    const id = h.state.compose({ ...PAUSE, decision: { text: 'why' } });
    const outcome = await h.state.send(id);
    expect(outcome).toMatchObject({ accepted: false, invalid: true });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.state.composing()[0]?.invalid).toContain('decision.text');
    expect(h.state.rejected()).toHaveLength(0);
    expect(h.state.errors()[0]).toMatchObject({ localId: id, kind: 'invalid' });
    h.state.update(id, PAUSE);
    expect(h.state.composing()[0]?.invalid).toBeUndefined();
    await h.state.send(id);
    expect(h.post).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});

describe('guarded post (relay boundary)', () => {
  it('refuses an invalid intent without reaching the inner post', async () => {
    const inner = vi.fn(async () => ({ accepted: true }));
    const post = guardPost(inner, fakeIntentAdapter, () => normalFixture());
    expect(await post(keyed({ ...PAUSE, decision: { option: 'x' } }))).toMatchObject({ accepted: false, invalid: true });
    expect(inner).not.toHaveBeenCalled();
    expect(await post(keyed(PAUSE))).toEqual({ accepted: true });
  });

  it('a refusal at the boundary returns the entry to composing with the reason', async () => {
    const h = harness({ post: async () => ({ accepted: false, reason: 'refused at boundary', invalid: true }) });
    const id = h.state.compose(PAUSE);
    await h.state.send(id);
    expect(h.state.composing()[0]).toMatchObject({ localId: id, invalid: 'refused at boundary' });
    expect(h.state.inFlight()).toHaveLength(0);
    h.dispose();
  });
});

describe('sent object is immutable', () => {
  it('the posted intent is a frozen copy, detached from the draft', async () => {
    const h = harness();
    const draft = { nodeId: 't-draft', action: 'task.instruct', decision: { text: 'a' } };
    const id = h.state.compose(draft);
    await h.state.send(id);
    const posted = h.post.mock.calls[0]![0] as typeof draft;
    expect(posted).not.toBe(draft);
    expect(Object.isFrozen(posted)).toBe(true);
    draft.decision.text = 'tampered';
    expect(posted.decision.text).toBe('a');
    expect(h.state.inFlight()[0]!.intent).toBe(posted);
    h.dispose();
  });
});

describe('unconfirmed sends', () => {
  it('stays in-flight; a projection showing it landed clears it', async () => {
    const h = harness({ post: () => Promise.reject(new Error('socket hang up')) });
    const outcome = await h.state.submit(PAUSE);
    expect(outcome).toMatchObject({ accepted: false, unconfirmed: true });
    expect(h.state.inFlight()[0]?.unconfirmed).toContain('socket hang up');
    expect(h.state.errors()[0]).toMatchObject({ kind: 'unconfirmed' });
    h.state.reconcile(paused([h.state.inFlight()[0]!.idempotencyKey]));
    expect(h.state.entries()).toHaveLength(0);
    h.dispose();
  });

  it('reopen → composing keeps the values and the next send gets a new key', async () => {
    let fail = true;
    const h = harness({
      post: async () => {
        if (fail) throw new Error('offline');
        return { accepted: true };
      },
    });
    const id = h.state.compose(PAUSE);
    await h.state.send(id);
    const firstKey = h.state.inFlight()[0]!.idempotencyKey;
    h.state.reopen(id);
    const [back] = h.state.composing();
    expect(back?.draft).toEqual(PAUSE);
    expect(back?.priorUnconfirmed?.reason).toContain('offline');
    fail = false;
    await h.state.send(id);
    expect(h.state.inFlight()[0]!.idempotencyKey).not.toBe(firstKey);
    h.dispose();
  });
});

describe('rejection details', () => {
  it('no upstream reason → reason stays absent, nothing is synthesized', async () => {
    const h = harness({ post: async () => ({ accepted: false }) });
    await h.state.submit(PAUSE);
    expect(h.state.rejected()[0]!.reason).toBeUndefined();
    expect(h.state.errors()[0]).toMatchObject({ kind: 'rejected', reason: undefined });
    h.dispose();
  });

  it('a rejection arriving after reconcile removed the entry is kept as its own error', async () => {
    let reconcileNow: (key: string) => void = () => undefined;
    const h = harness({
      post: async (intent) => {
        reconcileNow(intent.idempotencyKey);
        return { accepted: false, reason: 'late: superseded' };
      },
    });
    reconcileNow = (key) => h.state.reconcile(paused([key]));
    await h.state.submit(PAUSE);
    expect(h.state.inFlight()).toHaveLength(0);
    expect(h.state.errors()).toMatchObject([{ kind: 'rejected', reason: 'late: superseded', afterReconcile: true }]);
    h.dispose();
  });
});

describe('reconcile scope', () => {
  it('an unrelated projection update does not clear an in-flight entry', async () => {
    const h = harness();
    await h.state.submit(PAUSE);
    const unrelated = normalFixture();
    unrelated.revision += 1;
    unrelated.appliedIntentKeys = ['other-intent'];
    unrelated.edges = [...unrelated.edges, { id: 'e-new', from: 't-a', to: 't-b', edgeKind: 'dependency' }];
    h.state.reconcile(unrelated);
    expect(h.state.inFlight()).toHaveLength(1);
    h.dispose();
  });
});
