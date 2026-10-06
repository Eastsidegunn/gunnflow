// Depth model (①→②→③): surface resolution and the carried decision-queue
// position — no invented relation, no kind semantics beyond the existing
// kind→surface table. (The ③ context strip and its helpers are gone: the
// screen review ② — ③ fills the screen, return is Esc only.)
import { describe, expect, it } from 'vitest';
import { queueIndexOf, resolveWorkSurface, surfaceForKind } from '../src/state/depth.js';

describe('surfaceForKind', () => {
  it('keeps the existing kind→surface table; anything else has no deep surface', () => {
    expect(surfaceForKind('gate')).toBe('approval');
    expect(surfaceForKind('task')).toBe('inspector');
    expect(surfaceForKind('deliverable')).toBe('assembly');
    expect(surfaceForKind('mission')).toBe('assembly');
    expect(surfaceForKind(undefined)).toBe('assembly');
  });
});

describe('queueIndexOf', () => {
  it('positions the node in a carried queue, -1 outside it', () => {
    expect(queueIndexOf(['a', 'b'], 'b')).toBe(1);
    expect(queueIndexOf(['a', 'b'], 'c')).toBe(-1);
    expect(queueIndexOf(undefined, 'a')).toBe(-1);
  });
});

describe('resolveWorkSurface (live fallback)', () => {
  it('keeps the deep surface when the domain record exists', () => {
    expect(resolveWorkSurface('task', true)).toBe('inspector');
    expect(resolveWorkSurface('gate', true)).toBe('approval');
  });
  it('falls back to the assembly when the projection has no domain record', () => {
    expect(resolveWorkSurface('task', false)).toBe('assembly');
    expect(resolveWorkSurface('gate', false)).toBe('assembly');
  });
  it('assembly kinds never consult the record flag', () => {
    expect(resolveWorkSurface('deliverable', false)).toBe('assembly');
    expect(resolveWorkSurface(undefined, false)).toBe('assembly');
  });
});
