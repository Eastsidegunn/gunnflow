/**
 * The personal board on the canvas: boxes (goals/subgoals), links and sticky
 * notes (text or rendered mermaid diagrams), all in the personal grade, above
 * the workspace, at the person's own positions — outside layout, lenses and
 * filters (a personal item is always shown as the person's). Links may end on
 * received nodes; a link whose node is gone is drawn broken, not dropped.
 */
import type { DiagramEntry } from '../personal/diagrams.js';
import { DEFAULT_THEME } from '../theme/defaultTheme.js';
import type { LinkEnd, PersonalBox, PersonalDoc, PersonalSticky } from '../personal/schema.js';
import type { Camera } from '../state/viewState.js';
import { PERSONAL_STYLE } from './tokens.js';

export type Rect = { x: number; y: number; w: number; h: number };
export const RESIZE_HANDLE = 12;
export const BOX_HEADER = 30;
export const DIAGRAM_HEADER = 20;

export const handleRect = (r: Rect): Rect => ({ x: r.x + r.w - RESIZE_HANDLE, y: r.y + r.h - RESIZE_HANDLE, w: RESIZE_HANDLE, h: RESIZE_HANDLE });

export interface PersonalDrawInput {
  doc: PersonalDoc;
  open: { kind: 'sticky' | 'box'; id: string } | null;
  connectFrom: LinkEnd | null;
  diagram: (source: string) => DiagramEntry;
  /** A received node's drawn rect, or undefined when it is not in the workspace. */
  nodeRect: (id: string) => Rect | undefined;
}

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Where the segment from the rect's centre toward (tx, ty) leaves the rect. */
function border(r: Rect, tx: number, ty: number) {
  const c = centre(r);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) {
        out.push(line);
        line = word;
      } else line = next;
      if (out.length >= maxLines) break;
    }
    out.push(line);
    if (out.length >= maxLines) break;
  }
  if (out.length > maxLines) out.length = maxLines;
  return out;
}

function handle(ctx: CanvasRenderingContext2D, r: Rect) {
  const h = handleRect(r);
  ctx.fillStyle = PERSONAL_STYLE.color;
  ctx.beginPath();
  ctx.moveTo(h.x + h.w, h.y);
  ctx.lineTo(h.x + h.w, h.y + h.h);
  ctx.lineTo(h.x, h.y + h.h);
  ctx.closePath();
  ctx.fill();
}

function drawBox(ctx: CanvasRenderingContext2D, b: PersonalBox, open: boolean, nodeRect: (id: string) => Rect | undefined) {
  ctx.fillStyle = PERSONAL_STYLE.boxFill;
  ctx.strokeStyle = PERSONAL_STYLE.color;
  ctx.lineWidth = open ? 3 : 2;
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.fill();
  ctx.stroke();
  // Header chip: the box's label, marked personal.
  ctx.font = DEFAULT_THEME.fonts.personalHeader;
  const label = `▢ ${b.label || '(untitled)'}`;
  const tag = ` · ${PERSONAL_STYLE.label}`;
  const textW = Math.min(b.w - 16, ctx.measureText(label).width + ctx.measureText(tag).width + 16);
  ctx.fillStyle = PERSONAL_STYLE.chip;
  ctx.fillRect(b.x, b.y, textW, 24);
  ctx.fillStyle = PERSONAL_STYLE.text;
  ctx.fillText(label, b.x + 8, b.y + 16, Math.max(10, textW - 16 - ctx.measureText(tag).width));
  ctx.font = DEFAULT_THEME.fonts.personalMeta;
  ctx.fillStyle = PERSONAL_STYLE.color;
  ctx.fillText(tag, b.x + 8 + Math.min(ctx.measureText(label).width + 2, textW - 60), b.y + 16);
  if (b.members.length > 0) {
    // Filed received nodes: my classification; members gone from the workspace stay counted as missing.
    const missing = b.members.filter((m) => !nodeRect(m)).length;
    ctx.font = DEFAULT_THEME.fonts.personalMeta;
    ctx.fillStyle = PERSONAL_STYLE.color;
    const info = `${b.members.length} filed${missing > 0 ? ` · ${missing} missing` : ''}`;
    ctx.fillText(info, b.x + b.w - ctx.measureText(info).width - 10, b.y + 16);
  }
  handle(ctx, b);
}

