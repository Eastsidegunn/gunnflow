// Wiring config: config is data — closed shapes, closed engine tokens, no
// expressions, references only to real siblings, inputs bound to their send.
import { describe, expect, it } from 'vitest';
import {
  WIRING_LIMITS,
  WIRING_SCHEMA_VERSION,
  attentionMechanism,
  coveredActions,
  actionLabel,
  attentionGroup,
  detailCollapsed,
  detailCopyable,
  detailEmphasis,
  kindParts,
  kindShape,
  RELATION_ROLES,
  relationArrangeFor,
  relationRoleFor,
  SHAPE_IDS,
  renderFor,
  validateWiringConfig,
  viewerFor,
  type WiringConfig,
} from '../src/wiring/index.js';

const valid: WiringConfig = {
  version: WIRING_SCHEMA_VERSION,
  render: { running: { glyph: '▶', tone: '#4da3ff' }, blocked: { glyph: '■', tone: '#ff5d5d' } },
  relations: { depends_on: { style: 'solid' } },
  attention: [{ match: { cause: 'waiting_for_human' }, mechanism: 'interrupt' }],
  viewers: { 'text/markdown': 'markdown-source', 'text/html': 'html-isolated', 'image/*': 'image' },
  kinds: {
    approval: {
      parts: [
        { id: 'status', part: 'glyph' },
        { id: 'title', part: 'label', source: 'kind' },
        { id: 'name', part: 'label', source: 'label' },
        { id: 'evidence', part: 'viewer', source: { artifact: 0 } },
        { id: 'choice', part: 'selector', action: 'decide' },
        { id: 'reason', part: 'text', action: 'decide' },
        { id: 'submit', part: 'send', action: 'decide', requires: ['choice', 'reason'] },
        { id: 'log', part: 'stream', source: { role: 'pty' }, retainItems: 500, retainBytes: 65536 },
        { id: 'body', part: 'editor', action: 'edit', rows: 12, wrap: 'soft' },
        { id: 'save', part: 'send', action: 'edit', requires: ['body'] },
      ],
    },
  },
};

const problemsOf = (config: unknown) => {
  const r = validateWiringConfig(config);
  return r.ok ? [] : r.problems;
};
const withKind = (parts: unknown[]) => ({ version: WIRING_SCHEMA_VERSION, kinds: { k: { parts } } });

