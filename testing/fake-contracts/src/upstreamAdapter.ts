/**
 * The simulator as an upstream: implements the BFF's upstream port
 * over the fake streams, relays and fixtures, plus test-only controls
 * (fixture switching, bursts, declared stream loss). Wired in by the BFF's
 * composition root in dev/test; nothing else in the BFF touches the simulator.
 */
import type { Intent } from '@gunnflow/contract';
import type { UpstreamFactory, UpstreamProjectionEnvelope, WorkspaceUpstream } from '@gunnflow/upstream-port';
import { FakeExecutionEventStream, type FakeSessionIntent, type FakeSessionProjection } from './execution.js';
import { FAKE_EXECUTIONS, emptyExecutionFixture, largeExecutionFixture } from './executionFixtures.js';
import { fakeBase64ToBytes, fakeSha256Hex } from './artifacts.js';
import { detailOf } from './details.js';
import { FIXTURES, type FixtureName } from './fixtures.js';
import type { FakeIntent } from './projection.js';
import { NullIntentRelay } from './relay.js';
import { projectNodes } from './projectNodes.js';
import { FakeWorkspaceStream } from './stream.js';
import { type FakeStreamFeed, fakePtyFeed, fakePtyStreamRef } from './streams.js';
import { FakePtyStream, fakePtyBuffer, largePtyBuffer, type FakeTerminalIntent } from './terminal.js';

export interface FakeUpstreamControls {
  /** Test-only: swap the whole scenario (used by e2e via /api/_fake/fixture). */
  loadFixture(name: FixtureName): void;
  /** Test-only: append N synthetic events to a task's execution stream. */
  burstExecution(taskId: string, count: number): void;
  /** Test-only: append N synthetic PTY lines to a session's terminal stream. */
  burstPty(sessionId: string, count: number): void;
  /** Test-only: an upstream-declared loss of `count` seqs on a session's PTY stream. */
  gapStream(sessionId: string, count: number): void;
}

/** The composition root's `fake` entry: the simulator with its test controls, starting on the normal fixture. */
export const createUpstream: UpstreamFactory = async () => createFakeUpstream('normal');

