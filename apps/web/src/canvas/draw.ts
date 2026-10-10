/**
 * Canvas painter (generic path only). Pure rendering of (scene × view × lens ×
 * selection × pending) — draws exactly what was received, nothing more. Text
 * goes to fillText verbatim; colours come from the theme preset and config
 * literals. The old domain painter is gone: every upstream speaks the contract.
 */
import { inflate, labelBeside, labelX, shapeRect, tracePath } from './shapes.js';
import { isSessionIntent } from '../model/types.js';
import type { WorkspaceLayout, NodeBox } from './layout.js';
import type { Camera } from '../state/viewState.js';
import type { Emphasis } from '../state/lens.js';
import type { InFlightEntry } from '../state/pendingIntents.js';
import { endpointBox, nestedChipRect, type GenericScene, type GroupBox, type SceneNode } from './genericScene.js';
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
  /** The zoom detail is decided at: the step a zoom move is heading to (no flicker mid-move); defaults to the camera's. */
  labelZoom?: number;
  /** Relevance tiers (dynamic-view P2); absent = every node tier 1. */
  tiers?: ReadonlyMap<string, Tier>;
  /** Where a drag would settle if released now (dashed outlines; view furniture, no grade). */
  ghost?: readonly { shape: import('./shapes.js').LeafShape; rect: { x: number; y: number; w: number; h: number } }[] | null;
}

export interface GenericDrawInput extends Omit<Frame, 'layout' | 'boxOf'> {
  scene: GenericScene;
  now: number;
}

