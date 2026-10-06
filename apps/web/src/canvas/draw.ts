/**
 * Canvas painter (generic path only). Pure rendering of (scene × view × lens ×
 * selection × pending) — draws exactly what was received, nothing more. Text
 * goes to fillText verbatim; colours come from the theme preset and config
 * literals. The old domain painter is gone: every upstream speaks the contract.
 */
import { isSessionIntent } from '../model/types.js';
import type { WorkspaceLayout, NodeBox } from './layout.js';
import type { Camera } from '../state/viewState.js';
import type { Emphasis } from '../state/lens.js';
import type { InFlightEntry } from '../state/pendingIntents.js';
import { endpointBox, type GenericScene, type GroupBox, type SceneNode } from './genericScene.js';
import { ATTENTION_COLOR, CONFIG_EDGE_DASH, GROUP_STYLE, PENDING_DASH } from './tokens.js';
import { DEFAULT_THEME } from '../theme/defaultTheme.js';
import { detailOn, type Tier } from '../state/relevance.js';

/** What both render paths share: geometry, view, lens, selection, pending. */
interface Frame {
  layout: WorkspaceLayout;
  camera: Camera;
  emphasis: Map<string, Emphasis>;
  selectedId: string | null;
  focusAlpha: Map<string, number> | null;
  pending: readonly InFlightEntry[];
  rewireDrag: { fromId: string; toX: number; toY: number } | null;
  /** Edge endpoint geometry; defaults to the node boxes (the generic path adds group boxes). */
  boxOf?: (id: string) => NodeBox | undefined;
  /** Semantic-zoom threshold (a machine-local pref); detail lines appear at or above it. */
  detailZoom?: number;
  /** Relevance tiers (dynamic-view P2); absent = every node tier 1. */
  tiers?: ReadonlyMap<string, Tier>;
}

export interface GenericDrawInput extends Omit<Frame, 'layout' | 'boxOf'> {
  scene: GenericScene;
  now: number;
}

// The painter's palette is the theme preset — no values live in this file.
const C = DEFAULT_THEME.canvas;

function alphaFor(id: string, input: Frame): number {
  // Tiers are the one pipeline when present; the emphasis map is the legacy/test path.
  const dim = input.tiers ? (input.tiers.get(id) ?? 1) === 0 : (input.emphasis.get(id) ?? 'normal') === 'dim';
  const lensAlpha = dim ? 0.22 : 1;
  const focus = input.focusAlpha?.get(id) ?? 1;
  // Combine lens and focus without fully erasing any node (brief §16).
  return Math.max(0.12, Math.min(lensAlpha, focus));
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, camera: Camera): void {
  const step = DEFAULT_THEME.geometry.gridStep;
  const left = camera.x - width / 2 / camera.zoom;
  const top = camera.y - height / 2 / camera.zoom;
  const right = camera.x + width / 2 / camera.zoom;
  const bottom = camera.y + height / 2 / camera.zoom;
  ctx.fillStyle = C.grid;
  for (let x = Math.floor(left / step) * step; x < right; x += step) {
    for (let y = Math.floor(top / step) * step; y < bottom; y += step) {
      ctx.fillRect(x, y, 2 / camera.zoom, 2 / camera.zoom);
    }
  }
}

function centre(box: NodeBox): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

const boxOf = (input: Frame, id: string) => (input.boxOf ? input.boxOf(id) : input.layout.nodes.get(id));

function drawPendingEdges(ctx: CanvasRenderingContext2D, input: Frame): void {
  // Pending intents are visibly NOT authoritative: dashed, labelled (charter §15).
  for (const p of input.pending) {
    const i = p.intent;
    if (isSessionIntent(i) || i.action !== 'edge.rewire' || !i.decision?.option) continue;
    const from = boxOf(input, i.nodeId);
    const to = boxOf(input, i.decision.option);
    if (!from || !to) continue;
    ctx.strokeStyle = C.pending;
    ctx.lineWidth = 2;
    ctx.setLineDash([...PENDING_DASH]);
    curve(ctx, from.x + from.w, centre(from).y, to.x, centre(to).y);
    ctx.setLineDash([]);
    ctx.fillStyle = C.pending;
    ctx.font = DEFAULT_THEME.fonts.pendingLabel;
    const mx = (from.x + from.w + to.x) / 2;
    const my = (centre(from).y + centre(to).y) / 2 - 8;
    ctx.fillText('pending…', mx - 24, my);
  }
}

