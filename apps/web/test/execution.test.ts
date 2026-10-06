// Execution Surface acceptance: projection integrity, live tail window,
// filters, virtualization, control write path, capability gating.
import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import {
  FakeExecutionEventStream,
  buildExecutionFixture,
  draftExecutionFixture,
  largeExecutionFixture,
} from '@gunnflow-testing/fake-contracts';
import {
  eventRow,
  fileChanges,
  filterEvents,
  visibleRange,
  NO_FILTERS,
} from '../src/state/executionLogic.js';
import { createExecutionStore, EVENT_WINDOW } from '../src/state/executionStore.js';
import { writeAffordance } from '../src/state/capabilities.js';
import type { SessionIntent } from '../src/model/executionTypes.js';

describe('projection integrity', () => {
  it('rows carry upstream label/status verbatim — no re-summarization', () => {
    const failed = buildExecutionFixture().events.find((e) => e.status === 'failed')!;
    const row = eventRow(failed);
    expect(row.label).toBe('12 passed, 1 failed');
    expect(row.status).toBe('failed');
    // No message content is ever reinterpreted into reasoning.
    expect(Object.keys(row).sort()).toEqual(['duration', 'kind', 'label', 'status', 'time']);
  });

  it('tool failure and session state are separate facts (§24)', () => {
    const p = buildExecutionFixture();
    expect(p.events.some((e) => e.status === 'failed')).toBe(true);
    expect(p.sessions.find((s) => s.id === 's-184')!.state).toBe('running');
  });

  it('fork lineage comes from upstream parentSessionId only', () => {
    const p = draftExecutionFixture();
    expect(p.sessions.find((s) => s.id === 's-201a')!.parentSessionId).toBe('s-201');
  });

  it('masked env arrives masked — no raw secret exists in the fixture', () => {
    const runtime = buildExecutionFixture().sessions[0]!.runtime!;
    expect(runtime.maskedEnv!.API_KEY).toBe('••••••');
  });
});

describe('view-only filters (§26)', () => {
  const events = buildExecutionFixture().events;
  it('failed-only and kind filters never mutate the source', () => {
    const frozen = JSON.stringify(events);
    const failed = filterEvents(events, { ...NO_FILTERS, failedOnly: true });
    expect(failed.every((e) => e.status === 'failed' || e.status === 'denied')).toBe(true);
    const files = filterEvents(events, { ...NO_FILTERS, kinds: new Set(['file.change']) });
    expect(files.every((e) => e.kind === 'file.change')).toBe(true);
    expect(JSON.stringify(events)).toBe(frozen);
  });

  it('session filter isolates one session', () => {
    const all = draftExecutionFixture().events;
    const only = filterEvents(all, { ...NO_FILTERS, sessionId: 's-201a' });
    expect(only.every((e) => e.sessionId === 's-201a')).toBe(true);
    expect(only.length).toBeGreaterThan(0);
  });
});

