// Generic intake: the contract's NodeProjection collection travels beside the
// domain projection, kept apart from it; the default wiring config validates.
import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { createFakeUpstream, normalFixture, projectNodes } from '@gunnflow-testing/fake-contracts';
import { coveredActions } from '@gunnflow/contract/wiring';
import { normalizeNodes, normalizeProjection } from '../src/model/normalize.js';
import { createProjectionStore } from '../src/state/projectionStore.js';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { EMPTY_WIRING, loadWiring } from '../src/wiring/loadWiring.js';

describe('generic node intake', () => {
  it('a node whose live artifact URL carries credentials is listed invalid and never shown', () => {
    const node = (url: string) => ({
      id: 'n1', kind: 'deliverable', state: { value: 'ready' }, relations: [], capabilities: [], attention: [],
      artifacts: [{ id: 'a1', mediaType: 'text/html', access: { kind: 'live', url } }],
    });
    const clean = normalizeNodes({ nodes: [node('https://preview.example/a')] })!;
    expect(clean.nodes.map((n) => n.id)).toEqual(['n1']);
    const leaked = normalizeNodes({ nodes: [node('https://alice:s3cret@preview.example/a')] })!;
    expect(leaked.nodes).toEqual([]);
    expect(leaked.invalid).toHaveLength(1);
    expect(leaked.invalid[0]!.problem).toContain('must not carry credentials');
    expect(leaked.invalid[0]!.problem).not.toContain('s3cret');
    expect(leaked.invalid[0]!.problem).not.toContain('alice');
  });

  it('the simulator envelope carries nodes; the domain projection never contains them', () => {
    const body = createFakeUpstream('normal').snapshot().body;
    const domain = normalizeProjection(body);
    expect('nodes' in domain).toBe(false);
    const generic = normalizeNodes(body)!;
    expect(generic.invalid).toEqual([]);
    expect(generic.nodes).toEqual(projectNodes(normalFixture()));
  });

  it('absent nodes stay absent; malformed nodes are listed, not repaired', () => {
    expect(normalizeNodes({ tasks: [] })).toBeNull();
    const generic = normalizeNodes({ nodes: [projectNodes(normalFixture())[0], { id: 'x', kind: 'k' }] })!;
    expect(generic.nodes).toHaveLength(1);
    expect(generic.invalid).toEqual([{ index: 1, problem: expect.stringContaining('state') }]);
  });

  it('the projection store keeps generic nodes in their own field', () => {
    const h = createRoot((dispose) => ({ store: createProjectionStore(), dispose }));
    const body = createFakeUpstream('normal').snapshot().body;
    h.store.applyUpstream(normalizeProjection(body), normalizeNodes(body));
    expect(h.store.genericNodes()?.nodes.length).toBeGreaterThan(0);
    expect(h.store.projection().tasks.length).toBeGreaterThan(0);
    h.store.applyUpstream(normalizeProjection({}));
    expect(h.store.genericNodes()).toBeNull();
    h.dispose();
  });
});

describe('wiring config loading', () => {
  it('the default config validates and every kind the simulator emits has an assembly', () => {
    const logs: string[] = [];
    const loaded = loadWiring(DEFAULT_WIRING, (m) => logs.push(m));
    expect(loaded.problems).toEqual([]);
    expect(logs).toEqual([]);
    const kinds = new Set(projectNodes(normalFixture()).map((n) => n.kind));
    for (const k of kinds) expect(loaded.config.kinds?.[k], k).toBeDefined();
    // The actions the task assembly gives a presentation to (capabilities remain the source).
    expect(coveredActions(loaded.config, 'task')).toEqual(['task.instruct', 'task.pause', 'task.resume', 'artifact.edit']);
  });

  it('an invalid config is logged and replaced by the engine defaults', () => {
    const logs: string[] = [];
    const loaded = loadWiring({ version: '0.1.0', render: { running: { glyph: '●', tone: 'not-a-colour' } } }, (m) => logs.push(m));
    expect(loaded.config).toEqual(EMPTY_WIRING);
    expect(loaded.problems.join()).toContain('tone');
    expect(logs[0]).toContain('wiring config rejected');
  });
});
