// Acceptance C1–C4: pending → relay → upstream projection → authoritative.
import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { FakeWorkspaceStream, NullIntentRelay, normalFixture, projectNodes } from '@gunnflow-testing/fake-contracts';
import { createProjectionStore } from '../src/state/projectionStore.js';
import { createPendingIntentState } from '../src/state/pendingIntents.js';
import { createFakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import type { Intent } from '../src/model/types.js';

function harness(options?: { reject?: string }) {
  return createRoot((dispose) => {
    const stream = new FakeWorkspaceStream(normalFixture());
    const relay = new NullIntentRelay(stream, {
      latencyMs: 5, // upstream is never synchronous; keeps the pending phase observable
      rejectWith: options?.reject ? () => options.reject : undefined,
    });
    const projectionStore = createProjectionStore();
    projectionStore.applyUpstream(stream.current());
    const pendingIntents = createPendingIntentState(
      (intent) => relay.send(intent as never, 'fake-actor:test'),
      createFakeIntentAdapter(() => projectNodes(stream.current())),
      projectionStore.projection,
    );
    // Wire like App does: authoritative projections reconcile pendings.
    stream.subscribe((p) => {
      projectionStore.applyUpstream(p);
      pendingIntents.reconcile(p);
    });
    return { stream, relay, projectionStore, pendingIntents, dispose };
  });
}

const REWIRE: Intent = { nodeId: 't-draft', action: 'edge.rewire', decision: { option: 't-test' } };

describe('write path', () => {
  it('C1+C2: submitting shows pending, does NOT mutate the authoritative graph', async () => {
    const h = harness();
    const edgesBefore = h.projectionStore.projection().edges;
    const submitted = h.pendingIntents.submit(REWIRE);
    // Synchronously after submit: pending exists, authoritative graph untouched.
    expect(h.pendingIntents.inFlight()).toHaveLength(1);
    expect(h.projectionStore.projection().edges).toBe(edgesBefore);
    await submitted;
    h.dispose();
  });

  it('C3: the edge becomes authoritative only via the upstream projection, clearing pending', async () => {
    const h = harness();
    await h.pendingIntents.submit(REWIRE);
    expect(
      h.projectionStore.projection().edges.some((e) => e.from === 't-draft' && e.to === 't-test'),
    ).toBe(true);
    expect(h.pendingIntents.inFlight()).toHaveLength(0);
    // And it arrived as an audited append, not a local write.
    expect(h.stream.auditChain().some((e) => e.type === 'edge.rewire')).toBe(true);
    h.dispose();
  });

  it('C4: rejection leaves in-flight and surfaces the upstream reason', async () => {
    const h = harness({ reject: 'upstream rejected: cross-mission wiring is gated' });
    const before = h.projectionStore.projection();
    const result = await h.pendingIntents.submit(REWIRE);
    expect(result.accepted).toBe(false);
    expect(h.pendingIntents.inFlight()).toHaveLength(0);
    expect(h.pendingIntents.errors()[0]?.reason).toContain('upstream rejected');
    expect(h.pendingIntents.errors()[0]?.kind).toBe('rejected');
    expect(h.projectionStore.projection()).toBe(before);
    h.dispose();
  });

  it('relay transport failure is unconfirmed, not a rejection: stays in-flight with the diagnostic', async () => {
    const h = createRoot((dispose) => {
      const pendingIntents = createPendingIntentState(
        () => Promise.reject(new Error('down')),
        createFakeIntentAdapter(() => projectNodes(normalFixture())),
        normalFixture,
      );
      return { pendingIntents, dispose };
    });
    const result = await h.pendingIntents.submit(REWIRE);
    expect(result).toMatchObject({ accepted: false, unconfirmed: true });
    // It may have landed upstream, so it keeps its pending mark.
    expect(h.pendingIntents.inFlight()).toHaveLength(1);
    expect(h.pendingIntents.rejected()).toHaveLength(0);
    expect(h.pendingIntents.errors()[0]).toMatchObject({ kind: 'unconfirmed' });
    expect(h.pendingIntents.errors()[0]?.reason).toContain('relay unreachable');
    h.dispose();
  });
});

describe('wire shape', () => {
  it('the relay receives a contract Intent with its idempotency key; confirmation is by that key', async () => {
    const h = harness();
    await h.pendingIntents.submit(REWIRE);
    const sent = h.relay.sent[0]!.intent;
    expect(sent).toEqual({ ...REWIRE, idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(h.stream.current().appliedIntentKeys).toContain(sent.idempotencyKey);
    expect(h.pendingIntents.inFlight()).toHaveLength(0);
    h.dispose();
  });
});
