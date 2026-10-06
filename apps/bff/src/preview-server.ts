/**
 * Isolated preview origin (:8788). Agent-generated content is only ever served
 * from here — a separate origin from the workspace — under a strict CSP with
 * sandboxing. The workspace embeds it via a sandboxed iframe, never same-origin.
 *
 * Artifact bytes are addressed immutably by digest: `/artifact/:id/:digest`
 * serves exactly the bytes that hash to that digest, or nothing. There is no
 * "current version" route. Only the web origin may read responses
 * cross-origin (the viewer's HEAD check).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { DIAGRAM_MEDIA_TYPES } from '@gunnflow/contract/wiring';
import { cachedRenderer, type MermaidRenderer } from './mermaidRender.js';
import type { PersonalRenders } from './personalRender.js';

export const PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

export const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:5173';

/**
 * CSP of the isolated viewer pages: this origin's scripts only (no inline
 * script, no eval), no network beyond this origin, sandboxed to an opaque
 * origin with scripts allowed.
 */
export const VIEWER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

const BFF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Static viewer assets: our viewer code, the vendored Excalidraw bundle and its fonts. */
const ASSET_ROOTS: Record<string, string> = {
  '': join(BFF_ROOT, 'viewers'),
  'excalidraw/fonts': join(BFF_ROOT, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts'),
  excalidraw: join(BFF_ROOT, 'viewers', 'dist', 'excalidraw'),
};
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface PreviewSnapshot {
  mediaType: string;
  bytes: Uint8Array;
}

export interface PreviewSource {
  /** The bytes of this artifact version, if the upstream holds it. */
  artifactSnapshot(artifactId: string, digest: string): PreviewSnapshot | undefined | Promise<PreviewSnapshot | undefined>;
}

export interface PreviewOptions {
  /** The only origin allowed to read responses cross-origin. */
  webOrigin?: string;
  /** Mermaid → SVG renderer. None is built in; without one the route answers 503 with the reason. */
  renderMermaid?: MermaidRenderer;
  /** Personal diagrams the BFF rendered, served here by source hash. */
  personalRenders?: PersonalRenders;
}

/** Media types the isolated origin renders; markdown and plain text go out as plain text. */
const SERVED_TYPES: Record<string, string> = {
  'text/html': 'text/html; charset=utf-8',
  'image/svg+xml': 'image/svg+xml',
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'text/plain': 'text/plain; charset=utf-8',
  'text/markdown': 'text/plain; charset=utf-8',
  'text/vnd.mermaid': 'text/plain; charset=utf-8',
  'text/x-mermaid': 'text/plain; charset=utf-8',
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function buildPreviewServer(source?: PreviewSource, options: PreviewOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const webOrigin = options.webOrigin ?? DEFAULT_WEB_ORIGIN;

  const mermaid = options.renderMermaid ? cachedRenderer(options.renderMermaid) : null;

  app.addHook('onSend', async (_req, reply, payload) => {
    // Viewer pages set their own (script-allowing) policy; everything else gets the strict one.
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', PREVIEW_CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cross-origin-resource-policy', 'cross-origin');
    return payload;
  });

  app.get('/preview/:deliverableId', async (req, reply) => {
    const { deliverableId } = req.params as { deliverableId: string };
    reply.type('text/html');
    // Placeholder until the deliverable declaration event exists (BLOCKED.md #1).
    return `<!doctype html><html><body style="font-family:system-ui;color:#888;display:grid;place-items:center;height:100vh;margin:0">
<div>deliverable preview placeholder — ${escapeHtml(deliverableId)}<br/>(isolated origin, strict CSP, BLOCKED(contract))</div>
</body></html>`;
  });

  /** Data-carrying responses: readable by the web origin only, never cached, digest exposed. */
  const dataHeaders = (reply: FastifyReply) => {
    reply.header('access-control-allow-origin', webOrigin);
    reply.header('vary', 'origin');
    reply.header('access-control-expose-headers', 'x-gunnflow-digest, x-gunnflow-render-error');
    reply.header('cache-control', 'no-store');
  };
  /** The verified bytes at a digest address, or the error reply already sent. */
  const verified = async (reply: FastifyReply, artifactId: string | undefined, digest: string | undefined) => {
    if (!artifactId || !digest || !SHA256_HEX.test(digest)) {
      reply.code(400).type('text/plain').send('an artifact id and a sha256 hex digest are required');
      return null;
    }
    const snap = await source?.artifactSnapshot(artifactId, digest);
    if (!snap) {
      reply.code(404).type('text/plain').send('no bytes for this artifact version');
      return null;
    }
    if (createHash('sha256').update(snap.bytes).digest('hex') !== digest) {
      reply.code(409).type('text/plain').send('bytes do not match the addressed digest');
      return null;
    }
    reply.header('x-gunnflow-digest', digest);
    return snap;
  };

  app.get('/artifact/:artifactId/:digest', async (req, reply) => {
    const { artifactId, digest } = req.params as { artifactId: string; digest: string };
    const { download } = req.query as { download?: string };
    dataHeaders(reply);
    const snap = await verified(reply, artifactId, digest);
    if (!snap) return reply;
    // A download is asked for explicitly, and only verified bytes are offered.
    if (download === '1') {
      return reply.header('content-disposition', 'attachment').type('application/octet-stream').send(Buffer.from(snap.bytes));
    }
    const type = SERVED_TYPES[snap.mediaType];
    if (!type) return reply.code(415).type('text/plain').send(`media type ${snap.mediaType} is not rendered; ask for a download`);
    return reply.type(type).send(Buffer.from(snap.bytes));
  });

  // Mermaid → SVG, rendered here from verified bytes (cached by digest), shown by the web as <img>.
  app.get('/render/mermaid/:artifactId/:digest', async (req, reply) => {
    const { artifactId, digest } = req.params as { artifactId: string; digest: string };
    dataHeaders(reply);
    const snap = await verified(reply, artifactId, digest);
    if (!snap) return reply;
    if (!DIAGRAM_MEDIA_TYPES.mermaid.includes(snap.mediaType)) {
      return reply.code(415).type('text/plain').send(`media type ${snap.mediaType} is not a mermaid diagram`);
    }
    const failed = (why: string) =>
      reply.code(503).header('x-gunnflow-render-error', encodeURIComponent(why)).type('text/plain; charset=utf-8').send(why);
    if (!mermaid) return failed('no mermaid renderer configured');
    const result = await mermaid.render(digest, Buffer.from(snap.bytes).toString('utf8'));
    if (!result.ok) return failed(result.reason);
    return reply.type('image/svg+xml').send(result.svg);
  });

  // A personal diagram's SVG, by the hash of its source (rendered through the BFF). Shown as an image.
  app.get('/personal-render/:hash', async (req, reply) => {
    const { hash } = req.params as { hash: string };
    reply.header('cache-control', 'no-store');
    const svg = SHA256_HEX.test(hash) ? options.personalRenders?.svg(hash) : undefined;
    if (!svg) return reply.code(404).type('text/plain').send('not rendered (ask the BFF to render this source)');
    return reply.type('image/svg+xml').send(svg);
  });

  // Excalidraw scene, read-only: an isolated page with the verified scene embedded as data.
  app.get('/viewer/excalidraw', async (req, reply) => {
    const { id, digest } = req.query as { id?: string; digest?: string };
    dataHeaders(reply);
    const snap = await verified(reply, id, digest);
    if (!snap) return reply;
    if (!DIAGRAM_MEDIA_TYPES.excalidraw.includes(snap.mediaType)) {
      return reply.code(415).type('text/plain').send(`media type ${snap.mediaType} is not an Excalidraw scene`);
    }
    reply.header('content-security-policy', VIEWER_CSP);
    return reply.type('text/html; charset=utf-8').send(viewerPage('excalidraw', Buffer.from(snap.bytes).toString('utf8'), digest!));
  });

  // Static viewer code and vendored library files. Public code, no data: readable by any origin
  // (the sandboxed viewer pages have an opaque origin).
  app.get('/viewer-assets/*', async (req, reply) => {
    const rel = (req.params as { '*': string })['*'];
    const prefix = Object.keys(ASSET_ROOTS)
      .sort((a, b) => b.length - a.length)
      .find((k) => k === '' || rel.startsWith(`${k}/`));
    const base = ASSET_ROOTS[prefix ?? '']!;
    const file = resolve(base, prefix ? rel.slice(prefix.length + 1) : rel);
    const type = ASSET_TYPES[extname(file)];
    if (!type || !file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) {
      return reply.code(404).type('text/plain').send('no such viewer asset');
    }
    reply.header('access-control-allow-origin', '*');
    reply.header('cache-control', 'public, max-age=3600');
    return reply.type(type).send(readFileSync(file));
  });

  return app;
}

/** An isolated viewer page: the verified source travels as a JSON data island, never as markup or script. */
function viewerPage(kind: 'excalidraw', text: string, digest: string): string {
  const data = JSON.stringify(text).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en" data-digest="${escapeHtml(digest)}">
<head><meta charset="utf-8"><title>${kind} viewer</title>
<style>html,body{margin:0;height:100%;background:#fff;font-family:system-ui,sans-serif}#stage{position:fixed;inset:0;overflow:hidden;cursor:grab}#content{display:inline-block}#status{position:fixed;left:8px;top:8px;font-size:12px;color:#555}#status[data-state=error]{color:#b00020;white-space:pre-wrap}</style>
</head>
<body data-rendered="pending">
<div id="stage"><div id="content"></div></div>
<div id="status">rendering…</div>
<script type="application/json" id="gunnflow-source">${data}</script>
<script type="module" src="/viewer-assets/${kind}/${kind}-viewer.js"></script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
