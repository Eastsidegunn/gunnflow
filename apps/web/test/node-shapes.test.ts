// GF-P1b D: node shapes are wiring data on a kind (shape + size factor). The
// engine reads no meaning into a kind; shapes size the layout box, outline
// the node, decide where the title goes, and bound the hit test.
import { describe, expect, it } from 'vitest';
import type { NodeProjection } from '@gunnflow/contract';
import { WIRING_SCHEMA_VERSION, type WiringConfig } from '@gunnflow/contract/wiring';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { mergeWiring } from '../src/wiring/loadWiring.js';
import { LABEL_ROOM, SHAPE_SIZE, hitsLeaf, isBand, labelBeside, leafBaseSize, leafShapeOf, shapeRect } from '../src/canvas/shapes.js';
import { containerRects, fallbackLayout, layoutGraphOf } from '../src/canvas/layoutGraph.js';
import { DEFAULT_THEME } from '../src/theme/defaultTheme.js';

const V = WIRING_SCHEMA_VERSION;
const cfg = (kinds: WiringConfig['kinds']): WiringConfig => ({ ...DEFAULT_WIRING, kinds: { ...(DEFAULT_WIRING.kinds ?? {}), ...kinds } });

describe('node shapes', () => {
  it('unstated kinds keep the classic rectangle at the theme node size', () => {
    expect(leafShapeOf(DEFAULT_WIRING, 'anything')).toEqual({ shape: 'rect', size: 1 });
    expect(leafBaseSize(DEFAULT_WIRING, 'anything')).toEqual(DEFAULT_THEME.geometry.node);
  });

  it('a shape sets the base box; the size factor scales it; a circle adds room for its title beside it', () => {
    const c = cfg({ t: { shape: 'circle', size: 0.5 }, g: { shape: 'diamond', size: 1.5 }, h: { shape: 'hexagon' } });
    expect(leafBaseSize(c, 'g')).toEqual({ w: SHAPE_SIZE.diamond.w * 1.5, h: SHAPE_SIZE.diamond.h * 1.5 });
    expect(leafBaseSize(c, 'h')).toEqual(SHAPE_SIZE.hexagon);
    expect(leafBaseSize(c, 't')).toEqual({ w: Math.round((SHAPE_SIZE.circle.w + LABEL_ROOM) * 0.5), h: SHAPE_SIZE.circle.h * 0.5 });
    expect(labelBeside('circle')).toBe(true);
    expect(labelBeside('diamond')).toBe(false);
  });

  it("'band' is a container shape: a leaf declared band is a rect, a container declared band is a band", () => {
    const c = cfg({ m: { shape: 'band' } });
    expect(leafShapeOf(c, 'm').shape).toBe('rect');
    expect(isBand(c, 'm')).toBe(true);
    expect(isBand(c, 'x')).toBe(false);
  });

  it('the shape part of a label-beside box keeps the shape square however the tier grew the box', () => {
    const box = { x: 0, y: 0, w: (SHAPE_SIZE.circle.w + LABEL_ROOM) * 1.6, h: SHAPE_SIZE.circle.h * 1.6 };
    const r = shapeRect('circle', box);
    expect(r.w).toBeCloseTo(r.h, 9);
    expect(r.h).toBe(box.h);
    // Every other shape uses the whole box.
    expect(shapeRect('diamond', box)).toEqual(box);
  });

  it('hit tests follow the outline: a diamond or circle corner is empty canvas, a label strip is the node', () => {
    const d = { x: 0, y: 0, w: 100, h: 100 };
    expect(hitsLeaf('diamond', d, 50, 50)).toBe(true);
    expect(hitsLeaf('diamond', d, 50, 2)).toBe(true);
    expect(hitsLeaf('diamond', d, 8, 8)).toBe(false);
    expect(hitsLeaf('rect', d, 8, 8)).toBe(true);
    const c = { x: 0, y: 0, w: 56 + LABEL_ROOM, h: 56 };
    expect(hitsLeaf('circle', c, 28, 28)).toBe(true);
    expect(hitsLeaf('circle', c, 3, 3)).toBe(false);
    expect(hitsLeaf('circle', c, 120, 28)).toBe(true); // the title beside it (part of the node)
    const pill = { x: 0, y: 0, w: 200, h: 56 };
    expect(hitsLeaf('pill', pill, 100, 28)).toBe(true);
    expect(hitsLeaf('pill', pill, 28, 28)).toBe(true);
    expect(hitsLeaf('pill', pill, 3, 3)).toBe(false); // the rounded end's corner
    const h = { x: 0, y: 0, w: 168, h: 96 };
    expect(hitsLeaf('hexagon', h, 84, 48)).toBe(true);
    expect(hitsLeaf('hexagon', h, 2, 2)).toBe(false);
    expect(hitsLeaf('hexagon', h, 2, 48)).toBe(true);
    // Outside the box is never a hit.
    expect(hitsLeaf('rect', d, 101, 50)).toBe(false);
  });

  it('wiring files merge a kind field by field: a later file can change the shape and keep the parts', () => {
    const base: WiringConfig = { version: V, kinds: { task: { parts: [{ id: 'g', part: 'glyph' }] } } };
    const over: WiringConfig = { version: V, kinds: { task: { shape: 'circle' }, gate: { shape: 'diamond' } } };
    const merged = mergeWiring(base, over);
    expect(merged.kinds!.task).toEqual({ parts: [{ id: 'g', part: 'glyph' }], shape: 'circle' });
    expect(merged.kinds!.gate).toEqual({ shape: 'diamond' });
  });
});

describe('band containers', () => {
  const node = (id: string, kind: string, rel: { type: string; target: string }[] = []): NodeProjection => ({
    id,
    kind,
    label: id,
    state: { value: 'x' },
    relations: rel,
    capabilities: [],
    attention: [],
    artifacts: [],
  });
  // One container with eight unrelated members: packed into rows.
  const nodes = [node('M', 'mission'), ...Array.from({ length: 8 }, (_, i) => node(`t${i}`, 'task', [{ type: 'member-of', target: 'M' }]))];

  it('a band packs its unrelated members into a wide row; the default packs toward the engine aspect', () => {
    const plain = layoutGraphOf(nodes, DEFAULT_WIRING);
    const band = layoutGraphOf(nodes, cfg({ mission: { shape: 'band' } }));
    expect(band.bands?.has('M')).toBe(true);
    expect(band.signature).not.toBe(plain.signature);
    const box = (g: typeof plain) => {
      const pos = fallbackLayout(g);
      const sizes = new Map(g.nodes.map((n) => [n.id, n]));
      return containerRects(g, (id) => {
        const p = pos.get(id);
        const s = sizes.get(id);
        return p && s ? { x: p.x, y: p.y, w: s.w, h: s.h } : undefined;
      }).get('M')!;
    };
    const pb = box(plain);
    const bb = box(band);
    expect(bb.w / bb.h).toBeGreaterThan(pb.w / pb.h);
  });

  it('kind sizes reach the layout graph (and its signature): a circle task is smaller than a rect one', () => {
    const plain = layoutGraphOf(nodes, DEFAULT_WIRING);
    const circles = layoutGraphOf(nodes, cfg({ task: { shape: 'circle', size: 0.6 } }));
    const w = (g: typeof plain) => g.nodes.find((n) => n.id === 't0')!.w;
    expect(w(circles)).toBeLessThan(w(plain));
    expect(circles.signature).not.toBe(plain.signature);
  });
});