// The painter's palette is the theme preset — no values live in this file.
const C = DEFAULT_THEME.canvas;
/** The container header band's height (theme geometry), where a band's name strip goes. */
const LAYOUT_HEADER = DEFAULT_THEME.geometry.groupHeader;

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
  // Edges attach to a leaf's drawn shape (a label strip beside it is not part of the endpoint).
  const endpoint = (id: string) => {
    const b = endpointBox(input.scene, id);
    const n = input.scene.nodes.get(id);
    return b && n && input.scene.layout.nodes.has(id) ? { ...b, ...shapeRect(n.shape, b) } : b;
  };
  const frame: Frame = { ...input, layout: input.scene.layout, boxOf: endpoint };
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
  // Relations between a container and its own descendant: a '◂' chip on the descendant (no line).
  for (const [id, links] of input.scene.nestedLinks) {
    const box = endpointBox(input.scene, id);
    if (!box) continue;
    const r = nestedChipRect(box, links.length);
    ctx.globalAlpha = alphaFor(id, frame);
    ctx.fillStyle = C.node;
    ctx.strokeStyle = C.nodeBorder;
    ctx.lineWidth = 1;
    roundRect(ctx, r.x, r.y, r.w, r.h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.subtext;
    ctx.font = DEFAULT_THEME.fonts.small;
    ctx.fillText(links.length > 1 ? `◂${links.length}` : '◂', r.x + 5, r.y + 13);
    ctx.globalAlpha = 1;
  }
  if (input.ghost) {
    // The landing preview: the shape outline, dashed, where the drag would settle.
    ctx.strokeStyle = C.text;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([5 / camera.zoom, 5 / camera.zoom]);
    for (const g of input.ghost) {
      tracePath(ctx, g.shape, shapeRect(g.shape, g.rect));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
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
  if (node?.band) {
    // A band (wiring shape 'band'): its name sits on a strip across the top.
    ctx.save();
    roundRect(ctx, group.x, group.y, group.w, group.h, GROUP_STYLE.radius);
    ctx.clip();
    ctx.fillStyle = GROUP_STYLE.border;
    ctx.globalAlpha *= 0.35;
    ctx.fillRect(group.x, group.y, group.w, LAYOUT_HEADER);
    ctx.restore();
  }
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
  // The kind's shape (wiring); the label strip beside a small shape is not outlined.
  const sr = shapeRect(node.shape, box);
  ctx.fillStyle = interrupt ? DEFAULT_THEME.attentionWash : C.node;
  ctx.strokeStyle = interrupt ? ATTENTION_COLOR : C.nodeBorder;
  ctx.lineWidth = interrupt ? 2.5 : 1.5;
  tracePath(ctx, node.shape, sr);
  ctx.fill();
  ctx.stroke();

  const beside = labelBeside(node.shape);
  // Title and glyph: inside a shape that holds text, beside one that does not (D-4a).
  // Diamond and hexagon keep their text inside the inner band where the outline leaves room.
  const inset = node.shape === 'diamond' ? sr.w * 0.22 : node.shape === 'hexagon' ? Math.min(sr.w / 4, sr.h / 2) * 0.6 : node.shape === 'pill' ? sr.h * 0.25 : 0;
  const tx = beside ? labelX(node.shape, box) : box.x + 12 + inset;
  // A short box (a small size factor) centres its title instead of hanging it from the top.
  // A short circle (small size factor) has room for one centred title line only.
  const shortBeside = beside && sr.h < 44;
  const titleY = shortBeside
    ? sr.y + sr.h / 2 + 5
    : beside || node.shape === 'diamond'
      ? sr.y + sr.h / 2 - (node.shape === 'diamond' ? 4 : 6)
      : box.y + Math.min(22, box.h / 2 + 5);
  const textRight = box.x + box.w - 12 - inset;
  ctx.font = DEFAULT_THEME.fonts.title;
  ctx.fillStyle = node.tone;
  if (node.shape === 'diamond') {
    // A diamond holds text only along its middle: glyph above the centre line, title and detail centred on it.
    drawDiamondText(ctx, sr, node, frame);
  } else if (beside) {
    // The glyph sits in the shape's centre.
    const gw = ctx.measureText(node.glyph).width;
    ctx.fillText(node.glyph, sr.x + sr.w / 2 - gw / 2, sr.y + sr.h / 2 + 5);
  } else {
    ctx.fillText(node.glyph, tx, titleY);
  }
  if (node.shape !== 'diamond') {
    ctx.fillStyle = C.text;
    const titleX = beside ? tx : tx + 22;
    ctx.fillText(clip(ctx, node.title, Math.max(0, textRight - titleX - (beside ? 0 : 16))), titleX, titleY);
  }

  if (node.attention) {
    // Interrupt: badge; ambient: a quiet dot. Causes stay in the data, not the drawing.
    const ax = beside ? sr.x + sr.w - 6 : node.shape === 'diamond' ? sr.x + sr.w * 0.66 : box.x + box.w - 18 - inset;
    const ay = beside ? sr.y + 8 : node.shape === 'diamond' ? sr.y + sr.h * 0.3 : box.y + 22;
    ctx.fillStyle = ATTENTION_COLOR;
    if (interrupt) {
      ctx.font = DEFAULT_THEME.fonts.badge;
      ctx.fillText('!', ax, ay);
    } else {
      ctx.beginPath();
      ctx.arc(ax + 4, ay - 6, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (node.shape !== 'diamond' && detailOn((frame.tiers?.get(node.id) ?? 1) as Tier, frame.labelZoom ?? frame.camera.zoom, frame.detailZoom ?? 0.5)) {
    ctx.font = DEFAULT_THEME.fonts.meta;
    ctx.fillStyle = C.subtext;
    const detail = node.labels.length > 0 ? node.labels.join(' · ') : `${node.kind} · ${node.state}`;
    const detailY = beside ? titleY + 18 : box.y + 42;
    // Only where the line fits inside the box (a label-beside title strip has room below the title).
    if (beside ? !shortBeside : detailY <= box.y + box.h - 8) ctx.fillText(clip(ctx, detail, Math.max(0, textRight - tx)), tx, detailY);
    // A grown box (P3: tier sized it up) fits the line the labels displaced.
    if (!beside && node.labels.length > 0 && box.h >= node.baseSize.h + 18) {
      ctx.fillStyle = C.faint;
      ctx.fillText(clip(ctx, `${node.kind} · ${node.state}`, Math.max(0, textRight - tx)), tx, box.y + 60);
    }
    // Action chips only on rect and hexagon boxes with a bottom row below the detail line; circle, diamond
    // and pill never carry chips (approved mockup), whatever size the tier gives them.
    if (!beside && node.shape !== 'pill' && box.h >= 70) {
      const chips = node.parts.actions.slice(0, 3);
      let x = tx;
      for (const a of chips) {
        const usable = a.level === 'enabled' && (a.kind === 'assembled' ? !a.blocked : a.usable);
        const label = (usable ? '' : '⊘ ') + (Object.hasOwn(node.actionLabels, a.action) ? node.actionLabels[a.action]! : a.action);
        ctx.fillStyle = usable ? C.running : C.faint;
        ctx.font = DEFAULT_THEME.fonts.small;
        const text = clip(ctx, label, Math.max(0, textRight - x));
        // Chips sit on the box's bottom edge, whatever size the tier gave it.
        ctx.fillText(text, x, box.y + box.h - 16);
        x += ctx.measureText(text).width + 10;
        if (x > textRight - 18) break;
      }
    }
  }

  if (frame.selectedId === box.id) {
    ctx.strokeStyle = C.selection;
    ctx.lineWidth = 2.5;
    { const o = DEFAULT_THEME.geometry.selectionRingOffset; tracePath(ctx, node.shape, inflate(shapeRect(node.shape, box), o), 12); }
    ctx.stroke();
    // The cleared breathing margin around a grown focus node (engine furniture,
    // not a grade) — drawn only when the margin actually cleared (pins may sit
    // in it; the ring never claims space that is not free).
    if (box.w > node.baseSize.w) {
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

/** A diamond's text: the glyph above the centre, the title on it and the detail below, all centred within the middle width. */
function drawDiamondText(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, node: SceneNode, frame: Frame): void {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const centred = (text: string, y: number, maxW: number) => {
    const t = clip(ctx, text, maxW);
    ctx.fillText(t, cx - ctx.measureText(t).width / 2, y);
  };
  ctx.font = DEFAULT_THEME.fonts.title;
  ctx.fillStyle = node.tone;
  centred(node.glyph, cy - 12, r.w * 0.3);
  ctx.fillStyle = C.text;
  centred(node.title, cy + 6, r.w * 0.78);
  if (detailOn((frame.tiers?.get(node.id) ?? 1) as Tier, frame.labelZoom ?? frame.camera.zoom, frame.detailZoom ?? 0.5)) {
    ctx.font = DEFAULT_THEME.fonts.meta;
    ctx.fillStyle = C.subtext;
    centred(node.labels.length > 0 ? node.labels.join(' · ') : node.state, cy + 22, r.w * 0.5);
  }
}

