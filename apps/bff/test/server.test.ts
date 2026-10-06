import { describe, expect, it } from 'vitest';
import { createFakeUpstream, normalFixture } from '@gunnflow-testing/fake-contracts';
import { buildServer, findCredentialShapedKey } from '../src/server.js';
import { DEFAULT_WEB_ORIGIN, buildPreviewServer, PREVIEW_CSP } from '../src/preview-server.js';
import { SIMULATOR_MODULE, loadUpstream } from '../src/composition.js';

function makeApp() {
  const fake = createFakeUpstream('normal');
  const app = buildServer({ upstream: fake, loadFixture: (n) => fake.loadFixture(n as never) });
  return { app, fake };
}

describe('BFF transport', () => {
  it('stream route carries resync/append verbatim with seq ids; Last-Event-ID resumes', async () => {
    const { app, fake } = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const read = async (headers: Record<string, string>, until: (b: string) => boolean) => {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/stream/s-184/pty-s-184`, {
        headers,
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!until(buffer)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      controller.abort();
      return buffer;
    };
    try {
      const first = await read({}, (b) => b.includes('"type":"resync"'));
      expect(first).toContain('id: 10\nevent: stream');
      fake.burstPty('s-184', 2);
      const resumed = await read({ 'last-event-id': '10' }, (b) => b.includes('output line 2'));
      expect(resumed).toContain('"type":"append"');
      expect(resumed).not.toContain('"type":"resync"');
      expect(resumed).toContain('id: 12\n');
      // A seq the upstream can no longer resume from → resync bundle.
      fake.gapStream('s-184', 3);
      const after = await read({ 'last-event-id': '11' }, (b) => b.includes('"type":"resync"'));
      expect(after).toContain('"type":"resync"');
    } finally {
      await app.close();
    }
  });

  it('SSE stream opens with a snapshot, then tails coalesced projections', async () => {
    const { app, fake } = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/workspace/stream`, {
        signal: controller.signal,
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const readUntil = async (marker: string) => {
        while (!buffer.includes(marker)) {
          const { value, done } = await reader.read();
          if (done) throw new Error('stream closed early');
          buffer += decoder.decode(value, { stream: true });
        }
      };
      await readUntil('event: snapshot');
      expect(buffer).toContain('"revision"');
      // A burst of upstream updates must arrive coalesced as a projection event.
      await fake.relayIntent({ nodeId: 'workspace', action: 'mission.create', decision: { text: 'B1' }, idempotencyKey: 'b1' }, 'test');
      await fake.relayIntent({ nodeId: 'workspace', action: 'mission.create', decision: { text: 'B2' }, idempotencyKey: 'b2' }, 'test');
      await readUntil('event: projection');
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it('relays an intent and returns upstream acceptance (202)', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/intent',
      payload: { nodeId: 'workspace', action: 'mission.create', decision: { text: 'From test' }, idempotencyKey: 'k-from-test' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(true);
    await app.close();
  });

  it('returns upstream rejection verbatim (409) without inventing reasons', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/intent',
      payload: { nodeId: 't-draft', action: 'edge.rewire', decision: { option: 'reject-me' }, idempotencyKey: 'k-reject' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toContain('upstream rejected');
    await app.close();
  });

  it('G2: rejects credential-shaped payloads at the door', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/intent',
      payload: { nodeId: 'workspace', action: 'mission.create', decision: { text: 'x' }, idempotencyKey: 'k', config: { apiKey: 'sk-123' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('credential');
    await app.close();
  });

  it('credential detector walks nested shapes', () => {
    expect(findCredentialShapedKey({ a: [{ b: { token: 'x' } }] })).toBe('a[0].b.token');
    expect(findCredentialShapedKey({ intent: 'mission.create', name: 'ok' })).toBeNull();
  });

  it('composition root: fake by default; the simulator is loaded by its alias and must expose test controls', async () => {
    const loaded = await loadUpstream({});
    expect(loaded.fake).not.toBeNull();
    expect(loaded.label).toBe('fake');

    const imported: string[] = [];
    const deps = (mod: unknown) => ({ importModule: async (n: string) => (imported.push(n), mod) });
    await loadUpstream({ GUNNFLOW_UPSTREAM: 'fake', GUNNFLOW_UPSTREAM_URL: 'http://ignored' }, deps({
      createUpstream: async (options: unknown) => {
        expect(options).toEqual({});
        return createFakeUpstream('empty');
      },
    }));
    expect(imported).toEqual([SIMULATOR_MODULE]);
    const { loadFixture: _drop, ...noControls } = createFakeUpstream('empty');
    await expect(loadUpstream({}, deps({ createUpstream: async () => noControls }))).rejects.toThrow(/test controls/);
    await expect(loadUpstream({}, deps({}))).rejects.toThrow(/createUpstream/);
  });

  it('composition root refuses anything but fake or direct, before loading anything', async () => {
    const imported: string[] = [];
    const deps = { importModule: async (n: string) => (imported.push(n), {}) };
    for (const name of ['node:child_process', '../../evil.js', './direct-upstream.js', 'Direct', 'FAKE', 'file:///tmp/x.mjs', '@gunnflow-testing/fake-contracts', 'some-backend', '']) {
      await expect(loadUpstream({ GUNNFLOW_UPSTREAM: name }, deps), name).rejects.toThrow(/refusing/);
    }
    expect(imported).toEqual([]);
  });
});

describe('node detail route', () => {
  it('carries upstream detail verbatim (200) and absence of detail as 404', async () => {
    const fake = createFakeUpstream('attention');
    const app = buildServer({ upstream: fake });
    const ok = await app.inject({ method: 'GET', url: '/api/node/g-publish/detail' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(await fake.nodeDetail!('g-publish'));
    expect(ok.json().items).toContainEqual({ label: 'recommendation', text: 'Approve after reviewing the evidence.' });
    const none = await app.inject({ method: 'GET', url: '/api/node/t-draft/detail' });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({ reason: 'no detail for this node' });
    await app.close();
  });

  it('an upstream without the surface answers 501, stated — never an empty normal answer', async () => {
    const fake = createFakeUpstream('normal');
    const app = buildServer({ upstream: { ...fake, nodeDetail: undefined } });
    const res = await app.inject({ method: 'GET', url: '/api/node/t-build/detail' });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ reason: 'detail is not served by this upstream' });
    await app.close();
  });

  it('a detail that fails the contract check is cut at 502, not carried', async () => {
    const fake = createFakeUpstream('normal');
    const broken = { revision: 1, items: [{ label: '', text: 'x' }] };
    const app = buildServer({ upstream: { ...fake, nodeDetail: async () => broken } });
    const res = await app.inject({ method: 'GET', url: '/api/node/t-build/detail' });
    expect(res.statusCode).toBe(502);
    expect(res.json().reason).toContain('label');
    await app.close();
  });
});

describe('unsupported upstream surfaces', () => {
  it('stream and terminal routes answer 501 with the upstream reason instead of hanging open', async () => {
    const fake = createFakeUpstream('normal');
    const upstream = {
      ...fake,
      terminalSnapshot: () => ({ unsupported: 'terminal not provided (test)' }),
      subscribeTerminal: () => ({ unsupported: 'terminal not provided (test)' }),
      subscribeStream: () => ({ unsupported: 'no stream contract (test)' }),
    };
    const app = buildServer({ upstream });
    const stream = await app.inject({ method: 'GET', url: '/api/stream/s-184/pty-s-184' });
    expect(stream.statusCode).toBe(501);
    expect(stream.json()).toEqual({ unsupported: 'no stream contract (test)' });
    const terminal = await app.inject({ method: 'GET', url: '/api/terminal/s-184/stream' });
    expect(terminal.statusCode).toBe(501);
    expect(terminal.json()).toEqual({ unsupported: 'terminal not provided (test)' });
    await app.close();
  });
});

describe('isolated preview origin (G1)', () => {
  it('serves artifact bytes only at their digest address, to the web origin only', async () => {
    const { createHash } = await import('node:crypto');
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    const bytes = new TextEncoder().encode('<h1>report</h1>');
    const digest = sha(bytes);
    const other = 'f'.repeat(64);
    const exoticBytes = new TextEncoder().encode('opaque');
    const store: Record<string, { mediaType: string; bytes: Uint8Array }> = {
      [`ok/${digest}`]: { mediaType: 'text/html', bytes },
      // An upstream answering an address with the wrong bytes.
      [`tampered/${other}`]: { mediaType: 'text/html', bytes },
      [`exotic/${sha(exoticBytes)}`]: { mediaType: 'application/x-thing', bytes: exoticBytes },
    };
    const app = buildPreviewServer({ artifactSnapshot: (id, d) => store[`${id}/${d}`] }, { webOrigin: 'http://web.test' });
    const ok = await app.inject({ method: 'GET', url: `/artifact/ok/${digest}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-gunnflow-digest']).toBe(digest);
    expect(ok.headers['access-control-allow-origin']).toBe('http://web.test');
    expect(ok.headers['content-security-policy']).toBe(PREVIEW_CSP);
    expect(ok.headers['content-type']).toContain('text/html');
    expect(ok.headers['content-disposition']).toBeUndefined();
    expect(ok.body).toBe('<h1>report</h1>');
    const head = await app.inject({ method: 'HEAD', url: `/artifact/ok/${digest}` });
    expect(head.statusCode).toBe(200);
    expect(head.headers['x-gunnflow-digest']).toBe(digest);
    // No digest-less route, no "current version".
    expect((await app.inject({ method: 'GET', url: '/artifact/ok' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/artifact/ok?digest=${digest}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/artifact/ok/abc' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/artifact/ok/${other}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/artifact/tampered/${other}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/artifact/unknown/${digest}` })).statusCode).toBe(404);
    // Unrendered types: 415 unless a download is asked for; a download is an attachment of verified bytes only.
    expect((await app.inject({ method: 'GET', url: `/artifact/exotic/${sha(exoticBytes)}` })).statusCode).toBe(415);
    const dl = await app.inject({ method: 'GET', url: `/artifact/exotic/${sha(exoticBytes)}?download=1` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toBe('attachment');
    const failedDl = await app.inject({ method: 'GET', url: `/artifact/tampered/${other}?download=1` });
    expect(failedDl.statusCode).toBe(409);
    expect(failedDl.headers['content-disposition']).toBeUndefined();
    await app.close();
  });

  it('CORS defaults to the local web origin, never *', async () => {
    const app = buildPreviewServer({ artifactSnapshot: () => undefined });
    const res = await app.inject({ method: 'HEAD', url: `/artifact/x/${'a'.repeat(64)}` });
    expect(res.headers['access-control-allow-origin']).toBe(DEFAULT_WEB_ORIGIN);
    await app.close();
  });

  it('the simulator serves exactly the version it holds, by digest', () => {
    const fake = createFakeUpstream('normal');
    const ref = normalFixture().tasks.flatMap((t) => t.artifacts ?? []).find((a) => a.id === 'art-build-report')!;
    expect(fake.artifactSnapshot?.('art-build-report', ref.digest!)).toMatchObject({ mediaType: 'text/html' });
    expect(fake.artifactSnapshot?.('art-build-report', 'f'.repeat(64))).toBeUndefined();
    expect(fake.artifactSnapshot?.('nope', ref.digest!)).toBeUndefined();
  });

  it('serves previews only under a strict sandboxing CSP', async () => {
    const app = buildPreviewServer();
    const res = await app.inject({ method: 'GET', url: '/preview/d-report' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP);
    expect(PREVIEW_CSP).toContain('sandbox');
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    await app.close();
  });
});