function drawRewireDrag(ctx: CanvasRenderingContext2D, input: Frame): void {
  const drag = input.rewireDrag;
  if (!drag) return;
  const from = boxOf(input, drag.fromId);
  if (!from) return;
  ctx.strokeStyle = C.pending;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  curve(ctx, from.x + from.w, centre(from).y, drag.toX, drag.toY);
  ctx.setLineDash([]);
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function curve(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
  ctx.stroke();
  // arrowhead
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 8, y2 - 4);
  ctx.lineTo(x2 - 8, y2 + 4);
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle as string;
  ctx.fill();
}

/* ---- generic path: NodeProjection + wiring config ---- */

/**
 * Generic painter. Text comes from received values and is only ever passed to
 * fillText; colours and strokes come from engine constants selected by config
 * tokens. Attention is an engine rule on top of any assembly.
 */
export function drawGeneric(ctx: CanvasRenderingContext2D, width: number, height: number, input: GenericDrawInput): void {
  const frame: Frame = { ...input, layout: input.scene.layout, boxOf: (id) => endpointBox(input.scene, id) };
  const { camera } = input;
  ctx.save();
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  drawGrid(ctx, width, height, camera);
  for (const group of input.scene.groups) drawGroup(ctx, group, input.scene.nodes.get(group.id), frame);
  for (const edge of input.scene.edges) {
    const from = boxOf(frame, edge.from);
    const to = boxOf(frame, edge.to);
    if (!from || !to) continue;
    ctx.globalAlpha = Math.min(alphaFor(edge.from, frame), alphaFor(edge.to, frame));
    ctx.strokeStyle = edge.stroke.color;
    ctx.lineWidth = edge.stroke.width;
    ctx.setLineDash([...CONFIG_EDGE_DASH]);
    curve(ctx, from.x + from.w, centre(from).y, to.x, centre(to).y);
    if (edge.stroke.double) curve(ctx, from.x + from.w, centre(from).y + 4, to.x, centre(to).y + 4);
    ctx.globalAlpha = 1;
  }
  drawPendingEdges(ctx, frame);
  for (const box of frame.layout.nodes.values()) {
    const node = input.scene.nodes.get(box.id);
    if (node) drawGenericNode(ctx, box, node, frame);
  }
  drawRewireDrag(ctx, frame);
  ctx.restore();
}

