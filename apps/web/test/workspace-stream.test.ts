// Transport intake: a snapshot envelope dispatched through the browser stream's
// apply path answers to the snapshot rule with the envelope's revision — only
// the node changed after it is dropped, with its reason.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { createFakeUpstream } from '@gunnflow-testing/fake-contracts';
import type { NodeProjection } from '@gunnflow/contract';
import { createProjectionStore } from '../src/state/projectionStore.js';
import { openWorkspaceStream } from '../src/transport/stream.js';

/** The smallest EventSource stand-in: records listeners so the test can dispatch frames. */
class StubEventSource {
  static last: StubEventSource | null = null;
  readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    StubEventSource.last = this;
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  close() {}
  dispatch(name: string, data: unknown) {
    for (const fn of this.listeners.get(name) ?? []) fn(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('workspace stream intake', () => {
  it('drops only the node whose changedAtRevision is after the envelope revision', () => {
    vi.stubGlobal('EventSource', StubEventSource);
    const h = createRoot((dispose) => ({ store: createProjectionStore(), dispose }));
    const stream = openWorkspaceStream(h.store);
    const envelope = createFakeUpstream('views').snapshot();
    const body = envelope.body as { nodes: NodeProjection[] };
    const ahead = body.nodes.map((n) => (n.id === 't-build' ? { ...n, changedAtRevision: envelope.revision + 1 } : n));

    StubEventSource.last!.dispatch('snapshot', { revision: envelope.revision, body: { ...body, nodes: ahead } });

    const generic = h.store.genericNodes()!;
    expect(generic.nodes.map((n) => n.id)).toEqual(body.nodes.map((n) => n.id).filter((id) => id !== 't-build'));
    expect(generic.invalid).toEqual([
      { index: body.nodes.findIndex((n) => n.id === 't-build'), problem: expect.stringContaining('after the snapshot revision') },
    ]);
    expect(h.store.projection().revision).toBe(envelope.revision);
    stream.close();
    h.dispose();
  });
});
