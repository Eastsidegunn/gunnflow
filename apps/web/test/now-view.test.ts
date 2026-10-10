// View A "Now" (gf-p2-views §1) pure logic: section membership and order,
// the person's last-look marks (global + per node, reset on a revision drop),
// unsupported detection, the one list cursor, and the device-local store.
import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import type { NodeProjection } from '@gunnflow/contract';
import { WIRING_SCHEMA_VERSION, type WiringConfig } from '@gunnflow/contract/wiring';
import { createFakeUpstream, projectNodes, viewsFixture } from '@gunnflow-testing/fake-contracts';
import {
  EMPTY_SEEN,
  firstLookRecord,
  highestMark,
  activitySupported,
  changeSupported,
  changedNodes,
  cursorKey,
  cursorNodeId,
  cursorSection,
  displayName,
  markAllSeen,
  markNodeSeen,
  movingNodes,
  reconcileSeen,
  sanitizeSeen,
  seenOf,
  seenStorageKey,
  stepCursor,
  waitingGroups,
} from '../src/state/nowView.js';
import { createSeenState } from '../src/state/seenState.js';
import { groupRows, inboxRows } from '../src/state/decisionInbox.js';
import { msg, raw, setLocale, tm, translate } from '../src/i18n/index.js';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';

const node = (id: string, extra: Partial<NodeProjection> = {}): NodeProjection => ({
  id,
  kind: 'k',
  state: { value: 's' },
  relations: [],
  capabilities: [],
  attention: [],
  artifacts: [],
  ...extra,
});

describe('Now: names and waiting', () => {
  it('a row is named by the short name, else the label, else the id', () => {
    expect(displayName(node('a', { shortName: 'S', label: 'L' }))).toBe('S');
    expect(displayName(node('a', { label: 'L' }))).toBe('L');
    expect(displayName(node('a'))).toBe('a');
  });

  it('waiting = the decision inbox rows, in its order (interrupt before ambient, received order kept)', () => {
    const config: WiringConfig = {
      version: WIRING_SCHEMA_VERSION,
      attention: [
        { match: { cause: 'ask' }, mechanism: 'interrupt' },
        { match: { cause: 'note' }, mechanism: 'ambient' },
      ],
    };
    const nodes = [
      node('n1', { attention: [{ cause: 'note' }] }),
      node('n2', { attention: [{ cause: 'ask' }] }),
      node('n3'),
      node('n4', { attention: [{ cause: 'ask' }] }),
    ];
    const groups = waitingGroups(nodes, config);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBeNull();
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(inboxRows(nodes, config).map((r) => r.id));
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['n2', 'n4', 'n1']);
  });

  it('with wiring groups, the inbox groups in their order; groups with no rows are left out', () => {
    const config: WiringConfig = {
      version: WIRING_SCHEMA_VERSION,
      attention: [
        { match: { cause: 'ask' }, mechanism: 'interrupt', group: 'Decide' },
        { match: { cause: 'todo' }, mechanism: 'interrupt', group: 'Do' },
        { match: { cause: 'note' }, mechanism: 'ambient', group: 'Check' },
      ],
    };
    const nodes = [node('a', { attention: [{ cause: 'note' }] }), node('b', { attention: [{ cause: 'ask' }] }), node('c', { attention: [{ cause: 'other' }] })];
    const groups = waitingGroups(nodes, config);
    const inbox = groupRows(inboxRows(nodes, config), config)!.filter((g) => g.rows.length > 0);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual(inbox.map((g) => g.rows.map((r) => r.id)));
    // Names are descriptors: config literals verbatim, the default group from the catalog (translated when read).
    expect(groups.map((g) => g.name)).toEqual([raw('Decide'), raw('Check'), msg('inbox.defaultGroup')]);
    setLocale('en', { persist: false });
    expect(groups.map((g) => tm(g.name))).toEqual(['Decide', 'Check', 'Other']);
    // A locale switch re-reads the stored descriptors: the config names stay as received.
    setLocale('ko', { persist: false });
    expect(groups.map((g) => tm(g.name))).toEqual(['Decide', 'Check', translate('ko', 'inbox.defaultGroup')]);
    setLocale('en', { persist: false });
  });

  it('nothing waiting → no groups', () => {
    expect(waitingGroups([node('a')], DEFAULT_WIRING)).toEqual([]);
  });
});

