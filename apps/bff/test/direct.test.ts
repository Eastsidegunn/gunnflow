// The built-in direct upstream against the simulator's direct-wire reference
// server: a real HTTP round trip, the contract's conformance suite, and the
// wire's edge cases (absent stream, transport errors, missing /nodes).
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, DIRECT_WIRE, type ExecutionSnapshot, type NodeProjection } from '@gunnflow/contract';
import { defineConformanceSuite } from '@gunnflow/contract/conformance';
import { startFakeDirectServer, type FakeDirectServer } from '@gunnflow-testing/fake-contracts/direct-server';
import { UnsupportedDetail, type UpstreamProjectionEnvelope } from '@gunnflow/upstream-port';
import { createDirectUpstream } from '../src/direct-upstream.js';
import { buildServer } from '../src/server.js';
import { DIRECT_MODULE, loadUpstream } from '../src/composition.js';
import { CONFIG_ENV, loadConfigFile, parseConfig, resolveSettings } from '../src/config.js';

const nodesOf = (e: UpstreamProjectionEnvelope) => (e.body as { nodes: NodeProjection[] }).nodes;
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let ref: FakeDirectServer;
let upstream: Awaited<ReturnType<typeof createDirectUpstream>>;
beforeAll(async () => {
  ref = await startFakeDirectServer();
  upstream = await createDirectUpstream(`${ref.url}/`, { reconnectMs: 20 });
});
afterAll(async () => {
  upstream.close();
  await ref.close();
});

