// The mermaid render PORT (no renderer is built in): digest-keyed cache,
// explicit-unsupported honesty, and the isolated Excalidraw viewer page.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPreviewServer, PREVIEW_CSP, VIEWER_CSP, type PreviewSnapshot } from '../src/preview-server.js';
import { cachedRenderer, type MermaidRenderer } from '../src/mermaidRender.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

describe('mermaid render cache (the port)', () => {
  it('caches by digest: same bytes are never re-rendered; concurrent requests share one render; transient failures are retried', async () => {
    let n = 0;
    const cache = cachedRenderer(async () => (n++, { ok: true, svg: SVG }));
    await Promise.all([cache.render('d1', 'a'), cache.render('d1', 'a'), cache.render('d1', 'a')]);
    await cache.render('d1', 'a');
    expect(n).toBe(1);
    await cache.render('d2', 'b');
    expect(n).toBe(2);
    let m = 0;
    const flaky = cachedRenderer(async () => (m++, { ok: false, reason: 'renderer timed out', cacheable: false }));
    await flaky.render('d', 'x');
    await flaky.render('d', 'x');
    expect(m).toBe(2);
  });
});

describe('isolated origin: /render/mermaid and /viewer/excalidraw', () => {
  const bytes = (t: string) => new TextEncoder().encode(t);
  const erd = bytes('erDiagram\n  A ||--o{ B : has\n');
  const scene = bytes(JSON.stringify({ type: 'excalidraw', elements: [], appState: {}, files: {}, note: '</script><script>alert(1)</script>' }));
  const json = bytes('{"type":"excalidraw","elements":[]}');
  const store = new Map<string, PreviewSnapshot>([
    [`erd/${sha(erd)}`, { mediaType: 'text/vnd.mermaid', bytes: erd }],
    [`scene/${sha(scene)}`, { mediaType: 'application/vnd.excalidraw+json', bytes: scene }],
    [`json/${sha(json)}`, { mediaType: 'application/json', bytes: json }],
  ]);
  const source = { artifactSnapshot: (id: string, d: string) => store.get(`${id}/${d}`) };

  it('serves the SVG of verified mermaid bytes (cached by digest) with the source digest, under the strict CSP', async () => {
    let renders = 0;
    const render: MermaidRenderer = async () => (renders++, { ok: true, svg: SVG });
    const app = buildPreviewServer(source, { webOrigin: 'http://web.test', renderMermaid: render });
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'GET', url: `/render/mermaid/erd/${sha(erd)}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/svg+xml');
      expect(res.headers['x-gunnflow-digest']).toBe(sha(erd));
      expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP);
      expect(res.headers['access-control-allow-origin']).toBe('http://web.test');
    }
    expect(renders).toBe(1);
    expect((await app.inject({ method: 'GET', url: `/render/mermaid/erd/${'f'.repeat(64)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/render/mermaid/json/${sha(json)}` })).statusCode).toBe(415);
    await app.close();
  });

  it('a failed or missing renderer answers 503 with the reason (the viewer then shows the source as text)', async () => {
    const failing = buildPreviewServer(source, { renderMermaid: async () => ({ ok: false, reason: 'parse error: line 2', cacheable: true }) });
    const res = await failing.inject({ method: 'GET', url: `/render/mermaid/erd/${sha(erd)}` });
    expect(res.statusCode).toBe(503);
    expect(decodeURIComponent(res.headers['x-gunnflow-render-error'] as string)).toBe('parse error: line 2');
    expect(res.headers['access-control-expose-headers']).toContain('x-gunnflow-render-error');
    await failing.close();
    const none = buildPreviewServer(source);
    expect((await none.inject({ method: 'GET', url: `/render/mermaid/erd/${sha(erd)}` })).statusCode).toBe(503);
    // The source itself is readable as plain text for the fallback.
    const text = await none.inject({ method: 'GET', url: `/artifact/erd/${sha(erd)}` });
    expect(text.headers['content-type']).toContain('text/plain');
    await none.close();
  });

  it('the Excalidraw page embeds the verified scene as inert data under the viewer CSP; generic JSON is refused', async () => {
    const app = buildPreviewServer(source);
    const res = await app.inject({ method: 'GET', url: `/viewer/excalidraw?id=scene&digest=${sha(scene)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(VIEWER_CSP);
    expect(VIEWER_CSP).toContain("script-src 'self'");
    expect(VIEWER_CSP).not.toContain('unsafe-eval');
    expect(VIEWER_CSP).toContain('sandbox allow-scripts');
    expect(VIEWER_CSP).not.toContain('allow-same-origin');
    expect(res.headers['x-gunnflow-digest']).toBe(sha(scene));
    expect(res.body).toContain('<script type="application/json" id="gunnflow-source">');
    expect(res.body.match(/<script/g)).toHaveLength(2);
    expect(res.body).not.toContain('</script><script>alert(1)');
    expect(res.body).toContain('/viewer-assets/excalidraw/excalidraw-viewer.js');
    expect((await app.inject({ method: 'GET', url: `/viewer/excalidraw?id=json&digest=${sha(json)}` })).statusCode).toBe(415);
    expect((await app.inject({ method: 'GET', url: `/viewer/excalidraw?id=scene&digest=${'0'.repeat(64)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/viewer/excalidraw' })).statusCode).toBe(400);
    await app.close();
  });

  it('viewer assets: public library code only, no path escape, no source files', async () => {
    const app = buildPreviewServer(source);
    const js = await app.inject({ method: 'GET', url: '/viewer-assets/panzoom.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    expect(js.headers['access-control-allow-origin']).toBe('*');
    const font = await app.inject({ method: 'GET', url: '/viewer-assets/excalidraw/fonts/Virgil/Virgil-Regular.woff2' });
    expect(font.statusCode).toBe(200);
    for (const bad of ['/viewer-assets/../package.json', '/viewer-assets/%2e%2e/src/main.ts', '/viewer-assets/excalidraw-viewer.ts', '/viewer-assets/excalidraw/fonts/../../../../package.json']) {
      expect((await app.inject({ method: 'GET', url: bad })).statusCode, bad).toBe(404);
    }
    await app.close();
  });
});
