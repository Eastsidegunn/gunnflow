/**
 * View A "Now" (gf-p2-views §1) — pure readings of the received snapshot plus
 * the person's own "last look" marks. Three sections, in this order:
 *
 *   waiting — nodes carrying received attention, grouped and ordered exactly
 *             as the decision inbox groups them (its logic, not a copy);
 *   moving  — nodes the upstream states `active === true` (absent = unknown,
 *             never listed), newest `lastActivityTs` first;
 *   changed — nodes whose received `changedAtRevision` is above what this
 *             person last marked seen. A VIEW (a comparison with a local mark),
 *             never a received fact.
 *
 * Nothing here infers meaning: no progress from children, no priority. A
 * section whose decoration no node in the snapshot carries is UNSUPPORTED —
 * said so, never shown as an empty normal list.
 */
import type { NodeProjection } from '@gunnflow/contract';
import type { WiringConfig } from '@gunnflow/contract/wiring';
import { groupRows, inboxRows, type InboxRow } from './decisionInbox.js';
import { msg, raw, type Msg } from '../i18n/index.js';

/** The cockpit's current view: `now` (view A, a list) or `all` (the full canvas). Local-only view state. */
export type CockpitView = 'now' | 'all';
export const COCKPIT_VIEWS: readonly CockpitView[] = ['now', 'all'];
export const isCockpitView = (v: unknown): v is CockpitView => v === 'now' || v === 'all';

export type NowSection = 'waiting' | 'moving' | 'changed';
export const NOW_SECTIONS: readonly NowSection[] = ['waiting', 'moving', 'changed'];

/** A node's name in a list: the upstream short name, else its label, else its id (all received text). */
export function displayName(n: Pick<NodeProjection, 'id' | 'label' | 'shortName'>): string {
  return n.shortName ?? n.label ?? n.id;
}

/* ---------------- waiting ---------------- */

export interface WaitingGroup {
  /**
   * The group's name as a message: the config literal verbatim (raw), or the
   * inbox's default-group name from the catalog; null when the wiring names no
   * groups (one plain list). A descriptor, never a pre-translated string.
   */
  name: Msg | null;
  rows: InboxRow[];
}

/**
 * The inbox's own rows and groups (decisionInbox.ts): interrupt-mapped before
 * ambient, received order kept, config groups in first-appearance order.
 * Groups with no rows are left out of this list (their count is 0 — nothing waits there).
 */
export function waitingGroups(nodes: readonly NodeProjection[], config: WiringConfig): WaitingGroup[] {
  const rows = inboxRows(nodes, config);
  const groups = groupRows(rows, config);
  if (groups === null) return rows.length > 0 ? [{ name: null, rows }] : [];
  return groups
    .filter((g) => g.rows.length > 0)
    .map((g) => ({ name: g.name === null ? msg('inbox.defaultGroup') : raw(g.name), rows: g.rows }));
}

/* ---------------- moving ---------------- */

/** Whether any node in the snapshot states activity at all; none → the backend does not send it. */
export function activitySupported(nodes: readonly NodeProjection[]): boolean {
  return nodes.some((n) => typeof n.active === 'boolean');
}