describe('wiring config validator', () => {
  it('accepts a valid config; lists the actions an assembly covers', () => {
    expect(validateWiringConfig(valid)).toEqual({ ok: true, config: valid });
    expect(coveredActions(valid, 'approval')).toEqual(['decide', 'edit']);
    expect(attentionMechanism(valid, 'waiting_for_human')).toBe('interrupt');
    expect(attentionMechanism(valid, 'anything-else')).toBe('ambient');
    expect(validateWiringConfig({ version: WIRING_SCHEMA_VERSION }).ok).toBe(true);
  });

  it('detail.emphasis: labels verbatim — non-empty strings, capped, closed shape', () => {
    expect(problemsOf({ ...valid, detail: { emphasis: ['recommendation', '권고'] } })).toEqual([]);
    expect(detailEmphasis({ ...valid, detail: { emphasis: ['recommendation'] } })).toEqual(['recommendation']);
    expect(detailEmphasis(valid)).toEqual([]);
    expect(problemsOf({ ...valid, detail: { emphasis: [''] } }).join()).toContain('config.detail.emphasis[0]');
    expect(problemsOf({ ...valid, detail: { emphasis: 'recommendation' } }).join()).toContain('must be an array');
    expect(problemsOf({ ...valid, detail: { emphasis: [], bold: true } }).join()).toContain("unknown key 'bold'");
    expect(problemsOf({ ...valid, detail: { emphasis: Array.from({ length: WIRING_LIMITS.detailEmphasis + 1 }, (_, i) => `l${i}`) } }).join()).toContain(
      `more than ${WIRING_LIMITS.detailEmphasis}`,
    );
  });

  it('refuses unknown keys at every level (closed structure)', () => {
    expect(problemsOf({ ...valid, theme: 'dark' }).join()).toContain("unknown key 'theme'");
    expect(problemsOf({ ...valid, render: { x: { glyph: '●', tone: '#5b6672', color: 'red' } } }).join()).toContain("unknown key 'color'");
    expect(problemsOf(withKind([{ id: 'g', part: 'glyph', onClick: 'x' }])).join()).toContain("unknown key 'onClick'");
    expect(problemsOf({ ...valid, attention: [{ match: { cause: 'c', when: 'x' }, mechanism: 'ambient' }] }).join()).toContain("unknown key 'when'");
  });

  it('render is open to literals: any short unicode glyph and any #rrggbb tone', () => {
    expect(problemsOf({ ...valid, render: { x: { glyph: '🚀', tone: '#ff0000' } } })).toEqual([]);
    expect(problemsOf({ ...valid, render: { x: { glyph: '👨‍👩‍👧', tone: '#00FF00' } } })).toEqual([]); // ZWJ sequence passes
    expect(problemsOf({ ...valid, render: { x: { glyph: 'star', tone: '#5b6672' } } })).toEqual([]); // a non-token word is just a literal now
  });

  it('render literals stay data: no control/bidi glyphs, no non-hex tones, length capped', () => {
    expect(problemsOf({ ...valid, render: { x: { glyph: 'a‮b', tone: '#5b6672' } } }).join()).toContain('glyph'); // bidi override
    expect(problemsOf({ ...valid, render: { x: { glyph: '\u0007', tone: '#5b6672' } } }).join()).toContain('glyph'); // control
    expect(problemsOf({ ...valid, render: { x: { glyph: '   ', tone: '#5b6672' } } }).join()).toContain('glyph'); // whitespace only
    expect(problemsOf({ ...valid, render: { x: { glyph: 'x'.repeat(17), tone: '#5b6672' } } }).join()).toContain('glyph');
    expect(problemsOf({ ...valid, render: { x: { glyph: '●', tone: 'red' } } }).join()).toContain('tone'); // not a token, not hex
    expect(problemsOf({ ...valid, render: { x: { glyph: '●', tone: '#ff00' } } }).join()).toContain('tone'); // short hex
  });

  it('refuses values outside the engine token sets and reserved draft tokens', () => {
    expect(problemsOf({ ...valid, relations: { r: { style: 'dashed' } } }).join()).toContain('style');
    expect(problemsOf({ ...valid, relations: { r: { style: '--draft-edge' } } }).join()).toContain('reserved token');
    // Diagram viewers take only their own media types.
    for (const k of ['text/vnd.mermaid', 'text/x-mermaid']) expect(problemsOf({ ...valid, viewers: { [k]: 'mermaid' } })).toEqual([]);
    expect(problemsOf({ ...valid, viewers: { 'application/vnd.excalidraw+json': 'excalidraw' } })).toEqual([]);
    for (const [k, v] of [['application/json', 'excalidraw'], ['text/plain', 'mermaid'], ['text/*', 'mermaid'], ['application/vnd.excalidraw+json', 'mermaid'], ['text/vnd.mermaid', 'excalidraw']]) {
      expect(problemsOf({ ...valid, viewers: { [k!]: v } }).join(), `${k} → ${v}`).toContain(`'${v}' is only for`);
    }
        // Layout vocabulary is the one closed `arrange` token; parameters and expressions are refused.
    for (const arrange of ['flow', 'contain', 'none']) expect(problemsOf({ ...valid, relations: { r: { style: 'solid', arrange } } })).toEqual([]);
    expect(problemsOf({ ...valid, relations: { r: { style: 'solid', arrange: 'radial' } } }).join()).toContain('arrange');
    expect(problemsOf({ ...valid, relations: { r: { style: 'solid', arrange: '${dir}' } } }).length).toBeGreaterThan(0);
    expect(problemsOf({ ...valid, relations: { r: { style: 'solid', arrange: 'flow', direction: 'down' } } }).join()).toContain('direction');
    expect(problemsOf({ ...valid, relations: { r: { style: 'solid', arrange: { algorithm: 'layered' } } } }).length).toBeGreaterThan(0);
    expect(problemsOf({ ...valid, viewers: { 'text/plain': 'iframe' } }).join()).toContain('must be one of');
    expect(problemsOf({ ...valid, viewers: { 'text/plain': 'html-isolated' } }).join()).toContain('only for text/html');
    expect(problemsOf({ ...valid, viewers: { markdown: 'text' } }).join()).toContain('media type');
    expect(problemsOf({ ...valid, attention: [{ match: { cause: 'c' }, mechanism: 'popup' }] }).join()).toContain('mechanism');
  });

  it('refuses expression-like strings anywhere, keys included', () => {
    for (const bad of ['{{state}}', '${x}', 'x => x', 'function () {}', '`tpl`']) {
      expect(problemsOf({ ...valid, render: { [bad]: { glyph: '●', tone: '#5b6672' } } }).join(), bad).toContain('expression-like');
      expect(problemsOf(withKind([{ id: 's', part: 'send', action: bad, requires: [] }])).join(), bad).toContain('expression-like');
    }
  });

  it('send rules: sibling references only, no self/send refs, one send per action, inputs bound to their send', () => {
    expect(problemsOf(withKind([{ id: 's', part: 'send', action: 'a', requires: ['ghost'] }])).join()).toContain("unknown sibling 'ghost'");
    expect(problemsOf(withKind([{ id: 's', part: 'send', action: 'a', requires: ['s'] }])).join()).toContain('requires itself');
    expect(
      problemsOf(withKind([
        { id: 's1', part: 'send', action: 'a', requires: [] },
        { id: 's2', part: 'send', action: 'b', requires: ['s1'] },
      ])).join(),
    ).toContain('another send');
    expect(
      problemsOf(withKind([
        { id: 's1', part: 'send', action: 'a', requires: [] },
        { id: 's2', part: 'send', action: 'a', requires: [] },
      ])).join(),
    ).toContain('two sends');
    expect(
      problemsOf(withKind([
        { id: 't', part: 'text', action: 'b' },
        { id: 's', part: 'send', action: 'a', requires: ['t'] },
      ])).join(),
    ).toContain('different action');
    expect(problemsOf(withKind([{ id: 't', part: 'text', action: 'a' }])).join()).toContain('has no send');
    // An optional input: carried by its action's send without being a precondition.
    expect(
      problemsOf(withKind([
        { id: 't', part: 'text', action: 'a' },
        { id: 's', part: 'send', action: 'a', requires: [] },
      ])),
    ).toEqual([]);
  });

  it('part shapes: ids, positional viewer binding, editor and stream params, version', () => {
    expect(problemsOf(withKind([{ id: 'Bad Id', part: 'glyph' }])).join()).toContain('[a-z]');
    expect(problemsOf(withKind([{ id: 'g', part: 'glyph' }, { id: 'g', part: 'glyph' }])).join()).toContain('duplicate part id');
    expect(problemsOf(withKind([{ id: 'v', part: 'viewer', source: { artifact: -1 } }])).join()).toContain('artifact');
    expect(problemsOf(withKind([{ id: 'v', part: 'viewer', source: { role: 'x' } }])).join()).toContain("unknown key 'role'");
    expect(
      problemsOf(withKind([
        { id: 'e', part: 'editor', action: 'a', rows: 0, wrap: 'hard' },
        { id: 's', part: 'send', action: 'a', requires: ['e'] },
      ])).length,
    ).toBe(2);
    expect(problemsOf(withKind([{ id: 'x', part: 'button' }])).join()).toContain('unknown part');
    expect(problemsOf({ version: '9.0.0' }).join()).toContain('incompatible');
    expect(problemsOf({ version: 'latest' }).join()).toContain('semver');
    expect(problemsOf({ ...valid, attention: [
      { match: { cause: 'c' }, mechanism: 'ambient' },
      { match: { cause: 'c' }, mechanism: 'interrupt' },
    ] }).join()).toContain('unreachable');
  });
});

