/**
 * Shared layout shapes and bounds. Layout EXPLAINS received topology; it never
 * defines it (charter §9, §18). The positions themselves come from the layout
 * port (layoutGraph/elkLayout) — the old domain-collection layout is retired.
 */

export interface NodeBox {
  id: string;
  /** The opaque NodeProjection kind. */
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MissionBox {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WorkspaceLayout {
  nodes: Map<string, NodeBox>;
  missions: MissionBox[];
}

export function layoutBounds(layout: WorkspaceLayout): { x: number; y: number; w: number; h: number } | null {
  if (layout.missions.length === 0 && layout.nodes.size === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const extend = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  };
  for (const m of layout.missions) extend(m.x, m.y, m.w, m.h);
  for (const n of layout.nodes.values()) extend(n.x, n.y, n.w, n.h);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