describe('Now: moving', () => {
  it('only active === true; newest activity first, no time last, then by id', () => {
    const nodes = [
      node('z', { active: true }),
      node('old', { active: true, lastActivityTs: 100 }),
      node('off', { active: false, lastActivityTs: 999 }),
      node('unknown', { lastActivityTs: 999 }),
      node('a', { active: true }),
      node('new', { active: true, lastActivityTs: 500 }),
    ];
    expect(movingNodes(nodes).map((n) => n.id)).toEqual(['new', 'old', 'a', 'z']);
  });

  it('activity is unsupported when no node states it (absent is unknown, not false)', () => {
    expect(activitySupported([node('a'), node('b', { lastActivityTs: 5 })])).toBe(false);
    expect(activitySupported([node('a'), node('b', { active: false })])).toBe(true);
  });
});

describe('Now: changed since the last look (a view)', () => {
  const nodes = [
    node('a', { changedAtRevision: 3 }),
    node('b', { changedAtRevision: 9 }),
    node('c', { changedAtRevision: 9 }),
    node('d'),
    node('e', { changedAtRevision: 6 }),
  ];

  it('never looked → every stated change, latest first, ties by id', () => {
    expect(changedNodes(nodes, EMPTY_SEEN).map((n) => n.id)).toEqual(['b', 'c', 'e', 'a']);
  });

  it('seen = max(global, per node); a node opened is seen up to its own change only', () => {
    let rec = { lastSeen: 5, nodes: {} };
    expect(changedNodes(nodes, rec).map((n) => n.id)).toEqual(['b', 'c', 'e']);
    rec = markNodeSeen(rec, nodes[1]!);
    expect(seenOf(rec, 'b')).toBe(9);
    expect(seenOf(rec, 'c')).toBe(5);
    expect(changedNodes(nodes, rec).map((n) => n.id)).toEqual(['c', 'e']);
    // A node without a change revision, or one already seen, leaves the record untouched.
    expect(markNodeSeen(rec, nodes[3]!)).toBe(rec);
    expect(markNodeSeen(rec, { id: 'a', changedAtRevision: 3 })).toBe(rec);
  });

  it('mark all seen moves the global mark to the snapshot revision and folds the per-node marks', () => {
    const rec = markAllSeen(10);
    expect(rec).toEqual({ lastSeen: 10, nodes: {} });
    expect(changedNodes(nodes, rec)).toEqual([]);
  });

  it('a revision below the mark (backend rebuilt) resets to the current revision; nothing shows as changed', () => {
    const rec = { lastSeen: 50, nodes: { x: 60 } };
    const reset = reconcileSeen(rec, 9);
    expect(reset).toEqual({ lastSeen: 9, nodes: {} });
    expect(changedNodes(nodes, reset)).toEqual([]);
    // At or above every mark, the record stays as it is (it is never advanced automatically).
    const same = { lastSeen: 5, nodes: { b: 9 } };
    expect(reconcileSeen(same, 9)).toBe(same);
    expect(reconcileSeen(same, 40)).toBe(same);
  });

  it('a revision below a per-node mark is a drop too: everything resets, every per-node mark clears', () => {
    expect(highestMark({ lastSeen: 0, nodes: { x: 10 } })).toBe(10);
    expect(reconcileSeen({ lastSeen: 0, nodes: { x: 10 } }, 5)).toEqual({ lastSeen: 5, nodes: {} });
    expect(reconcileSeen({ lastSeen: 3, nodes: { x: 10, y: 4 } }, 9)).toEqual({ lastSeen: 9, nodes: {} });
    const ok = { lastSeen: 0, nodes: { x: 10 } };
    expect(reconcileSeen(ok, 10)).toBe(ok);
  });

  it('a first visit starts at the current revision (no earlier look to measure from)', () => {
    expect(firstLookRecord(10)).toEqual({ lastSeen: 10, nodes: {} });
    expect(changedNodes(nodes, firstLookRecord(10))).toEqual([]);
  });

  it('change revisions are unsupported when no node states one', () => {
    expect(changeSupported([node('a'), node('b', { active: true })])).toBe(false);
    expect(changeSupported(nodes)).toBe(true);
  });

  it('a stored record is cleaned per field', () => {
    expect(sanitizeSeen(null)).toEqual(EMPTY_SEEN);
    expect(sanitizeSeen({ lastSeen: -1, nodes: [] })).toEqual(EMPTY_SEEN);
    expect(sanitizeSeen({ lastSeen: 4, nodes: { a: 7, b: 2, c: 'x', '': 9 } })).toEqual({ lastSeen: 4, nodes: { a: 7 } });
  });
});