describe('wiring config defences', () => {
  it('refuses prototype-reaching keys in every table and never looks them up', () => {
    for (const table of ['render', 'relations', 'viewers', 'kinds', 'actions']) {
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        const raw = JSON.parse(`{"version":"${WIRING_SCHEMA_VERSION}","${table}":{"${key}":{}}}`);
        expect(problemsOf(raw).join(), `${table}.${key}`).toContain(`forbidden key '${key}'`);
      }
    }
    expect(renderFor({ version: WIRING_SCHEMA_VERSION }, 'constructor')).toBeUndefined();
    expect(renderFor({ version: WIRING_SCHEMA_VERSION, render: {} }, 'toString')).toBeUndefined();
    expect(actionLabel({ version: WIRING_SCHEMA_VERSION }, 'constructor')).toBe('constructor');
    expect(actionLabel({ version: WIRING_SCHEMA_VERSION, actions: {} }, 'toString')).toBe('toString');
    expect(actionLabel({ version: WIRING_SCHEMA_VERSION, actions: {} }, '__proto__')).toBe('__proto__');
  });

  it('size ceilings hold at the boundary', () => {
    const str = (n: number) => 'a'.repeat(n);
    expect(problemsOf({ version: WIRING_SCHEMA_VERSION, relations: { [str(WIRING_LIMITS.string)]: { style: 'solid' } } })).toEqual([]);
    expect(problemsOf({ version: WIRING_SCHEMA_VERSION, relations: { [str(WIRING_LIMITS.string + 1)]: { style: 'solid' } } }).join()).toContain('longer than');
    const glyphs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, part: 'glyph' }));
    expect(problemsOf(withKind(glyphs(WIRING_LIMITS.partsPerKind)))).toEqual([]);
    expect(problemsOf(withKind(glyphs(WIRING_LIMITS.partsPerKind + 1))).join()).toContain('parts');
    const req = (n: number) => [
      ...glyphs(n),
      { id: 'send', part: 'send', action: 'a', requires: Array.from({ length: n }, (_, i) => `g${i}`) },
    ];
    expect(problemsOf(withKind(req(WIRING_LIMITS.requires)))).toEqual([]);
    expect(problemsOf(withKind(req(WIRING_LIMITS.requires + 1))).join()).toContain('requires');
    const table = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { style: 'solid' }]));
    expect(problemsOf({ version: WIRING_SCHEMA_VERSION, relations: table(WIRING_LIMITS.tableEntries) })).toEqual([]);
    expect(problemsOf({ version: WIRING_SCHEMA_VERSION, relations: table(WIRING_LIMITS.tableEntries + 1) }).join()).toContain('entries');
  });

  it('at most one selector, text and editor per action in a kind', () => {
    const send = { id: 's', part: 'send', action: 'a', requires: [] };
    expect(problemsOf(withKind([{ id: 't1', part: 'text', action: 'a' }, { id: 't2', part: 'text', action: 'a' }, send])).join()).toContain('second text');
    expect(problemsOf(withKind([{ id: 'c1', part: 'selector', action: 'a' }, { id: 'c2', part: 'selector', action: 'a' }, send])).join()).toContain('second selector');
    expect(problemsOf(withKind([{ id: 'c', part: 'selector', action: 'a' }, { id: 't', part: 'text', action: 'a' }, send]))).toEqual([]);
  });

  it('SVG never maps through image/* and only to html-isolated or fallback', () => {
    expect(problemsOf({ version: WIRING_SCHEMA_VERSION, viewers: { 'image/svg+xml': 'image' } }).join()).toContain('svg');
    expect(problemsOf({ version: WIRING_SCHEMA_VERSION, viewers: { 'image/svg+xml': 'html-isolated' } })).toEqual([]);
    const cfg: WiringConfig = { version: WIRING_SCHEMA_VERSION, viewers: { 'image/*': 'image' } };
    expect(viewerFor(cfg, 'image/png')).toBe('image');
    expect(viewerFor(cfg, 'image/svg+xml')).toBeUndefined();
  });
});

