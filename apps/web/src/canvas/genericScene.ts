/**
 * Generic scene: NodeProjection[] + wiring config → what the canvas draws.
 * Vocabulary is opaque: state values, kinds, relation types and causes are
 * shown as received text and mapped only through config tokens; anything
 * unmapped gets the engine default (neutral glyph, default edge, ambient).
 * Layout explains the declared relations and nothing else.
 */
import { WORKSPACE_ROOT_KIND, type NodeProjection } from '@gunnflow/contract';
import {
  actionLabel,
  attentionMechanism,
  configLenses,
  relationArrangeFor,
  relationDirectionFor,
  relationStyleFor,
  renderFor,
  type AttentionMechanism,
  type WiringConfig,
} from '@gunnflow/contract/wiring';
import { configLensEmphasis, type Emphasis, type Lens, type LensFacts } from '../state/lens.js';
import type { NodeBox, WorkspaceLayout } from './layout.js';
import { resolveParts, type ResolvedParts } from './parts.js';
import { GENERIC_NODE_SIZE, LAYOUT, childrenOf, containerRects, fallbackLayout, layoutGraphOf, leafIds, type Positions, type Rect } from './layoutGraph.js';
import { edgeStroke, glyphChar, toneColor, type EdgeStroke } from './tokens.js';

export interface SceneNode {
  id: string;
  /** The upstream's label, else the id. */
  title: string;
  kind: string;
  /** The raw state value, shown as text. */
  state: string;
  glyph: string;
  tone: string;
  /** Label texts from the assembly; empty when the kind has no label parts. */
  labels: string[];
  /** Engine attention rule, independent of the assembly; null when the node carries none. */
  attention: { mechanism: AttentionMechanism; causes: string[] } | null;
  /** The received relations, verbatim (lens `within` clauses read them). */
  relations: readonly { type: string; target: string }[];
  parts: ResolvedParts;
  /** Display label per action name (wiring `actions`, else the raw name). */
  actionLabels: Readonly<Record<string, string>>;
}

export interface SceneEdge {
  from: string;
  to: string;
  type: string;
  stroke: EdgeStroke;
}

export interface GenericScene {
  layout: WorkspaceLayout;
  /** Every canvas node's display data (leaves and group parents). */
  nodes: Map<string, SceneNode>;
  edges: SceneEdge[];
  /** Container boxes, outer first. */
  groups: GroupBox[];
  /** Nodes whose grouping is withheld (several containers or a containment cycle). */
  withheld: string[];
}

export { GENERIC_NODE_SIZE } from './layoutGraph.js';

/** A node that contains others, drawn as a labelled container around them. */
export interface GroupBox {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Nesting depth (0 = top level); outer groups draw first. */
  depth: number;
  /** Leaf nodes inside, at any depth. */
  members: string[];
}

function sceneNode(n: NodeProjection, config: WiringConfig): SceneNode {
  const render = renderFor(config, n.state.value);
  const parts = resolveParts(n, config);
  const causes = n.attention.map((a) => a.cause);
  const mechanisms = causes.map((c) => attentionMechanism(config, c));
  return {
    id: n.id,
    title: n.label ?? n.id,
    kind: n.kind,
    state: n.state.value,
    glyph: glyphChar(render?.glyph),
    tone: toneColor(render?.tone),
    labels: parts.display.flatMap((d) => (d.part === 'label' ? [d.text] : [])),
    attention:
      causes.length === 0
        ? null
        : { mechanism: mechanisms.includes('interrupt') ? 'interrupt' : 'ambient', causes },
    relations: n.relations,
    parts,
    actionLabels: Object.fromEntries(parts.actions.map((a) => [a.action, actionLabel(config, a.action)])),
  };
}