describe('direct upstream ↔ simulator direct wire', () => {
  it('carries the snapshot as { revision, body: { nodes } } — nothing added', async () => {
    const res = await fetch(`${ref.url}${DIRECT_WIRE.nodes}`);
    const wire = (await res.json()) as { revision: number; nodes: NodeProjection[] };
    expect(upstream.snapshot()).toEqual({ revision: wire.revision, body: { nodes: wire.nodes } });
    expect(Object.keys(upstream.snapshot().body as object)).toEqual(['nodes']);
  });

  it('relays an intent with the actor header, and the effect arrives as a streamed snapshot', async () => {
    ref.loadFixture('normal');
    await until(() => nodesOf(upstream.snapshot()).find((n) => n.id === 't-build')?.state.value === 'running');
    const seen: UpstreamProjectionEnvelope[] = [];
    const off = upstream.subscribe((e) => seen.push(e));
    const result = await upstream.relayIntent({ nodeId: 't-build', action: 'task.pause', idempotencyKey: 'direct-1' }, 'fake-actor:direct');
    expect(result).toEqual({ accepted: true });
    await until(() => seen.some((e) => nodesOf(e).find((n) => n.id === 't-build')?.state.value === 'paused'));
    off();
  });

  it('carries refusals verbatim from the backend (contract validation happens there)', async () => {
    const r = await upstream.relayIntent({ nodeId: 't-build', action: 'task.pause', idempotencyKey: 'k', origin: 'copilot' }, 'a');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/unknown key 'origin'/);
  });

  it('fetches artifact bytes by digest address; unknown versions are absent', async () => {
    const ref0 = nodesOf(upstream.snapshot()).flatMap((n) => n.artifacts).find((a) => a.id === 'art-build-report')!;
    const snap = await upstream.artifactSnapshot?.('art-build-report', ref0.digest!);
    expect(snap?.mediaType).toBe('text/html');
    expect(Buffer.from(snap!.bytesBase64, 'base64').toString()).toContain('Build report');
    expect(await upstream.artifactSnapshot?.('art-build-report', 'f'.repeat(64))).toBeUndefined();
  });

  it('fetches node detail over the wire: 200 → NodeDetail, 404 → undefined', async () => {
    ref.loadFixture('attention');
    expect(await upstream.nodeDetail?.('t-build')).toEqual({ revision: 20, items: [{ label: 'progress', text: '41/42 tests' }] });
    expect(await upstream.nodeDetail?.('t-draft')).toBeUndefined();
    ref.loadFixture('normal');
  });

  it('surfaces the wire does not define are unsupported, not empty', () => {
    expect(upstream.terminalSnapshot('s')).toMatchObject({ unsupported: expect.any(String) });
    expect(upstream.subscribeTerminal('s', () => undefined)).toMatchObject({ unsupported: expect.any(String) });
    expect(upstream.subscribeStream('n', 's', null, () => undefined)).toMatchObject({ unsupported: expect.any(String) });
  });

  it('fetches the execution snapshot over the wire: contract fields only; an unknown task is 404 → undefined', async () => {
    const snap = (await upstream.executionSnapshot('t-build')) as ExecutionSnapshot;
    expect(snap.sessions.map((s) => s.id)).toContain('s-184');
    expect(Object.keys(snap.sessions[0]!).sort()).toEqual(['id', 'label', 'state', 'taskId']);
    // No payload fields ride this surface — kind/label/status verbatim is all.
    expect(Object.keys(snap.events[0]!).sort()).toEqual(['at', 'kind', 'label', 'seq', 'sessionId', 'status']);
    expect(snap.events.map((e) => e.seq)).toEqual([...snap.events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(await upstream.executionSnapshot('no-such-task')).toBeUndefined();
  });

  it('execution stream: the first frame is the current snapshot, changes re-emit the FULL snapshot', async () => {
    const seen: ExecutionSnapshot[] = [];
    const off = upstream.subscribeExecution('t-build', (delta) => {
      const d = delta as { type: string; snapshot: ExecutionSnapshot };
      if (d.type === 'snapshot') seen.push(d.snapshot);
    });
    await until(() => seen.length >= 1);
    const before = seen[0]!.events.length;
    ref.burstExecution('t-build', 2);
    await until(() => (seen.at(-1)?.events.length ?? 0) >= before + 2);
    const last = seen.at(-1)!;
    // A full republish, not a delta: the whole history window rides every frame.
    expect(last.events.length).toBeGreaterThanOrEqual(before + 2);
    expect(last.events.at(-1)!.label).toBe('burst event 2');
    off();
  });
});

defineConformanceSuite('direct wire (simulator reference server)', async () => {
  let before = upstream.snapshot().revision;
  return {
    contractVersion: CONTRACT_VERSION,
    nodes: () => nodesOf(upstream.snapshot()),
    // The wire serves execution (reference server): the suite validates what it serves.
    execution: async (taskId) => (await upstream.executionSnapshot(taskId)) as ExecutionSnapshot | undefined,
    relay: (intent) => {
      before = upstream.snapshot().revision;
      return upstream.relayIntent(intent, 'fake-actor:conformance');
    },
    // Effects are observable once a newer snapshot has streamed in.
    settle: () => until(() => upstream.snapshot().revision > before).catch(() => undefined),
  };
});

describe('direct wire edge cases', () => {
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const s: Server = createServer(handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const a = s.address();
    return { url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, close: () => new Promise((r) => (s.closeAllConnections(), s.close(r))) };
  };

  it('refuses to start without GET /nodes; an absent stream leaves the initial snapshot static', async () => {
    const none = await serve((_q, r) => (r.writeHead(404), r.end()));
    await expect(createDirectUpstream(none.url)).rejects.toThrow(/\/nodes answered 404/);
    await none.close();

    const statuses: number[] = [];
    const onlyNodes = await serve((q, r) => {
      if (q.url === '/nodes') return (r.writeHead(200, { 'content-type': 'application/json' }), r.end(JSON.stringify({ revision: 4, nodes: [] })));
      if (q.url === '/intent') return (r.writeHead(503), r.end(JSON.stringify({ reason: 'backend draining' })));
      r.writeHead(q.url === '/stream' || q.url?.startsWith('/detail/') || q.url?.startsWith('/execution/') ? 501 : 404);
      r.end();
    });
    const u = await createDirectUpstream(onlyNodes.url, { reconnectMs: 10, onStreamUnsupported: (s) => statuses.push(s) });
    await until(() => statuses.length > 0);
    expect(statuses).toEqual([501]);
    expect(u.snapshot()).toEqual({ revision: 4, body: { nodes: [] } });
    // Transport errors carry the backend's text verbatim.
    expect(await u.relayIntent({ nodeId: 'x', action: 'y', idempotencyKey: 'k' }, 'a')).toEqual({ accepted: false, reason: 'backend draining' });
    expect(await u.artifactSnapshot?.('a', 'b'.repeat(64))).toBeUndefined();
    // A 501 from /detail is remembered: the surface stays unsupported, not empty.
    await expect(u.nodeDetail!('x')).rejects.toBeInstanceOf(UnsupportedDetail);
    await expect(u.nodeDetail!('y')).rejects.toBeInstanceOf(UnsupportedDetail);
    // Same latch for /execution: 501 once, unsupported from then on. The BFF
    // SSE route states it as ONE terminal `end` frame on a 200 — an
    // EventSource cannot read a non-200, and unsupported is not an outage.
    expect(await u.executionSnapshot('t')).toMatchObject({ unsupported: expect.stringContaining('501') });
    expect(await u.executionSnapshot('t')).toMatchObject({ unsupported: expect.stringContaining(DIRECT_WIRE.execution) });
    const app = buildServer({ upstream: u });
    const resEnd = await app.inject({ method: 'GET', url: '/api/execution/t/stream' });
    expect(resEnd.statusCode).toBe(200);
    expect(resEnd.headers['content-type']).toContain('text/event-stream');
    expect(resEnd.body).toContain('event: end');
    expect(resEnd.body).toContain('"reason":"unsupported"');
    await app.close();
    u.close();
    await onlyNodes.close();
  });

  it('execution relay: an absent execution is a stated end-frame, and a contract-breaking snapshot is a reasoned 502 — never an anonymous 500', async () => {
    // 404 from the wire (no execution for the task) → a terminal `end` frame with reason 'none'.
    const okApp = buildServer({ upstream });
    const resNone = await okApp.inject({ method: 'GET', url: '/api/execution/no-such-task/stream' });
    expect(resNone.statusCode).toBe(200);
    expect(resNone.body).toContain('event: end');
    expect(resNone.body).toContain('"reason":"none"');
    await okApp.close();

    // A backend serving a snapshot that breaks the contract: the client rejects, the BFF answers 502 with the reasons.
    const bad = await serve((q, r) => {
      if (q.url === '/nodes') return (r.writeHead(200, { 'content-type': 'application/json' }), r.end(JSON.stringify({ revision: 1, nodes: [] })));
      if (q.url?.startsWith('/execution/')) {
        r.writeHead(200, { 'content-type': 'application/json' });
        return r.end(JSON.stringify({ sessions: [{ id: 's' }], events: [{ seq: 2 }, { seq: 1 }] }));
      }
      r.writeHead(q.url === '/stream' ? 501 : 404);
      r.end();
    });
    const u = await createDirectUpstream(bad.url, { reconnectMs: 10, onStreamUnsupported: () => undefined });
    await expect(u.executionSnapshot('t')).rejects.toThrow(/fails the contract/);
    const app = buildServer({ upstream: u });
    const res = await app.inject({ method: 'GET', url: '/api/execution/t/stream' });
    expect(res.statusCode).toBe(502);
    expect(res.json().reason).toMatch(/execution unavailable: .*fails the contract/);
    await app.close();
    u.close();
    await bad.close();
  });

  it('execution referential integrity: a snapshot answering for another task is a contract failure', async () => {
    const wrongTask = await serve((q, r) => {
      if (q.url === '/nodes') return (r.writeHead(200, { 'content-type': 'application/json' }), r.end(JSON.stringify({ revision: 1, nodes: [] })));
      if (q.url?.startsWith('/execution/')) {
        r.writeHead(200, { 'content-type': 'application/json' });
        return r.end(JSON.stringify({ sessions: [{ id: 's', taskId: 'other-task', state: 'running' }], events: [] }));
      }
      r.writeHead(q.url === '/stream' ? 501 : 404);
      r.end();
    });
    const u = await createDirectUpstream(wrongTask.url, { reconnectMs: 10, onStreamUnsupported: () => undefined });
    await expect(u.executionSnapshot('t')).rejects.toThrow(/fails the contract: session 's' carries taskId 'other-task'/);
    u.close();
    await wrongTask.close();
  });

  it('execution tail terminal ends: stream 404 → gone, 501 → unsupported (latched), persistent contract breaks → invalid', async () => {
    const validSnapshot = JSON.stringify({ sessions: [{ id: 's', taskId: 't', state: 'running' }], events: [] });
    const mkServer = (stream: (r: import('node:http').ServerResponse) => void) =>
      serve((q, r) => {
        if (q.url === '/nodes') return (r.writeHead(200, { 'content-type': 'application/json' }), r.end(JSON.stringify({ revision: 1, nodes: [] })));
        if (q.url === '/execution/t/stream') return stream(r);
        if (q.url?.startsWith('/execution/')) return (r.writeHead(200, { 'content-type': 'application/json' }), r.end(validSnapshot));
        r.writeHead(q.url === '/stream' ? 501 : 404);
        r.end();
      });
    const tailEnd = async (u: Awaited<ReturnType<typeof createDirectUpstream>>) => {
      const ends: Array<{ reason?: string }> = [];
      const off = u.subscribeExecution('t', (delta) => {
        const d = delta as { type: string; reason?: string };
        if (d.type === 'end') ends.push(d);
      });
      await until(() => ends.length > 0);
      off();
      return ends[0]!.reason;
    };

    const gone = await mkServer((r) => (r.writeHead(404), r.end()));
    const u1 = await createDirectUpstream(gone.url, { reconnectMs: 10, onStreamUnsupported: () => undefined });
    expect(await tailEnd(u1)).toBe('gone');
    u1.close();
    await gone.close();

    const unsupported = await mkServer((r) => (r.writeHead(501), r.end()));
    const u2 = await createDirectUpstream(unsupported.url, { reconnectMs: 10, onStreamUnsupported: () => undefined });
    expect(await tailEnd(u2)).toBe('unsupported');
    // The stream's 501 latches the whole surface: the GET answers unsupported without re-asking the wire.
    expect(await u2.executionSnapshot('t')).toMatchObject({ unsupported: expect.stringContaining('501') });
    u2.close();
    await unsupported.close();

    const invalid = await mkServer((r) => {
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      // Three consecutive contract-breaking frames: broken JSON, unknown key, another task's session.
      r.write('event: snapshot\ndata: {oops\n\n');
      r.write('event: snapshot\ndata: {"sessions":[],"events":[],"payload":1}\n\n');
      r.write(`event: snapshot\ndata: ${JSON.stringify({ sessions: [{ id: 's', taskId: 'other', state: 'running' }], events: [] })}\n\n`);
    });
    const u3 = await createDirectUpstream(invalid.url, { reconnectMs: 10, onStreamUnsupported: () => undefined });
    expect(await tailEnd(u3)).toBe('invalid');
    u3.close();
    await invalid.close();
  });

  it('BFF execution route over the direct wire: SSE first frame, then full-snapshot re-emits', async () => {
    ref.loadFixture('normal'); // rebuild the execution stream: earlier tests burst events into it
    const app = buildServer({ upstream, coalesceMs: 5 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/execution/t-build/stream`, { signal: controller.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const readUntil = async (cond: (b: string) => boolean) => {
        const end = Date.now() + 3000;
        while (!cond(buffer)) {
          if (Date.now() > end) throw new Error(`timed out; got: ${buffer.slice(0, 500)}`);
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
      };
      await readUntil((b) => b.includes('event: snapshot'));
      ref.burstExecution('t-build', 1);
      // The re-emit is the FULL snapshot as a `snapshot` event (no deltas on this wire).
      await readUntil((b) => b.includes('burst event 1'));
      const afterFirst = buffer.slice(buffer.indexOf('\n\n') + 2);
      expect(afterFirst).toContain('event: snapshot');
      expect(afterFirst).not.toContain('event: events');
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it('composition: `direct` loads the built-in module by alias and needs a url', async () => {
    const imported: string[] = [];
    const loaded = await loadUpstream(
      { GUNNFLOW_UPSTREAM: 'direct', GUNNFLOW_UPSTREAM_URL: ref.url },
      { importModule: async (n) => (imported.push(n), import('../src/direct-upstream.js')) },
    );
    expect(imported).toEqual([DIRECT_MODULE]);
    expect(loaded.fake).toBeNull();
    expect(loaded.label).toBe(`direct → ${ref.url}`);
    (loaded.upstream as { close?(): void }).close?.();
    await expect(loadUpstream({ GUNNFLOW_UPSTREAM: 'direct' })).rejects.toThrow(/needs a url/);
  });
});

describe('gunnflow.config.json', () => {
  it('accepts the schema; refuses unknown keys, non-strings, non-http urls, credentials and non-origin origins', () => {
    const ok = { upstream: 'direct', url: 'http://127.0.0.1:9000/gunnflow', webOrigin: 'http://127.0.0.1:5173', previewOrigin: 'http://127.0.0.1:8788' };
    expect(parseConfig(ok)).toEqual(ok);
    expect(() => parseConfig({ ...ok, token: 'x' })).toThrow(/unknown key 'token'/);
    expect(() => parseConfig({ upstream: 3 })).toThrow(/non-empty string/);
    expect(() => parseConfig({ upstream: 'some-backend' })).toThrow(/'upstream' must be 'fake' or 'direct'/);
    expect(() => parseConfig({ url: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => parseConfig({ url: 'http://user:pw@host' })).toThrow(/credentials/);
    expect(() => parseConfig({ webOrigin: 'http://127.0.0.1:5173/app' })).toThrow(/origin/);
    expect(() => parseConfig([])).toThrow(/object/);
  });

  it('env wins over the file; an absent file is an empty config', () => {
    const settings = resolveSettings({ GUNNFLOW_UPSTREAM_URL: 'http://env.test' }, { upstream: 'direct', url: 'http://file.test' });
    expect(settings[CONFIG_ENV.upstream]).toBe('direct');
    expect(settings[CONFIG_ENV.url]).toBe('http://env.test');
    expect(loadConfigFile('/nonexistent/gunnflow.config.json')).toEqual({});
  });
});
