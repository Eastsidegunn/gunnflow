/**
 * Personal mermaid diagrams: the person's own sources, rendered by the same
 * render port as artifacts but bound to no artifact. Keyed by the sha256 of
 * the source (same source, same SVG — never re-rendered). The BFF renders on
 * request; the isolated origin serves the SVG by hash. Nothing goes upstream.
 */
import { createHash } from 'node:crypto';
import { cachedRenderer, type MermaidRenderer, type RenderResult } from './mermaidRender.js';

export const PERSONAL_SOURCE_MAX_CHARS = 20_000;

export function createPersonalRenders(render: MermaidRenderer | undefined, max = 256) {
  const cache = render ? cachedRenderer(render, max) : null;
  const svgs = new Map<string, string>();
  return {
    async render(source: string): Promise<{ hash: string; result: RenderResult }> {
      const hash = createHash('sha256').update(source, 'utf8').digest('hex');
      if (!cache) return { hash, result: { ok: false, reason: 'no mermaid renderer configured', cacheable: false } };
      const result = await cache.render(hash, source);
      if (result.ok) {
        svgs.set(hash, result.svg);
        if (svgs.size > max) svgs.delete(svgs.keys().next().value!);
      }
      return { hash, result };
    },
    /** The SVG for a rendered source hash, if this process rendered it. */
    svg: (hash: string) => svgs.get(hash),
  };
}

export type PersonalRenders = ReturnType<typeof createPersonalRenders>;
