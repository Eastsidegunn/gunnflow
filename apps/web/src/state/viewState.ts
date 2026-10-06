/**
 * WorkspaceViewState — zoom, pan, and local node position overrides.
 * Local-only presentation state: moving a node here changes NO topology meaning
 * (charter §32: visual layout move ≠ semantic rewire).
 */
import { createSignal } from 'solid-js';

export interface Camera {
  x: number; // world coord at viewport centre
  y: number;
  zoom: number;
}

export function createViewState() {
  const [camera, setCamera] = createSignal<Camera>({ x: 0, y: 0, zoom: 1 });
  const [positions, setPositions] = createSignal<ReadonlyMap<string, { x: number; y: number }>>(
    new Map(),
  );
  /** Whether the user has panned, zoomed or dragged; automatic framing stops once they have. */
  const [userMoved, setUserMoved] = createSignal(false);
  /**
   * P4 seam (dynamic-view): the received-field sort key the person picks in the
   * sort UI. Local-only view input; changing it is a geometry TRANSITION MOMENT
   * (the canvas already gates on it — see canvas/space.ts transitionCause).
   * Until the P4 sort UI lands, nothing writes it.
   */
  const [sortKey, setSortKey] = createSignal<string | null>(null);

  return {
    camera,
    positions,
    userMoved,
    sortKey,
    setSortKey,
    panBy(dx: number, dy: number) {
      setUserMoved(true);
      const c = camera();
      setCamera({ ...c, x: c.x - dx / c.zoom, y: c.y - dy / c.zoom });
    },
    zoomAt(factor: number, min = 0.15, max = 2.5) {
      setUserMoved(true);
      const c = camera();
      const zoom = Math.min(max, Math.max(min, c.zoom * factor));
      setCamera({ ...c, zoom });
    },
    reset() {
      setCamera({ x: 0, y: 0, zoom: 1 });
    },
    centerOn(x: number, y: number) {
      const c = camera();
      setCamera({ ...c, x, y });
    },
    /** Frame a whole bounds: centre + the zoom that fits it (never above 1 — fit zooms out, not in). */
    fitBounds(bounds: { x: number; y: number; w: number; h: number }, viewW: number, viewH: number, margin = 48, min = 0.15) {
      const zoom = Math.max(min, Math.min(1, (viewW - margin * 2) / Math.max(1, bounds.w), (viewH - margin * 2) / Math.max(1, bounds.h)));
      setCamera({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, zoom });
    },
    /** Visual layout move — local only, never relayed, never a topology change. */
    moveNode(id: string, x: number, y: number) {
      setUserMoved(true);
      const next = new Map(positions());
      next.set(id, { x, y });
      setPositions(next);
    },
  };
}

export type ViewState = ReturnType<typeof createViewState>;