/** `active === true` only; newest `lastActivityTs` first, nodes without one last, then by id. */
export function movingNodes(nodes: readonly NodeProjection[]): NodeProjection[] {
  return nodes
    .filter((n) => n.active === true)
    .sort((a, b) => {
      const ta = a.lastActivityTs;
      const tb = b.lastActivityTs;
      if (ta !== undefined && tb !== undefined && ta !== tb) return tb - ta;
      if (ta !== undefined && tb === undefined) return -1;
      if (ta === undefined && tb !== undefined) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/* ---------------- changed (the person's last look) ---------------- */

/**
 * The person's "last look": one global revision plus per-node exceptions
 * (a node opened from the list is seen up to its own change revision).
 * Device-local; never sent anywhere.
 */
export interface SeenRecord {
  /** Global mark: every change at or below this revision counts as seen. 0 = never looked. */
  lastSeen: number;
  /** Per-node marks above the global one. */
  nodes: Readonly<Record<string, number>>;
}

export const EMPTY_SEEN: SeenRecord = { lastSeen: 0, nodes: {} };

const isRevision = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A stored record, cleaned per field; anything malformed reads as "never looked". */
export function sanitizeSeen(raw: unknown): SeenRecord {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const lastSeen = isRevision(o.lastSeen) ? o.lastSeen : 0;
  const nodes: Record<string, number> = {};
  const rawNodes = o.nodes;
  if (typeof rawNodes === 'object' && rawNodes !== null && !Array.isArray(rawNodes)) {
    for (const [id, rev] of Object.entries(rawNodes as Record<string, unknown>)) {
      if (id !== '' && isRevision(rev) && rev > lastSeen) nodes[id] = rev;
    }
  }
  return { lastSeen, nodes };
}

/** What counts as seen for one node: the larger of the global mark and its own. */
export function seenOf(rec: SeenRecord, id: string): number {
  return Math.max(rec.lastSeen, Object.hasOwn(rec.nodes, id) ? rec.nodes[id]! : 0);
}

/** Whether any node in the snapshot states a change revision at all; none → the backend does not send it. */
export function changeSupported(nodes: readonly NodeProjection[]): boolean {
  return nodes.some((n) => n.changedAtRevision !== undefined);
}

/** Nodes changed above what the person has seen; latest change first, then by id. */
export function changedNodes(nodes: readonly NodeProjection[], rec: SeenRecord): NodeProjection[] {
  return nodes
    .filter((n) => n.changedAtRevision !== undefined && n.changedAtRevision > seenOf(rec, n.id))
    .sort((a, b) => b.changedAtRevision! - a.changedAtRevision! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** "Mark all seen": the global mark moves to the current snapshot revision; per-node marks fold into it. */
export function markAllSeen(revision: number): SeenRecord {
  return { lastSeen: Math.max(0, revision), nodes: {} };
}

/**
 * A first visit (no stored record for this upstream on this device): the
 * record starts at the current snapshot revision. Not an advance — there was
 * no earlier look to measure from; later changes show from here on.
 */
export function firstLookRecord(revision: number): SeenRecord {
  return markAllSeen(revision);
}

/** Opening one node marks only that node, up to its own change revision (no-op without one). */
export function markNodeSeen(rec: SeenRecord, node: Pick<NodeProjection, 'id' | 'changedAtRevision'>): SeenRecord {
  const rev = node.changedAtRevision;
  if (rev === undefined || rev <= seenOf(rec, node.id)) return rec;
  return { lastSeen: rec.lastSeen, nodes: { ...rec.nodes, [node.id]: rev } };
}

/** The highest mark in a record: the global one or any per-node one. */
export function highestMark(rec: SeenRecord): number {
  return Math.max(rec.lastSeen, ...Object.values(rec.nodes));
}

/**
 * The upstream revision fell below any of the person's marks (global or per
 * node — the backend was rebuilt): the mark resets to the current revision
 * and every per-node mark clears, so nothing shows as changed. Otherwise the
 * record is returned as is (it is never advanced automatically).
 */
export function reconcileSeen(rec: SeenRecord, revision: number): SeenRecord {
  if (revision >= highestMark(rec)) return rec;
  return markAllSeen(revision);
}

/** Device-local storage key: one record per upstream this cockpit is wired to. */
export function seenStorageKey(upstream: string): string {
  return `gunnflow.now.seen.v1|${upstream}`;
}

/* ---------------- the one list cursor ---------------- */

/** A cursor position: a section and a node (a node may appear in several sections). */
export const cursorKey = (section: NowSection, id: string) => `${section}:${id}`;

export function cursorNodeId(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

export function cursorSection(key: string): NowSection | null {
  const s = key.slice(0, key.indexOf(':'));
  return (NOW_SECTIONS as readonly string[]).includes(s) ? (s as NowSection) : null;
}

/** ↑/↓ across all sections as one list; the cursor never leaves it. Null when the list is empty. */
export function stepCursor(keys: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return delta === 1 ? keys[0]! : keys[keys.length - 1]!;
  return keys[Math.min(keys.length - 1, Math.max(0, at + delta))]!;
}

/** A received ms-epoch time as an ISO string for the shared relative-time reading; undefined stays undefined. */
export function isoOf(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}
