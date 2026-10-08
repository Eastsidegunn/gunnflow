// WP-K: the wiring directory's files merge over the default in file-name order.
import { describe, expect, it } from 'vitest';
import { WIRING_SCHEMA_VERSION, detailEmphasis, type WiringConfig } from '@gunnflow/contract/wiring';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { createWiringState, loadWiringFiles, mergeWiring, type WiringFileEntry } from '../src/wiring/loadWiring.js';
import { configGroups } from '../src/state/decisionInbox.js';

const V = WIRING_SCHEMA_VERSION;
const quiet = () => undefined;

describe('mergeWiring', () => {
  it('tables override per key (whole entry) and add new keys; kinds are replaced whole', () => {
    const over: WiringConfig = {
      version: V,
      render: { running: { glyph: '●', tone: '#6ee7a8' }, triaged: { glyph: '◆', tone: '#4da3ff' } },
      relations: { blocks: { style: 'bold' } },
      viewers: { 'text/csv': 'text' },
      kinds: { mission: { parts: [{ id: 'status', part: 'glyph' }] } },
    };
    const m = mergeWiring(DEFAULT_WIRING, over);
    expect(m.render!.running).toEqual({ glyph: '●', tone: '#6ee7a8' });
    expect(m.render!.triaged).toEqual({ glyph: '◆', tone: '#4da3ff' });
    expect(m.render!.queued).toEqual(DEFAULT_WIRING.render!.queued);
    expect(m.relations!.blocks).toEqual({ style: 'bold' });
    expect(m.relations!.dependency).toEqual(DEFAULT_WIRING.relations!.dependency);
    expect(m.viewers!['text/csv']).toBe('text');
    expect(m.kinds!.mission).toEqual({ parts: [{ id: 'status', part: 'glyph' }] });
    expect(m.kinds!.task).toEqual(DEFAULT_WIRING.kinds!.task);
    expect(m.version).toBe(DEFAULT_WIRING.version);
  });

  it('detail merges per list: a stated list replaces that list whole; absence keeps the base', () => {
    expect(mergeWiring(DEFAULT_WIRING, { version: V }).detail).toEqual(DEFAULT_WIRING.detail);
    expect(mergeWiring(DEFAULT_WIRING, { version: V, detail: { emphasis: ['권고'] } }).detail).toEqual({ emphasis: ['권고'] });
    const both = mergeWiring(DEFAULT_WIRING, { version: V, detail: { copyable: ['command'] } });
    expect(both.detail).toEqual({ emphasis: DEFAULT_WIRING.detail!.emphasis, copyable: ['command'] });
    expect(mergeWiring(both, { version: V, detail: { copyable: ['명령'] } }).detail!.copyable).toEqual(['명령']);
    expect(mergeWiring({ version: V }, { version: V }).detail).toBeUndefined();
  });

  it('detail: {} keeps its old meaning — it replaces (clears) the base detail whole', () => {
    const base = mergeWiring(DEFAULT_WIRING, { version: V, detail: { copyable: ['command'], collapsed: ['digest'] } });
    expect(base.detail).toEqual({ emphasis: DEFAULT_WIRING.detail!.emphasis, copyable: ['command'], collapsed: ['digest'] });
    const cleared = mergeWiring(base, { version: V, detail: {} });
    expect(cleared.detail).toEqual({});
    expect(detailEmphasis(cleared)).toEqual([]);
    // Stating one list is the per-list path again.
    expect(mergeWiring(cleared, { version: V, detail: { emphasis: ['x'] } }).detail).toEqual({ emphasis: ['x'] });
  });

  it('actions merge per key like the other tables', () => {
    const a = mergeWiring(DEFAULT_WIRING, { version: V, actions: { 'x.go': { label: 'Go' }, 'x.stop': { label: 'Stop' } } });
    const b = mergeWiring(a, { version: V, actions: { 'x.go': { label: '가기' } } });
    expect(b.actions).toEqual({ 'x.go': { label: '가기' }, 'x.stop': { label: 'Stop' } });
    expect(mergeWiring(DEFAULT_WIRING, { version: V }).actions).toBeUndefined();
  });

  it('a file that names groups states their order: its rules lead, the base\'s other causes follow', () => {
    const over: WiringConfig = {
      version: V,
      attention: [
        { match: { cause: 'decide' }, mechanism: 'interrupt', group: 'A' },
        { match: { cause: 'waiting_for_human' }, mechanism: 'interrupt', group: 'A' },
        { match: { cause: 'todo' }, mechanism: 'interrupt', group: 'B' },
        { match: { cause: 'flagged' }, mechanism: 'ambient', group: 'C' },
      ],
    };
    const m = mergeWiring({ ...DEFAULT_WIRING, attention: [...DEFAULT_WIRING.attention!, { match: { cause: 'other' }, mechanism: 'ambient' }] }, over);
    expect(m.attention!.map((r) => [r.match.cause, r.group])).toEqual([
      ['decide', 'A'],
      ['waiting_for_human', 'A'],
      ['todo', 'B'],
      ['flagged', 'C'],
      ['other', undefined],
    ]);
    // A later ungrouped file (e.g. a settings edit) keeps that order and the groups.
    const edited = mergeWiring(m, { version: V, attention: [{ match: { cause: 'flagged' }, mechanism: 'interrupt' }] });
    expect(edited.attention!.map((r) => [r.match.cause, r.mechanism, r.group])).toEqual([
      ['decide', 'interrupt', 'A'],
      ['waiting_for_human', 'interrupt', 'A'],
      ['todo', 'interrupt', 'B'],
      ['flagged', 'interrupt', 'C'],
      ['other', 'ambient', undefined],
    ]);
  });

  it('a replacing attention rule without a group keeps the replaced rule\'s group; a stated group wins', () => {
    const base: WiringConfig = { version: V, attention: [{ match: { cause: 'c' }, mechanism: 'interrupt', group: 'G' }] };
    expect(mergeWiring(base, { version: V, attention: [{ match: { cause: 'c' }, mechanism: 'ambient' }] }).attention).toEqual([
      { match: { cause: 'c' }, mechanism: 'ambient', group: 'G' },
    ]);
    expect(mergeWiring(base, { version: V, attention: [{ match: { cause: 'c' }, mechanism: 'ambient', group: 'H' }] }).attention).toEqual([
      { match: { cause: 'c' }, mechanism: 'ambient', group: 'H' },
    ]);
  });

  it('attention merges per cause: a known cause is replaced in place, a new cause is appended', () => {
    const m = mergeWiring(DEFAULT_WIRING, {
      version: V,
      attention: [
        { match: { cause: 'escalated' }, mechanism: 'interrupt' },
        { match: { cause: 'waiting_for_human' }, mechanism: 'ambient' },
      ],
    });
    expect(m.attention).toEqual([
      { match: { cause: 'waiting_for_human' }, mechanism: 'ambient' },
      { match: { cause: 'flagged' }, mechanism: 'ambient' },
      { match: { cause: 'escalated' }, mechanism: 'interrupt' },
    ]);
  });
});

