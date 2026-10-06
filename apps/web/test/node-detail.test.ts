// Response → display-state mapping for the on-demand Details section:
// received items pass through untouched; 404 omits, 501 states unsupported.
import { describe, expect, it } from 'vitest';
import { detailViewOf } from '../src/state/nodeDetail.js';

describe('detailViewOf', () => {
  it('a valid 200 carries the detail through untouched', () => {
    const detail = { revision: 20, items: [{ label: 'progress', text: '41/42 tests' }] };
    expect(detailViewOf(200, detail)).toEqual({ kind: 'items', detail });
  });

  it('404 omits the section silently; 501 is explicit unsupported (invariant 2)', () => {
    expect(detailViewOf(404, { reason: 'no detail for this node' })).toEqual({ kind: 'absent' });
    expect(detailViewOf(501, { reason: 'detail is not served by this upstream' })).toEqual({ kind: 'unsupported' });
  });

  it('a malformed 200 is never partially rendered — it becomes unavailable with the problems', () => {
    const view = detailViewOf(200, { revision: 1, items: [{ label: 'x', text: 'a', artifact: { id: 'a', mediaType: 't', access: { kind: 'snapshot' } } }] });
    expect(view.kind).toBe('unavailable');
    expect((view as { reason: string }).reason).toContain('exactly one body');
  });

  it('other statuses carry the upstream reason verbatim, or name the status', () => {
    expect(detailViewOf(502, { reason: 'upstream detail fails the contract: items[0].label …' })).toEqual({
      kind: 'unavailable',
      reason: 'upstream detail fails the contract: items[0].label …',
    });
    expect(detailViewOf(500, null)).toEqual({ kind: 'unavailable', reason: 'detail route answered 500' });
  });
});