describe('lenses as config data', () => {
  const lens = (over: object) => ({ ...valid, lenses: [{ id: 'hot', label: 'Hot', match: { states: ['running'] }, ...over }] });
  it('accepts a lens: id + label + a match table over received facts', () => {
    expect(problemsOf(lens({}))).toEqual([]);
    expect(problemsOf({ ...valid, lenses: [{ id: 'mine', label: '내 것', match: { attention: true, kinds: ['crate'] } }] })).toEqual([]);
  });
  it('refuses engine ids, duplicates, empty matches and non-table shapes', () => {
    expect(problemsOf({ ...valid, lenses: [{ id: 'all', label: 'x', match: { attention: true } }] }).join()).toContain('engine lens');
    expect(problemsOf({ ...valid, lenses: [{ id: 'plan', label: 'x', match: { attention: true } }] }).join()).toContain('engine lens');
    const dup = { id: 'a', label: 'x', match: { attention: true } };
    expect(problemsOf({ ...valid, lenses: [dup, dup] }).join()).toContain('duplicate lens id');
    expect(problemsOf(lens({ match: {} })).join()).toContain('at least one');
    expect(problemsOf(lens({ match: { states: [] } })).join()).toContain('non-empty');
    expect(problemsOf(lens({ match: { attention: false } })).join()).toContain('attention');
    expect(problemsOf(lens({ onClick: 'x' })).join()).toContain("unknown key 'onClick'");
  });
  it('within: a closed { anchor, relations, direction } clause, alone or alongside the other fields', () => {
    const within = { anchor: 'dom-1', relations: ['member-of', 'contains'], direction: 'in' };
    expect(problemsOf(lens({ match: { within } }))).toEqual([]);
    expect(problemsOf(lens({ match: { kinds: ['task'], within } }))).toEqual([]);
  });
  it('within refuses open shapes: missing pieces, unknown keys, off-table directions', () => {
    const base = { anchor: 'a', relations: ['member-of'], direction: 'out' };
    expect(problemsOf(lens({ match: { within: 'subtree' } })).join()).toContain('must be { anchor, relations, direction }');
    expect(problemsOf(lens({ match: { within: { ...base, anchor: '' } } })).join()).toContain('anchor');
    expect(problemsOf(lens({ match: { within: { ...base, relations: [] } } })).join()).toContain('relations');
    expect(problemsOf(lens({ match: { within: { ...base, direction: 'up' } } })).join()).toContain('direction');
    expect(problemsOf(lens({ match: { within: { ...base, transitive: false } } })).join()).toContain("unknown key 'transitive'");
  });
});