export function createFakeUpstream(
  initial: FixtureName = 'normal',
): WorkspaceUpstream & FakeUpstreamControls {
  const rejectWith = (intent: FakeIntent): string | undefined => {
    if (intent.intent === 'edge.rewire' && intent.to === 'reject-me') {
      return 'upstream rejected: target refuses incoming dependency (fake policy)';
    }
    return undefined;
  };
  let stream = new FakeWorkspaceStream(FIXTURES[initial]());
  let relay = new NullIntentRelay(stream, { latencyMs: 120, rejectWith });
  let fixtureName: FixtureName = initial;
  let executionStreams = new Map<string, FakeExecutionEventStream>();

  function executionStream(taskId: string): FakeExecutionEventStream {
    let es = executionStreams.get(taskId);
    if (!es) {
      const make =
        fixtureName === 'large'
          ? () => largeExecutionFixture(taskId)
          : (FAKE_EXECUTIONS[taskId] ?? (() => emptyExecutionFixture(taskId)));
      es = new FakeExecutionEventStream(make());
      executionStreams.set(taskId, es);
    }
    return es;
  }
  let ptyStreams = new Map<string, FakePtyStream>();
  let ptyFeeds = new Map<string, FakeStreamFeed>();
  /** The terminal session record declares its PTY stream channel. */
  const withStreams = (s: FakeSessionProjection): FakeSessionProjection => ({
    ...s,
    streams: [fakePtyStreamRef(s.id)],
  });
  function ptyFeed(sessionId: string): FakeStreamFeed | null {
    let feed = ptyFeeds.get(sessionId);
    if (feed) return feed;
    const ps = ptyStream(sessionId);
    if (!ps) return null;
    feed = fakePtyFeed(ps, sessionId);
    ptyFeeds.set(sessionId, feed);
    return feed;
  }

  function ptyStream(sessionId: string): FakePtyStream | null {
    let ps = ptyStreams.get(sessionId);
    if (ps) return ps;
    // Find the owning execution stream (build known fixtures if needed).
    for (const taskId of [...executionStreams.keys(), ...Object.keys(FAKE_EXECUTIONS)]) {
      const session = executionStream(taskId)
        .snapshot()
        .sessions.find((x) => x.id === sessionId);
      if (session) {
        const buffer =
          fixtureName === 'large' ? largePtyBuffer(sessionId) : fakePtyBuffer(sessionId);
        ps = new FakePtyStream(session, buffer);
        ptyStreams.set(sessionId, ps);
        // Keep the terminal's session record in sync with execution controls.
        executionStream(taskId).subscribe((delta) => {
          if (delta.type === 'session' && delta.session.id === sessionId) {
            ps!.applySessionState(delta.session);
          }
        });
        return ps;
      }
    }
    return null;
  }
  const listeners = new Set<(p: UpstreamProjectionEnvelope) => void>();
  let unhook = hook();

  function envelope(): UpstreamProjectionEnvelope {
    // The contract's generic nodes ride alongside the domain body (additive field).
    const current = stream.current();
    return { revision: current.revision, body: { ...current, nodes: projectNodes(current) } };
  }

  function hook(): () => void {
    return stream.subscribe(() => {
      for (const l of listeners) l(envelope());
    });
  }

  // The simulator is in-process: always reachable.
  const since = new Date().toISOString();
  return {
    snapshot: envelope,
    status: () => ({ connected: true, since }),
    subscribeStatus: () => () => undefined,
    // In-process: a refresh is a re-broadcast of the current snapshot.
    async refresh() {
      for (const l of listeners) l(envelope());
      return { ok: true } as const;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async relayIntent(intent, actor) {
      const name = (intent as { intent?: string }).intent ?? '';
      if (name === 'session.stdin' || name === 'session.kill') {
        await new Promise((r) => setTimeout(r, 120));
        const terminalIntent = intent as FakeTerminalIntent;
        const ps = ptyStream(terminalIntent.sessionId);
        if (!ps) return { accepted: false, reason: 'unknown session' };
        const result = ps.acceptIntent(terminalIntent, actor);
        if (result.accepted && name === 'session.kill') {
          // The kill is a runtime fact: reflect it in the execution projection too.
          const killed = ps.snapshot().session!;
          for (const es of executionStreams.values()) {
            if (es.snapshot().sessions.some((x) => x.id === killed.id)) {
              es.applySessionRecord(killed);
              es.appendEvents([
                { sessionId: killed.id, kind: 'human', label: `Session killed by ${actor}`, status: 'ok' },
              ]);
            }
          }
        }
        return result;
      }
      if (name.startsWith('session.')) {
        // Session controls target the execution stream in this fake upstream.
        await new Promise((r) => setTimeout(r, 120));
        for (const es of executionStreams.values()) {
          const hit = es
            .snapshot()
            .sessions.some((s) => s.id === (intent as FakeSessionIntent).sessionId);
          if (hit) return es.acceptSessionIntent(intent as FakeSessionIntent, actor);
        }
        return { accepted: false, reason: 'unknown session' };
      }
      return relay.send(intent as Intent, actor);
    },
    executionSnapshot(taskId) {
      return executionStream(taskId).snapshot();
    },
    subscribeExecution(taskId, listener) {
      return executionStream(taskId).subscribe(listener);
    },
    burstPty(sessionId, count) {
      const ps = ptyStream(sessionId);
      ps?.appendOutput(
        Array.from({ length: count }, (_, i) => ({
          channel: 'stdout' as const,
          text: `[burst] output line ${i + 1}`,
        })),
      );
    },
    // The terminal route carries the session record only; PTY content rides the stream route.
    terminalSnapshot(sessionId) {
      const session = ptyStream(sessionId)?.snapshot().session;
      return { session: session ? withStreams(session) : null, events: [] };
    },
    subscribeTerminal(sessionId, listener) {
      const ps = ptyStream(sessionId);
      if (!ps) return () => undefined;
      return ps.subscribe((delta) => {
        if (delta.type === 'session') listener({ type: 'session', session: withStreams(delta.session) });
      });
    },
    // On-demand detail from the current fixture; undefined = no detail for that node.
    async nodeDetail(nodeId) {
      return detailOf(stream.current(), nodeId);
    },
    artifactSnapshot(artifactId, digest) {
      const p = stream.current();
      const ref = [...p.tasks, ...p.deliverables].flatMap((n) => n.artifacts ?? []).find((a) => a.id === artifactId);
      const bytesBase64 = p.artifactSnapshots?.[artifactId];
      if (!ref || ref.access.kind !== 'snapshot' || bytesBase64 === undefined) return undefined;
      // The simulator holds one version per artifact; any other digest is a version it does not have.
      if (fakeSha256Hex(fakeBase64ToBytes(bytesBase64)) !== digest) return undefined;
      return { mediaType: ref.mediaType, bytesBase64 };
    },
    subscribeStream(nodeId, streamId, lastSeenSeq, listener) {
      const feed = ptyFeed(nodeId);
      if (!feed || feed.ref.id !== streamId) return () => undefined;
      return feed.subscribe(lastSeenSeq, listener);
    },
    gapStream(sessionId, count) {
      ptyFeed(sessionId)?.declareGap(count, `upstream dropped ${count} chunks (fake overflow)`);
    },
    burstExecution(taskId, count) {
      const es = executionStream(taskId);
      const sessionId = es.snapshot().sessions[0]?.id ?? 'unknown';
      es.appendEvents(
        Array.from({ length: count }, (_, i) => ({
          sessionId,
          kind: 'message' as const,
          label: `burst event ${i + 1}`,
          message: { role: 'system' as const, content: `burst ${i + 1}` },
        })),
      );
    },
    loadFixture(name) {
      unhook();
      fixtureName = name;
      stream = new FakeWorkspaceStream(FIXTURES[name]());
      relay = new NullIntentRelay(stream, { latencyMs: 120, rejectWith });
      executionStreams = new Map();
      ptyStreams = new Map();
      ptyFeeds = new Map();
      unhook = hook();
      for (const l of listeners) l(envelope());
    },
  };
}