describe('Now: the one list cursor', () => {
  it('walks every section as one list and never leaves it', () => {
    const keys = [cursorKey('waiting', 'a'), cursorKey('moving', 'a'), cursorKey('changed', 'b')];
    expect(stepCursor(keys, null, 1)).toBe('waiting:a');
    expect(stepCursor(keys, null, -1)).toBe('changed:b');
    expect(stepCursor(keys, 'waiting:a', 1)).toBe('moving:a');
    expect(stepCursor(keys, 'changed:b', 1)).toBe('changed:b');
    expect(stepCursor(keys, 'waiting:a', -1)).toBe('waiting:a');
    expect(stepCursor([], 'x', 1)).toBeNull();
    expect(cursorNodeId('changed:a:b')).toBe('a:b');
    expect(cursorSection('moving:x')).toBe('moving');
    expect(cursorSection('bogus:x')).toBeNull();
  });
});

describe('Now: the last-look store is device-local, one record per upstream', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('first visit: no record until the first revision, then the mark starts there and persists under the upstream key', () => {
    const storage = memory();
    createRoot((dispose) => {
      const s = createSeenState(storage);
      expect(s.record()).toBeNull();
      s.reconcile(7); // unbound: nothing happens
      expect(s.record()).toBeNull();
      s.bind('fake');
      expect(s.persistent()).toBe(true);
      expect(s.record()).toBeNull();
      s.reconcile(10);
      expect(s.record()).toEqual({ lastSeen: 10, nodes: {} });
      expect(s.firstLook()).toBe(true);
      expect(JSON.parse(storage.m.get(seenStorageKey('fake'))!)).toEqual({ lastSeen: 10, nodes: {} });
      s.markNode({ id: 'a', changedAtRevision: 12 });
      s.markAll(12);
      expect(s.firstLook()).toBe(false);
      expect(JSON.parse(storage.m.get(seenStorageKey('fake'))!)).toEqual({ lastSeen: 12, nodes: {} });
      // Upstreams stay apart: another one is a first visit of its own.
      s.bind('direct → http://example.test');
      expect(s.record()).toBeNull();
      dispose();
    });
    createRoot((dispose) => {
      const again = createSeenState(storage);
      again.bind('fake');
      expect(again.record()).toEqual({ lastSeen: 12, nodes: {} });
      again.reconcile(12);
      expect(again.firstLook()).toBe(false);
      dispose();
    });
  });

  it('a node opened before the record is ready is queued, never dropped', () => {
    const storage = memory();
    storage.setItem(seenStorageKey('fake'), JSON.stringify({ lastSeen: 2, nodes: {} }));
    createRoot((dispose) => {
      const s = createSeenState(storage);
      s.markNode({ id: 'a', changedAtRevision: 5 }); // the identity is still on its way
      s.bind('fake');
      expect(s.record()).toEqual({ lastSeen: 2, nodes: { a: 5 } });
      expect(JSON.parse(storage.m.get(seenStorageKey('fake'))!)).toEqual({ lastSeen: 2, nodes: { a: 5 } });
      dispose();
    });
  });

  it('a storage that throws on read: memory only from the start, no key used', () => {
    const writes: string[] = [];
    const broken = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (k: string) => void writes.push(k),
    };
    createRoot((dispose) => {
      const s = createSeenState(broken);
      s.bind('fake');
      expect(s.persistent()).toBe(false);
      expect(s.record()).toEqual(EMPTY_SEEN);
      s.markAll(10);
      expect(s.record()).toEqual({ lastSeen: 10, nodes: {} });
      expect(writes).toEqual([]);
      dispose();
    });
  });

  it('a storage that throws on write: switches to memory only and keeps the record', () => {
    let attempts = 0;
    const full = {
      getItem: (): string | null => null,
      setItem: () => {
        attempts++;
        throw new Error('quota');
      },
    };
    createRoot((dispose) => {
      const s = createSeenState(full);
      s.bind('fake');
      expect(s.persistent()).toBe(true);
      s.reconcile(10); // first visit: the write fails
      expect(s.persistent()).toBe(false);
      expect(s.record()).toEqual({ lastSeen: 10, nodes: {} });
      s.markNode({ id: 'a', changedAtRevision: 12 });
      expect(s.record()).toEqual({ lastSeen: 10, nodes: { a: 12 } });
      expect(attempts).toBe(1); // no further writes once memory-only
      dispose();
    });
  });

  it('no upstream identity: memory only, nothing written, nothing counted as seen', () => {
    const storage = memory();
    createRoot((dispose) => {
      const s = createSeenState(storage);
      s.bind(null);
      expect(s.persistent()).toBe(false);
      expect(s.record()).toEqual(EMPTY_SEEN);
      s.reconcile(10);
      expect(s.firstLook()).toBe(false);
      s.markNode({ id: 'a', changedAtRevision: 4 });
      s.markAll(10);
      expect(s.record()).toEqual({ lastSeen: 10, nodes: {} });
      expect(storage.m.size).toBe(0);
      dispose();
    });
  });
});