/** A `contain` parent: a labelled container around its members (engine style). */
function drawGroup(ctx: CanvasRenderingContext2D, group: GroupBox, node: SceneNode | undefined, frame: Frame): void {
  ctx.globalAlpha = alphaFor(group.id, frame);
  const interrupt = node?.attention?.mechanism === 'interrupt';
  ctx.fillStyle = GROUP_STYLE.fill;
  ctx.strokeStyle = interrupt ? ATTENTION_COLOR : GROUP_STYLE.border;
  ctx.lineWidth = GROUP_STYLE.borderWidth;
  roundRect(ctx, group.x, group.y, group.w, group.h, GROUP_STYLE.radius);
  ctx.fill();
  ctx.stroke();
  ctx.font = GROUP_STYLE.labelFont;
  let x = group.x + 14;
  if (node) {
    ctx.fillStyle = node.tone;
    ctx.fillText(node.glyph, x, group.y + 20);
    x += 20;
  }
  ctx.fillStyle = GROUP_STYLE.label;
  const detail = node ? ` · ${node.state}` : '';
  ctx.fillText(clip(ctx, `${group.name}${detail}`, group.w - (x - group.x) - 14), x, group.y + 20);
  if (node?.attention) {
    // Same attention marks as a node: interrupt badge, ambient dot.
    ctx.fillStyle = ATTENTION_COLOR;
    if (interrupt) {
      ctx.font = DEFAULT_THEME.fonts.badge;
      ctx.fillText('!', group.x + group.w - 18, group.y + 20);
    } else {
      ctx.beginPath();
      ctx.arc(group.x + group.w - 14, group.y + 15, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (frame.selectedId === group.id) {
    ctx.strokeStyle = C.selection;
    ctx.lineWidth = 2.5;
    roundRect(ctx, group.x - 4, group.y - 4, group.w + 8, group.h + 8, GROUP_STYLE.radius + 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawGenericNode(ctx: CanvasRenderingContext2D, box: NodeBox, node: SceneNode, frame: Frame): void {
  ctx.globalAlpha = alphaFor(box.id, frame);
  const interrupt = node.attention?.mechanism === 'interrupt';
  ctx.fillStyle = interrupt ? DEFAULT_THEME.attentionWash : C.node;
  ctx.strokeStyle = interrupt ? ATTENTION_COLOR : C.nodeBorder;
  ctx.lineWidth = interrupt ? 2.5 : 1.5;
  roundRect(ctx, box.x, box.y, box.w, box.h, 10);
  ctx.fill();
  ctx.stroke();

  ctx.font = DEFAULT_THEME.fonts.title;
  ctx.fillStyle = node.tone;
  ctx.fillText(node.glyph, box.x + 12, box.y + 22);
  ctx.fillStyle = C.text;
  ctx.fillText(clip(ctx, node.title, box.w - 60), box.x + 34, box.y + 22);

  if (node.attention) {
    // Interrupt: badge; ambient: a quiet dot. Causes stay in the data, not the drawing.
    ctx.fillStyle = ATTENTION_COLOR;
    if (interrupt) {
      ctx.font = DEFAULT_THEME.fonts.badge;
      ctx.fillText('!', box.x + box.w - 18, box.y + 22);
    } else {
      ctx.beginPath();
      ctx.arc(box.x + box.w - 14, box.y + 16, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (detailOn((frame.tiers?.get(node.id) ?? 1) as Tier, frame.camera.zoom, frame.detailZoom ?? 0.5)) {
    ctx.font = DEFAULT_THEME.fonts.meta;
    ctx.fillStyle = C.subtext;
    const detail = node.labels.length > 0 ? node.labels.join(' · ') : `${node.kind} · ${node.state}`;
    ctx.fillText(clip(ctx, detail, box.w - 24), box.x + 12, box.y + 42);
    // A grown box (P3: tier sized it up) fits the line the labels displaced.
    if (node.labels.length > 0 && box.h >= DEFAULT_THEME.geometry.node.h + 18) {
      ctx.fillStyle = C.faint;
      ctx.fillText(clip(ctx, `${node.kind} · ${node.state}`, box.w - 24), box.x + 12, box.y + 60);
    }
    const chips = node.parts.actions.slice(0, 3);
    let x = box.x + 12;
    for (const a of chips) {
      const usable = a.level === 'enabled' && (a.kind === 'assembled' ? !a.blocked : a.usable);
      const label = (usable ? '' : '⊘ ') + a.action;
      ctx.fillStyle = usable ? C.running : C.faint;
      ctx.font = DEFAULT_THEME.fonts.small;
      const text = clip(ctx, label, box.x + box.w - 12 - x);
      // Chips sit on the box's bottom edge, whatever size the tier gave it.
      ctx.fillText(text, x, box.y + box.h - 16);
      x += ctx.measureText(text).width + 10;
      if (x > box.x + box.w - 30) break;
    }
  }

  if (frame.selectedId === box.id) {
    ctx.strokeStyle = C.selection;
    ctx.lineWidth = 2.5;
    { const o = DEFAULT_THEME.geometry.selectionRingOffset; roundRect(ctx, box.x - o, box.y - o, box.w + 2 * o, box.h + 2 * o, 12); }
    ctx.stroke();
    // The cleared breathing margin around a grown focus node (engine furniture,
    // not a grade) — drawn only when the margin actually cleared (pins may sit
    // in it; the ring never claims space that is not free).
    if (box.w > DEFAULT_THEME.geometry.node.w) {
      const m = DEFAULT_THEME.geometry.focusMargin;
      const halo = { x: box.x - m, y: box.y - m, w: box.w + 2 * m, h: box.h + 2 * m };
      const occupied = [...frame.layout.nodes.values()].some(
        (o) => o.id !== box.id && o.x < halo.x + halo.w && halo.x < o.x + o.w && o.y < halo.y + halo.h && halo.y < o.y + o.h,
      );
      if (!occupied) {
        ctx.globalAlpha = alphaFor(box.id, frame) * 0.5;
        ctx.lineWidth = 1;
        ctx.setLineDash([...DEFAULT_THEME.dashes.focusMargin]);
        roundRect(ctx, halo.x, halo.y, halo.w, halo.h, 14);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  ctx.globalAlpha = 1;
}
