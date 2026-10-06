// WP-N: the personal layer — its own store, local saving, honest orphans and
// refusals, and no structural path to intents, attestation or evidence.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { normalFixture, projectNodes } from '@gunnflow-testing/fake-contracts';
import { createPersonalState } from '../src/personal/personalState.js';
import { emptyPersonalDoc, migratePersonalDoc, personalDocProblem, type PersonalDoc } from '../src/personal/schema.js';
import type { PersonalStore } from '../src/personal/client.js';
import { createFakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import { guardPost } from '../src/state/intentValidator.js';
import type { WireIntent } from '../src/model/types.js';
import { planEmphasis } from '../src/state/lens.js';

function memoryStore(initial: unknown | null = null) {
  const saves: PersonalDoc[] = [];
  let stored = initial;
  const store: PersonalStore & { saves: PersonalDoc[]; fail?: boolean } = {
    saves,
    async load() {
      return { doc: stored };
    },
    async save(doc) {
      if (store.fail) throw new Error('disk full');
      stored = doc;
      saves.push(doc);
    },
  };
  return store;
}
const inRoot = <T,>(fn: () => T) => createRoot(() => fn());

describe('personal document schema (v2)', () => {
  const iso = new Date(0).toISOString();
  const sticky = { id: 's1', kind: 'text', text: 't', x: 1, y: 2, w: 190, h: 112, updatedAt: iso };
  const box = { id: 'b1', label: 'Goal', x: 0, y: 0, w: 400, h: 300, members: ['t-build'], updatedAt: iso };
  const doc = (over: Record<string, unknown> = {}) => ({ ...emptyPersonalDoc(), ...over });

  it('accepts the empty document and a full board; refuses unknown keys, bad items and other versions', () => {
    expect(personalDocProblem(emptyPersonalDoc())).toBeNull();
    const link = { id: 'l1', from: { kind: 'box', id: 'b1' }, to: { kind: 'node', id: 't-build' }, label: 'owns', updatedAt: iso };
    expect(personalDocProblem(doc({ stickies: [sticky], boxes: [box], links: [link] }))).toBeNull();
    expect(personalDocProblem(doc({ extra: 1 }))).toContain('unknown key');
    expect(personalDocProblem({ ...emptyPersonalDoc(), version: 3 })).toContain('version');
    expect(personalDocProblem(doc({ notes: { a: { text: 'x' } } }))).toContain("note 'a'");
    expect(personalDocProblem(doc({ stickies: [sticky, sticky] }))).toContain('sticky id');
    expect(personalDocProblem(doc({ stickies: [{ ...sticky, x: Infinity }] }))).toContain('rect');
    expect(personalDocProblem(doc({ stickies: [{ ...sticky, w: 5 }] }))).toContain('rect');
    expect(personalDocProblem(doc({ stickies: [{ ...sticky, kind: 'excalidraw' }] }))).toContain('kind');
    expect(personalDocProblem(doc({ stickies: [{ ...sticky, intent: 'x' }] }))).toContain('sticky must be');
    expect(personalDocProblem(doc({ boxes: [box, { ...box, id: 'b2' }] }))).toContain('more than one box');
    expect(personalDocProblem(doc({ boxes: [{ ...box, members: [''] }] }))).toContain('member id');
    // An early v2 box without members is normalized.
    const { members: _m, ...bare } = box;
    expect(personalDocProblem(migratePersonalDoc(doc({ boxes: [bare] })))).toBeNull();
    // A personal link end must exist; a node end may be gone (drawn broken).
    expect(personalDocProblem(doc({ links: [{ ...link, from: { kind: 'box', id: 'nope' } }], boxes: [box] }))).toContain('end');
    expect(personalDocProblem(doc({ links: [{ ...link, to: { kind: 'node', id: 'long-gone' } }], boxes: [box] }))).toBeNull();
  });

  it('migrates a v1 document: notes and stickies kept, text stickies sized by default', () => {
    const v1 = { version: 1, notes: { a: { text: 'n', updatedAt: iso } }, stickies: [{ id: 's1', text: 't', x: 1, y: 2, updatedAt: iso }] };
    const v2 = migratePersonalDoc(v1) as PersonalDoc;
    expect(personalDocProblem(v2)).toBeNull();
    expect(v2).toMatchObject({ version: 2, notes: v1.notes, boxes: [], links: [] });
    expect(v2.stickies[0]).toMatchObject({ id: 's1', kind: 'text', text: 't', w: 190, h: 112 });
  });
});

describe('personal state', () => {
  it('saves notes and stickies locally after a debounce; an empty note is removed', async () => {
    const store = memoryStore();
    const s = inRoot(() => createPersonalState(store, { debounceMs: 5 }));
    await s.load();
    expect(s.status()).toBe('ready');
    s.setNote('t-build', 'first');
    s.setNote('t-build', 'second');
    expect(s.status()).toBe('unsaved');
    await s.flush();
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.notes['t-build']!.text).toBe('second');
    const id = s.addSticky(10, 20, 'hello')!;
    s.updateSticky(id, { x: 30, text: 'moved' });
    await s.flush();
    expect(store.saves.at(-1)!.stickies).toMatchObject([{ id, x: 30, y: 20, text: 'moved' }]);
    s.setNote('t-build', '');
    s.removeSticky(id);
    await s.flush();
    expect(store.saves.at(-1)).toMatchObject({ notes: {}, stickies: [] });
    expect(s.status()).toBe('ready');
  });

  it('a note outlives its node: orphans are listed, never dropped', async () => {
    const s = inRoot(() => createPersonalState(memoryStore(), { debounceMs: 1 }));
    await s.load();
    s.setNote('t-build', 'kept');
    s.setNote('gone-node', 'still here');
    const live = new Set(projectNodes(normalFixture()).map((n) => n.id));
    expect(s.orphans(live)).toEqual([expect.objectContaining({ nodeId: 'gone-node', text: 'still here' })]);
    expect(s.note('gone-node')).toBe('still here');
  });

  it('an invalid stored document switches editing off instead of overwriting it', async () => {
    const store = memoryStore({ version: 1, notes: { a: 'not a note' }, stickies: [] });
    const s = inRoot(() => createPersonalState(store, { debounceMs: 1 }));
    await s.load();
    expect(s.status()).toBe('unavailable');
    expect(s.problem()).toContain('editing is off');
    expect(s.setNote('x', 'y')).toBe(false);
    expect(s.addSticky(0, 0)).toBeNull();
    await s.flush();
    expect(store.saves).toHaveLength(0);
  });

  it('a stored v1 document is migrated on load and saved back as v2', async () => {
    const iso = new Date(0).toISOString();
    const store = memoryStore({ version: 1, notes: { a: { text: 'kept', updatedAt: iso } }, stickies: [] });
    const s = inRoot(() => createPersonalState(store, { debounceMs: 1 }));
    await s.load();
    expect(s.status()).toBe('ready');
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]).toMatchObject({ version: 2, notes: { a: { text: 'kept' } }, boxes: [], links: [] });
  });

  it('boxes carry what lies inside them (by coordinates); links reach boxes, stickies and nodes, and break without being dropped', async () => {
    const s = inRoot(() => createPersonalState(memoryStore(), { debounceMs: 1 }));
    await s.load();
    const goal = s.addBox(0, 0, 'My OS', 1000, 600)!;
    const sub = s.addBox(40, 60, 'Subgoal', 400, 300)!;
    const diagram = s.addSticky(60, 120, 'erDiagram\n  A ||--o{ B : has', 'mermaid')!;
    const outside = s.addSticky(2000, 2000, 'elsewhere')!;
    expect(s.contentsOf(goal)).toEqual({ stickies: [diagram], boxes: [sub] });
    s.moveBoxWithContents(goal, 100, 50, s.contentsOf(goal));
    const d = s.doc();
    expect(d.boxes.find((b) => b.id === sub)).toMatchObject({ x: 140, y: 110 });
    expect(d.stickies.find((x) => x.id === diagram)).toMatchObject({ x: 160, y: 170 });
    expect(d.stickies.find((x) => x.id === outside)).toMatchObject({ x: 2000, y: 2000 });
    s.updateSticky(diagram, { w: 10, h: 99999 });
    expect(s.doc().stickies.find((x) => x.id === diagram)).toMatchObject({ w: 60, h: 4000 });

    const l1 = s.addLink({ kind: 'box', id: sub }, { kind: 'node', id: 't-build' }, 'builds')!;
    const l2 = s.addLink({ kind: 'sticky', id: diagram }, { kind: 'node', id: 'gone-node' })!;
    expect(s.addLink({ kind: 'box', id: sub }, { kind: 'box', id: sub })).toBeNull();
    expect(s.addLink({ kind: 'box', id: 'no-such-box' }, { kind: 'node', id: 't-build' })).toBeNull();
    const live = new Set(projectNodes(normalFixture()).map((n) => n.id));
    expect(s.brokenLinks(live).map((l) => l.id)).toEqual([l2]);
    expect(personalDocProblem(s.doc())).toBeNull();
    // Removing a personal item removes its links; a gone node never does.
    s.removeBox(sub);
    expect(s.doc().links.map((l) => l.id)).toEqual([l2]);
    void l1;
  });

  it('received nodes filed in boxes: one box per node (last placement wins), take-out, orphans kept, planned for the Plan lens', async () => {
    const s = inRoot(() => createPersonalState(memoryStore(), { debounceMs: 1 }));
    await s.load();
    const a = s.addBox(0, 0, 'Subgoal')!;
    const b = s.addBox(600, 0, 'Gunnflow')!;
    s.placeNode('t-build', a);
    s.placeNode('t-draft', a);
    s.placeNode('t-build', b);
    expect(s.doc().boxes.find((x) => x.id === a)!.members).toEqual(['t-draft']);
    expect(s.boxOfNode('t-build')).toBe(b);
    s.placeNode('t-draft', null);
    expect(s.boxOfNode('t-draft')).toBeNull();
    s.placeNode('vanished', b);
    const live = new Set(projectNodes(normalFixture()).map((n) => n.id));
    expect(s.missingMembers(live)).toEqual([{ boxId: b, nodeId: 'vanished' }]);
    s.addLink({ kind: 'box', id: a }, { kind: 'node', id: 't-test' });
    expect([...s.plannedNodes()].sort()).toEqual(['t-build', 't-test', 'vanished']);
    expect(personalDocProblem(s.doc())).toBeNull();
  });

  it('a failed save is reported, not hidden', async () => {
    const store = memoryStore();
    const s = inRoot(() => createPersonalState(store, { debounceMs: 1 }));
    await s.load();
    store.fail = true;
    s.setNote('t', 'x');
    await s.flush();
    expect(s.status()).toBe('unavailable');
    expect(s.problem()).toBe('not saved: disk full');
  });
});

