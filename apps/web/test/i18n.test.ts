// i18n: locale resolution order, interpolation, the en fallback, catalog
// parity (ko has exactly en's keys and placeholders), and reactivity — a
// switch re-runs whatever reads `t`, with no reload.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemo, createRoot, createSignal } from 'solid-js';
import { normalFixture } from '@gunnflow-testing/fake-contracts';
import {
  CATALOGS,
  LOCALES,
  locale,
  matchLocale,
  msg,
  msgN,
  raw,
  resolveLocale,
  setLocale,
  t,
  tm,
  tn,
  translate,
  type MessageKey,
  type Msg,
} from '../src/i18n/index.js';
import { en } from '../src/i18n/en.js';
import { ko } from '../src/i18n/ko.js';
import { relativeSince } from '../src/state/decisionInbox.js';
import { KEYBINDINGS, bindingLabel } from '../src/state/keybindings.js';
import { createPendingIntentState } from '../src/state/pendingIntents.js';
import { fakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import { createPrefsState } from '../src/prefs/prefsState.js';
import { copiedMessage } from '../src/state/copyText.js';
import { positionsProblem } from '../src/canvas/layoutGraph.js';
import { personalDocProblem } from '../src/personal/schema.js';
import type { WorkspaceIntent } from '../src/model/types.js';
import { createTerminalStore } from '../src/state/terminalStore.js';

afterEach(() => setLocale('en', { persist: false }));

describe('locale resolution: stored choice → navigator language → en', () => {
  it('a stored choice wins over the browser language', () => {
    expect(resolveLocale('ko', 'en-US')).toBe('ko');
    expect(resolveLocale('en', 'ko-KR')).toBe('en');
  });
  it('without a (valid) stored choice the navigator language decides', () => {
    expect(resolveLocale(null, 'ko')).toBe('ko');
    expect(resolveLocale(null, 'ko-KR')).toBe('ko');
    expect(resolveLocale(undefined, 'KO_kr')).toBe('ko');
    expect(resolveLocale(null, 'en-GB')).toBe('en');
    expect(resolveLocale(null, 'fr-FR')).toBe('en');
    expect(resolveLocale('xx', 'ko-KR')).toBe('ko'); // an unknown stored value is ignored
  });
  it('with neither, en', () => {
    expect(resolveLocale(null, undefined)).toBe('en');
    expect(resolveLocale(undefined, '')).toBe('en');
    expect(matchLocale(null)).toBeNull();
  });
  it('the unit-test runtime starts in en (node has no storage; its navigator is en-US)', () => {
    expect(locale()).toBe('en');
  });
});

describe('t', () => {
  it('interpolates {name} parameters and leaves unknown ones visible', () => {
    expect(t('inbox.pendingCount', { count: 3 })).toBe('3 pending');
    expect(translate('ko', 'inbox.pendingCount', { count: 3 })).toBe('미결 3');
    expect(t('inbox.pendingCount')).toBe('{count} pending');
  });
  it('count forms pick .one / .other', () => {
    expect(tn('copy.lines', 1)).toBe('1 line');
    expect(tn('copy.lines', 2)).toBe('2 lines');
    expect(tn('copy.lines', 0)).toBe('0 lines');
  });
  it('a key missing from a catalog falls back to en (then to the key itself)', () => {
    const koTable = CATALOGS.ko as Record<string, string>;
    const saved = koTable['inbox.title']!;
    delete koTable['inbox.title'];
    try {
      expect(translate('ko', 'inbox.title')).toBe(en['inbox.title']);
    } finally {
      koTable['inbox.title'] = saved;
    }
    expect(translate('ko', 'no.such.key' as MessageKey)).toBe('no.such.key');
  });
});

describe('catalog parity', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it('ko has exactly en’s keys', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const l of LOCALES) expect(Object.keys(CATALOGS[l]).length).toBe(Object.keys(en).length);
  });
  it('every ko text uses the same parameters as its en text', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(ko[key]), key).toEqual(placeholders(en[key]));
    }
  });
  it('no text is empty', () => {
    for (const l of LOCALES) for (const [k, v] of Object.entries(CATALOGS[l])) expect(v.trim(), `${l}:${k}`).not.toBe('');
  });
});

