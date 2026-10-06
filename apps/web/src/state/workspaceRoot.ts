/**
 * The workspace root: the one node of the contract's root kind. Zero or
 * several such nodes means there is no root — no workspace actions, and the
 * reason is reported rather than a candidate guessed.
 */
import { WORKSPACE_ROOT_KIND, type NodeProjection } from '@gunnflow/contract';

export type RootResolution = { root: NodeProjection } | { root: undefined; problem: string | null };

export function workspaceRoot(nodes: readonly NodeProjection[] | null): RootResolution {
  if (!nodes) return { root: undefined, problem: null };
  const roots = nodes.filter((n) => n.kind === WORKSPACE_ROOT_KIND);
  if (roots.length === 1) return { root: roots[0]! };
  return {
    root: undefined,
    problem: roots.length === 0 ? null : `${roots.length} nodes of kind '${WORKSPACE_ROOT_KIND}' — no workspace root adopted`,
  };
}
