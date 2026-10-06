// 결정함 queue logic: ordering by wiring attention mapping (never an engine
// reading of the cause), §11 fold (decided stays, dimmed, counted), and the
// auto-advance steps — all pure.
import { describe, expect, it } from 'vitest';
import type { NodeProjection } from '@gunnflow/contract';
import { WIRING_SCHEMA_VERSION, type WiringConfig } from '@gunnflow/contract/wiring';
import {
  accumulateSeen,
  advanceInQueue,
  decidedRows,
  inboxRows,
  intentBadge,
  nextPendingId,
  stepSelection,
  type InboxRow,
} from '../src/state/decisionInbox.js';

const CONFIG: WiringConfig = {
  version: WIRING_SCHEMA_VERSION,
  attention: [{ match: { cause: 'needs_human' }, mechanism: 'interrupt' }],
};

const node = (id: string, causes: string[], over: Partial<NodeProjection> = {}): NodeProjection => ({
  id,
  kind: 'gate',
  label: `L-${id}`,
  state: { value: 'waiting' },
  relations: [],
  capabilities: [],
  attention: causes.map((cause) => ({ cause })),
  artifacts: [],
  ...over,
});

describe('inboxRows', () => {
  it('queues every node with received attention: interrupt-mapped first, received order kept inside groups', () => {
    const rows = inboxRows(
      [node('amb1', ['flagged']), node('int1', ['needs_human']), node('none', []), node('amb2', ['other']), node('int2', ['x', 'needs_human'])],
      CONFIG,
    );
    expect(rows.map((r) => r.id)).toEqual(['int1', 'int2', 'amb1', 'amb2']);
    expect(rows[0]).toEqual({ id: 'int1', label: 'L-int1', stateValue: 'waiting', causes: ['needs_human'], mechanism: 'interrupt' });
    // The unmapped cause is ambient by engine invariant; the cause string stays verbatim.
    expect(rows[2]!.mechanism).toBe('ambient');
    expect(rows[2]!.causes).toEqual(['flagged']);
  });
});

describe('fold (§11: folded, never removed)', () => {
  const r = (id: string): InboxRow => ({ id, label: id, stateValue: 'waiting', causes: ['needs_human'], mechanism: 'interrupt' });

  it('a row seen while open whose attention cleared moves to decided; totals never shrink', () => {
    let seen = accumulateSeen(new Map(), [r('a'), r('b')]);
    expect(decidedRows(seen, [r('a'), r('b')])).toEqual([]);
    // b's attention cleared; a new c arrived.
    seen = accumulateSeen(seen, [r('a'), r('c')]);
    const pending = [r('a'), r('c')];
    const decided = decidedRows(seen, pending);
    expect(decided.map((x) => x.id)).toEqual(['b']);
    expect(pending.length + decided.length).toBe(3);
  });

  it('accumulateSeen keeps the newest received facts and is a no-op when nothing changed', () => {
    const seen = accumulateSeen(new Map(), [r('a')]);
    expect(accumulateSeen(seen, [r('a')])).toBe(seen);
    const updated = accumulateSeen(seen, [{ ...r('a'), stateValue: 'approved' }]);
    expect(updated.get('a')!.stateValue).toBe('approved');
  });
});

describe('selection movement', () => {
  const pending = [{ id: 'a' }, { id: 'b' }, { id: 'c' }].map((x) => ({
    ...x,
    label: x.id,
    stateValue: 's',
    causes: ['c'],
    mechanism: 'interrupt' as const,
  }));

  it('nextPendingId advances past the decided item and wraps; a vanished item yields its old slot', () => {
    expect(nextPendingId(pending, 'a')).toBe('b');
    expect(nextPendingId(pending, 'c')).toBe('a');
    expect(nextPendingId(pending, 'gone', 1)).toBe('b');
    expect(nextPendingId(pending, null)).toBe('a');
    expect(nextPendingId([], 'a')).toBeNull();
  });

  it('stepSelection moves within bounds (↑↓/jk never leave the list)', () => {
    expect(stepSelection(pending, 'a', 1)).toBe('b');
    expect(stepSelection(pending, 'c', 1)).toBe('c');
    expect(stepSelection(pending, 'a', -1)).toBe('a');
    expect(stepSelection(pending, null, 1)).toBe('a');
    expect(stepSelection([], 'a', 1)).toBeNull();
  });

  it('intentBadge mirrors the pending store: sending, else the error grade, else none', () => {
    expect(intentBadge(true, undefined)).toBe('sending');
    expect(intentBadge(true, 'rejected')).toBe('sending'); // a resend in flight reads as sending
    expect(intentBadge(false, undefined)).toBeNull();
    expect(intentBadge(false, 'unconfirmed')).toBe('unconfirmed');
    expect(intentBadge(false, 'rejected')).toBe('rejected');
    expect(intentBadge(false, 'invalid')).toBe('rejected'); // refused before sending reads as rejected
  });

  it('a rejected item whose attention is still received stays pending (never folds as done)', () => {
    // Fold is driven ONLY by received attention: an upstream rejection leaves
    // the attention in place, so the row stays in the pending list.
    const row: InboxRow = { id: 'a', label: 'a', stateValue: 'waiting', causes: ['needs_human'], mechanism: 'interrupt' };
    const seen = accumulateSeen(new Map(), [row]);
    expect(decidedRows(seen, [row])).toEqual([]); // attention still present → still pending
    expect(intentBadge(false, 'rejected')).toBe('rejected'); // …and it carries the 거부 badge
  });

  it('advanceInQueue (③ queue mode) lands on the next still-pending id, wrapping, else null', () => {
    const queue = ['a', 'b', 'c'];
    expect(advanceInQueue(queue, 'a', new Set(['b', 'c']))).toBe('b');
    expect(advanceInQueue(queue, 'b', new Set(['a']))).toBe('a');
    expect(advanceInQueue(queue, 'c', new Set([]))).toBeNull();
    expect(advanceInQueue(queue, 'outside', new Set(['b']))).toBe('b');
  });
});