describe('switching the locale', () => {
  it('re-renders what reads t, at once and without a reload', () => {
    createRoot((dispose) => {
      // A rendered inbox header, a relative time and a keybinding description, as a component computes them.
      const header = createMemo(() => `${t('inbox.title')} · ${t('inbox.pendingCount', { count: 2 })}`);
      const NOW = Date.parse('2026-10-08T12:00:00Z');
      const age = createMemo(() => relativeSince(new Date(NOW - 4 * 60_000).toISOString(), NOW));
      const binding = createMemo(() => bindingLabel(KEYBINDINGS[0]));
      expect([header(), age(), binding()]).toEqual(['Decisions · 2 pending', '4m ago', 'Open/close decisions']);
      setLocale('ko', { persist: false });
      expect([header(), age(), binding()]).toEqual(['결정함 · 미결 2', '4분 전', '결정함 열기/닫기']);
      setLocale('en', { persist: false });
      expect(header()).toBe('Decisions · 2 pending');
      dispose();
    });
  });
});

describe('stored messages follow a locale switch', () => {
  const PAUSE: WorkspaceIntent = { nodeId: 't-draft', action: 'task.pause' };

  it('a pending entry’s engine-written reason re-renders; a received rejection stays verbatim', async () => {
    const h = createRoot((dispose) => {
      const [projection] = createSignal(normalFixture());
      let call = 0;
      const post = vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('socket hang up');
        return { accepted: false as const, reason: 'policy says no' };
      });
      const state = createPendingIntentState(post, fakeIntentAdapter, projection);
      // What the toasts render: the errors accessor, read inside a tracked scope.
      const shown = createMemo(() => state.errors().map((e) => e.reason ?? ''));
      return { state, shown, dispose };
    });
    await h.state.submit(PAUSE); // unconfirmed: relay unreachable (the engine's text around the transport error)
    await h.state.submit({ nodeId: 't-draft', action: 'task.resume' }); // rejected upstream: verbatim
    const en = h.shown();
    expect(en.some((r) => r.startsWith('relay unreachable') || r.includes('socket hang up'))).toBe(true);
    expect(en).toContain('policy says no');
    setLocale('ko', { persist: false });
    const ko = h.shown();
    expect(ko).not.toEqual(en); // the engine's wording changed language, without a new send
    expect(ko.find((r) => r.includes('socket hang up'))).not.toBe(en.find((r) => r.includes('socket hang up')));
    expect(ko).toContain('policy says no'); // received text is never translated
    h.dispose();
  });

  it('a settings/prefs save problem written by the engine re-renders in the new language', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 503 })) as typeof fetch;
    try {
      const h = createRoot((dispose) => {
        const prefs = createPrefsState();
        const shown = createMemo(() => prefs.saveProblem());
        return { prefs, shown, dispose };
      });
      await h.prefs.save({ zoomSensitivity: 1.2 });
      expect(h.shown()).toBe('prefs store answered 503');
      setLocale('ko', { persist: false });
      expect(h.shown()).toBe('prefs 저장소 응답 503');
      h.dispose();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('nested messages (copy statement, diagnostics) translate as a whole', () => {
    const stored = copiedMessage('a');
    expect(tm(stored)).toBe('✓ Copied · 1 line · 1 byte');
    setLocale('ko', { persist: false });
    expect(tm(stored)).toBe('✓ 복사됨 · 1줄 · 1바이트');
    expect(tm(msg('settings.notSaved', { reason: raw('disk full') }))).toBe('저장 안 됨 — disk full');
    setLocale('en', { persist: false });
    expect(tm(msg('settings.notSaved', { reason: raw('disk full') }))).toBe('not saved — disk full');
  });

  it('cockpit diagnostics are catalog messages: layout and personal-schema problems', () => {
    const problem = positionsProblem({ nodes: [{ id: 'a', w: 10, h: 10 }], flow: [], parentOf: new Map(), withheld: [] } as never, new Map());
    expect(tm(problem)).toBe('leaf positions: expected 1, got 0');
    const schema = personalDocProblem({ version: 2, notes: {}, stickies: [], boxes: [], links: [], extra: 1 });
    expect(tm(schema)).toBe("unknown key 'extra'");
    setLocale('ko', { persist: false });
    expect(tm(problem)).toBe('잎 노드 위치: 1개 기대, 0개 받음');
    expect(tm(schema)).toBe("알 수 없는 키 'extra'");
  });
});

