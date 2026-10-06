// Live Terminal acceptance: authority guards, stdin/kill through the single
// PendingIntentState (local echo ≠ authoritative), unconfirmed inputs, kill
// flow, audit attribution — against the TEST-ONLY fake PTY stream and feed.
import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import {
  FakePtyStream,
  buildExecutionFixture,
  fakePtyBuffer,
  fakePtyFeed,
  fakePtyStreamRef,
  normalFixture,
  type FakeTerminalIntent,
} from '@gunnflow-testing/fake-contracts';
import { GUARD_LABEL, stdinGuard } from '../src/state/terminalLogic.js';
import { createTerminalStore } from '../src/state/terminalStore.js';
import { createPendingIntentState } from '../src/state/pendingIntents.js';
import { fakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import { guardPost } from '../src/state/intentValidator.js';
import { chunksOf, createStreamStore } from '../src/state/streamStore.js';
import { emptyProjection, type WireIntent } from '../src/model/types.js';

const session184 = () => buildExecutionFixture().sessions[0]!;

describe('stdin authority guards (A/B/F/J)', () => {
  it('intervene alone is not enough — upstream capability decides', () => {
    const noAuthority = { ...session184(), capabilities: {} };
    expect(stdinGuard(noAuthority, 'live').reason).toBe('no-authority');
    const disabled = { ...session184(), capabilities: { stdin: 'disabled' as const } };
    expect(stdinGuard(disabled, 'live').reason).toBe('authority-disabled');
    expect(stdinGuard(session184(), 'live').allowed).toBe(true);
  });

  it('stale/disconnected/replay terminals take no input', () => {
    expect(stdinGuard(session184(), 'lost').reason).toBe('not-live');
    expect(stdinGuard(session184(), 'replay').reason).toBe('not-live');
  });

  it('paused/killed sessions take no stdin', () => {
    const paused = { ...session184(), state: 'paused' as const };
    expect(stdinGuard(paused, 'live').reason).toBe('session-not-running');
  });
});

const PARAMS = { source: { role: 'pty' }, retainItems: 5000, retainBytes: 8 * 1024 * 1024 };

function harness() {
  return createRoot((dispose) => {
    const pty = new FakePtyStream(session184(), fakePtyBuffer('s-184'));
    const feed = fakePtyFeed(pty, 's-184');
    const posted: WireIntent[] = [];
    const pending = createPendingIntentState(
      async (intent) => {
        posted.push(intent);
        await new Promise((r) => setTimeout(r, 5));
        return pty.acceptIntent(intent as FakeTerminalIntent, 'fake-actor:test');
      },
      fakeIntentAdapter,
      emptyProjection,
    );
    const terminal = createTerminalStore(pending);
    terminal.applySnapshot({ session: { ...pty.snapshot().session!, streams: [fakePtyStreamRef('s-184')] } });
    pty.subscribe((d) => {
      if (d.type === 'session') terminal.applySession(d.session);
    });
    const stream = createStreamStore(fakePtyStreamRef('s-184'), PARAMS);
    feed.subscribe(null, (event) => {
      stream.apply(event);
      pending.reconcileChunks('s-184', chunksOf(event));
    });
    const chunks = () => stream.rows().flatMap((r) => (r.kind === 'chunk' ? [r.chunk] : []));
    return { pty, feed, pending, terminal, stream, chunks, posted, dispose };
  });
}

describe('stdin through PendingIntentState (C)', () => {
  it('stdin is an in-flight entry until the authoritative operator chunk returns', async () => {
    const h = harness();
    const submit = h.terminal.submitStdin('pnpm test src/utils/format.test.ts');
    expect(h.pending.inFlight()).toHaveLength(1);
    expect(h.pending.inFlight()[0]!.intent).toMatchObject({ intent: 'session.stdin', sessionId: 's-184' });
    expect(h.terminal.stdinEntries()[0]!.phase).toBe('in-flight');
    expect(h.chunks().some((c) => c.channel === 'operator')).toBe(false);
    await submit;
    const operator = h.chunks().find((c) => c.channel === 'operator')!;
    expect(operator.data).toBe('$ pnpm test src/utils/format.test.ts');
    expect(h.pending.entries()).toHaveLength(0);
    h.dispose();
  });

  it('a refused input is a rejected entry with the upstream reason — never shown as executed', async () => {
    const h = harness();
    const result = await h.terminal.submitStdin('sudo rm -rf /');
    expect(result.accepted).toBe(false);
    const [entry] = h.terminal.stdinEntries();
    expect(entry?.phase).toBe('rejected');
    expect(entry?.phase === 'rejected' && entry.reason).toContain('policy');
    expect(h.chunks().some((c) => c.data.includes('sudo'))).toBe(false);
    // Restore puts the text back into the composer.
    h.pending.reopen(entry!.localId);
    expect(h.terminal.stdinDraft()).toBe('sudo rm -rf /');
    h.dispose();
  });

  it('connection loss marks in-flight input unconfirmed; a later echo still confirms it', async () => {
    const h = harness();
    const sending = h.terminal.submitStdin('pnpm build');
    h.terminal.markLost();
    const [entry] = h.pending.inFlight();
    expect(entry?.unconfirmed).toBe('connection lost');
    await sending;
    expect(h.pending.entries()).toHaveLength(0);
    h.dispose();
  });

  it('the composer text is a composing entry, sent only by submit', () => {
    const h = harness();
    h.terminal.setStdinDraft('echo hi');
    expect(h.pending.composing()).toHaveLength(1);
    expect(h.posted).toHaveLength(0);
    h.terminal.setStdinDraft('echo hello');
    expect(h.pending.composing()).toHaveLength(1);
    expect(h.terminal.stdinDraft()).toBe('echo hello');
    h.dispose();
  });

  it('stdin and kill pass the guarded relay boundary (schema keys enforced)', async () => {
    const inner = async () => ({ accepted: true });
    const post = guardPost(inner, fakeIntentAdapter, emptyProjection);
    const k = { idempotencyKey: 'k' };
    expect(await post({ intent: 'session.stdin', sessionId: 's', input: 'ls', inputRef: 'in-1', ...k })).toEqual({ accepted: true });
    expect(await post({ intent: 'session.kill', sessionId: 's', reason: 'x', ...k })).toEqual({ accepted: true });
    const extra = { intent: 'session.stdin', sessionId: 's', input: 'ls', inputRef: 'in-1', shell: 'bash', ...k } as unknown as WireIntent;
    expect(await post(extra)).toMatchObject({ accepted: false, invalid: true });
    // Even the terminal's stand-in intents carry their idempotency key on the wire.
    expect(await post({ intent: 'session.pause', sessionId: 's' } as unknown as WireIntent)).toMatchObject({ invalid: true });
  });

  it('an unrelated workspace projection touches neither stdin entries nor stream state', async () => {
    const h = harness();
    const release = h.terminal.submitStdin('pnpm lint');
    const rowsBefore = h.stream.rows();
    h.pending.reconcile(normalFixture());
    expect(h.pending.inFlight()).toHaveLength(1);
    expect(h.stream.rows()).toBe(rowsBefore);
    await release;
    h.dispose();
  });
});

describe('terminal session controls (guarded)', () => {
  it('pause/resume/fork pass the guarded boundary with their schema keys', async () => {
    const post = guardPost(async () => ({ accepted: true }), fakeIntentAdapter, emptyProjection);
    for (const intent of ['session.pause', 'session.resume', 'session.fork'] as const) {
      expect(await post({ intent, sessionId: 's-184', idempotencyKey: 'k' })).toEqual({ accepted: true });
    }
    const extra = { intent: 'session.pause', sessionId: 's-184', force: true, idempotencyKey: 'k' } as unknown as WireIntent;
    expect(await post(extra)).toMatchObject({ accepted: false, invalid: true });
  });

  it('a pause is in-flight until the session record says paused', async () => {
    const h = createRoot((dispose) => {
      const pending = createPendingIntentState(async () => ({ accepted: true }), fakeIntentAdapter, emptyProjection);
      return { pending, dispose };
    });
    await h.pending.submit({ intent: 'session.pause', sessionId: 's-184' });
    h.pending.reconcileSession(session184());
    expect(h.pending.inFlight()).toHaveLength(1);
    h.pending.reconcileSession({ ...session184(), state: 'paused' });
    expect(h.pending.inFlight()).toHaveLength(0);
    h.dispose();
  });
});

describe('kill flow (E)', () => {
  it('kill without a reason is refused upstream and kept as a rejected entry', async () => {
    const h = harness();
    const result = await h.terminal.submitKill('   ');
    expect(result.accepted).toBe(false);
    expect(h.terminal.session()!.state).toBe('running');
    expect(h.pending.rejected()[0]!.intent).toMatchObject({ intent: 'session.kill' });
    h.dispose();
  });

  it('kill with reason: pending until the session record says killed; attributed control chunk appended', async () => {
    const h = harness();
    const killing = h.terminal.submitKill('Runaway loop, burning budget');
    expect(h.terminal.pendingKill()).toBe(true);
    await killing;
    expect(h.terminal.session()!.state).toBe('killed');
    expect(h.terminal.pendingKill()).toBe(false);
    const control = h.chunks().at(-1)!;
    expect(control.channel).toBe('control');
    expect(control.data).toContain('killed by fake-actor:test');
    expect(control.data).toContain('Runaway loop');
    const after = await h.terminal.submitStdin('echo hi');
    expect(after.accepted).toBe(false);
    h.dispose();
  });
});

describe('buffer & audit (G, §20, §25)', () => {
  it('PTY events are append-only and frozen', () => {
    const stream = new FakePtyStream(session184(), fakePtyBuffer('s-184'));
    const first = stream.snapshot().events[0]!;
    expect(() => {
      (first as { text: string }).text = 'tampered';
    }).toThrow();
  });

  it('no terminal history touches browser storage (§25)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const file of ['terminalStore.ts', 'terminalLogic.ts', 'streamStore.ts']) {
      const text = readFileSync(join(import.meta.dirname, '..', 'src', 'state', file), 'utf8');
      expect(text).not.toContain('localStorage');
      expect(text).not.toContain('sessionStorage');
      expect(text).not.toContain('indexedDB');
    }
  });
});
