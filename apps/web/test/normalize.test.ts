// Wire → internal normalization: bodies arrive in the cockpit's shape;
// absent collections become empty ones.
import { describe, expect, it } from 'vitest';
import { normalizeProjection } from '../src/model/normalize.js';
import { blockedFixture, gatesFixture } from '@gunnflow-testing/fake-contracts';

describe('normalizeProjection (internal/fake passthrough)', () => {
  it('fake fixtures pass through structurally unchanged', () => {
    for (const fixture of [blockedFixture(), gatesFixture()]) {
      const p = normalizeProjection(fixture);
      expect(p.tasks).toEqual(fixture.tasks);
      expect(p.gates).toEqual(fixture.gates);
      expect(p.deliverables).toEqual(fixture.deliverables);
      expect(p.edges).toEqual(fixture.edges);
      expect(p.capabilities).toEqual(fixture.capabilities);
      expect(p.gateCapabilities).toEqual(fixture.gateCapabilities);
      expect(p.effects).toEqual(fixture.effects);
    }
  });
});

describe('normalizeProjection (absent collections)', () => {
  it('fills missing collections with empty ones and invents nothing else', () => {
    const p = normalizeProjection({ revision: 7, tasks: [] });
    expect(p.revision).toBe(7);
    expect(p.missions).toEqual([]);
    expect(p.capabilities).toEqual({});
    expect(p.counts).toEqual({ running: 0, needsYou: 0, blocked: 0 });
    expect(p.declaredCapabilities).toBeUndefined();
  });
});
