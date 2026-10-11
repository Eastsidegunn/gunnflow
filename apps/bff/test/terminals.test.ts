import { afterEach, describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, createFakeUpstream } from '@gunnflow-testing/fake-contracts';
import type { UpstreamTerminalEvent, WorkspaceUpstream } from '@gunnflow/upstream-port';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const b64 = (s: string) => bytesToBase64(new TextEncoder().encode(s));
let open: FastifyInstance | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

function makeApp() {
  const app = buildServer({ upstream: createFakeUpstream('normal') });
  return app;
}

async function readOutput(app: FastifyInstance, terminalId: string, until: (text: string, events: string[]) => boolean) {
  await app.listen({ port: 0, host: '127.0.0.1' });
  open = app;
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/terminals/${terminalId}/output`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const events: string[] = [];
  const parse = () => {
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      events.push(event);
      const parsed = JSON.parse(data) as { bytesBase64?: string };
      if (parsed.bytesBase64 !== undefined) text += new TextDecoder().decode(base64ToBytes(parsed.bytesBase64));
    }
  };
  return {
    status: res.status,
    async next() {
      while (!until(text, events)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        parse();
      }
      return { text, events };
    },
    close: () => controller.abort(),
  };
}

describe('terminal relay (upstream-port 0.2.0)', () => {
  it('lists, opens a shell, carries input and answers with output chunks', async () => {
    const app = makeApp();
    const list = await app.inject({ method: 'GET', url: '/api/terminals' });
    expect(list.json().terminals[0]).toMatchObject({ terminalId: 'term-build', kind: 'attachable', nodeId: 't-build' });
    const opened = await app.inject({
      method: 'POST',
      url: '/api/terminals',
      payload: { target: { shell: { cwd: '/w' } }, cols: 90, rows: 20 },
    });
    expect(opened.json()).toEqual({ terminalId: 'shell-1' });
    const out = await readOutput(app, 'shell-1', (t) => t.includes('hello\r\n$ '));
    expect(out.status).toBe(200);
    const input = await app.inject({ method: 'POST', url: '/api/terminals/shell-1/input', payload: { bytesBase64: b64('hello\r') } });
    expect(input.statusCode).toBe(204);
    const { text, events } = await out.next();
    expect(events[0]).toBe('snapshot');
    expect(text).toContain('$ hello\r\nhello\r\n$ ');
    out.close();
  });

  it('a reconnect starts from the retained snapshot; exit ends the stream', async () => {
    const app = makeApp();
    await app.inject({ method: 'POST', url: '/api/terminals/term-build/input', payload: { bytesBase64: b64('before\r') } });
    const out = await readOutput(app, 'term-build', (_t, e) => e.includes('exit'));
    const resize = await app.inject({ method: 'POST', url: '/api/terminals/term-build/resize', payload: { cols: 70, rows: 10 } });
    expect(resize.statusCode).toBe(204);
    await app.inject({ method: 'POST', url: '/api/terminals/term-build/input', payload: { bytesBase64: b64('size\rexit\r') } });
    const { text, events } = await out.next();
    expect(events[0]).toBe('snapshot');
    expect(text).toContain('before\r\n');
    expect(text).toContain('70x10');
    expect(events.at(-1)).toBe('exit');
    const late = await app.inject({ method: 'POST', url: '/api/terminals/term-build/input', payload: { bytesBase64: b64('x') } });
    expect(late.statusCode).toBe(409);
    out.close();
  });

  it('steering is limited to loopback callers and loopback pages', async () => {
    const app = makeApp();
    const remote = await app.inject({
      method: 'POST',
      url: '/api/terminals/term-build/input',
      remoteAddress: '192.0.2.10',
      payload: { bytesBase64: b64('x') },
    });
    expect(remote.statusCode).toBe(403);
    const foreignPage = await app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: { origin: 'https://example.com' },
      payload: { target: { shell: { cwd: '/' } }, cols: 80, rows: 24 },
    });
    expect(foreignPage.statusCode).toBe(403);
    const localPage = await app.inject({
      method: 'DELETE',
      url: '/api/terminals/term-build',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(localPage.statusCode).toBe(204);
    // Reading the list stays open (it carries no bytes).
    const list = await app.inject({ method: 'GET', url: '/api/terminals', remoteAddress: '192.0.2.10' });
    expect(list.statusCode).toBe(200);
  });

  it('refuses malformed shapes and unknown terminals', async () => {
    const app = makeApp();
    const bad = [
      { url: '/api/terminals', payload: { target: { shell: {} }, cols: 80, rows: 24 } },
      { url: '/api/terminals', payload: { target: { attach: 'term-build' }, cols: 0, rows: 24 } },
      { url: '/api/terminals/term-build/input', payload: { bytesBase64: 'not base64!' } },
      { url: '/api/terminals/term-build/input', payload: { bytesBase64: 'A'.repeat(64 * 1024 + 4) } },
      { url: '/api/terminals/term-build/resize', payload: { cols: 80.5, rows: 24 } },
    ];
    for (const b of bad) expect((await app.inject({ method: 'POST', ...b })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/terminals/nope/input', payload: { bytesBase64: '' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/terminals/nope/output' })).statusCode).toBe(404);
    const refused = await app.inject({
      method: 'POST',
      url: '/api/terminals',
      payload: { target: { attach: 'nope' }, cols: 80, rows: 24 },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({ reason: 'no such terminal' });
  });

  it('an upstream without terminals answers 501 on every route', async () => {
    const full = createFakeUpstream('normal');
    const bare: WorkspaceUpstream = { ...full };
    for (const k of ['listTerminals', 'openTerminal', 'subscribeTerminalOutput', 'terminalInput', 'terminalResize', 'closeTerminal'] as const) {
      delete bare[k];
    }
    const app = buildServer({ upstream: bare });
    const calls = [
      { method: 'GET', url: '/api/terminals' },
      { method: 'POST', url: '/api/terminals', payload: {} },
      { method: 'GET', url: '/api/terminals/x/output' },
      { method: 'POST', url: '/api/terminals/x/input', payload: {} },
      { method: 'POST', url: '/api/terminals/x/resize', payload: {} },
      { method: 'DELETE', url: '/api/terminals/x' },
    ] as const;
    for (const c of calls) expect((await app.inject(c)).statusCode).toBe(501);
  });

  it('backpressure: a viewer that stops reading is dropped past the high-water mark, and the upstream is released', async () => {
    let listener: ((e: UpstreamTerminalEvent) => void) | null = null;
    let released = false;
    const upstream: WorkspaceUpstream = {
      ...createFakeUpstream('normal'),
      subscribeTerminalOutput: (_id, l) => {
        listener = l;
        l({ type: 'snapshot', bytesBase64: '' });
        return () => {
          released = true;
        };
      },
    };
    const app = buildServer({ upstream });
    await app.listen({ port: 0, host: '127.0.0.1' });
    open = app;
    const a = app.server.address();
    const res = await fetch(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/terminals/x/output`);
    expect(res.status).toBe(200);
    // Never read the body: everything written piles up in the BFF's socket buffer.
    const chunk = bytesToBase64(new Uint8Array(48 * 1024));
    for (let i = 0; i < 64 && !released; i++) {
      listener!({ type: 'data', bytesBase64: chunk });
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(released).toBe(true);
    await res.body?.cancel().catch(() => undefined);
  });

  it('an upstream `end` closes the viewer stream without an exit frame', async () => {
    const upstream: WorkspaceUpstream = {
      ...createFakeUpstream('normal'),
      subscribeTerminalOutput: (_id, l) => {
        l({ type: 'snapshot', bytesBase64: b64('kept') });
        setTimeout(() => l({ type: 'end', reason: 'gone' }), 10);
        return () => undefined;
      },
    };
    const out = await readOutput(buildServer({ upstream }), 'x', () => false);
    const { text, events } = await out.next();
    expect(events).toEqual(['snapshot']);
    expect(text).toBe('kept');
  });
});
