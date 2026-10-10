// GF-E: a relation between a container and its own descendant is not drawn as
// a line (it would read as the containment again) but kept as a nested link
// on the descendant. Decided by containment geometry only — never by name.
import { describe, expect, it } from 'vitest';
import type { NodeProjection } from '@gunnflow/contract';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { buildScene, nestedChipRect } from '../src/canvas/genericScene.js';

const node = (id: string, kind: string, relations: { type: string; target: string }[] = []): NodeProjection => ({
  id,
  kind,
  label: `L-${id}`,
  state: { value: 'x' },
  relations,
  capabilities: [],
  attention: [],
  artifacts: [],
});

describe('nested links', () => {
  // G ⊃ M ⊃ {a, b}; M produces a; G produces b (grandparent); a produces b (siblings); b member-of… only M.
  const nodes = [
    node('G', 'goal'),
    node('M', 'mission', [
      { type: 'member-of', target: 'G' },
      { type: 'produces', target: 'a' },
    ]),
    node('a', 'deliverable', [
      { type: 'member-of', target: 'M' },
      { type: 'produces', target: 'b' },
    ]),
    node('b', 'task', [
      { type: 'member-of', target: 'M' },
      { type: 'dependency', target: 'G' },
    ]),
  ];
  const g2 = { ...nodes[0]!, relations: [{ type: 'produces', target: 'b' }] };
  const scene = buildScene([g2, ...nodes.slice(1)], DEFAULT_WIRING);

  it('container → own member, grandparent → descendant and descendant → container: chips, no lines', () => {
    const lines = scene.edges.map((e) => `${e.from}>${e.to}:${e.type}`);
    expect(lines).not.toContain('M>a:produces');
    expect(lines).not.toContain('G>b:produces');
    expect(lines).not.toContain('b>G:dependency');
    expect(scene.nestedLinks.get('a')).toEqual([{ type: 'produces', other: 'M', direction: 'in' }]);
    expect(scene.nestedLinks.get('b')).toEqual(
      expect.arrayContaining([
        { type: 'produces', other: 'G', direction: 'in' },
        { type: 'dependency', other: 'G', direction: 'out' },
      ]),
    );
  });

  it('siblings inside a container keep their line; the containment itself stays nesting only', () => {
    const lines = scene.edges.map((e) => `${e.from}>${e.to}:${e.type}`);
    expect(lines).toContain('a>b:produces');
    expect(lines.filter((l) => l.includes('member-of'))).toEqual([]);
    expect(scene.nestedLinks.has('M')).toBe(false);
  });

  it('the chip sits on the descendant’s top-left corner; wider for several links', () => {
    const box = { x: 100, y: 50, w: 200, h: 78 };
    expect(nestedChipRect(box, 1)).toEqual({ x: 92, y: 40, w: 20, h: 18 });
    expect(nestedChipRect(box, 2).w).toBeGreaterThan(20);
  });
});
