// Acceptance E1–E4: lenses re-weight the presentation, never modify it.
// The engine knows `all` and `plan`; everything else is a config match table
// evaluated over received facts — no vocabulary lives in the engine.
import { describe, expect, it } from 'vitest';
import type { NodeProjection } from '@gunnflow/contract';
import { WIRING_SCHEMA_VERSION, validateWiringConfig, type WiringConfig } from '@gunnflow/contract/wiring';
import { buildScene, genericEmphasis } from '../src/canvas/genericScene.js';
import { configLensEmphasis, lensMatcher, lensMatches, planEmphasis, withinMembers, type LensFacts } from '../src/state/lens.js';

const node = (id: string, kind: string, state: string, attention = false, relations: { type: string; target: string }[] = []): NodeProjection => ({
  id,
  kind,
  state: { value: state },
  relations,
  capabilities: [],
  attention: attention ? [{ cause: 'x' }] : [],
  artifacts: [],
});

const CONFIG: WiringConfig = {
  version: WIRING_SCHEMA_VERSION,
  lenses: [
    { id: 'needs-you', label: 'Needs you', match: { attention: true } },
    { id: 'hot', label: 'Hot', match: { states: ['running', 'burning'] } },
    { id: 'crates', label: 'Crates', match: { kinds: ['crate'] } },
    { id: 'hot-crates', label: 'Hot crates', match: { states: ['running'], kinds: ['crate'] } },
  ],
};
const NODES = [
  node('a', 'crate', 'running'),
  node('b', 'crate', 'idle'),
  node('c', 'pipe', 'running', true),
  node('d', 'pipe', 'idle'),
];

describe('lens match tables (engine evaluates, never interprets)', () => {
  it('states / kinds / attention each constrain; present fields are ANDed', () => {
    const facts = (id: string) => ({ id, kind: id <= 'b' ? 'crate' : 'pipe', state: id === 'a' || id === 'c' ? 'running' : 'idle', hasAttention: id === 'c', relations: [] });
    expect(lensMatches({ states: ['running'] }, facts('a'))).toBe(true);
    expect(lensMatches({ states: ['running'] }, facts('b'))).toBe(false);
    expect(lensMatches({ kinds: ['crate'] }, facts('b'))).toBe(true);
    expect(lensMatches({ attention: true }, facts('c'))).toBe(true);
    expect(lensMatches({ attention: true }, facts('d'))).toBe(false);
    expect(lensMatches({ states: ['running'], kinds: ['crate'] }, facts('a'))).toBe(true);
    expect(lensMatches({ states: ['running'], kinds: ['crate'] }, facts('c'))).toBe(false);
  });

  it('config lens emphasis: matching nodes highlight, the rest dim — nothing hidden', () => {
    const scene = buildScene(NODES, CONFIG);
    const e = genericEmphasis(scene, 'hot', CONFIG);
    expect(e.get('a')).toBe('highlight');
    expect(e.get('c')).toBe('highlight');
    expect(e.get('b')).toBe('dim');
    expect(e.get('d')).toBe('dim');
    expect(e.size).toBe(NODES.length); // every node keeps an emphasis — no node disappears
  });

  it('E1: an attention lens highlights exactly the nodes carrying attention', () => {
    const scene = buildScene(NODES, CONFIG);
    const e = genericEmphasis(scene, 'needs-you', CONFIG);
    expect(e.get('c')).toBe('highlight');
    for (const id of ['a', 'b', 'd']) expect(e.get(id)).toBe('dim');
  });

  it('`all` is the engine rule: everything plain, interrupt stands out', () => {
    const cfg: WiringConfig = { ...CONFIG, attention: [{ match: { cause: 'x' }, mechanism: 'interrupt' }] };
    const scene = buildScene(NODES, cfg);
    const e = genericEmphasis(scene, 'all', cfg);
    expect(e.get('c')).toBe('highlight');
    expect(e.get('a')).toBe('normal');
  });

  it('an id the config no longer declares falls back to `all` (never crashes, never hides)', () => {
    const scene = buildScene(NODES, CONFIG);
    const e = genericEmphasis(scene, 'gone-lens', CONFIG);
    for (const id of ['a', 'b', 'd']) expect(e.get(id)).toBe('normal');
  });

  it('E4: computing a lens never mutates the nodes', () => {
    const frozen = JSON.stringify(NODES);
    const scene = buildScene(NODES, CONFIG);
    for (const l of ['needs-you', 'hot', 'crates', 'hot-crates', 'all']) genericEmphasis(scene, l, CONFIG);
    configLensEmphasis(CONFIG.lenses![0]!, []);
    expect(JSON.stringify(NODES)).toBe(frozen);
  });

  it('plan: board-referenced nodes forward, the rest dim', () => {
    const e = planEmphasis(['a', 'b'], new Set(['b']));
    expect(e.get('a')).toBe('dim');
    expect(e.get('b')).toBe('highlight');
  });

  it('the lens table itself validates as config data', () => {
    expect(validateWiringConfig(CONFIG).ok).toBe(true);
  });
});