describe('no path from personal items to intents, attestation or evidence', () => {
  const SRC = join(import.meta.dirname, '..', 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : /\.(ts|tsx)$/.test(e) ? [join(dir, e)] : []));
  const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);

  it('the personal modules import no relay, pending-intent, validator, evidence or transport code', () => {
    for (const file of files(join(SRC, 'personal'))) {
      for (const spec of importsOf(file)) {
        expect(/pendingIntents|intentValidator|fakeIntentAdapter|editorLogic|gateLogic|renderedToken|transport\/|genericActions|stores/.test(spec), `${file}: ${spec}`).toBe(false);
      }
    }
  });

  it('intent, relay and evidence modules never import the personal layer', () => {
    const guarded = ['state/pendingIntents.ts', 'state/intentValidator.ts', 'state/fakeIntentAdapter.ts', 'state/editorLogic.ts', 'state/gateLogic.ts', 'ui/renderedToken.ts', 'transport'];
    for (const g of guarded) {
      const path = join(SRC, g);
      for (const file of statSync(path).isDirectory() ? files(path) : [path]) {
        for (const spec of importsOf(file)) expect(spec.includes('personal'), `${file}: ${spec}`).toBe(false);
      }
    }
  });

  it('an intent carrying personal content is refused at the relay boundary', async () => {
    const p = normalFixture();
    const post = vi.fn(async () => ({ accepted: true }));
    const guarded = guardPost(post, createFakeIntentAdapter(() => projectNodes(p)), () => p);
    // Attestations are built only from display records minted by the evidence ledger, which the personal layer cannot reach (above).
    for (const extra of [{ personal: { note: 'x' } }, { note: 'x' }, { sticky: { id: 's-1' } }]) {
      const r = await guarded({ nodeId: 't-build', action: 'task.pause', idempotencyKey: 'k', ...extra } as unknown as WireIntent);
      expect(r.accepted).toBe(false);
    }
    expect(post).not.toHaveBeenCalled();
  });
});

describe('Plan lens', () => {
  it('brings planned nodes forward and dims the rest — every node keeps an entry (nothing hidden, no count change)', () => {
    const ids = projectNodes(normalFixture()).map((n) => n.id);
    const e = planEmphasis(ids, new Set(['t-build', 't-test']));
    expect(e.size).toBe(ids.length);
    expect(e.get('t-build')).toBe('highlight');
    expect(e.get('t-draft')).toBe('dim');
  });
});