describe('Now: the views scenario fills every section', () => {
  it('waiting, moving (one without a time, last) and changed all have rows; unknown activity is not listed', () => {
    const p = viewsFixture();
    const nodes = projectNodes(p);
    expect(waitingGroups(nodes, DEFAULT_WIRING).flatMap((g) => g.rows.map((r) => r.id))).toEqual(['t-build', 't-test']);
    expect(movingNodes(nodes).map((n) => n.id)).toEqual(['t-build', 't-draft', 'm1']);
    expect(nodes.find((n) => n.id === 'm1')!.lastActivityTs).toBeUndefined();
    expect(changedNodes(nodes, EMPTY_SEEN).map((n) => n.id)).toEqual(['m1', 't-build', 't-draft', 't-test', 'd-report', 't-research']);
    expect(changedNodes(nodes, markAllSeen(p.revision))).toEqual([]);
    // The undecorated scenario says neither activity nor change.
    const plain = (createFakeUpstream('normal').snapshot().body as { nodes: NodeProjection[] }).nodes;
    expect(activitySupported(plain)).toBe(false);
    expect(changeSupported(plain)).toBe(false);
  });
});


describe('Now: every string comes from the catalog (en default, ko translation)', () => {
  it('count-bearing headings take the count form', () => {
    expect(translate('en', 'now.changed.heading.one', { count: 1 })).toBe('1 change since your last look');
    expect(translate('en', 'now.changed.heading.other', { count: 6 })).toBe('6 changes since your last look');
    expect(translate('en', 'now.waiting.heading.other', { count: 2 })).toBe('2 waiting on you');
    expect(translate('ko', 'now.waiting.heading.other', { count: 2 })).toBe('나를 기다림 2');
    expect(translate('en', 'view.now')).toBe('Now');
    expect(translate('ko', 'view.all')).toBe('전체');
    expect(translate('en', 'now.changed.markAll')).toBe('Mark all seen');
    expect(translate('ko', 'now.changed.markAll')).toBe('모두 봤음');
  });
});
