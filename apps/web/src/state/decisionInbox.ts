/**
 * Decision inbox (결정함) queue logic — pure. The queue is a reading of the
 * projection: nodes carrying received attention, interrupt-mapped (wiring)
 * before ambient-mapped, received order within each group. Items observed
 * while the inbox is open that no longer carry attention FOLD into a decided
 * section — folded, never removed (§11: counts stay invariant).
 */
import type { NodeProjection } from '@gunnflow/contract';
import { attentionMechanism, type AttentionMechanism, type WiringConfig } from '@gunnflow/contract/wiring';

export interface InboxRow {
  id: string;
  label: string;
  /** Received state value, verbatim. */
  stateValue: string;
  /** Received causes, verbatim, in received order. */
  causes: readonly string[];
  /** interrupt when any cause maps to interrupt (config), else ambient. */
  mechanism: AttentionMechanism;
}

/** Current pending rows: every node with received attention, interrupts first. */
export function inboxRows(nodes: readonly NodeProjection[], config: WiringConfig): InboxRow[] {
  const rows = nodes
    .filter((n) => n.attention.length > 0)
    .map((n) => ({
      id: n.id,
      label: n.label ?? n.id,
      stateValue: n.state.value,
      causes: n.attention.map((a) => a.cause),
      mechanism: n.attention.some((a) => attentionMechanism(config, a.cause) === 'interrupt')
        ? ('interrupt' as const)
        : ('ambient' as const),
    }));
  // Stable split, not a sort: received order is kept inside each group.
  return [...rows.filter((r) => r.mechanism === 'interrupt'), ...rows.filter((r) => r.mechanism === 'ambient')];
}

/** Every row seen since the inbox opened, newest facts winning; nothing is dropped. */
export function accumulateSeen(seen: ReadonlyMap<string, InboxRow>, current: readonly InboxRow[]): ReadonlyMap<string, InboxRow> {
  let changed = false;
  const next = new Map(seen);
  for (const row of current) {
    const prev = next.get(row.id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(row)) {
      next.set(row.id, row);
      changed = true;
    }
  }
  return changed ? next : seen;
}

/** Rows whose attention cleared since the inbox opened: folded below, in first-seen order. */
export function decidedRows(seen: ReadonlyMap<string, InboxRow>, current: readonly InboxRow[]): InboxRow[] {
  const pending = new Set(current.map((r) => r.id));
  return [...seen.values()].filter((r) => !pending.has(r.id));
}

/**
 * Auto-advance: the pending row after `afterId`; when that row itself left
 * the queue, the row now at its old index; null when nothing is pending.
 */
export function nextPendingId(pending: readonly InboxRow[], afterId: string | null, lastIndex = 0): string | null {
  if (pending.length === 0) return null;
  const at = afterId === null ? -1 : pending.findIndex((r) => r.id === afterId);
  if (at >= 0) return pending[(at + 1) % pending.length]!.id;
  return pending[Math.min(Math.max(lastIndex, 0), pending.length - 1)]!.id;
}

/** ↑/↓ (j/k) movement over the pending rows; selection never leaves the list. */
export function stepSelection(pending: readonly InboxRow[], selectedId: string | null, delta: 1 | -1): string | null {
  if (pending.length === 0) return null;
  const at = selectedId === null ? -1 : pending.findIndex((r) => r.id === selectedId);
  if (at < 0) return pending[0]!.id;
  return pending[Math.min(pending.length - 1, Math.max(0, at + delta))]!.id;
}

/**
 * The queue row's view of the item's own decision intent (PendingIntentState
 * read, no new machinery): sending while in flight, else the entry error's
 * grade. Nothing here resolves the item — only the projection folds it.
 */
export type IntentBadge = 'sending' | 'unconfirmed' | 'rejected';
export function intentBadge(sending: boolean, errorKind: 'rejected' | 'invalid' | 'unconfirmed' | undefined): IntentBadge | null {
  if (sending) return 'sending';
  if (errorKind === undefined) return null;
  return errorKind === 'unconfirmed' ? 'unconfirmed' : 'rejected';
}

/**
 * Queue-mode advance in ③: when the current node stopped being pending (its
 * decision was applied upstream), the next carried-queue id that is still
 * pending; null when none is (stay put — the record stays on screen).
 */
export function advanceInQueue(queue: readonly string[], currentId: string, stillPending: ReadonlySet<string>): string | null {
  const at = queue.indexOf(currentId);
  const order = at >= 0 ? [...queue.slice(at + 1), ...queue.slice(0, at)] : queue;
  return order.find((id) => stillPending.has(id)) ?? null;
}