// `within`: mechanical reachability over received relations — the engine
// follows named edge types from an anchor and never knows what they mean.
describe('within clause (edge/subtree matching as a derived view)', () => {
  const rel = (type: string, target: string) => ({ type, target });
  const TREE = [
    node('dom', 'domain', 'active'),
    node('goal', 'goal', 'active', false, [rel('member-of', 'dom')]),
    node('t1', 'task', 'running', false, [rel('member-of', 'goal')]),
    node('t2', 'task', 'idle', false, [rel('member-of', 'goal'), rel('blocks', 't1')]),
    node('stray', 'task', 'idle', false, [rel('member-of', 'elsewhere')]),
  ];
  const facts: LensFacts[] = TREE.map((n) => ({ id: n.id, kind: n.kind, state: n.state.value, hasAttention: false, relations: n.relations }));

  it("direction 'in': nodes whose member-of chain reaches the anchor (a subtree over child→parent edges)", () => {
    const got = withinMembers({ anchor: 'dom', relations: ['member-of'], direction: 'in' }, facts);
    expect([...got].sort()).toEqual(['dom', 'goal', 't1', 't2']);
  });

  it("direction 'out': the chain the anchor itself points along", () => {
    const got = withinMembers({ anchor: 't1', relations: ['member-of'], direction: 'out' }, facts);
    expect([...got].sort()).toEqual(['dom', 'goal', 't1']);
  });

  it("direction 'any': the whole connected component through the named types", () => {
    const got = withinMembers({ anchor: 'goal', relations: ['member-of'], direction: 'any' }, facts);
    expect([...got].sort()).toEqual(['dom', 'goal', 't1', 't2']);
  });

  it('only the named relation types are walked', () => {
    // t2 →blocks→ t1, but blocks is not in the table: t2 stays outside t1's 'in' set.
    const got = withinMembers({ anchor: 't1', relations: ['blocks'], direction: 'in' }, facts);
    expect([...got].sort()).toEqual(['t1', 't2']);
    expect(withinMembers({ anchor: 't1', relations: ['member-of'], direction: 'in' }, facts).has('t2')).toBe(false);
  });

  it('an anchor that was never received selects nothing on screen — everything dims, nothing hides', () => {
    const decl = { id: 'ghost', label: 'Ghost', match: { within: { anchor: 'never-received', relations: ['member-of'], direction: 'in' as const } } };
    const e = configLensEmphasis(decl, facts);
    expect(e.size).toBe(facts.length);
    for (const f of facts) expect(e.get(f.id)).toBe('dim');
  });

  it('within ANDs with the other fields', () => {
    const matches = lensMatcher({ within: { anchor: 'dom', relations: ['member-of'], direction: 'in' }, kinds: ['task'] }, facts);
    expect(facts.filter(matches).map((f) => f.id).sort()).toEqual(['t1', 't2']);
  });

  it('emphasis through the scene path: subtree highlights, the rest dims, every node keeps an emphasis', () => {
    const cfg: WiringConfig = {
      version: WIRING_SCHEMA_VERSION,
      lenses: [{ id: 'dom-tree', label: 'Domain tree', match: { within: { anchor: 'dom', relations: ['member-of'], direction: 'in' } } }],
    };
    expect(validateWiringConfig(cfg).ok).toBe(true);
    const scene = buildScene(TREE, cfg);
    const e = genericEmphasis(scene, 'dom-tree', cfg);
    expect(e.get('t1')).toBe('highlight');
    expect(e.get('stray')).toBe('dim');
    expect(e.size).toBe(TREE.length);
  });
});
