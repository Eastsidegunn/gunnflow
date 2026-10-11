// Terminals over the direct wire: browser-facing BFF routes → the built-in
// direct upstream → HTTP → the simulator's reference server and its echo
// shells, and back. Bytes stay base64 end to end.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DIRECT_WIRE } from '@gunnflow/contract';
import { base64ToBytes, bytesToBase64 } from '@gunnflow-testing/fake-contracts';
import { startFakeDirectServer, type FakeDirectServer } from '@gunnflow-testing/fake-contracts/direct-server';
import type { UpstreamTerminalEvent } from '@gunnflow/upstream-port';
import { createDirectUpstream } from '../src/direct-upstream.js';
import { buildServer } from '../src/server.js';

const b64 = (s: string) => bytesToBase64(new TextEncoder().encode(s));
const text = (b: string) => new TextDecoder().decode(base64ToBytes(b));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function wired(options: { terminals?: boolean } = {}) {
  const ref: FakeDirectServer = await startFakeDirectServer(options);
  cleanup.push(() => ref.close());
  const upstream = await createDirectUpstream(ref.url, { reconnectMs: 20 });
  cleanup.push(() => upstream.close());
  const app: FastifyInstance = buildServer({ upstream });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanup.push(() => app.close());
  const a = app.server.address();
  const bff = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  return { ref, upstream, app, bff };
}

/** The browser's view of /api/terminals/:id/output: decoded text plus event names. */
async function watch(bff: string, terminalId: string) {
  const controller = new AbortController();
  const res = await fetch(`${bff}/api/terminals/${terminalId}/output`, { signal: controller.signal });
  const state = { text: '', events: [] as string[], done: false };
  if (res.ok) {
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!event || !data) continue;
            state.events.push(event);
            const parsed = JSON.parse(data) as { bytesBase64?: string };
            if (event === 'snapshot') state.text = '';
            if (parsed.bytesBase64 !== undefined) state.text += text(parsed.bytesBase64);
          }
        }
      } catch {
        /* aborted */
      }
      state.done = true;
    })();
  }
  cleanup.push(() => controller.abort());
  return { status: res.status, state, close: () => controller.abort() };
}

