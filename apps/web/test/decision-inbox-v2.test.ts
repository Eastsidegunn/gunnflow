// 결정함 v2 pure logic: display groups from wiring data (never a reading of a
// cause or group name), waiting time from the received `since`, the
// exact-bytes copy box tokenization, and the inbox-aside camera framing.
import { describe, expect, it } from 'vitest';
import type { NodeProjection } from '@gunnflow/contract';
import { WIRING_SCHEMA_VERSION, type WiringConfig } from '@gunnflow/contract/wiring';
import {
  DEFAULT_GROUP_NAME,
  configGroups,
  groupKey,
  groupName,
  groupRows,
  groupStartsOpen,
  inboxRows,
  navigableRows,
  nextPendingId,
  relativeSince,
  rowGroup,
  stepSelection,
} from '../src/state/decisionInbox.js';
import { copiedStatement, joinRaw, lineCount, markFor, tokenizeCopyText, utf8Bytes, type CopyLine } from '../src/state/copyText.js';
import { asideCamera, frameIds, lerpCamera, unionRect } from '../src/state/inboxCamera.js';
import { hiddenDraft, shownDecision, textModeFor } from '../src/state/genericActions.js';
import { buildScene } from '../src/canvas/genericScene.js';

describe('action bar text slots (F5): nothing is relayed that the control does not show', () => {
  it('stacked surfaces: a field per text slot; the bar: inline only for the optional primary, else expand', () => {
    const m = (o: Partial<Parameters<typeof textModeFor>[0]>) => textModeFor({ hasText: true, bar: true, required: false, primary: false, ...o });
    expect(m({ hasText: false })).toBe('none');
    expect(m({ bar: false })).toBe('field');
    expect(m({ bar: false, required: true })).toBe('field');
    expect(m({ primary: true })).toBe('inline');
    expect(m({ primary: true, required: true })).toBe('expand');
    expect(m({ required: true })).toBe('expand');
    // The case that used to send directly: an optional, non-primary text slot opens a form now.
    expect(m({})).toBe('expand');
  });

  it('a composing text the control does not show is a hidden draft: never sent, never dropped', () => {
    const typedElsewhere = { text: 'typed on the stage', option: 'x' };
    // Hidden: behind a closed form, or no field at all any more (slot removed by a capability/config change).
    expect(hiddenDraft(typedElsewhere, 'expand', false)).toBe('typed on the stage');
    expect(hiddenDraft(typedElsewhere, 'none', false)).toBe('typed on the stage');
    // Shown: no hidden draft.
    expect(hiddenDraft(typedElsewhere, 'expand', true)).toBeNull();
    expect(hiddenDraft(typedElsewhere, 'inline', false)).toBeNull();
    expect(hiddenDraft(typedElsewhere, 'field', false)).toBeNull();
    // Nothing typed: nothing to protect.
    expect(hiddenDraft({}, 'none', false)).toBeNull();
    expect(hiddenDraft({ text: '' }, 'none', false)).toBeNull();
    // Whitespace is typed bytes too.
    expect(hiddenDraft({ text: ' ' }, 'none', false)).toBe(' ');
  });

  it('sanitizing drops only an EMPTY hidden text; a typed one is never stripped (the send is refused instead)', () => {
    const typed = { text: 'keep me', option: 'x' };
    expect(shownDecision(typed, 'none', false)).toEqual(typed);
    expect(shownDecision(typed, 'expand', false)).toEqual(typed);
    expect(shownDecision({ text: '', option: 'x' }, 'none', false)).toEqual({ option: 'x' });
    expect(shownDecision({ text: '' }, 'expand', true)).toEqual({ text: '' });
    expect(shownDecision({}, 'none', false)).toEqual({});
  });
});