describe('wiring 0.4.0 presentation fields (attention group, action labels, detail collapsed/copyable)', () => {
  const v = WIRING_SCHEMA_VERSION;

  it('accepts every new field; configs without them stay valid', () => {
    const cfg: WiringConfig = {
      version: v,
      attention: [
        { match: { cause: 'a' }, mechanism: 'interrupt', group: '결정' },
        { match: { cause: 'b' }, mechanism: 'ambient', group: 'check ✓' },
        { match: { cause: 'c' }, mechanism: 'ambient' },
      ],
      actions: { 'gate.approve': { label: '승인' }, x: { label: 'Do it' } },
      detail: { emphasis: ['권고'], collapsed: ['digest'], copyable: ['명령', 'command'] },
    };
    expect(validateWiringConfig(cfg)).toEqual({ ok: true, config: cfg });
    expect(validateWiringConfig(valid).ok).toBe(true);
    // Every detail list is optional on its own, including emphasis.
    expect(problemsOf({ version: v, detail: {} })).toEqual([]);
    expect(problemsOf({ version: v, detail: { copyable: ['명령'] } })).toEqual([]);
    expect(problemsOf({ version: v, detail: { collapsed: ['digest'] } })).toEqual([]);
    expect(problemsOf({ version: v, actions: {} })).toEqual([]);
  });

  it('lookups: group of the first matching rule; label else raw name; detail lists else empty', () => {
    const cfg: WiringConfig = {
      version: v,
      attention: [
        { match: { cause: 'a' }, mechanism: 'interrupt', group: 'G1' },
        { match: { cause: 'c' }, mechanism: 'ambient' },
      ],
      actions: { 'gate.approve': { label: '승인' } },
      detail: { collapsed: ['digest'], copyable: ['명령'] },
    };
    expect(attentionGroup(cfg, 'a')).toBe('G1');
    expect(attentionGroup(cfg, 'c')).toBeUndefined();
    expect(attentionGroup(cfg, 'unknown')).toBeUndefined();
    expect(attentionGroup({ version: v }, 'a')).toBeUndefined();
    expect(actionLabel(cfg, 'gate.approve')).toBe('승인');
    expect(actionLabel(cfg, 'gate.reject')).toBe('gate.reject');
    expect(actionLabel({ version: v }, 'gate.approve')).toBe('gate.approve');
    expect(detailCollapsed(cfg)).toEqual(['digest']);
    expect(detailCopyable(cfg)).toEqual(['명령']);
    expect(detailEmphasis(cfg)).toEqual([]);
    expect(detailCollapsed({ version: v })).toEqual([]);
    expect(detailCopyable({ version: v })).toEqual([]);
  });

  it('attention group: a non-blank printable string', () => {
    const rule = (group: unknown) => ({ version: v, attention: [{ match: { cause: 'a' }, mechanism: 'ambient', group }] });
    for (const bad of ['', '   ', 3, null, ['x'], { name: 'x' }, true]) {
      expect(problemsOf(rule(bad)).join(), JSON.stringify(bad)).toContain('config.attention[0].group');
    }
    for (const ctl of ['a\u0000b', 'a\nb', 'a\u202eb', 'a\u2066b', 'a\u0085b']) {
      expect(problemsOf(rule(ctl)).join(), JSON.stringify(ctl)).toContain('control or bidi');
    }
    expect(problemsOf(rule('a'.repeat(WIRING_LIMITS.string)))).toEqual([]);
    expect(problemsOf(rule('a'.repeat(WIRING_LIMITS.string + 1))).join()).toContain('longer than');
    expect(problemsOf(rule('${x}')).join()).toContain('expression-like');
    expect(problemsOf({ version: v, attention: [{ match: { cause: 'a' }, mechanism: 'ambient', groups: 'x' }] }).join()).toContain("unknown key 'groups'");
  });

  it('actions: a closed { label } table with table limits', () => {
    const at = (entry: unknown) => problemsOf({ version: v, actions: { 'gate.approve': entry } }).join();
    expect(at({ label: '' })).toContain("config.actions.gate.approve.label");
    expect(at({ label: ' ' })).toContain('non-blank');
    expect(at({ label: 3 })).toContain('non-blank');
    expect(at({})).toContain('non-blank');
    expect(at({ label: 'ok', icon: 'x' })).toContain("unknown key 'icon'");
    expect(at('승인')).toContain('must be { label }');
    expect(at(['승인'])).toContain('must be { label }');
    expect(at({ label: 'a\u202eb' })).toContain('control or bidi');
    expect(problemsOf({ version: v, actions: ['x'] }).join()).toContain('config.actions: must be an object');
    expect(problemsOf({ version: v, actions: { '': { label: 'x' } } }).join()).toContain('empty key');
    const table = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, { label: `L${i}` }]));
    expect(problemsOf({ version: v, actions: table(WIRING_LIMITS.tableEntries) })).toEqual([]);
    expect(problemsOf({ version: v, actions: table(WIRING_LIMITS.tableEntries + 1) }).join()).toContain('entries');
  });

  it('detail lists: arrays of non-empty labels, capped, closed shape', () => {
    for (const key of ['emphasis', 'collapsed', 'copyable']) {
      const at = (list: unknown) => problemsOf({ version: v, detail: { [key]: list } }).join();
      expect(problemsOf({ version: v, detail: { [key]: ['x', '명령'] } }), key).toEqual([]);
      expect(at('x'), key).toContain(`config.detail.${key}: must be an array`);
      expect(at({ x: 1 }), key).toContain('must be an array');
      expect(at(['']), key).toContain(`config.detail.${key}[0]`);
      expect(at([1]), key).toContain(`config.detail.${key}[0]`);
      expect(problemsOf({ version: v, detail: { [key]: Array.from({ length: WIRING_LIMITS.detailEmphasis }, (_, i) => `l${i}`) } }), key).toEqual([]);
      expect(at(Array.from({ length: WIRING_LIMITS.detailEmphasis + 1 }, (_, i) => `l${i}`)), key).toContain(`more than ${WIRING_LIMITS.detailEmphasis}`);
    }
    expect(problemsOf({ version: v, detail: { hidden: ['x'] } }).join()).toContain("unknown key 'hidden'");
    expect(problemsOf({ version: v, detail: ['x'] }).join()).toContain('must be { emphasis?, collapsed?, copyable? }');
  });

  it('prototype-reaching keys stay refused in the new shapes', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const raw = JSON.parse(`{"version":"${v}","actions":{"${key}":{"label":"x"}}}`);
      expect(problemsOf(raw).join(), key).toContain(`forbidden key '${key}'`);
      const det = JSON.parse(`{"version":"${v}","detail":{"${key}":["x"]}}`);
      expect(problemsOf(det).join(), key).toContain(`forbidden key '${key}'`);
    }
  });
});

