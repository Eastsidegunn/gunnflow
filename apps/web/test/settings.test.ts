// WP-Q2: the settings model — the View tab by kind (global tables, shared
// values marked), merge provenance, closed-token edits, validator-derived
// viewer choices, and save refusal.
import { describe, expect, it } from 'vitest';
import type { NodeProjection } from '@gunnflow/contract';
import { gatesFixture, normalFixture, projectNodes } from '@gunnflow-testing/fake-contracts';
import { WIRING_SCHEMA_VERSION, relationRoleFor, type WiringConfig } from '@gunnflow/contract/wiring';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import {
  DEFAULT_TAB_ID,
  USER_FILE,
  draftProblems,
  emptyUserConfig,
  mediaTypes,
  previewConfig,
  provenance,
  resetKey,
  setAttention,
  setRelation,
  keptRole,
  setRender,
  setViewer,
  sourceName,
  sourceTabs,
  sourceUnobserved,
  viewSections,
  viewerOptions,
} from '../src/settings/settingsModel.js';

const V = WIRING_SCHEMA_VERSION;

describe('View tab: organised by kind, tables stay global', () => {
  it('lists each observed kind with the states its nodes show and the relations they take part in', () => {
    const { sections } = viewSections(projectNodes(normalFixture()), DEFAULT_WIRING);
    expect(sections[0]!.kind).toBe('workspace');
    const task = sections.find((s) => s.kind === 'task')!;
    expect(task.states.map((s) => s.key)).toEqual(expect.arrayContaining(['running', 'queued', 'completed']));
    expect(task.relations.map((r) => r.key)).toEqual(expect.arrayContaining(['member-of', 'dependency']));
    // mission takes part in member-of as the target.
    expect(sections.find((s) => s.kind === 'mission')!.relations.map((r) => r.key)).toContain('member-of');
  });

  it('marks a value used by several kinds as shared — one setting shown in each section', () => {
    const nodes: NodeProjection[] = [
      { id: 't', kind: 'task', state: { value: 'waiting' }, relations: [], capabilities: [], attention: [], artifacts: [] },
      { id: 'g', kind: 'gate', state: { value: 'waiting' }, relations: [{ type: 'gate', target: 't' }], capabilities: [], attention: [], artifacts: [] },
    ];
    const { sections } = viewSections(nodes, DEFAULT_WIRING);
    for (const kind of ['task', 'gate']) {
      const s = sections.find((x) => x.kind === kind)!;
      expect(s.states).toEqual([{ key: 'waiting', kinds: ['gate', 'task'] }]);
      expect(s.relations).toEqual([{ key: 'gate', kinds: ['gate', 'task'] }]);
    }
  });

  it('keys the config maps but the workspace does not show are grouped as unobserved', () => {
    const { unobserved } = viewSections(projectNodes(normalFixture()), DEFAULT_WIRING);
    expect(unobserved.states).toEqual(expect.arrayContaining(['approved', 'rejected', 'expired']));
    expect(unobserved.states).not.toContain('running');
    expect(unobserved.relations).toEqual(expect.arrayContaining(['superseded-by']));
    expect(viewSections(projectNodes(gatesFixture()), DEFAULT_WIRING).unobserved.relations).not.toContain('gate');
  });
});