describe('action labels on the canvas (F4)', () => {
  it('scene nodes carry the config label per action, raw name when unlabelled', () => {
    const cfg: WiringConfig = {
      version: V,
      actions: { 'gate.approve': { label: 'Approve' } },
      kinds: { gate: { parts: [{ id: 'approve', part: 'send', action: 'gate.approve', requires: [] }] } },
    };
    const n = node('g', [], {
      capabilities: [
        { action: 'gate.approve', level: 'enabled' },
        { action: 'gate.reject', level: 'enabled' },
      ],
    });
    const scene = buildScene([n], cfg, new Map(), new Map(), new Map());
    expect(scene.nodes.get('g')!.actionLabels).toEqual({ 'gate.approve': 'Approve', 'gate.reject': 'gate.reject' });
  });
});

const V = WIRING_SCHEMA_VERSION;
const node = (id: string, causes: (string | { cause: string; since?: string })[], over: Partial<NodeProjection> = {}): NodeProjection => ({
  id,
  kind: 'gate',
  label: `L-${id}`,
  state: { value: 'waiting' },
  relations: [],
  capabilities: [],
  attention: causes.map((c) => (typeof c === 'string' ? { cause: c } : c)),
  artifacts: [],
  ...over,
});

/** Opaque test vocabulary: the engine must work for any strings. */
const GROUPED: WiringConfig = {
  version: V,
  attention: [
    { match: { cause: 'c-decide' }, mechanism: 'interrupt', group: 'A' },
    { match: { cause: 'c-decide-2' }, mechanism: 'interrupt', group: 'A' },
    { match: { cause: 'c-todo' }, mechanism: 'interrupt', group: 'B' },
    { match: { cause: 'c-plain' }, mechanism: 'interrupt' },
    { match: { cause: 'c-check' }, mechanism: 'ambient', group: 'C' },
    { match: { cause: 'c-check-2' }, mechanism: 'ambient', group: 'C' },
  ],
};

