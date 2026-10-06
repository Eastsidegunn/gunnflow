// WP-K: the wiring directory's files merge over the default in file-name order.
import { describe, expect, it } from 'vitest';
import { WIRING_SCHEMA_VERSION, type WiringConfig } from '@gunnflow/contract/wiring';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { createWiringState, loadWiringFiles, mergeWiring, type WiringFileEntry } from '../src/wiring/loadWiring.js';

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

  it('detail replaces whole: the later file states the full emphasis list; absence keeps the base', () => {
    expect(mergeWiring(DEFAULT_WIRING, { version: V }).detail).toEqual(DEFAULT_WIRING.detail);
    expect(mergeWiring(DEFAULT_WIRING, { version: V, detail: { emphasis: ['권고'] } }).detail).toEqual({ emphasis: ['권고'] });
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