describe('English count forms (singular and plural)', () => {
  const families = [
    ['copy.lines', '1 line', '2 lines'],
    ['copy.bytes', '1 byte', '2 bytes'],
    ['settings.nodeCount', '1 node', '2 nodes'],
    ['inspector.forks', '1 fork', '2 forks'],
    ['strip.needsYou', '◆ 1 needs you', '◆ 2 need you'],
    ['a11y.wiringOk', 'ok (1 kind)', 'ok (2 kinds)'],
    ['a11y.wiringRejected', 'merge rejected (1 problem) — default in use', 'merge rejected (2 problems) — default in use'],
    ['execution.newEvents', '1 new event ↓', '2 new events ↓'],
    ['terminal.newLines', '1 new line ↓', '2 new lines ↓'],
    ['stream.units.lines', '1 line', '2 lines'],
    ['stream.units.chunks', '1 chunk', '2 chunks'],
    ['stream.ranges', '1 range', '2 ranges'],
    ['stream.breaks', '1 break', '2 breaks'],
    ['stream.malformedGaps', '1 malformed gap declaration ignored', '2 malformed gap declarations ignored'],
    ['personal.list.stickies', '1 sticky note on the canvas.', '2 sticky notes on the canvas.'],
    ['a11y.notes', 'note', 'notes'],
    ['a11y.stickies', 'sticky', 'stickies'],
    ['a11y.boxes', 'box', 'boxes'],
    ['a11y.links', 'link', 'links'],
  ] as const;
  it.each(families)('%s', (base, one, two) => {
    expect(tn(base, 1)).toBe(one);
    expect(tn(base, 2)).toBe(two);
  });
  it('count forms with extra parameters and nested counts', () => {
    expect(tn('execution.truncated', 1, { window: 500 })).toBe('1 older event beyond the 500-event window — full history stays upstream');
    expect(tn('editorCheck.overLimit', 1, { max: 0 })).toBe('body is 1 byte, limit 0');
    expect(tn('editor.bytes', 1, { bytes: 1 })).toBe('1 of 1 byte allowed · not sent');
    expect(t('stream.marker.gap', { from: 7, to: 7, missing: msgN('stream.units.lines', 1) })).toBe('STREAM GAP: 7–7 (1 line missing)');
    expect(t('stream.localDrop', { ranges: msgN('stream.ranges', 1), chunks: msgN('stream.units.chunks', 1), list: 'seq 3–3' })).toBe(
      'LOCAL BUFFER DROP: 1 range · 1 chunk discarded (seq 3–3)',
    );
  });
  it('every .one has an .other and vice versa', () => {
    const keys = Object.keys(en);
    for (const k of keys) {
      if (k.endsWith('.one')) expect(keys, k).toContain(k.replace(/\.one$/, '.other'));
      if (k.endsWith('.other')) expect(keys, k).toContain(k.replace(/\.other$/, '.one'));
    }
  });
});

describe('local refusals always carry a message', () => {
  it('terminal stdin/kill without a session or draft: refusedIntent with a catalog message', async () => {
    const h = createRoot((dispose) => {
      const [projection] = createSignal(normalFixture());
      const pending = createPendingIntentState(vi.fn(async () => ({ accepted: true })), fakeIntentAdapter, projection);
      return { terminal: createTerminalStore(pending), dispose };
    });
    const noSession = await h.terminal.submitStdin('ls');
    expect(noSession).toMatchObject({ accepted: false, invalid: true, reason: 'no session', why: { key: 'terminal.refused.noSession' } });
    expect(await h.terminal.submitKill('x')).toMatchObject({ invalid: true, why: { key: 'terminal.refused.noSession' } });
    setLocale('ko', { persist: false });
    expect(tm((noSession as { why: Msg }).why)).toBe('세션 없음');
    h.dispose();
  });
});