describe('display groups (wiring attention[].group)', () => {
  it('config groups in first-appearance order; interrupt when any of its rules is', () => {
    expect(configGroups(GROUPED)).toEqual([
      { name: 'A', mechanism: 'interrupt' },
      { name: 'B', mechanism: 'interrupt' },
      { name: 'C', mechanism: 'ambient' },
    ]);
    const mixed: WiringConfig = {
      version: V,
      attention: [
        { match: { cause: 'x' }, mechanism: 'ambient', group: 'M' },
        { match: { cause: 'y' }, mechanism: 'interrupt', group: 'M' },
      ],
    };
    expect(configGroups(mixed)).toEqual([{ name: 'M', mechanism: 'interrupt' }]);
    expect(configGroups({ version: V })).toEqual([]);
    expect(configGroups({ version: V, attention: [{ match: { cause: 'x' }, mechanism: 'interrupt' }] })).toEqual([]);
  });

  it('no groups in the config: null — the single list stays exactly as before', () => {
    const cfg: WiringConfig = { version: V, attention: [{ match: { cause: 'c-decide' }, mechanism: 'interrupt' }] };
    const rows = inboxRows([node('a', ['c-decide'])], cfg);
    expect(groupRows(rows, cfg)).toBeNull();
    expect(groupRows([], { version: V })).toBeNull();
  });

  it('a row joins the earliest grouped rule of its strongest mechanism matching one of its causes', () => {
    const row = (causes: string[]) => inboxRows([node('x', causes)], GROUPED)[0]!;
    expect(rowGroup(row(['c-check', 'c-todo']), GROUPED)).toBe('B');
    expect(rowGroup(row(['c-check-2', 'c-decide-2']), GROUPED)).toBe('A');
    expect(rowGroup(row(['c-decide-2', 'c-decide']), GROUPED)).toBe('A');
    expect(rowGroup(row(['c-check-2', 'c-check']), GROUPED)).toBe('C');
    // An interrupt row never joins a group through an ambient rule: no grouped
    // interrupt rule matches here, so it goes to the default group.
    expect(rowGroup(row(['c-plain', 'c-check']), GROUPED)).toBeNull();
    expect(rowGroup(row(['c-plain']), GROUPED)).toBeNull();
    expect(rowGroup(row(['unknown']), GROUPED)).toBeNull();
    expect(rowGroup({ causes: [], mechanism: 'ambient' }, GROUPED)).toBeNull();
  });

  it('reverse-order mixed causes: an ambient grouped rule listed FIRST still cannot take an interrupt row', () => {
    const cfg: WiringConfig = {
      version: V,
      attention: [
        { match: { cause: 'quiet' }, mechanism: 'ambient', group: 'Check' },
        { match: { cause: 'loud' }, mechanism: 'interrupt', group: 'Decide' },
      ],
    };
    const rows = inboxRows([node('m', ['quiet', 'loud']), node('q', ['quiet'])], cfg);
    expect(rows[0]!.mechanism).toBe('interrupt');
    expect(rowGroup(rows[0]!, cfg)).toBe('Decide');
    const groups = groupRows(rows, cfg)!;
    expect(groups.map((g) => [g.name, g.mechanism, g.rows.map((r) => r.id)])).toEqual([
      ['Check', 'ambient', ['q']],
      ['Decide', 'interrupt', ['m']],
    ]);
    // The interrupt row's group starts open; the ambient one starts folded.
    expect(groups.map(groupStartsOpen)).toEqual([false, true]);
    // The interrupt cause's rule is ungrouped and only the ambient cause is grouped: default group, open.
    const cfg2: WiringConfig = {
      version: V,
      attention: [
        { match: { cause: 'quiet' }, mechanism: 'ambient', group: 'Check' },
        { match: { cause: 'loud' }, mechanism: 'interrupt' },
      ],
    };
    const g2 = groupRows(inboxRows([node('m', ['quiet', 'loud'])], cfg2), cfg2)!;
    expect(g2.map((g) => [g.name, g.mechanism, g.rows.map((r) => r.id)])).toEqual([
      ['Check', 'ambient', []],
      [null, 'interrupt', ['m']],
    ]);
    expect(groupStartsOpen(g2[1]!)).toBe(true);
  });

  it('a group mechanism follows its actual rows: interrupt rules with only ambient rows fold', () => {
    const cfg: WiringConfig = {
      version: V,
      attention: [
        { match: { cause: 'loud' }, mechanism: 'interrupt', group: 'Mixed' },
        { match: { cause: 'quiet' }, mechanism: 'ambient', group: 'Mixed' },
      ],
    };
    expect(groupRows(inboxRows([node('q', ['quiet'])], cfg), cfg)![0]!.mechanism).toBe('ambient');
    expect(groupRows(inboxRows([node('q', ['quiet']), node('l', ['loud'])], cfg), cfg)![0]!.mechanism).toBe('interrupt');
    // Empty: the rules' mechanism.
    expect(groupRows([], cfg)![0]!.mechanism).toBe('interrupt');
  });

  it('groups in config order, zero-count groups kept, received order inside, default group last', () => {
    const rows = inboxRows(
      [
        node('k1', ['c-check']),
        node('u1', ['unknown']),
        node('d1', ['c-decide']),
        node('k2', ['c-check-2']),
        node('p1', ['c-plain']),
        node('d2', ['c-decide-2', 'c-check']),
      ],
      GROUPED,
    );
    const groups = groupRows(rows, GROUPED)!;
    expect(groups.map((g) => [g.name, g.mechanism, g.rows.map((r) => r.id)])).toEqual([
      ['A', 'interrupt', ['d1', 'd2']],
      ['B', 'interrupt', []],
      ['C', 'ambient', ['k1', 'k2']],
      // Unmatched (ambient by invariant) and ungrouped-interrupt rows: one default group, interrupt if any row is.
      [null, 'interrupt', ['p1', 'u1']],
    ]);
    // Counts add up: grouping never drops a row.
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(rows.length);
  });

  it('the default group appears only when it has rows; its mechanism follows its rows', () => {
    const rows = inboxRows([node('u1', ['unknown'])], GROUPED);
    const groups = groupRows(rows, GROUPED)!;
    expect(groups.at(-1)).toMatchObject({ name: null, mechanism: 'ambient' });
    expect(groupRows(inboxRows([node('d1', ['c-decide'])], GROUPED), GROUPED)!.map((g) => g.name)).toEqual(['A', 'B', 'C']);
  });

  it('names, fold keys and starting folds: interrupt open, ambient folded', () => {
    expect(groupName({ name: 'C', mechanism: 'ambient' })).toBe('C');
    expect(groupName({ name: null, mechanism: 'ambient' })).toBe(DEFAULT_GROUP_NAME);
    expect(groupKey({ name: null, mechanism: 'ambient' })).not.toBe(groupKey({ name: 'default', mechanism: 'ambient' }));
    expect(groupStartsOpen({ name: 'A', mechanism: 'interrupt' })).toBe(true);
    expect(groupStartsOpen({ name: 'C', mechanism: 'ambient' })).toBe(false);
  });

  it('navigation and auto-advance move through open groups only, in display order', () => {
    const rows = inboxRows([node('k1', ['c-check']), node('d1', ['c-decide']), node('t1', ['c-todo']), node('d2', ['c-decide'])], GROUPED);
    const groups = groupRows(rows, GROUPED)!;
    const nav = navigableRows(groups, groupStartsOpen);
    expect(nav.map((r) => r.id)).toEqual(['d1', 'd2', 't1']);
    expect(nextPendingId(nav, 'd2')).toBe('t1');
    expect(stepSelection(nav, 't1', 1)).toBe('t1');
    // Opening the folded group adds its rows after the others.
    expect(navigableRows(groups, () => true).map((r) => r.id)).toEqual(['d1', 'd2', 't1', 'k1']);
    expect(navigableRows(groups, () => false)).toEqual([]);
  });
});