describe('wiring 0.5.0 kind shape and size', () => {
  const v = WIRING_SCHEMA_VERSION;

  it('accepts shape and size on a kind, with or without parts; configs without them stay valid', () => {
    const cfg: WiringConfig = {
      version: v,
      kinds: {
        task: { parts: [{ id: 'g', part: 'glyph' }], shape: 'circle', size: 0.6 },
        gate: { shape: 'diamond', size: 1.4 },
        mission: { shape: 'band' },
        plain: { parts: [] },
      },
    };
    expect(validateWiringConfig(cfg)).toEqual({ ok: true, config: cfg });
    for (const shape of SHAPE_IDS) expect(validateWiringConfig({ version: v, kinds: { k: { shape } } }).ok).toBe(true);
  });

  it('rejects an unknown shape, a size out of range or not a number, and unknown fields', () => {
    const bad = (k: unknown) => validateWiringConfig({ version: v, kinds: { k } } as unknown as WiringConfig);
    expect(bad({ shape: 'star' }).ok).toBe(false);
    expect(bad({ shape: 'circle', size: 0.4 }).ok).toBe(false);
    expect(bad({ size: 3.01 }).ok).toBe(false);
    expect(bad({ size: '2' }).ok).toBe(false);
    expect(bad({ size: Number.NaN }).ok).toBe(false);
    expect(bad({ shape: 'circle', colour: 'red' }).ok).toBe(false);
    expect(bad({ parts: 'x' }).ok).toBe(false);
  });

  it('helpers: unstated = rect at 1; a shape-only kind has no parts (the default assembly)', () => {
    const cfg: WiringConfig = { version: v, kinds: { gate: { shape: 'diamond', size: 2 } } };
    expect(kindShape(cfg, 'gate')).toEqual({ shape: 'diamond', size: 2 });
    expect(kindShape(cfg, 'task')).toEqual({ shape: 'rect', size: 1 });
    expect(kindParts(cfg, 'gate')).toBeUndefined();
    // Prototype keys are never read as kinds.
    expect(kindShape(cfg, '__proto__')).toEqual({ shape: 'rect', size: 1 });
  });
});


