/**
 * NullIntentRelay — TEST-ONLY stand-in for an upstream write relay
 * (BLOCKED.md #3). It never mutates any local graph; on acceptance it hands the
 * intent to a FakeWorkspaceStream, which appends an event and re-projects —
 * exactly the shape the real relay will have.
 */
import type { Intent, IntentResult } from '@gunnflow/contract';
import { fakeIntentFromCanonical } from './canonical.js';
import type { FakeIntent } from './projection.js';
import type { FakeWorkspaceStream } from './stream.js';

export interface NullIntentRelayOptions {
  /** Simulated upstream latency in ms. */
  latencyMs?: number;
  /** Decide rejection per intent; return a reason string to reject. */
  rejectWith?: (intent: FakeIntent) => string | undefined;
}

export class NullIntentRelay {
  /** Every intent ever sent, in order (as received on the wire) — lets tests assert the audit trail. */
  readonly sent: Array<{ intent: Intent; actor: string; at: number }> = [];

  constructor(
    private readonly stream: FakeWorkspaceStream | null,
    private readonly options: NullIntentRelayOptions = {},
  ) {}

  /** Receives a contract Intent; translation to the simulator's domain happens at apply time. */
  async send(intent: Intent, actor: string): Promise<IntentResult> {
    this.sent.push({ intent, actor, at: Date.now() });
    if (this.options.latencyMs) {
      await new Promise((r) => setTimeout(r, this.options.latencyMs));
    }
    if (!this.stream) return { accepted: true };
    const fake = fakeIntentFromCanonical(this.stream.current(), intent);
    if ('refused' in fake) return { accepted: false, reason: fake.refused };
    const reason = this.options.rejectWith?.(fake);
    if (reason !== undefined) {
      return { accepted: false, reason };
    }
    // Acceptance C1/C3: the caller's local state must not change here; the only
    // path to an authoritative update is the stream's own projection emit.
    return this.stream.acceptIntent(fake, actor, intent.idempotencyKey);
  }
}