describe('waiting time (attention.since)', () => {
  const NOW = Date.parse('2026-10-08T12:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('relative steps: 방금 / n분 전 / n시간 전 / n일 전', () => {
    expect(relativeSince(ago(0), NOW)).toBe('방금');
    expect(relativeSince(ago(59_999), NOW)).toBe('방금');
    expect(relativeSince(ago(60_000), NOW)).toBe('1분 전');
    expect(relativeSince(ago(59 * 60_000 + 59_000), NOW)).toBe('59분 전');
    expect(relativeSince(ago(60 * 60_000), NOW)).toBe('1시간 전');
    expect(relativeSince(ago(3 * 3_600_000 + 5), NOW)).toBe('3시간 전');
    expect(relativeSince(ago(23 * 3_600_000 + 59 * 60_000), NOW)).toBe('23시간 전');
    expect(relativeSince(ago(24 * 3_600_000), NOW)).toBe('1일 전');
    expect(relativeSince(ago(10 * 86_400_000), NOW)).toBe('10일 전');
  });

  it('a future time reads as 방금; absent or unparseable shows nothing', () => {
    expect(relativeSince(ago(-120_000), NOW)).toBe('방금');
    expect(relativeSince(undefined, NOW)).toBeNull();
    expect(relativeSince('not a time', NOW)).toBeNull();
    expect(relativeSince('', NOW)).toBeNull();
  });

  it('a row carries the oldest parseable since, verbatim; order stays as received', () => {
    const rows = inboxRows(
      [
        node('a', [{ cause: 'x', since: '2026-10-08T10:00:00Z' }, { cause: 'y', since: '2026-10-08T09:00:00+00:00' }]),
        node('b', [{ cause: 'x', since: 'garbage' }]),
        node('c', ['x']),
        node('d', [{ cause: 'x', since: '2026-10-01T00:00:00Z' }]),
      ],
      { version: V },
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows[0]!.since).toBe('2026-10-08T09:00:00+00:00');
    expect('since' in rows[1]!).toBe(false);
    expect('since' in rows[2]!).toBe(false);
    expect(rows[3]!.since).toBe('2026-10-01T00:00:00Z');
  });
});

