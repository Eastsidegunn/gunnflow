/**
 * Inbox-aside camera framing (결정함 F2) — pure, view status only. While the
 * decision inbox covers the right of the screen, the canvas frames the
 * selected item in the part still visible: the node, its nearest container
 * (the layout's own parent map) and the nodes one received relation away.
 * Nothing is hidden or added — only the camera moves, and closing the inbox
 * puts back the camera the person had.
 */
import type { NodeProjection } from '@gunnflow/contract';
import type { Camera } from './viewState.js';

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The ids to keep in view for `id`: itself, its nearest container, and its
 * direct neighbours over received relations (both directions). Relations
 * that only express containment are left to the nearest container, so a far
 * ancestor box never drags the frame wide.
 */
export function frameIds(
  nodes: readonly NodeProjection[],
  id: string,
  parentOf: ReadonlyMap<string, string> | undefined,
  isContain: (relationType: string) => boolean,
): string[] {
  const self = nodes.find((n) => n.id === id);
  if (!self) return [];
  const out = new Set<string>([id]);
  const parent = parentOf?.get(id);
  if (parent !== undefined) out.add(parent);
  for (const r of self.relations) if (!isContain(r.type)) out.add(r.target);
  for (const n of nodes) {
    if (n.id === id) continue;
    if (n.relations.some((r) => r.target === id && !isContain(r.type))) out.add(n.id);
  }
  return [...out];
}

/** The bounding rect of the given rects; null when there are none. */
export function unionRect(rects: readonly FrameRect[]): FrameRect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface AsideViewport {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Width of the canvas part left of the drawer (from the canvas's left edge). */
  visibleWidth: number;
}

/**
 * The camera that fits `bounds` into the visible part of the canvas: centred
 * there, zoomed to fit with a margin — never above 1 (framing zooms out, not
 * in) and never below `minZoom`. The camera's (x, y) is the world point at
 * the CANVAS centre, so the centre shifts by the hidden part.
 */
export function asideCamera(bounds: FrameRect, view: AsideViewport, margin = 40, minZoom = 0.15): Camera {
  const visW = Math.max(1, Math.min(view.width, view.visibleWidth));
  const zoom = Math.max(
    minZoom,
    Math.min(1, (visW - margin * 2) / Math.max(1, bounds.w), (view.height - margin * 2) / Math.max(1, bounds.h)),
  );
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return { x: cx - (visW / 2 - view.width / 2) / zoom, y: cy, zoom };
}

/** Linear camera interpolation (the eased fraction comes from the caller). */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, zoom: a.zoom + (b.zoom - a.zoom) * t };
}
