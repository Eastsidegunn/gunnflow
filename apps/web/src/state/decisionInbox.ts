/**
 * Decision inbox (결정함) queue logic — pure. The queue is a reading of the
 * projection: nodes carrying received attention, interrupt-mapped (wiring)
 * before ambient-mapped, received order within each group. Items observed
 * while the inbox is open that no longer carry attention FOLD into a decided
 * section — folded, never removed (§11: counts stay invariant).
 *
 * Display groups (wiring `attention[].group`) are config data: a row joins the
 * group of the earliest grouped rule matching any of its causes; the engine
 * never reads what a cause or a group name means.
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
  /** The oldest received `attention.since` that parses as a time, verbatim; absent when none. */
  since?: string;
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
      ...sinceOf(n.attention),
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

/** The oldest parseable `since` among a node's attention entries (a value comparison only). */
function sinceOf(attention: NodeProjection['attention']): { since?: string } {
  let best: { at: number; raw: string } | null = null;
  for (const a of attention) {
    if (a.since === undefined) continue;
    const at = Date.parse(a.since);
    if (Number.isNaN(at)) continue;
    if (!best || at < best.at) best = { at, raw: a.since };
  }
  return best ? { since: best.raw } : {};
}

/**
 * Relative waiting time for a received `since` (view status: a difference of
 * two clocks, nothing more). Future or sub-minute → "방금"; unparseable → null.
 */
export function relativeSince(since: string | undefined, now: number): string | null {
  if (since === undefined) return null;
  const at = Date.parse(since);
  if (Number.isNaN(at)) return null;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** The default group's chrome name: for rows whose causes match no grouped rule. */
export const DEFAULT_GROUP_NAME = '그 밖';

export interface InboxGroupDecl {
  /** Config group name (verbatim literal); null for the default group. */
  name: string | null;
  /** interrupt when any rule of the group is interrupt-mapped (default group: any of its rows). */
  mechanism: AttentionMechanism;
}

export interface InboxGroup extends InboxGroupDecl {
  rows: InboxRow[];
}

/** The config's groups, in first-appearance order; empty when the config names none. */
export function configGroups(config: WiringConfig): InboxGroupDecl[] {
  const out: InboxGroupDecl[] = [];
  for (const rule of config.attention ?? []) {
    if (rule.group === undefined) continue;
    const at = out.find((g) => g.name === rule.group);
    if (!at) out.push({ name: rule.group, mechanism: rule.mechanism });
    else if (rule.mechanism === 'interrupt') at.mechanism = 'interrupt';
  }
  return out;
}

/**
 * The group a row joins: among the grouped rules of the row's strongest
 * mechanism (interrupt before ambient) that match one of its causes, the
 * earliest; null = the default group. A row carrying an interrupt cause
 * therefore never lands in a group through an ambient rule.
 */
export function rowGroup(row: Pick<InboxRow, 'causes' | 'mechanism'>, config: WiringConfig): string | null {
  for (const rule of config.attention ?? []) {
    if (rule.group !== undefined && rule.mechanism === row.mechanism && row.causes.includes(rule.match.cause)) return rule.group;
  }
  return null;
}

/** A group's mechanism from its actual rows (interrupt if any is); an empty group keeps its rules' mechanism. */
function rowsMechanism(rows: readonly InboxRow[], fallback: AttentionMechanism): AttentionMechanism {
  if (rows.length === 0) return fallback;
  return rows.some((r) => r.mechanism === 'interrupt') ? 'interrupt' : 'ambient';
}

/**
 * Rows split into display groups: config groups in first-appearance order
 * (zero-count groups included), then the default group when it has rows.
 * Received order is kept inside each group (no sorting). A group's mechanism
 * (fold start, emphasis) follows its actual rows. Null when the config
 * defines no groups — the single-list inbox applies unchanged.
 */
export function groupRows(rows: readonly InboxRow[], config: WiringConfig): InboxGroup[] | null {
  const decls = configGroups(config);
  if (decls.length === 0) return null;
  const groups: InboxGroup[] = decls.map((d) => ({ ...d, rows: [] }));
  const rest: InboxRow[] = [];
  for (const row of rows) {
    const name = rowGroup(row, config);
    const g = name === null ? undefined : groups.find((x) => x.name === name);
    if (g) g.rows.push(row);
    else rest.push(row);
  }
  for (const g of groups) g.mechanism = rowsMechanism(g.rows, g.mechanism);
  if (rest.length > 0) groups.push({ name: null, mechanism: rowsMechanism(rest, 'ambient'), rows: rest });
  return groups;
}

/** A group's display name: its config literal, or the neutral chrome name for the default group. */
export function groupName(group: InboxGroupDecl): string {
  return group.name ?? DEFAULT_GROUP_NAME;
}

/** Stable key for a group's fold state (the default group cannot collide with a config name). */
export function groupKey(group: InboxGroupDecl): string {
  return group.name === null ? 'default' : `g:${group.name}`;
}

/** A group's starting fold: interrupt groups open, ambient groups folded (folded ≠ hidden: the count stays). */
export function groupStartsOpen(group: InboxGroupDecl): boolean {
  return group.mechanism === 'interrupt';
}

/** The rows a person can step through: those of open groups, in display order. */
export function navigableRows(groups: readonly InboxGroup[], isOpen: (g: InboxGroup) => boolean): InboxRow[] {
  return groups.flatMap((g) => (isOpen(g) ? g.rows : []));
}
