/**
 * Rendered personal diagrams: mermaid sources → SVG images served by the
 * isolated origin (drawn into the canvas as images, which run no script).
 * Keyed by source text; a failure keeps its reason so the sticky shows it
 * with the source as plain text.
 */
import { createSignal } from 'solid-js';
import { renderPersonalMermaid, type PersonalRender } from './client.js';

export type DiagramEntry =
  | { state: 'pending' }
  | { state: 'ok'; src: string; image: HTMLImageElement | null; width: number; height: number }
  | { state: 'error'; reason: string };

export function createDiagramCache(previewOrigin: string, render: (source: string) => Promise<PersonalRender> = renderPersonalMermaid) {
  const entries = new Map<string, DiagramEntry>();
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);
  return {
    /** Changes whenever an entry settles (redraw trigger). */
    version,
    get(source: string): DiagramEntry {
      const hit = entries.get(source);
      if (hit) return hit;
      entries.set(source, { state: 'pending' });
      if (entries.size > 200) entries.delete(entries.keys().next().value!);
      void render(source).then((r) => {
        if (!r.ok) {
          entries.set(source, { state: 'error', reason: r.reason });
          return bump();
        }
        const src = `${previewOrigin}${r.svgPath}`;
        if (typeof Image === 'undefined') {
          entries.set(source, { state: 'ok', src, image: null, width: 0, height: 0 });
          return bump();
        }
        const image = new Image();
        image.onload = () => {
          entries.set(source, { state: 'ok', src, image, width: image.naturalWidth, height: image.naturalHeight });
          bump();
        };
        image.onerror = () => {
          entries.set(source, { state: 'error', reason: 'the rendered SVG could not be loaded' });
          bump();
        };
        image.src = src;
      });
      return entries.get(source)!;
    },
  };
}

export type DiagramCache = ReturnType<typeof createDiagramCache>;