function drawSticky(ctx: CanvasRenderingContext2D, s: PersonalSticky, open: boolean, diagram: (source: string) => DiagramEntry) {
  const f = PERSONAL_STYLE.fold;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(s.x + s.w - f, s.y);
  ctx.lineTo(s.x + s.w, s.y + f);
  ctx.lineTo(s.x + s.w, s.y + s.h);
  ctx.lineTo(s.x, s.y + s.h);
  ctx.closePath();
  ctx.fillStyle = PERSONAL_STYLE.fill;
  ctx.fill();
  ctx.strokeStyle = PERSONAL_STYLE.color;
  ctx.lineWidth = open ? 2.5 : 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s.x + s.w - f, s.y);
  ctx.lineTo(s.x + s.w - f, s.y + f);
  ctx.lineTo(s.x + s.w, s.y + f);
  ctx.stroke();
  ctx.fillStyle = PERSONAL_STYLE.color;
  ctx.font = DEFAULT_THEME.fonts.personalChip;
  ctx.fillText(s.kind === 'mermaid' ? `◇ diagram · ${PERSONAL_STYLE.label}` : `✎ ${PERSONAL_STYLE.label}`, s.x + 10, s.y + 14);
  if (s.kind === 'mermaid') {
    const area = { x: s.x + 6, y: s.y + DIAGRAM_HEADER, w: s.w - 12, h: s.h - DIAGRAM_HEADER - 6 };
    const entry = s.text.trim() ? diagram(s.text) : ({ state: 'error', reason: 'empty diagram source' } as DiagramEntry);
    if (entry.state === 'ok' && entry.image && entry.width > 0) {
      ctx.fillStyle = DEFAULT_THEME.canvas.paper;
      ctx.fillRect(area.x, area.y, area.w, area.h);
      const k = Math.min(area.w / entry.width, area.h / entry.height);
      const w = entry.width * k;
      const h = entry.height * k;
      ctx.drawImage(entry.image, area.x + (area.w - w) / 2, area.y + (area.h - h) / 2, w, h);
    } else {
      ctx.font = DEFAULT_THEME.fonts.personalBody;
      ctx.fillStyle = PERSONAL_STYLE.text;
      const lines =
        entry.state === 'pending'
          ? ['rendering…']
          : entry.state === 'error'
            ? [`Renderer unavailable — ${entry.reason}`, ...s.text.split('\n')]
            : ['rendering…'];
      wrap(ctx, lines.join('\n'), area.w - 8, Math.max(1, Math.floor(area.h / 15))).forEach((line, i) =>
        ctx.fillText(line, area.x + 4, area.y + 14 + i * 15),
      );
    }
  } else {
    ctx.fillStyle = PERSONAL_STYLE.text;
    ctx.font = DEFAULT_THEME.fonts.personalBody;
    const lines = wrap(ctx, s.text || '(empty)', s.w - 20, Math.max(1, Math.floor((s.h - 30) / 15)));
    lines.forEach((line, i) => ctx.fillText(line, s.x + 10, s.y + 34 + i * 15));
  }
  handle(ctx, s);
}

export function endRect(input: PersonalDrawInput, end: LinkEnd): Rect | undefined {
  if (end.kind === 'sticky') return input.doc.stickies.find((s) => s.id === end.id);
  if (end.kind === 'box') return input.doc.boxes.find((b) => b.id === end.id);
  return input.nodeRect(end.id);
}

function drawLinks(ctx: CanvasRenderingContext2D, input: PersonalDrawInput) {
  ctx.strokeStyle = PERSONAL_STYLE.color;
  ctx.fillStyle = PERSONAL_STYLE.color;
  ctx.lineWidth = 2;
  for (const l of input.doc.links) {
    const a = endRect(input, l.from);
    const b = endRect(input, l.to);
    if (!a && !b) continue;
    if (a && b) {
      const p = border(a, centre(b).x, centre(b).y);
      const q = border(b, centre(a).x, centre(a).y);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      const ang = Math.atan2(q.y - p.y, q.x - p.x);
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x - 10 * Math.cos(ang - 0.4), q.y - 10 * Math.sin(ang - 0.4));
      ctx.lineTo(q.x - 10 * Math.cos(ang + 0.4), q.y - 10 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
      if (l.label) {
        ctx.font = DEFAULT_THEME.fonts.personalMeta;
        const mx = (p.x + q.x) / 2;
        const my = (p.y + q.y) / 2;
        const w = ctx.measureText(l.label).width + 8;
        ctx.fillStyle = PERSONAL_STYLE.chip;
        ctx.fillRect(mx - w / 2, my - 9, w, 16);
        ctx.fillStyle = PERSONAL_STYLE.text;
        ctx.fillText(l.label, mx - w / 2 + 4, my + 3);
        ctx.fillStyle = PERSONAL_STYLE.color;
      }
    } else {
      // Broken: the node end is gone. A stub ending in a cross, kept visible.
      const r = (a ?? b)!;
      const start = { x: r.x + r.w, y: r.y + r.h / 2 };
      const end = { x: start.x + 60, y: start.y };
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.moveTo(end.x - 6, end.y - 6);
      ctx.lineTo(end.x + 6, end.y + 6);
      ctx.moveTo(end.x + 6, end.y - 6);
      ctx.lineTo(end.x - 6, end.y + 6);
      ctx.stroke();
      ctx.font = DEFAULT_THEME.fonts.pendingLabel;
      ctx.fillText('node gone', end.x + 10, end.y + 4);
    }
  }
}

export function drawPersonal(ctx: CanvasRenderingContext2D, width: number, height: number, camera: Camera, input: PersonalDrawInput): void {
  const { doc } = input;
  if (doc.stickies.length === 0 && doc.boxes.length === 0 && doc.links.length === 0) return;
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  // Larger boxes first, so nested boxes stay visible.
  for (const b of [...doc.boxes].sort((p, q) => q.w * q.h - p.w * p.h)) drawBox(ctx, b, input.open?.kind === 'box' && input.open.id === b.id, input.nodeRect);
  drawLinks(ctx, input);
  for (const s of doc.stickies) drawSticky(ctx, s, input.open?.kind === 'sticky' && input.open.id === s.id, input.diagram);
  ctx.restore();
}
