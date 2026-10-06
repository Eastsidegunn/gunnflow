/**
 * TEST-ONLY terminal shapes (Live Terminal brief §41), standing in for the
 * unresolved PTY protocol and control relay contracts (BLOCKED.md).
 * The invariant they simulate is the screen's core sentence: direct control is
 * not a bypass — every operator keystroke becomes an attributed, append-only
 * event; the browser never owns runtime truth.
 */
import type { FakeSessionProjection } from './execution.js';

export interface FakePtyEvent {
  seq: number;
  at: number;
  sessionId: string;
  channel: 'stdout' | 'stderr' | 'control';
  text: string;
  /** Who caused this line — runtime/agent output vs operator-injected stdin. */
  attribution: 'agent' | 'operator' | 'system';
  /** Actor id for operator lines (audit marker). */
  actor?: string;
  /** Correlates an operator line back to the stdin intent that caused it. */
  inputRef?: string;
}

export interface FakeTerminalProjection {
  session: FakeSessionProjection | null;
  events: FakePtyEvent[];
}

export type FakeTerminalIntent =
  | { intent: 'session.stdin'; sessionId: string; input: string; inputRef: string }
  | { intent: 'session.kill'; sessionId: string; reason: string };

export type FakeTerminalDelta =
  | { type: 'pty'; events: FakePtyEvent[] }
  | { type: 'session'; session: FakeSessionProjection };

type Listener = (delta: FakeTerminalDelta) => void;

/** TEST-ONLY per-session PTY stream: append-only buffer + control application. */
export class FakePtyStream {
  private session: FakeSessionProjection;
  private readonly events: FakePtyEvent[];
  private readonly listeners = new Set<Listener>();
  private seq: number;

  constructor(session: FakeSessionProjection, initial: FakePtyEvent[] = []) {
    this.session = session;
    this.events = initial.map((e) => Object.freeze(e));
    this.seq = Math.max(0, ...initial.map((e) => e.seq));
  }

  snapshot(): FakeTerminalProjection {
    return { session: this.session, events: this.events };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Simulated runtime output (bursts, live activity). Append-only. */
  appendOutput(lines: Array<Pick<FakePtyEvent, 'channel' | 'text'>>): void {
    this.push(
      lines.map((l) => ({ ...l, attribution: 'agent' as const })),
    );
  }

  /**
   * Operator stdin: recorded as an attributed event FIRST (the audit fact),
   * then the simulated runtime responds. Rejection appends nothing.
   */
  acceptIntent(
    intent: FakeTerminalIntent,
    actor: string,
  ): { accepted: boolean; reason?: string } {
    if (this.session.state === 'ended' || this.session.state === 'killed') {
      return { accepted: false, reason: `session already ${this.session.state}` };
    }
    if (intent.intent === 'session.stdin') {
      // Fake upstream policy: privileged stdin needs elevation. (Risk lives
      // upstream — Gunnflow never classifies command content itself.)
      if (intent.input.trimStart().startsWith('sudo')) {
        return { accepted: false, reason: 'policy: privileged stdin requires elevation (fake policy)' };
      }
      if (this.session.state !== 'running') {
        return { accepted: false, reason: 'session is not running' };
      }
      this.push([
        {
          channel: 'stdout',
          text: `$ ${intent.input}`,
          attribution: 'operator',
          actor,
          inputRef: intent.inputRef,
        },
        { channel: 'stdout', text: `[fake runtime] ran: ${intent.input}`, attribution: 'agent' },
      ]);
      return { accepted: true };
    }
    // session.kill — reason is mandatory at the contract level here.
    if (!intent.reason.trim()) {
      return { accepted: false, reason: 'kill requires a reason' };
    }
    this.session = { ...this.session, state: 'killed' };
    for (const l of this.listeners) l({ type: 'session', session: this.session });
    this.push([
      {
        channel: 'control',
        text: `session killed by ${actor} — reason: ${intent.reason}`,
        attribution: 'operator',
        actor,
      },
    ]);
    return { accepted: true };
  }

  /** Keep session record in sync with execution-side control changes. */
  applySessionState(session: FakeSessionProjection): void {
    this.session = session;
    for (const l of this.listeners) l({ type: 'session', session });
  }

  private push(lines: Array<Omit<FakePtyEvent, 'seq' | 'at' | 'sessionId'>>): void {
    const appended = lines.map(
      (l) =>
        Object.freeze({
          seq: ++this.seq,
          at: Date.now(),
          sessionId: this.session.id,
          ...l,
        }) as FakePtyEvent,
    );
    this.events.push(...appended);
    for (const l of this.listeners) l({ type: 'pty', events: appended });
  }
}

/** Sample PTY buffers keyed by session id. */
export function fakePtyBuffer(sessionId: string): FakePtyEvent[] {
  if (sessionId !== 's-184') return [];
  const NOW = 1_757_400_000_000;
  const line = (seq: number, channel: FakePtyEvent['channel'], text: string): FakePtyEvent => ({
    seq,
    at: NOW - (20 - seq) * 30_000,
    sessionId,
    channel,
    text,
    attribution: 'agent',
  });
  return [
    line(1, 'stdout', '$ pnpm install'),
    line(2, 'stdout', 'Packages: +412'),
    line(3, 'stdout', 'Done in 3.1s'),
    line(4, 'stdout', '$ pnpm test'),
    line(5, 'stdout', ' RUN  v3.2.7 /workspace/app'),
    line(6, 'stdout', ' ✓ src/utils/format.test.ts (8 tests)'),
    line(7, 'stderr', ' ✕ src/auth.spec.ts > refreshes expired token'),
    line(8, 'stderr', '   AssertionError: expected 401 to be 200'),
    line(9, 'stdout', ' Tests  12 passed | 1 failed'),
    line(10, 'stdout', ''),
  ];
}

/** Performance fixture (brief §44): a large retained history. */
export function largePtyBuffer(sessionId: string, lines = 10_000): FakePtyEvent[] {
  const NOW = 1_757_400_000_000;
  return Array.from({ length: lines }, (_, i) => ({
    seq: i + 1,
    at: NOW - (lines - i) * 100,
    sessionId,
    channel: i % 37 === 0 ? ('stderr' as const) : ('stdout' as const),
    text: i % 37 === 0 ? `warn: transient failure ${i}` : `[${i}] build output line with some longer content ${'x'.repeat(i % 40)}`,
    attribution: 'agent' as const,
  }));
}