const post = (url: string, body: unknown, method = 'POST') =>
  fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('terminals over the direct wire', () => {
  it('round trip: list, open a shell, type, read the echo, resize, close — through the wire', async () => {
    const { bff } = await wired();
    const list = (await (await fetch(`${bff}/api/terminals`)).json()) as { terminals: unknown[] };
    expect(list.terminals).toEqual([
      { terminalId: 'term-build', label: 'Web Build console', kind: 'attachable', state: 'running', nodeId: 't-build' },
    ]);

    const opened = await post(`${bff}/api/terminals`, { target: { shell: { cwd: '/w' } }, cols: 90, rows: 20 });
    expect(opened.status).toBe(200);
    const { terminalId } = (await opened.json()) as { terminalId: string };
    expect(terminalId).toBe('shell-1');

    const out = await watch(bff, terminalId);
    expect(out.status).toBe(200);
    await until(() => out.state.events[0] === 'snapshot' && out.state.text.includes('$ '));
    expect(out.state.text).toContain('echo shell in /w (simulated)');

    // Non-ASCII and control bytes survive both directions untouched.
    expect((await post(`${bff}/api/terminals/${terminalId}/input`, { bytesBase64: b64('héllo ✓\r') })).status).toBe(204);
    await until(() => out.state.text.includes('héllo ✓\r\nhéllo ✓\r\n$ '));

    expect((await post(`${bff}/api/terminals/${terminalId}/resize`, { cols: 132, rows: 40 })).status).toBe(204);
    await post(`${bff}/api/terminals/${terminalId}/input`, { bytesBase64: b64('size\r') });
    await until(() => out.state.text.includes('132x40'));

    expect((await fetch(`${bff}/api/terminals/${terminalId}`, { method: 'DELETE' })).status).toBe(204);
    await until(() => out.state.events.at(-1) === 'exit');
    expect((await post(`${bff}/api/terminals/${terminalId}/input`, { bytesBase64: b64('x') })).status).toBe(404);
    const after = (await (await fetch(`${bff}/api/terminals`)).json()) as { terminals: Array<{ terminalId: string }> };
    expect(after.terminals.map((t) => t.terminalId)).toEqual(['term-build']);
  });

  it('joins an attachable terminal; exited input is 409; unknown ids are 404; a refused open carries the reason', async () => {
    const { bff } = await wired();
    const joined = await post(`${bff}/api/terminals`, { target: { attach: 'term-build' }, cols: 80, rows: 24 });
    expect(await joined.json()).toEqual({ terminalId: 'term-build' });
    const refused = await post(`${bff}/api/terminals`, { target: { attach: 'nope' }, cols: 80, rows: 24 });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ reason: 'no such terminal' });

    expect((await post(`${bff}/api/terminals/nope/input`, { bytesBase64: b64('x') })).status).toBe(404);
    expect((await post(`${bff}/api/terminals/nope/resize`, { cols: 80, rows: 24 })).status).toBe(404);
    expect((await fetch(`${bff}/api/terminals/nope`, { method: 'DELETE' })).status).toBe(404);
    expect((await watch(bff, 'nope')).status).toBe(404);

    await post(`${bff}/api/terminals/term-build/input`, { bytesBase64: b64('exit\r') });
    const ended = await watch(bff, 'term-build');
    await until(() => ended.state.events.join(',') === 'snapshot,exit');
    expect((await post(`${bff}/api/terminals/term-build/input`, { bytesBase64: b64('x') })).status).toBe(409);
  });

  it('a dropped wire stream reconnects underneath: the viewer gets a fresh snapshot, then live output again', async () => {
    const { ref, upstream } = await wired();
    const opened = await upstream.openTerminal!({ target: { shell: { cwd: '/r' } }, cols: 80, rows: 24 });
    if (!('ok' in opened) || !opened.ok) throw new Error('open failed');
    const events: UpstreamTerminalEvent[] = [];
    const off = await upstream.subscribeTerminalOutput!(opened.terminalId, (e) => events.push(e));
    if (typeof off !== 'function') throw new Error('no subscription');
    cleanup.push(off);
    await upstream.terminalInput!(opened.terminalId, b64('one\r'));
    await until(() => events.some((e) => e.type === 'data' && text(e.bytesBase64).includes('one')));

    ref.dropTerminalStreams();
    await until(() => events.filter((e) => e.type === 'snapshot').length === 2);
    const resync = events.filter((e) => e.type === 'snapshot')[1] as { bytesBase64: string };
    expect(text(resync.bytesBase64)).toContain('one\r\none\r\n$ ');
    await upstream.terminalInput!(opened.terminalId, b64('two\r'));
    await until(() => events.some((e) => e.type === 'data' && text(e.bytesBase64).includes('two')));
    expect(events.some((e) => e.type === 'end')).toBe(false);
  });

  it('a terminal that disappears while the stream is down ends the tail as gone; the BFF drops the viewer', async () => {
    const { ref, upstream, bff } = await wired();
    const opened = await upstream.openTerminal!({ target: { shell: { cwd: '/g' } }, cols: 80, rows: 24 });
    if (!('ok' in opened) || !opened.ok) throw new Error('open failed');
    const events: UpstreamTerminalEvent[] = [];
    await upstream.subscribeTerminalOutput!(opened.terminalId, (e) => events.push(e));
    const viewer = await watch(bff, opened.terminalId);
    await until(() => viewer.state.events.length > 0);
    // The backend restarts on a fresh table: shell-1 no longer exists there.
    await ref.restart(30, 'normal');
    await until(() => events.at(-1)?.type === 'end');
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'gone' });
    await until(() => viewer.state.done);
    expect(viewer.state.events).not.toContain('exit');
  });

  it('a backend without terminals: every terminal route answers 501, stated', async () => {
    const { bff, upstream } = await wired({ terminals: false });
    const list = await fetch(`${bff}/api/terminals`);
    expect(list.status).toBe(501);
    expect(((await list.json()) as { reason: string }).reason).toContain(`${DIRECT_WIRE.terminals} answered 404`);
    expect((await post(`${bff}/api/terminals`, { target: { shell: { cwd: '/w' } }, cols: 80, rows: 24 })).status).toBe(501);
    expect((await post(`${bff}/api/terminals/x/input`, { bytesBase64: b64('x') })).status).toBe(501);
    expect((await post(`${bff}/api/terminals/x/resize`, { cols: 80, rows: 24 })).status).toBe(501);
    expect((await fetch(`${bff}/api/terminals/x`, { method: 'DELETE' })).status).toBe(501);
    expect((await watch(bff, 'x')).status).toBe(501);
    expect(await upstream.listTerminals!()).toMatchObject({ unsupported: expect.any(String) });
  });

  it('a wire answering broken terminal data is a reasoned 502, not a crash or an empty list', async () => {
    const s: Server = createServer((q, r) => {
      if (q.url === DIRECT_WIRE.nodes) return r.writeHead(200, { 'content-type': 'application/json' }).end('{"revision":1,"nodes":[]}');
      if (q.url === DIRECT_WIRE.terminals) {
        return r.writeHead(200, { 'content-type': 'application/json' }).end('[{"terminalId":"a","label":"x","kind":"pty","state":"running"}]');
      }
      if (q.url === '/terminals/a/input') return r.writeHead(500).end('backend fell over');
      r.writeHead(404).end();
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => (s.closeAllConnections(), s.close(r))));
    const a = s.address();
    const upstream = await createDirectUpstream(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, { reconnectMs: 20 });
    cleanup.push(() => upstream.close());
    const app = buildServer({ upstream });
    cleanup.push(() => app.close());
    const list = await app.inject({ method: 'GET', url: '/api/terminals' });
    expect(list.statusCode).toBe(502);
    expect(list.json().reason).toContain("kind must be 'attachable' or 'shell'");
    const input = await app.inject({
      method: 'POST',
      url: '/api/terminals/a/input',
      remoteAddress: '127.0.0.1',
      payload: { bytesBase64: b64('x') },
    });
    expect(input.statusCode).toBe(502);
    expect(input.json().reason).toContain('backend fell over');
  });

  it('carries wire chunks verbatim and skips nothing it does not understand except unknown event names', async () => {
    // A hand-written wire: an unknown event between frames, then exit.
    const chunk = bytesToBase64(new Uint8Array([0, 255, 27, 91, 50, 74])); // NUL, 0xFF, ESC[2J
    const s: Server = createServer((q, r) => {
      if (q.url === DIRECT_WIRE.nodes) return r.writeHead(200, { 'content-type': 'application/json' }).end('{"revision":1,"nodes":[]}');
      if (q.url === '/terminals/raw/stream') {
        r.writeHead(200, { 'content-type': 'text/event-stream' });
        r.write('event: snapshot\ndata:\n\n');
        r.write('event: future\ndata: whatever\n\n');
        r.write(`event: data\ndata: ${chunk}\n\n`);
        return r.end('event: exit\ndata: {"code":3}\n\n');
      }
      r.writeHead(404).end();
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => (s.closeAllConnections(), s.close(r))));
    const a = s.address();
    const upstream = await createDirectUpstream(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, { reconnectMs: 20 });
    cleanup.push(() => upstream.close());
    const events: UpstreamTerminalEvent[] = [];
    await upstream.subscribeTerminalOutput!('raw', (e) => events.push(e));
    await until(() => events.at(-1)?.type === 'exit');
    expect(events).toEqual([
      { type: 'snapshot', bytesBase64: '' },
      { type: 'data', bytesBase64: chunk },
      { type: 'exit', code: 3 },
    ]);
  });
});