describe('wiring 0.6.0 relation role', () => {
  const v = WIRING_SCHEMA_VERSION;

  it('accepts every role in the closed set; relations without a role stay valid', () => {
    expect(RELATION_ROLES).toEqual(['waits_on', 'blocks', 'supports', 'produces', 'contains']);
    for (const role of RELATION_ROLES) {
      expect(validateWiringConfig({ version: v, relations: { r: { style: 'solid', role } } }).ok).toBe(true);
    }
    const cfg: WiringConfig = {
      version: v,
      relations: { parent: { style: 'muted', arrange: 'contain', direction: 'out', role: 'contains' }, plain: { style: 'solid' } },
    };
    expect(validateWiringConfig(cfg)).toEqual({ ok: true, config: cfg });
  });

  it('rejects a role outside the closed set', () => {
    const bad = (role: unknown) => validateWiringConfig({ version: v, relations: { r: { style: 'solid', role } } } as unknown as WiringConfig);
    for (const role of ['depends_on', 'WAITS_ON', '', 3, null]) {
      const r = bad(role);
      expect(r.ok, String(role)).toBe(false);
      if (!r.ok) expect(r.problems[0]).toContain('config.relations.r.role');
    }
  });

  it('relationRoleFor: the stated role, else undefined; arrange is independent of it', () => {
    const cfg: WiringConfig = { version: v, relations: { needs: { style: 'solid', arrange: 'flow', role: 'waits_on' }, plain: { style: 'solid' } } };
    expect(relationRoleFor(cfg, 'needs')).toBe('waits_on');
    expect(relationRoleFor(cfg, 'plain')).toBeUndefined();
    expect(relationRoleFor(cfg, 'unregistered')).toBeUndefined();
    expect(relationRoleFor(cfg, '__proto__')).toBeUndefined();
    expect(relationArrangeFor(cfg, 'needs')).toBe('flow');
  });
});