describe('virtualization & retention (§17/§34)', () => {
  it('visibleRange renders a slice, not the world', () => {
    const r = visibleRange(3000, 600, 30, 5000);
    expect(r.end - r.start).toBeLessThan(50);
    expect(r.start).toBeGreaterThan(0);
    expect(visibleRange(0, 600, 30, 10)).toEqual({ start: 0, end: 10 });
  });

  it('event window caps retention but keeps identity and truncation count', () => {
    const h = createRoot((dispose) => ({ store: createExecutionStore(async () => ({ accepted: true })), dispose }));
    const big = largeExecutionFixture('t-x', EVENT_WINDOW + 500);
    h.store.applySnapshot({ sessions: big.sessions, events: big.events });
    expect(h.store.events().length).toBe(EVENT_WINDOW);
    expect(h.store.truncated()).toBe(500);
    // identity: the kept tail is the upstream tail, untouched
    expect(h.store.events().at(-1)!.seq).toBe(big.events.at(-1)!.seq);
    h.dispose();
  });

  it('an upstream-declared window cut (truncatedBefore) is a received fact, shown apart from the local window', () => {
    const h = createRoot((dispose) => ({ store: createExecutionStore(async () => ({ accepted: true })), dispose }));
    const p = buildExecutionFixture();
    h.store.applySnapshot({ sessions: p.sessions, events: p.events, truncatedBefore: 1 });
    expect(h.store.upstreamTruncatedBefore()).toBe(1);
    expect(h.store.truncated()).toBe(0); // the local window did not cut anything
    // A later snapshot without the field clears it — no stale claim survives a republish.
    h.store.applySnapshot({ sessions: p.sessions, events: p.events });
    expect(h.store.upstreamTruncatedBefore()).toBeNull();
    h.dispose();
  });

  it('file rollup keeps the last upstream change per path', () => {
    const changes = fileChanges(buildExecutionFixture().events);
    const paths = changes.map((e) => e.file!.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('src/old.ts');
  });
});

describe('session controls: pending → relay → projection', () => {
  function harness() {
    return createRoot((dispose) => {
      const stream = new FakeExecutionEventStream(buildExecutionFixture());
      const store = createExecutionStore(async (intent: SessionIntent) => {
        await new Promise((r) => setTimeout(r, 5));
        return stream.acceptSessionIntent(intent, 'fake-actor:test');
      });
      store.applySnapshot(stream.snapshot());
      stream.subscribe((delta) => {
        if (delta.type === 'events') store.applyEvents(delta.events);
        else store.applySession(delta.session);
      });
      return { stream, store, dispose };
    });
  }

  it('pause: pending shown, state flips only via the upstream session delta', async () => {
    const h = harness();
    const submit = h.store.submitControl({ intent: 'session.pause', sessionId: 's-184' });
    expect(h.store.hasPending('s-184', 'session.pause')).toBe(true);
    expect(h.store.sessions().find((s) => s.id === 's-184')!.state).toBe('running');
    await submit;
    expect(h.store.sessions().find((s) => s.id === 's-184')!.state).toBe('paused');
    expect(h.store.hasPending('s-184')).toBe(false);
    // …and the intervention itself landed as an attributed event.
    expect(h.store.events().at(-1)!.label).toContain('Paused by fake-actor:test');
    h.dispose();
  });

  it('fork creates a child session via upstream, with lineage', async () => {
    const h = harness();
    await h.store.submitControl({ intent: 'session.fork', sessionId: 's-184' });
    const fork = h.store.sessions().find((s) => s.parentSessionId === 's-184');
    expect(fork).toBeDefined();
    h.dispose();
  });

  it('rejection clears pending and surfaces the upstream reason', async () => {
    const h = createRoot((dispose) => ({
      store: createExecutionStore(async () => ({ accepted: false, reason: 'session already ended' })),
      dispose,
    }));
    await h.store.submitControl({ intent: 'session.pause', sessionId: 's-x' });
    expect(h.store.hasPending('s-x')).toBe(false);
    expect(h.store.controlError()).toBe('session already ended');
    h.dispose();
  });

  it('capability gating: the upstream level decides, verbatim', () => {
    const caps = buildExecutionFixture().sessions[0]!.capabilities!;
    expect(writeAffordance(caps.restart)).toBe('disabled');
    expect(writeAffordance(caps.kill)).toBe('enabled');
  });
});

describe('stated stream ends vs connection loss (불변식 2)', () => {
  const makeStore = () =>
    createRoot((dispose) => ({ store: createExecutionStore(async () => ({ accepted: true })), dispose }));

  it("a terminal end is an explicit state ('unsupported'/'none'), never dressed as lost", () => {
    const h = makeStore();
    h.store.markEnded('unsupported');
    expect(h.store.connection()).toBe('unsupported');
    h.store.markEnded('none');
    expect(h.store.connection()).toBe('none');
    h.dispose();
  });

  it('a transport error after a stated end does not downgrade it to CONNECTION LOST', () => {
    const h = makeStore();
    h.store.markEnded('unsupported');
    h.store.markLost(); // the EventSource errors after the server closes the ended stream
    expect(h.store.connection()).toBe('unsupported');
    h.dispose();
  });

  it('a real loss still marks lost', () => {
    const h = makeStore();
    h.store.applySnapshot({ sessions: [], events: [] });
    expect(h.store.connection()).toBe('live');
    h.store.markLost();
    expect(h.store.connection()).toBe('lost');
    h.dispose();
  });
});
