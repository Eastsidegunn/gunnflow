// WP-N: the BFF's personal route — plain local file read/write, structure
// checks only, never overwriting an unreadable file, nothing upstream.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFakeUpstream } from '@gunnflow-testing/fake-contracts';
import { buildServer } from '../src/server.js';
import { PERSONAL_MAX_BYTES, workspaceKey } from '../src/personalStore.js';
import { parseConfig } from '../src/config.js';
import { createPersonalRenders } from '../src/personalRender.js';
import { buildPreviewServer } from '../src/preview-server.js';

const doc = { version: 1, notes: { 't-build': { text: 'mine', updatedAt: new Date(0).toISOString() } }, stickies: [] };

describe('personal store route', () => {
  it('round-trips through the file; a fresh server (restart) reads what the last one wrote; nothing goes upstream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gunnflow-personal-'));
    try {
      const file = join(dir, 'nested', 'fake.json');
      const upstream = createFakeUpstream('normal');
      const relay = vi.spyOn(upstream, 'relayIntent');
      const a = buildServer({ upstream, personalFile: file });
      expect((await a.inject({ method: 'GET', url: '/api/personal' })).json()).toEqual({ doc: null });
      expect((await a.inject({ method: 'PUT', url: '/api/personal', payload: doc })).json()).toEqual({ saved: true });
      await a.close();
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(doc);
      const b = buildServer({ upstream: createFakeUpstream('normal'), personalFile: file });
      expect((await b.inject({ method: 'GET', url: '/api/personal' })).json()).toEqual({ doc });
      await b.close();
      expect(relay).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks structure only, refuses oversize, and never overwrites an unreadable file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gunnflow-personal-'));
    try {
      const file = join(dir, 'w.json');
      const app = buildServer({ upstream: createFakeUpstream('normal'), personalFile: file });
      for (const bad of [[1, 2], { notes: {} }, 'text']) {
        expect((await app.inject({ method: 'PUT', url: '/api/personal', payload: JSON.stringify(bad), headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
      }
      const big = { version: 1, pad: 'x'.repeat(PERSONAL_MAX_BYTES) };
      expect((await app.inject({ method: 'PUT', url: '/api/personal', payload: big })).statusCode).toBe(400);
      writeFileSync(file, '{ corrupted');
      expect((await app.inject({ method: 'GET', url: '/api/personal' })).statusCode).toBe(409);
      expect((await app.inject({ method: 'PUT', url: '/api/personal', payload: doc })).statusCode).toBe(409);
      expect(readFileSync(file, 'utf8')).toBe('{ corrupted');
      await app.close();
      const none = buildServer({ upstream: createFakeUpstream('normal') });
      expect((await none.inject({ method: 'GET', url: '/api/personal' })).statusCode).toBe(501);
      await none.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('one file per workspace, named from the upstream; the directory is configurable', () => {
    expect(workspaceKey('fake')).toBe('fake');
    expect(workspaceKey('direct → http://backend.test:9000')).toBe('direct-backend.test-9000');
    expect(workspaceKey('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(workspaceKey('')).toBe('workspace');
    expect(parseConfig({ personalDir: '/tmp/p' })).toEqual({ personalDir: '/tmp/p' });
  });
});

describe('personal mermaid rendering', () => {
  it('renders a personal source by content hash (cached), served as SVG by the isolated origin; failures carry their reason', async () => {
    let calls = 0;
    const renders = createPersonalRenders(async (src) =>
      (calls++, src.includes('bad') ? { ok: false, reason: 'parse error at 1:1', cacheable: true } : { ok: true, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }),
    );
    const bff = buildServer({ upstream: createFakeUpstream('normal'), personalRenders: renders });
    const preview = buildPreviewServer(undefined, { personalRenders: renders });
    const source = 'erDiagram\n  A ||--o{ B : has\n';
    const first = await bff.inject({ method: 'POST', url: '/api/personal/render-mermaid', payload: { source } });
    const { hash, svgPath } = first.json() as { hash: string; svgPath: string };
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(svgPath).toBe(`/personal-render/${hash}`);
    await bff.inject({ method: 'POST', url: '/api/personal/render-mermaid', payload: { source } });
    expect(calls).toBe(1);
    const svg = await preview.inject({ method: 'GET', url: svgPath });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await preview.inject({ method: 'GET', url: `/personal-render/${'0'.repeat(64)}` })).statusCode).toBe(404);
    const bad = await bff.inject({ method: 'POST', url: '/api/personal/render-mermaid', payload: { source: 'bad' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ reason: 'parse error at 1:1' });
    expect((await bff.inject({ method: 'POST', url: '/api/personal/render-mermaid', payload: { source: '' } })).statusCode).toBe(400);
    const none = buildServer({ upstream: createFakeUpstream('normal') });
    expect((await none.inject({ method: 'POST', url: '/api/personal/render-mermaid', payload: { source } })).statusCode).toBe(503);
    await Promise.all([bff.close(), preview.close(), none.close()]);
  });
});
