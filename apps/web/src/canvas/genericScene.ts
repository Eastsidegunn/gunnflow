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
import { isBand, leafBaseSize, leafShapeOf, type LeafShape } from './shapes.js';
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
  /** The kind's drawn shape (wiring `kinds[kind].shape`; 'rect' unless stated) and its tier-1 box. */
  shape: LeafShape;
  baseSize: { w: number; h: number };
  /** A container drawn as a wide band (wiring shape 'band'). */
  band: boolean;
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
  /**
   * Relations between a container and one of its own descendants (other than
   * the containment the nesting already shows), per descendant. They are not
   * drawn as lines — a line from a box to something inside it reads as the
   * containment again — but as a small chip on the descendant (decision
   * 2026-10-10, GF-E). Received facts, kept verbatim; the engine reads only
   * the geometry of containment, never a relation's name.
   */
  nestedLinks: ReadonlyMap<string, readonly NestedLink[]>;
}

/** A relation between a descendant and one of its containers, seen from the descendant. */
export interface NestedLink {
  /** The relation type, verbatim. */
  type: string;
  /** The container end. */
  other: string;
  /** 'in': the container's relation points at the descendant; 'out': the descendant's points at the container. */
  direction: 'in' | 'out';
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
    shape: leafShapeOf(config, n.kind).shape,
    baseSize: leafBaseSize(config, n.kind),
    band: isBand(config, n.kind),
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
    const size = graph.nodes.find((g) => g.id === id) ?? GENERIC_NODE_SIZE;
    boxes.set(id, { id, kind: byId.get(id)!.kind, x: at.x, y: at.y, w: size.w, h: size.h });
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

  const { edges, nestedLinks } = classifyRelations(nodes, config, graph);
  const groupList = [...groups.values()].sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
  return {
    layout: { nodes: boxes, missions: groupList },
    nodes: new Map(nodes.map((n) => [n.id, sceneNode(n, config)])),
    edges,
    groups: groupList,
    withheld: graph.withheld,
    nestedLinks,
  };
}

/**
 * Which received relations are drawn as lines, and which are kept as nested
 * links on a descendant (GF-E): a containment the nesting shows is neither; a
 * relation between a container and its own descendant is a nested link; every
 * other relation is a line. Containment geometry only — never a relation's name.
 */
export function classifyRelations(
  nodes: readonly NodeProjection[],
  config: WiringConfig,
  graph: { parentOf: ReadonlyMap<string, string> },
): { edges: SceneEdge[]; nestedLinks: Map<string, NestedLink[]> } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // A containing relation is shown by the nesting itself.
  const nestingShows = (n: NodeProjection, r: { type: string; target: string }) => {
    if (relationArrangeFor(config, r.type) !== 'contain') return false;
    return relationDirectionFor(config, r.type) === 'out'
      ? graph.parentOf.get(r.target) === n.id
      : graph.parentOf.get(n.id) === r.target;
  };
  /** Whether `a` contains `b` at any depth (containment as laid out). */
  const isAncestor = (a: string, b: string) => {
    for (let p = graph.parentOf.get(b), guard = 0; p !== undefined && guard <= LAYOUT.maxNestDepth + 1; p = graph.parentOf.get(p), guard++) {
      if (p === a) return true;
    }
    return false;
  };
  const nestedLinks = new Map<string, NestedLink[]>();
  const addNested = (descendant: string, link: NestedLink) => {
    const list = nestedLinks.get(descendant);
    if (list) list.push(link);
    else nestedLinks.set(descendant, [link]);
  };
  const edges: SceneEdge[] = nodes.flatMap((n) =>
    n.relations
      .filter((r) => byId.has(r.target) && !nestingShows(n, r))
      .filter((r) => {
        // Between a container and its own descendant: a chip on the descendant, not a line.
        if (isAncestor(n.id, r.target)) {
          addNested(r.target, { type: r.type, other: n.id, direction: 'in' });
          return false;
        }
        if (isAncestor(r.target, n.id)) {
          addNested(n.id, { type: r.type, other: r.target, direction: 'out' });
          return false;
        }
        return true;
      })
      .map((r) => ({ from: n.id, to: r.target, type: r.type, stroke: edgeStroke(relationStyleFor(config, r.type)) })),
  );
  return { edges, nestedLinks };
}

/** Where a descendant's nested-link chip sits: on its top-left corner, a little outside (world units). */
export function nestedChipRect(box: Rect, count: number): Rect {
  return { x: box.x - 8, y: box.y - 10, w: count > 1 ? 30 : 20, h: 18 };
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