export function buildScene(
  all: readonly NodeProjection[],
  config: WiringConfig,
  overrides: ReadonlyMap<string, { x: number; y: number }> = new Map(),
  base: Positions = new Map(),
  /** On-screen rects (dynamic-view P3): the animated, tier-sized geometry. Hit-testing follows these. */
  onScreen: ReadonlyMap<string, Rect> = new Map(),
  /** Layout-shaping options (the `packContainers` machine pref), so the fallback matches the layout state's. */
  layoutOptions: { packContainers?: boolean } = {},
): GenericScene {
  // The workspace root is the toolbar's node, not a canvas node.
  const nodes = all.filter((n) => n.kind !== WORKSPACE_ROOT_KIND);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const graph = layoutGraphOf(nodes, config, layoutOptions);
  const leaves = leafIds(graph);
  // Computed positions come from the layout state; anything it has not placed yet takes the fallback.
  const placed = leaves.every((id) => base.has(id)) ? base : new Map([...fallbackLayout(graph), ...base]);
  const boxes = new Map<string, NodeBox>();
  for (const id of leaves) {
    const r = onScreen.get(id);
    if (r) {
      boxes.set(id, { id, kind: byId.get(id)!.kind, x: r.x, y: r.y, w: r.w, h: r.h });
      continue;
    }
    const at = overrides.get(id) ?? placed.get(id) ?? { x: 0, y: 0 };
    boxes.set(id, { id, kind: byId.get(id)!.kind, x: at.x, y: at.y, w: GENERIC_NODE_SIZE.w, h: GENERIC_NODE_SIZE.h });
  }

  // Group boxes wrap their content (after drags).
  const children = childrenOf(graph);
  const rects = containerRects(graph, (id) => boxes.get(id));
  const depthOf = (id: string) => {
    let d = 0;
    for (let p = graph.parentOf.get(id); p !== undefined && d <= LAYOUT.maxNestDepth; p = graph.parentOf.get(p)) d++;
    return d;
  };
  const groups = new Map<string, GroupBox>();
  const members = (id: string): string[] => {
    const out: string[] = [];
    const stack = [...(children.get(id) ?? [])];
    while (stack.length > 0) {
      const k = stack.pop()!;
      const kids = children.get(k);
      if (kids) stack.push(...kids);
      else out.push(k);
    }
    return out.sort();
  };
  for (const [id, r] of rects) {
    const n = byId.get(id)!;
    groups.set(id, { id, name: n.label ?? n.id, kind: n.kind, ...r, depth: depthOf(id), members: members(id) });
  }

  // A containing relation is shown by the nesting itself; every other relation is drawn.
  const nestingShows = (n: NodeProjection, r: { type: string; target: string }) => {
    if (relationArrangeFor(config, r.type) !== 'contain') return false;
    return relationDirectionFor(config, r.type) === 'out'
      ? graph.parentOf.get(r.target) === n.id
      : graph.parentOf.get(n.id) === r.target;
  };
  const edges: SceneEdge[] = nodes.flatMap((n) =>
    n.relations
      .filter((r) => byId.has(r.target) && !nestingShows(n, r))
      .map((r) => ({ from: n.id, to: r.target, type: r.type, stroke: edgeStroke(relationStyleFor(config, r.type)) })),
  );
  const groupList = [...groups.values()].sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
  return {
    layout: { nodes: boxes, missions: groupList },
    nodes: new Map(nodes.map((n) => [n.id, sceneNode(n, config)])),
    edges,
    groups: groupList,
    withheld: graph.withheld,
  };
}

/** The drawn rect of any canvas node: its node box, or its group box when it contains others. */
export function endpointBox(scene: GenericScene, id: string): (Rect & { id: string; kind: string }) | undefined {
  return scene.layout.nodes.get(id) ?? scene.groups.find((g) => g.id === id);
}

/** A scene node reduced to the facts a lens match table may read. */
export function sceneLensFacts(scene: GenericScene): LensFacts[] {
  return [...scene.nodes.values()].map((n) => ({ id: n.id, kind: n.kind, state: n.state, hasAttention: n.attention != null, relations: n.relations }));
}

/**
 * Lens emphasis on the generic path. `all` is the engine rule (everything
 * plain, interrupt stands out). Every other lens is config data: its match
 * table is evaluated over received facts, matching nodes highlight, the rest
 * dim. An id the config no longer declares falls back to `all`.
 */
export function genericEmphasis(
  scene: GenericScene,
  lens: Lens,
  config: WiringConfig,
): Map<string, Emphasis> {
  const decl = lens === 'all' ? undefined : configLenses(config).find((l) => l.id === lens);
  if (decl) return configLensEmphasis(decl, sceneLensFacts(scene));
  const out = new Map<string, Emphasis>();
  for (const n of scene.nodes.values()) out.set(n.id, n.attention?.mechanism === 'interrupt' ? 'highlight' : 'normal');
  return out;
}