describe('loadWiringFiles', () => {
  const file = (name: string, config: unknown): WiringFileEntry => ({ file: name, config });

  it('layers files in the order given (the BFF sorts by file name): the later file wins', () => {
    const r = loadWiringFiles(
      [
        file('10-a.json', { version: V, render: { running: { glyph: '●', tone: '#5b6672' } } }),
        file('20-b.json', { version: V, render: { running: { glyph: '▶', tone: '#e8a33d' } } }),
      ],
      DEFAULT_WIRING,
      quiet,
    );
    expect(r.config.render!.running).toEqual({ glyph: '▶', tone: '#e8a33d' });
    expect(r.files).toEqual({ loaded: ['10-a.json', '20-b.json'], rejected: [] });
    expect(r.problems).toEqual([]);
  });

  it('skips invalid files and transport errors without failing silently: each is reported with its reasons', () => {
    const logs: string[] = [];
    const r = loadWiringFiles(
      [
        file('a.json', { version: V, render: { running: { glyph: '●', tone: 'not-a-colour' } } }),
        file('b.json', { version: '9.0.0' }),
        { file: 'c.json', error: 'invalid JSON: Unexpected token' },
        file('d.json', { version: V, relations: { blocks: { style: 'bold' } } }),
      ],
      DEFAULT_WIRING,
      (m) => logs.push(m),
    );
    expect(r.files.loaded).toEqual(['d.json']);
    expect(r.files.rejected.map((x) => x.file)).toEqual(['a.json', 'b.json', 'c.json']);
    expect(r.files.rejected.every((x) => x.reasons.length > 0)).toBe(true);
    expect(r.files.rejected[2]!.reasons).toEqual(['invalid JSON: Unexpected token']);
    expect(r.config.render!.running).toEqual(DEFAULT_WIRING.render!.running);
    expect(r.config.relations!.blocks).toEqual({ style: 'bold' });
    expect(logs.length).toBe(3);
  });

  it('re-validates the merged whole: a merge that breaks a limit falls back to the default, with reasons', () => {
    const many = (prefix: string) =>
      Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`${prefix}-${i}`, { glyph: '●', tone: '#dde3ea' }]));
    const r = loadWiringFiles(
      [file('a.json', { version: V, render: many('a') }), file('b.json', { version: V, render: many('b') })],
      DEFAULT_WIRING,
      quiet,
    );
    expect(r.files.loaded).toEqual(['a.json', 'b.json']);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.config).toBe(DEFAULT_WIRING);
  });

  it('no files: the default, unchanged', () => {
    const r = loadWiringFiles([], DEFAULT_WIRING, quiet);
    expect(r.config).toEqual(DEFAULT_WIRING);
    expect(r.files).toEqual({ loaded: [], rejected: [] });
  });
});