describe('settings model', () => {
  it('shows where each effective value comes from: my settings, a wiring file, the default, or the engine', () => {
    const layers = [
      { file: '10-backend.json', config: { version: V, render: { blocked: { glyph: '■', tone: '#e8a33d' } } } as WiringConfig },
      { file: USER_FILE, config: { version: V, render: { running: { glyph: '●', tone: '#ff5d5d' } } } as WiringConfig },
    ];
    const draft = layers[1]!.config;
    expect(provenance('render', 'running', layers, draft)).toBe('my settings');
    expect(provenance('render', 'blocked', layers, draft)).toBe('10-backend.json');
    expect(provenance('render', 'queued', layers, draft)).toBe('default');
    expect(provenance('render', 'something-new', layers, draft)).toBe('engine default');
    expect(previewConfig(draft, layers).render!.running).toEqual({ glyph: '●', tone: '#ff5d5d' });
  });

  it('a style or layout edit keeps the relation role an earlier layer gave it', () => {
    const layers = [{ file: '10-backend.json', config: { version: V, relations: { dependency: { style: 'solid', arrange: 'flow', role: 'blocks' } } } as WiringConfig }];
    let d = emptyUserConfig();
    d = setRelation(d, 'dependency', { style: 'bold', arrange: 'flow', ...keptRole(previewConfig(d, layers), 'dependency') });
    expect(relationRoleFor(previewConfig(d, layers), 'dependency')).toBe('blocks');
    d = setRelation(d, 'dependency', { style: 'bold', arrange: 'none', ...keptRole(previewConfig(d, layers), 'dependency') });
    expect(relationRoleFor(previewConfig(d, layers), 'dependency')).toBe('blocks');
    // Without it, the user entry replaces the layer's entry whole and the role is gone.
    expect(relationRoleFor(previewConfig(setRelation(emptyUserConfig(), 'dependency', { style: 'bold' }), layers), 'dependency')).toBeUndefined();
    expect(keptRole(previewConfig(emptyUserConfig(), layers), 'evidence')).toEqual({});
  });

  it('edits use closed tokens only, and "back to default" removes the key from my file', () => {
    let d = emptyUserConfig();
    d = setRender(d, 'running', { glyph: '●', tone: '#ff5d5d' });
    d = setRelation(d, 'dependency', { style: 'bold', arrange: 'flow' });
    d = setAttention(d, 'flagged', 'interrupt');
    d = setAttention(d, 'flagged', 'ambient');
    d = setViewer(d, 'text/html', 'fallback');
    expect(d).toEqual({
      version: V,
      render: { running: { glyph: '●', tone: '#ff5d5d' } },
      relations: { dependency: { style: 'bold', arrange: 'flow' } },
      attention: [{ match: { cause: 'flagged' }, mechanism: 'ambient' }],
      viewers: { 'text/html': 'fallback' },
    });
    expect(draftProblems(d, [])).toEqual([]);
    for (const [t, k] of [['render', 'running'], ['relations', 'dependency'], ['attention', 'flagged'], ['viewers', 'text/html']] as const) d = resetKey(d, t, k);
    expect(d).toEqual({ version: V });
  });

  it('viewer choices come from the validator: never image for SVG, diagram viewers only for their own types', () => {
    expect(viewerOptions('image/svg+xml')).toEqual(['html-isolated', 'fallback']);
    expect(viewerOptions('text/vnd.mermaid')).toContain('mermaid');
    expect(viewerOptions('application/json')).not.toContain('excalidraw');
    expect(mediaTypes(projectNodes(normalFixture()), DEFAULT_WIRING)).toContain('text/vnd.mermaid');
  });

  it('accepts literal glyphs (emoji) and hex tones — the render tables are open', () => {
    const d = setRender(emptyUserConfig(), 'running', { glyph: '🚀', tone: '#12ab34' });
    expect(draftProblems(d, [])).toEqual([]);
  });

  it('refuses to save a draft that is invalid or breaks the merge', () => {
    expect(draftProblems({ version: V, render: { x: { glyph: '●', tone: 'red' } } } as unknown as WiringConfig, []).length).toBeGreaterThan(0);
    const many = (p: string) => Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`${p}-${i}`, { glyph: '●', tone: '#dde3ea' }]));
    const layers = [{ file: '10-big.json', config: { version: V, render: many('a') } as WiringConfig }];
    expect(draftProblems({ version: V, render: many('b') } as WiringConfig, layers).some((p) => p.startsWith('merged:'))).toBe(true);
  });

  it('backend tabs come from the wiring file names themselves, plus the built-in default', () => {
    expect(sourceName('10-somebackend.json')).toBe('somebackend');
    expect(sourceName('05_acme-wire.json')).toBe('acme-wire');
    expect(sourceName('somebackend.json')).toBe('somebackend');
    expect(sourceName('10-.json')).toBe('10-.json'); // nothing left → the file name stays
    const layers = [
      { file: '10-somebackend.json', config: { version: V } as WiringConfig },
      { file: USER_FILE, config: { version: V } as WiringConfig }, // the person's file is not a backend
    ];
    expect(sourceTabs(layers).map((t) => [t.id, t.name])).toEqual([
      ['10-somebackend.json', 'somebackend'],
      [DEFAULT_TAB_ID, 'default'],
    ]);
    expect(sourceTabs([]).map((t) => t.name)).toEqual(['default']);
  });

  it('lists what a source maps but the workspace does not show', () => {
    const source: WiringConfig = {
      version: V,
      render: { waiting: { glyph: '◷', tone: '#ffb02e' }, archived: { glyph: '▤', tone: '#5b6672' } },
      relations: { 'member-of': { style: 'muted' }, 'blocks': { style: 'bold' } },
    };
    const nodes: NodeProjection[] = [
      { id: 't', kind: 'task', state: { value: 'waiting' }, relations: [{ type: 'member-of', target: 't' }], capabilities: [], attention: [], artifacts: [] },
    ];
    expect(sourceUnobserved(source, nodes)).toEqual({ states: ['archived'], relations: ['blocks'] });
  });
});
