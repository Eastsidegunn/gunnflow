/**
 * LensState — the sidebar is a lens, not navigation (charter §11). A lens
 * only re-weights the projection's presentation; it never touches upstream
 * state, hides nodes or changes counts.
 *
 * The engine knows exactly two lenses: `all` (everything plain, interrupt
 * stands out) and `plan` (the person's board forward). Every other lens is
 * config data (`WiringConfig.lenses`): a label plus a match table over
 * received facts — the engine evaluates the table and never knows what the
 * words in it mean.
 */
import { createSignal } from 'solid-js';
import type { LensDecl } from '@gunnflow/contract/wiring';

/** `all`, `plan`, or a config-declared lens id. */
export type Lens = string;

export type Emphasis = 'highlight' | 'normal' | 'dim';

/** What a lens match table reads of a node: received facts only. */
export interface LensFacts {
  id: string;
  kind: string;
  state: string;
  hasAttention: boolean;
  /** The node's received relations, verbatim; only `within` clauses read them. */
  relations: readonly { type: string; target: string }[];
}

/**
 * The ids a `within` clause selects: the anchor plus every node connected to
 * it through the named relation types, transitively. Pure reachability over
 * received relations — no interpretation of what the type names mean. An
 * anchor that was never received selects only itself (nothing on screen).
 */
export function withinMembers(
  within: NonNullable<LensDecl['match']['within']>,
  facts: readonly LensFacts[],
): ReadonlySet<string> {
  const types = new Set(within.relations);
  const next = new Map<string, string[]>();
  const step = (from: string, to: string) => {
    const list = next.get(from);
    if (list) list.push(to);
    else next.set(from, [to]);
  };
  for (const f of facts) {
    for (const r of f.relations) {
      if (!types.has(r.type)) continue;
      if (within.direction !== 'in') step(f.id, r.target);
      if (within.direction !== 'out') step(r.target, f.id);
    }
  }
  const seen = new Set<string>([within.anchor]);
  const queue = [within.anchor];
  while (queue.length > 0) {
    for (const to of next.get(queue.pop()!) ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

/**
 * Pure table evaluation: every present field must hold. No interpretation.
 * A `within` field reads the precomputed member set (see `lensMatcher`).
 */
export function lensMatches(match: LensDecl['match'], node: LensFacts, withinIds?: ReadonlySet<string>): boolean {
  if (match.states && !match.states.includes(node.state)) return false;
  if (match.kinds && !match.kinds.includes(node.kind)) return false;
  if (match.attention && !node.hasAttention) return false;
  if (match.within && !withinIds?.has(node.id)) return false;
  return true;
}

/** Per-node matcher for one table, its `within` member set computed once. */
export function lensMatcher(match: LensDecl['match'], facts: readonly LensFacts[]): (node: LensFacts) => boolean {
  const withinIds = match.within ? withinMembers(match.within, facts) : undefined;
  return (node) => lensMatches(match, node, withinIds);
}

/** Config lens emphasis: matching nodes highlight, the rest dim. Nothing hides. */
export function configLensEmphasis(decl: LensDecl, nodes: readonly LensFacts[]): Map<string, Emphasis> {
  const matches = lensMatcher(decl.match, nodes);
  const out = new Map<string, Emphasis>();
  for (const n of nodes) out.set(n.id, matches(n) ? 'highlight' : 'dim');
  return out;
}

export function createLensState() {
  const [lens, setLens] = createSignal<Lens>('all');
  return { lens, setLens };
}

export type LensState = ReturnType<typeof createLensState>;

/**
 * The Plan lens: received nodes the person's board refers to (box members,
 * link ends, and the members of planned groups) are highlighted, the rest dim
 * — nothing is hidden and no count changes.
 */
export function planEmphasis(ids: Iterable<string>, planned: ReadonlySet<string>): Map<string, Emphasis> {
  const out = new Map<string, Emphasis>();
  for (const id of ids) out.set(id, planned.has(id) ? 'highlight' : 'dim');
  return out;
}
