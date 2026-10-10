/**
 * Node shapes (GF-P1b D) — how a kind's nodes are outlined and how much room
 * they take. Pure presentation: the wiring config attaches a shape and a size
 * factor to a kind; the engine never derives a shape from what a kind means,
 * and a shape says nothing about state, risk or priority.
 *
 * A leaf's box is the shape plus, for shapes too small to hold a title, a
 * label strip beside it (decision D-4a): spacing, drops and hit tests all use
 * the whole box, edges attach to the shape. Shapes never change with zoom;
 * only the box's size follows the relevance tier like any node.
 */
import { kindShape, type ShapeId, type WiringConfig } from '@gunnflow/contract/wiring';
import { DEFAULT_THEME } from '../theme/defaultTheme.js';

export type LeafShape = Exclude<ShapeId, 'band'>;
type Size = { w: number; h: number };
type Rect = { x: number; y: number; w: number; h: number };

const NODE = DEFAULT_THEME.geometry.node;

/** Each leaf shape's own outline at size factor 1 (theme geometry: the rect is the classic node). */
export const SHAPE_SIZE: Readonly<Record<LeafShape, Size>> = {
  rect: { w: NODE.w, h: NODE.h },
  pill: { w: NODE.w, h: 56 },
  circle: { w: 56, h: 56 },
  diamond: { w: 112, h: 112 },
  hexagon: { w: 168, h: 96 },
};

/** Room for the title beside a shape that cannot hold it (world units at size factor 1). */
export const LABEL_ROOM = 132;
/** The gap between such a shape and its label. */
const LABEL_GAP = 8;

/** Shapes whose title is written beside them rather than inside (D-4a). */
export function labelBeside(shape: LeafShape): boolean {
  return shape === 'circle';
}

/** A leaf kind's drawn shape: 'band' is a container shape, so a leaf declared 'band' is a rect. */
export function leafShapeOf(config: WiringConfig, kind: string): { shape: LeafShape; size: number } {
  const { shape, size } = kindShape(config, kind);
  return { shape: shape === 'band' ? 'rect' : shape, size };
}

/** Whether a container kind is drawn and packed as a wide band. */
export function isBand(config: WiringConfig, kind: string): boolean {
  return kindShape(config, kind).shape === 'band';
}

/** A leaf's base box (tier 1): its shape at the size factor, plus the label room for label-beside shapes. */
export function leafBaseSize(config: WiringConfig, kind: string): Size {
  const { shape, size } = leafShapeOf(config, kind);
  const s = SHAPE_SIZE[shape];
  const w = s.w * size + (labelBeside(shape) ? LABEL_ROOM * size : 0);
  return { w: Math.round(w), h: Math.round(s.h * size) };
}

/** The part of a leaf's box the shape occupies (the rest, if any, is its label strip). */
export function shapeRect(shape: LeafShape, box: Rect): Rect {
  if (!labelBeside(shape)) return box;
  const k = box.h / SHAPE_SIZE[shape].h;
  return { x: box.x, y: box.y, w: SHAPE_SIZE[shape].w * k, h: box.h };
}

/** Where a label-beside shape's title starts (left edge of the label strip). */
export function labelX(shape: LeafShape, box: Rect): number {
  const r = shapeRect(shape, box);
  return r.x + r.w + LABEL_GAP;
}

/** Traces a shape's outline into `r` (the caller fills/strokes). */
export function tracePath(ctx: CanvasRenderingContext2D, shape: LeafShape, r: Rect, radius = 10): void {
  const { x, y, w, h } = r;
  ctx.beginPath();
  switch (shape) {
    case 'circle':
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'diamond':
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w / 2, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      break;
    case 'hexagon': {
      const k = Math.min(w / 4, h / 2);
      ctx.moveTo(x + k, y);
      ctx.lineTo(x + w - k, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w - k, y + h);
      ctx.lineTo(x + k, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      break;
    }
    case 'pill':
      roundedRect(ctx, x, y, w, h, h / 2);
      break;
    default:
      roundedRect(ctx, x, y, w, h, radius);
  }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** The same rect grown by `d` on every side (selection rings, ghost outlines). */
export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/**
 * Hit test for a leaf: inside its outline, or on its title strip beside a
 * small shape (the title is part of the node — clicking it selects). A pointer
 * in the corner of a diamond's, circle's or pill's box is empty canvas.
 */
export function hitsLeaf(shape: LeafShape, box: Rect, px: number, py: number): boolean {
  if (px < box.x || px > box.x + box.w || py < box.y || py > box.y + box.h) return false;
  const r = shapeRect(shape, box);
  if (px > r.x + r.w) return true; // the label strip
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = Math.abs(px - cx) / (r.w / 2);
  const dy = Math.abs(py - cy) / (r.h / 2);
  switch (shape) {
    case 'circle':
      return dx * dx + dy * dy <= 1;
    case 'diamond':
      return dx + dy <= 1;
    case 'hexagon': {
      const k = Math.min(r.w / 4, r.h / 2) / (r.w / 2);
      return dx <= 1 - k * dy;
    }
    case 'pill': {
      // A capsule: the straight middle, or within the end caps' circles.
      const rr = Math.min(r.w, r.h) / 2;
      const ex = Math.max(r.x + rr, Math.min(r.x + r.w - rr, px));
      return (px - ex) ** 2 + (py - cy) ** 2 <= rr * rr;
    }
    default:
      return true;
  }
}
