// WP-P: the bottom instrument's three readings of the cockpit's own links.
import { describe, expect, it } from 'vitest';
import { connectionInstrument, createProjectionStore } from '../src/state/projectionStore.js';
import { emptyProjection } from '../src/model/types.js';

describe('connection instrument', () => {
  it('live: browser stream up and the BFF reaches the upstream (or does not report)', () => {
    expect(connectionInstrument('live', { connected: true, since: 'x' }, 1)).toEqual({ kind: 'live' });
    expect(connectionInstrument('live', null, 1)).toEqual({ kind: 'live' });
  });

  it('unreachable: browser stream up, the BFF lost the upstream — with the time it did', () => {
    expect(connectionInstrument('live', { connected: false, since: '2026-09-30T10:00:00.000Z' }, 1)).toEqual({
      kind: 'unreachable',
      since: '2026-09-30T10:00:00.000Z',
    });
  });

  it('lost wins over everything (the browser stream itself is down); connecting before the first snapshot', () => {
    expect(connectionInstrument('lost', { connected: false, since: 'x' }, 5)).toEqual({ kind: 'lost', lastSeenAt: 5 });
    expect(connectionInstrument('connecting', null, null)).toEqual({ kind: 'connecting' });
  });

  it('the store carries the reported state; it is a transport fact, not node attention', () => {
    const s = createProjectionStore();
    s.applyUpstream(emptyProjection());
    expect(s.instrument()).toEqual({ kind: 'live' });
    s.applyUpstreamStatus({ connected: false, since: '2026-09-30T10:00:00.000Z' });
    expect(s.instrument().kind).toBe('unreachable');
    expect(s.genericNodes()).toBeNull();
    s.applyUpstreamStatus({ connected: true, since: '2026-09-30T10:00:05.000Z' });
    expect(s.instrument()).toEqual({ kind: 'live' });
  });
});
