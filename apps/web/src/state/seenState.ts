/**
 * The person's "last look" marks for view A's Changed section (gf-p2-views §5):
 * device-local (localStorage — marking seen makes no request at all), one
 * record per upstream identity the BFF reports for itself. The actor is this
 * browser profile on this machine (the cockpit carries no actor identity of
 * its own); localStorage is already scoped to it. Never sent upstream, never
 * mixed with projection, pending intents or personal notes.
 *
 * Without an upstream identity, or when the storage fails to read or write
 * (quota, privacy mode), the record lives in
 * memory only and says so: marks do not survive a reload, and no shared
 * fallback record is ever written.
 */
import { createSignal } from 'solid-js';
import {
  EMPTY_SEEN,
  firstLookRecord,
  markAllSeen,
  markNodeSeen,
  reconcileSeen,
  sanitizeSeen,
  seenStorageKey,
  type SeenRecord,
} from './nowView.js';
import type { NodeProjection } from '@gunnflow/contract';

/** The minimal storage surface (window.localStorage in the browser; a map in tests). */
export interface SeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): SeenStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

type NodeMark = Pick<NodeProjection, 'id' | 'changedAtRevision'>;

export function createSeenState(storage: SeenStorage | null = defaultStorage()) {
  /** null until the identity is known — and, on a first visit, until the first snapshot revision. */
  const [record, setRecord] = createSignal<SeenRecord | null>(null);
  /** Whether marks are kept on this device (an identity and a storage that works); false = this session only. */
  const [persistent, setPersistent] = createSignal(false);
  /** The record was started at this visit's first snapshot (no earlier look to measure from). */
  const [firstLook, setFirstLook] = createSignal(false);
  /** Whether the upstream identity question has been answered (bind called). */
  const [bound, setBound] = createSignal(false);
  let key: string | null = null;
  /** Opening a node before the record is ready: kept, applied once it is (never dropped). */
  let queued: NodeMark[] = [];

  /** The storage failed (quota, privacy mode): from here on the record lives in memory only, and says so. */
  const memoryOnly = () => {
    key = null;
    setPersistent(false);
  };
  const persist = (next: SeenRecord) => {
    setRecord(next);
    if (!storage || key === null) return;
    try {
      storage.setItem(key, JSON.stringify(next));
    } catch {
      memoryOnly();
    }
  };
  const flush = () => {
    const cur = record();
    if (cur === null || queued.length === 0) return;
    const marks = queued;
    queued = [];
    const next = marks.reduce(markNodeSeen, cur);
    if (next !== cur) persist(next);
  };
  const update = (f: (r: SeenRecord) => SeenRecord) => {
    const cur = record();
    if (cur === null) return;
    const next = f(cur);
    if (next !== cur) persist(next);
  };

  return {
    record,
    bound,
    persistent,
    firstLook,
    /**
     * Binds to an upstream identity (null: none known — memory only). A
     * stored record loads at once; a first visit waits for the first
     * snapshot revision (reconcile) to start from.
     */
    bind(upstream: string | null) {
      setBound(true);
      key = upstream !== null && storage !== null ? seenStorageKey(upstream) : null;
      setPersistent(key !== null);
      setFirstLook(false);
      let stored: string | null = null;
      try {
        stored = key !== null ? storage!.getItem(key) : null;
      } catch {
        memoryOnly();
      }
      if (stored !== null) {
        let raw: unknown = null;
        try {
          raw = JSON.parse(stored);
        } catch {
          raw = null;
        }
        setRecord(sanitizeSeen(raw));
      } else if (key === null) {
        // Memory only: nothing was ever remembered, so nothing counts as seen.
        setRecord(EMPTY_SEEN);
      } else {
        setRecord(null);
      }
      flush();
    },
    /**
     * Each snapshot revision: a first visit starts its record here (the mark
     * at the current revision — there is no earlier look); a revision below
     * any mark means the backend was rebuilt and the record resets.
     */
    reconcile(revision: number) {
      if (!bound()) return;
      if (record() === null) {
        setFirstLook(true);
        persist(firstLookRecord(revision));
        flush();
        return;
      }
      update((r) => reconcileSeen(r, revision));
    },
    markAll(revision: number) {
      if (record() === null) return;
      setFirstLook(false);
      update(() => markAllSeen(revision));
    },
    markNode(node: NodeMark) {
      if (record() === null) queued.push({ id: node.id, changedAtRevision: node.changedAtRevision });
      else update((r) => markNodeSeen(r, node));
    },
  };
}

export type SeenState = ReturnType<typeof createSeenState>;
