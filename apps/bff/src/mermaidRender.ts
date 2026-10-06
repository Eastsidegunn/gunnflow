/**
 * The mermaid render PORT: the shape a renderer must have and a digest-keyed
 * cache over one. No renderer is built in — the cockpit does not depend on
 * any local drawing tool. Without one, every mermaid surface answers
 * "unavailable" with its reason (explicitly unsupported, never an empty frame).
 */

export type RenderResult = { ok: true; svg: string } | { ok: false; reason: string; cacheable: boolean };
export type MermaidRenderer = (source: string) => Promise<RenderResult>;

export const RENDER_TIMEOUT_MS = 10_000;
const MAX_SVG_BYTES = 8 * 1024 * 1024;

export function cachedRenderer(render: MermaidRenderer, max = 256) {
  const done = new Map<string, RenderResult>();
  const running = new Map<string, Promise<RenderResult>>();
  let renders = 0;
  return {
    get renders() {
      return renders;
    },
    async render(digest: string, source: string): Promise<RenderResult> {
      const hit = done.get(digest);
      if (hit) return hit;
      const inflight = running.get(digest);
      if (inflight) return inflight;
      renders++;
      const p = render(source).then((r) => {
        running.delete(digest);
        if (r.ok || r.cacheable) {
          done.set(digest, r);
          if (done.size > max) done.delete(done.keys().next().value!);
        }
        return r;
      });
      running.set(digest, p);
      return p;
    },
  };
}