describe('copy box: exact bytes, invisible characters made visible', () => {
  const marks = (lines: CopyLine[]) => lines.flatMap((l) => l.tokens.flatMap((t) => (t.kind === 'mark' ? [`${t.cls}:${t.mark}`] : [])));
  const roundTrip = (s: string) => expect(joinRaw(tokenizeCopyText(s))).toBe(s);

  it('the mock-up command: 2 lines, 83 bytes, a line-feed marker at the end of line 1', () => {
    const cmd = 'npm login\nnpm publish packages/contract/gunnflow-contract-0.3.2.tgz --access public';
    const lines = tokenizeCopyText(cmd);
    expect(lines.map((l) => l.number)).toEqual([1, 2]);
    expect(lines[0]!.tokens).toEqual([
      { kind: 'text', raw: 'npm login' },
      { kind: 'mark', raw: '\n', mark: '⏎', cls: 'eol' },
    ]);
    expect(lines[1]!.tokens).toEqual([{ kind: 'text', raw: 'npm publish packages/contract/gunnflow-contract-0.3.2.tgz --access public' }]);
    expect(lineCount(cmd)).toBe(2);
    expect(utf8Bytes(cmd)).toBe(83);
    expect(copiedStatement(cmd)).toBe('✓ 복사됨 · 2줄 · 83바이트');
    roundTrip(cmd);
  });

  it('empty string: no lines, 0 bytes', () => {
    expect(tokenizeCopyText('')).toEqual([]);
    expect(lineCount('')).toBe(0);
    expect(utf8Bytes('')).toBe(0);
    expect(copiedStatement('')).toBe('✓ 복사됨 · 0줄 · 0바이트');
  });

  it('line counting: a trailing line feed opens no new line; blank lines count', () => {
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\n')).toBe(1);
    expect(lineCount('\n')).toBe(1);
    expect(lineCount('a\n\nb')).toBe(3);
    expect(lineCount('a\nb\n')).toBe(2);
    expect(tokenizeCopyText('a\n').map((l) => l.number)).toEqual([1]);
    expect(tokenizeCopyText('a\n\nb').map((l) => l.number)).toEqual([1, 2, 3]);
    for (const s of ['a', 'a\n', '\n', 'a\n\nb', 'a\nb\n', '\n\n']) {
      expect(tokenizeCopyText(s).length, JSON.stringify(s)).toBe(lineCount(s));
      roundTrip(s);
    }
  });

  it('CRLF: the carriage return is a visible control marker before the line-feed marker', () => {
    const s = 'a\r\nb';
    const lines = tokenizeCopyText(s);
    expect(lines).toHaveLength(2);
    expect(marks(lines)).toEqual(['control:␍', 'eol:⏎']);
    expect(lineCount(s)).toBe(2);
    expect(utf8Bytes(s)).toBe(4);
    roundTrip(s);
  });

  it('tab, zero-width characters and BOM each get their marker', () => {
    expect(markFor('\t')).toEqual({ mark: '→', cls: 'tab' });
    expect(markFor(String.fromCodePoint(0x200b))).toEqual({ mark: 'ZWSP', cls: 'zero-width' });
    expect(markFor(String.fromCodePoint(0x200c))).toEqual({ mark: 'ZWNJ', cls: 'zero-width' });
    expect(markFor(String.fromCodePoint(0x200d))).toEqual({ mark: 'ZWJ', cls: 'zero-width' });
    expect(markFor(String.fromCodePoint(0x2060))).toEqual({ mark: 'WJ', cls: 'zero-width' });
    expect(markFor(String.fromCodePoint(0xfeff))).toEqual({ mark: 'BOM', cls: 'zero-width' });
    const s = `${String.fromCodePoint(0xfeff)}npm\tpublish${String.fromCodePoint(0x200b)}`;
    expect(marks(tokenizeCopyText(s))).toEqual(['zero-width:BOM', 'tab:→', 'zero-width:ZWSP']);
    roundTrip(s);
  });

  it('every C0 control (except LF/TAB) is a control picture; DEL is ␡; C1 is its escape', () => {
    for (let code = 0; code < 0x20; code++) {
      if (code === 0x0a || code === 0x09) continue;
      expect(markFor(String.fromCodePoint(code)), `C0 ${code}`).toEqual({ mark: String.fromCodePoint(0x2400 + code), cls: 'control' });
    }
    expect(markFor(String.fromCodePoint(0))!.mark).toBe('␀');
    expect(markFor(String.fromCodePoint(7))!.mark).toBe('␇');
    expect(markFor(String.fromCodePoint(0x1b))!.mark).toBe('␛');
    expect(markFor(String.fromCodePoint(0x7f))).toEqual({ mark: '␡', cls: 'control' });
    for (let code = 0x80; code <= 0x9f; code++) {
      expect(markFor(String.fromCodePoint(code)), `C1 ${code}`).toEqual({ mark: `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`, cls: 'control' });
    }
    expect(markFor(String.fromCodePoint(0x85))!.mark).toBe('\\u0085');
    const s = `echo${String.fromCodePoint(0)}x${String.fromCodePoint(0x1b)}[31m${String.fromCodePoint(0x7f)}${String.fromCodePoint(0x9b)}`;
    expect(marks(tokenizeCopyText(s))).toEqual(['control:␀', 'control:␛', 'control:␡', 'control:\\u009B']);
    roundTrip(s);
  });

  it('bidi controls and line/paragraph separators are marked too (they reorder or break what is seen)', () => {
    for (const code of [0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(markFor(String.fromCodePoint(code)), code.toString(16)).toEqual({ mark: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`, cls: 'bidi' });
    }
    const s = `rm -rf ${String.fromCodePoint(0x202e)}cod.txt`;
    expect(marks(tokenizeCopyText(s))).toEqual(['bidi:U+202E']);
    roundTrip(s);
  });

  it('visible text passes untouched: ASCII, Hangul, emoji (ZWJ inside an emoji sequence is still marked)', () => {
    for (const ch of ['a', ' ', '~', '한', 'é', '😀', '→', '⏎']) expect(markFor(ch), ch).toBeNull();
    const s = '배포 완료 😀';
    expect(tokenizeCopyText(s)).toEqual([{ number: 1, tokens: [{ kind: 'text', raw: s }] }]);
    roundTrip(s);
  });

  it('trailing spaces are marked, before a line feed and at the end; inner spaces are not', () => {
    const s = 'a b  \nc ';
    const lines = tokenizeCopyText(s);
    expect(lines[0]!.tokens).toEqual([
      { kind: 'text', raw: 'a b' },
      { kind: 'mark', raw: ' ', mark: '·', cls: 'trailing-space' },
      { kind: 'mark', raw: ' ', mark: '·', cls: 'trailing-space' },
      { kind: 'mark', raw: '\n', mark: '⏎', cls: 'eol' },
    ]);
    expect(lines[1]!.tokens).toEqual([
      { kind: 'text', raw: 'c' },
      { kind: 'mark', raw: ' ', mark: '·', cls: 'trailing-space' },
    ]);
    expect(marks(tokenizeCopyText('   '))).toEqual(['trailing-space:·', 'trailing-space:·', 'trailing-space:·']);
    roundTrip(s);
    roundTrip('   ');
  });

  it('UTF-8 byte counts: Hangul 3 bytes, emoji 4, ZWJ sequences add up, invisible characters count', () => {
    expect(utf8Bytes('a')).toBe(1);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('한')).toBe(3);
    expect(utf8Bytes('한글')).toBe(6);
    expect(utf8Bytes('😀')).toBe(4);
    expect(utf8Bytes('👨‍👩‍👧')).toBe(18);
    expect(utf8Bytes(String.fromCodePoint(0xfeff))).toBe(3);
    expect(utf8Bytes(String.fromCodePoint(0))).toBe(1);
    expect(utf8Bytes('\r\n')).toBe(2);
    expect(copiedStatement('배포\n완료 😀\n')).toBe('✓ 복사됨 · 2줄 · 19바이트'); // 6 + 1 + 6 + 1 + 4 + 1
  });

  it('round-trips arbitrary mixtures exactly (the copy writes what the box shows)', () => {
    const pool = ['a', ' ', '\n', '\r', '\t', '한', '😀', String.fromCodePoint(0), String.fromCodePoint(0x7f), String.fromCodePoint(0x85), String.fromCodePoint(0x200b), String.fromCodePoint(0xfeff), String.fromCodePoint(0x202e), String.fromCodePoint(0x2028)];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 200; n++) {
      const s = Array.from({ length: Math.floor(rnd() * 24) }, () => pool[Math.floor(rnd() * pool.length)]).join('');
      const lines = tokenizeCopyText(s);
      expect(joinRaw(lines)).toBe(s);
      expect(lines.length).toBe(lineCount(s));
    }
  });
});

describe('inbox-aside camera (view status only)', () => {
  const rel = (type: string, target: string) => ({ type, target });
  const nodes: NodeProjection[] = [
    node('m', [], { kind: 'mission' }),
    node('g', [], { relations: [rel('member-of', 'm'), rel('evidence', 'd')] }),
    node('t', [], { relations: [rel('member-of', 'm'), rel('gate', 'g')] }),
    node('d', [], { relations: [rel('member-of', 'm')] }),
    node('far', [], { relations: [rel('member-of', 'm')] }),
    node('root', []),
  ];
  const isContain = (t: string) => t === 'member-of';

  it('frames the node, its nearest container and its received neighbours (both directions)', () => {
    const parentOf = new Map([['g', 'm'], ['t', 'm'], ['d', 'm'], ['far', 'm'], ['m', 'root']]);
    expect(frameIds(nodes, 'g', parentOf, isContain).sort()).toEqual(['d', 'g', 'm', 't']);
    // Containment edges never pull in siblings or far ancestors.
    expect(frameIds(nodes, 'far', parentOf, isContain).sort()).toEqual(['far', 'm']);
    expect(frameIds(nodes, 'g', undefined, isContain).sort()).toEqual(['d', 'g', 't']);
    expect(frameIds(nodes, 'missing', parentOf, isContain)).toEqual([]);
  });

  it('union of rects; empty is null', () => {
    expect(unionRect([])).toBeNull();
    expect(unionRect([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: -5, w: 5, h: 5 }])).toEqual({ x: 0, y: -5, w: 25, h: 15 });
  });

  it('fits the bounds into the part left of the drawer, centred there; never zooms past 1', () => {
    const view = { width: 1000, height: 600, visibleWidth: 400 };
    const cam = asideCamera({ x: 0, y: 0, w: 100, h: 100 }, view);
    expect(cam.zoom).toBe(1);
    // World centre (50, 50) lands at screen x = 200 (middle of the visible 400px).
    const screenX = view.width / 2 + (50 - cam.x) * cam.zoom;
    expect(screenX).toBeCloseTo(200);
    expect(cam.y).toBe(50);
    const wide = asideCamera({ x: 0, y: 0, w: 1600, h: 100 }, view, 40);
    expect(wide.zoom).toBeCloseTo((400 - 80) / 1600);
    expect(view.width / 2 + (800 - wide.x) * wide.zoom).toBeCloseTo(200);
    // Bounds edges stay inside the visible part with the margin.
    expect(view.width / 2 + (0 - wide.x) * wide.zoom).toBeCloseTo(40);
    expect(view.width / 2 + (1600 - wide.x) * wide.zoom).toBeCloseTo(360);
    expect(asideCamera({ x: 0, y: 0, w: 1e6, h: 1e6 }, view).zoom).toBe(0.15);
  });

  it('interpolates the camera linearly', () => {
    const a = { x: 0, y: 10, zoom: 1 };
    const b = { x: 100, y: -10, zoom: 0.5 };
    expect(lerpCamera(a, b, 0)).toEqual(a);
    expect(lerpCamera(a, b, 1)).toEqual(b);
    expect(lerpCamera(a, b, 0.5)).toEqual({ x: 50, y: 0, zoom: 0.75 });
  });
});
