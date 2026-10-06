// Acceptance B1–B4 on the generic path: the canvas renders exactly what was
// received, nothing more. (The old domain painter is retired — every upstream
// speaks the contract, so integrity is checked on NodeProjection[].)
import { describe, expect, it } from 'vitest';
import { FIXTURES, projectNodes } from '@gunnflow-testing/fake-contracts';
import { WORKSPACE_ROOT_KIND } from '@gunnflow/contract';
import { buildScene, endpointBox } from '../src/canvas/genericScene.js';
import { layoutBounds } from '../src/canvas/layout.js';
import { drawGeneric } from '../src/canvas/draw.js';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';

/** Minimal recording stand-in for CanvasRenderingContext2D. */
function recordingContext() {
  const texts: string[] = [];
  const noop = () => undefined;
  const ctx = new Proxy(
    {
      fillText: (t: string) => texts.push(t),
      measureText: (t: string) => ({ width: t.length * 7 }),
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        return noop;
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

const input = (scene: ReturnType<typeof buildScene>, zoom = 1) => ({
  scene,
  camera: { x: 400, y: 300, zoom },
  emphasis: new Map<string, 'highlight' | 'normal' | 'dim'>(),
  selectedId: null,
  focusAlpha: null,
  pending: [],
  rewireDrag: null,
  now: Date.now(),
});

describe('projection rendering integrity (generic path)', () => {
  it('B1: every received node beyond the root is placed and painted with its received title', () => {
    for (const make of [FIXTURES.normal, FIXTURES.attention, FIXTURES.blocked]) {
      const nodes = projectNodes(make());
      const scene = buildScene(nodes, DEFAULT_WIRING);
      const { ctx, texts } = recordingContext();
      drawGeneric(ctx, 1200, 800, input(scene));
      const painted = texts.join('\n');
      for (const n of nodes) {
        if (n.kind === WORKSPACE_ROOT_KIND) continue;
        expect(endpointBox(scene, n.id), n.id).toBeDefined();
        const title = n.label ?? n.id;
        expect(painted).toContain(title.length > 30 ? title.slice(0, 10) : title);
      }
    }
  });

  it('B1: every relation endpoint of a placed node is itself placed', () => {
    for (const make of Object.values(FIXTURES)) {
      const nodes = projectNodes(make());
      const scene = buildScene(nodes, DEFAULT_WIRING);
      const placed = new Set(nodes.filter((n) => n.kind !== WORKSPACE_ROOT_KIND).map((n) => n.id));
      for (const n of nodes) {
        for (const r of n.relations) {
          if (!placed.has(n.id) || !placed.has(r.target)) continue;
          expect(endpointBox(scene, n.id), n.id).toBeDefined();
          expect(endpointBox(scene, r.target), r.target).toBeDefined();
        }
      }
    }
  });

  it('H: the large fixture builds a complete scene with finite bounds in time', () => {
    const nodes = projectNodes(FIXTURES.large());
    const started = performance.now();
    const scene = buildScene(nodes, DEFAULT_WIRING);
    const took = performance.now() - started;
    for (const n of nodes) {
      if (n.kind === WORKSPACE_ROOT_KIND) continue;
      expect(endpointBox(scene, n.id), n.id).toBeDefined();
    }
    expect(layoutBounds(scene.layout)).not.toBeNull();
    expect(took).toBeLessThan(2000); // sanity, not an invented SLA
  });
});