describe('wiring state', () => {
  it('starts on the default; a failed fetch keeps it; fetched files replace it', async () => {
    const w = createWiringState();
    expect(w.config).toEqual(DEFAULT_WIRING);
    await w.refresh(() => Promise.reject(new Error('offline')));
    expect(w.config).toEqual(DEFAULT_WIRING);
    await w.refresh(async () => [{ file: 'x.json', config: { version: V, relations: { blocks: { style: 'bold' } } } }]);
    expect(w.config.relations!.blocks).toEqual({ style: 'bold' });
    expect(w.files.loaded).toEqual(['x.json']);
  });
});

describe('lens merge', () => {
  it('a later file replaces a known lens id in place and appends new ones', () => {
    const base: WiringConfig = { version: V, lenses: [{ id: 'hot', label: 'Hot', match: { states: ['running'] } }] };
    const over: WiringConfig = {
      version: V,
      lenses: [
        { id: 'hot', label: 'Busy', match: { states: ['busy'] } },
        { id: 'mine', label: 'Mine', match: { attention: true } },
      ],
    };
    const merged = mergeWiring(base, over);
    expect(merged.lenses).toEqual([
      { id: 'hot', label: 'Busy', match: { states: ['busy'] } },
      { id: 'mine', label: 'Mine', match: { attention: true } },
    ]);
  });
});

describe('example wiring files', () => {
  it('every examples/wiring/*.json validates alone and merges over the default', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../../../examples/wiring/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const config = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as unknown;
      const r = loadWiringFiles([{ file: f, config }], DEFAULT_WIRING, quiet);
      expect(r.files.rejected, f).toEqual([]);
      expect(r.problems, f).toEqual([]);
      // The file's own display-group order survives the merge over the default.
      const alone = configGroups(config as WiringConfig).map((g) => g.name);
      if (alone.length > 0) expect(configGroups(r.config).map((g) => g.name), f).toEqual(alone);
    }
  });
});
