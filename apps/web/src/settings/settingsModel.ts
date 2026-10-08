/**
 * The settings screen as a wiring-config editor. Its only output is the
 * person's own file (`90-user.json`, merged last, so it always wins). It adds
 * no freedom to the engine: every choice is one of the closed tokens, and
 * nothing is saved unless the file — and the merge it produces — validates.
 *
 * The View tab is organised by kind, but the tables stay global (render and
 * relations are not per kind): a value used by several kinds is one setting,
 * shown in each kind's section and marked as shared.
 */
import { WORKSPACE_ROOT_KIND, type NodeProjection } from '@gunnflow/contract';
import {
  VIEWER_IDS,
  WIRING_SCHEMA_VERSION,
  validateWiringConfig,
  type ArrangeId,
  type AttentionMechanism,
  type ContainDirection,
  type EdgeStyleId,
  type ViewerId,
  type WiringConfig,
} from '@gunnflow/contract/wiring';
import { DEFAULT_WIRING } from '../wiring/defaultWiring.js';
import { loadWiringFiles } from '../wiring/loadWiring.js';

export const USER_FILE = '90-user.json';
export type Table = 'render' | 'relations' | 'attention' | 'viewers';
export type Layer = { file: string; config: WiringConfig };

/**
 * A backend tab in the View section. Tabs are derived from the loaded wiring
 * files (nothing is hard-coded): one per file (minus the person's own), named
 * by the file name with its ordering prefix and extension stripped, plus one
 * for the built-in default vocabulary.
 */
export interface SourceTab {
  id: string;
  name: string;
  config: WiringConfig;
}
export const DEFAULT_TAB_ID = '(default)';

/** `10-somebackend.json` → `somebackend` — the name comes from the config path itself. */
export function sourceName(file: string): string {
  const stripped = file.replace(/^[0-9]+[-_]*/, '').replace(/\.json$/i, '');
  return stripped || file;
}

export function sourceTabs(layers: readonly Layer[], defaultConfig: WiringConfig = DEFAULT_WIRING): SourceTab[] {
  const files = layers
    .filter((l) => l.file !== USER_FILE)
    .map((l) => ({ id: l.file, name: sourceName(l.file), config: l.config }));
  return [...files, { id: DEFAULT_TAB_ID, name: 'default', config: defaultConfig }];
}

/** Keys this source maps that the workspace does not currently show. */
export function sourceUnobserved(source: WiringConfig, nodes: readonly NodeProjection[]) {
  const states = new Set(nodes.map((n) => n.state.value));
  const relations = new Set(nodes.flatMap((n) => n.relations.map((r) => r.type)));
  return {
    states: Object.keys(source.render ?? {}).filter((k) => !states.has(k)).sort(byName),
    relations: Object.keys(source.relations ?? {}).filter((k) => !relations.has(k)).sort(byName),
  };
}

export const emptyUserConfig = (): WiringConfig => ({ version: WIRING_SCHEMA_VERSION });

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort(byName);

export interface SharedKey {
  key: string;
  /** Every kind whose nodes use this value (the setting is one, global). */
  kinds: string[];
}

export interface KindSection {
  kind: string;
  count: number;
  states: SharedKey[];
  relations: SharedKey[];
}

/**
 * View tab: per observed kind, the state values its nodes show and the
 * relation types they take part in (as source or target), each marked with
 * all kinds sharing it. Keys the config maps but the workspace does not show
 * are listed apart (unobserved).
 */
export function viewSections(nodes: readonly NodeProjection[], config: WiringConfig) {
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const stateKinds = new Map<string, Set<string>>();
  const relationKinds = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, key: string, kind: string) => m.set(key, (m.get(key) ?? new Set()).add(kind));
  const counts = new Map<string, number>();
  for (const n of nodes) {
    counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    add(stateKinds, n.state.value, n.kind);
    for (const r of n.relations) {
      add(relationKinds, r.type, n.kind);
      const target = kindOf.get(r.target);
      if (target) add(relationKinds, r.type, target);
    }
  }
  const shared = (m: Map<string, Set<string>>, kind: string): SharedKey[] =>
    [...m].filter(([, ks]) => ks.has(kind)).map(([key, ks]) => ({ key, kinds: sorted(ks) })).sort((a, b) => byName(a.key, b.key));
  const kinds = [...counts.keys()].sort((a, b) => (a === WORKSPACE_ROOT_KIND ? -1 : b === WORKSPACE_ROOT_KIND ? 1 : byName(a, b)));
  const sections: KindSection[] = kinds.map((kind) => ({
    kind,
    count: counts.get(kind)!,
    states: shared(stateKinds, kind),
    relations: shared(relationKinds, kind),
  }));
  return {
    sections,
    unobserved: {
      states: Object.keys(config.render ?? {}).filter((k) => !stateKinds.has(k)).sort(byName),
      relations: Object.keys(config.relations ?? {}).filter((k) => !relationKinds.has(k)).sort(byName),
    },
  };
}

/** Attention and Viewers tabs: what the workspace shows plus what the effective config already maps. */
export function attentionCauses(nodes: readonly NodeProjection[], config: WiringConfig): string[] {
  return sorted([...nodes.flatMap((n) => n.attention.map((a) => a.cause)), ...(config.attention ?? []).map((r) => r.match.cause)]);
}
export function mediaTypes(nodes: readonly NodeProjection[], config: WiringConfig): string[] {
  return sorted([...nodes.flatMap((n) => n.artifacts.map((a) => a.mediaType)), ...Object.keys(config.viewers ?? {})]);
}

const has = (config: WiringConfig, table: Table, key: string) =>
  table === 'attention' ? (config.attention ?? []).some((r) => r.match.cause === key) : Object.hasOwn(config[table] ?? {}, key);

/** Which layer the effective value of a key comes from: my settings, a wiring file, the default, or the engine. */
export function provenance(table: Table, key: string, layers: readonly Layer[], draft: WiringConfig): string {
  if (has(draft, table, key)) return 'my settings';
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]!;
    if (l.file !== USER_FILE && has(l.config, table, key)) return l.file;
  }
  return has(DEFAULT_WIRING, table, key) ? 'default' : 'engine default';
}

/* ---- draft edits (pure: each returns a new draft) ---- */

/** glyph: a preset token or a short literal (emoji ok); tone: a preset token or '#rrggbb'. The validator decides. */
export function setRender(d: WiringConfig, key: string, value: { glyph: string; tone: string }): WiringConfig {
  return { ...d, render: { ...(d.render ?? {}), [key]: value } };
}
export function setRelation(d: WiringConfig, key: string, value: { style: EdgeStyleId; arrange?: ArrangeId; direction?: ContainDirection }): WiringConfig {
  return { ...d, relations: { ...(d.relations ?? {}), [key]: value } };
}
export function setAttention(d: WiringConfig, cause: string, mechanism: AttentionMechanism): WiringConfig {
  const rules = [...(d.attention ?? [])];
  const at = rules.findIndex((r) => r.match.cause === cause);
  // A rule's display group survives a mechanism change.
  if (at >= 0) rules[at] = { ...rules[at]!, match: { cause }, mechanism };
  else rules.push({ match: { cause }, mechanism });
  return { ...d, attention: rules };
}
export function setViewer(d: WiringConfig, key: string, viewer: ViewerId): WiringConfig {
  return { ...d, viewers: { ...(d.viewers ?? {}), [key]: viewer } };
}
/** "Back to default": the key leaves my settings (the layers below apply again). */
export function resetKey(d: WiringConfig, table: Table, key: string): WiringConfig {
  if (table === 'attention') {
    const rules = (d.attention ?? []).filter((r) => r.match.cause !== key);
    const { attention: _a, ...rest } = d;
    return rules.length > 0 ? { ...rest, attention: rules } : rest;
  }
  const next = { ...(d[table] ?? {}) } as Record<string, unknown>;
  delete next[key];
  const { [table]: _t, ...rest } = d;
  return Object.keys(next).length > 0 ? ({ ...rest, [table]: next } as WiringConfig) : (rest as WiringConfig);
}

/** Viewers this media type may map to — asked of the validator itself (e.g. never image for SVG). */
export function viewerOptions(mediaType: string): ViewerId[] {
  return VIEWER_IDS.filter((v) => validateWiringConfig({ version: WIRING_SCHEMA_VERSION, viewers: { [mediaType]: v } }).ok);
}

/** The effective config with this draft as my file (what the canvas would use once saved). */
export function previewConfig(draft: WiringConfig, layers: readonly Layer[]): WiringConfig {
  const others = layers.filter((l) => l.file !== USER_FILE).map((l) => ({ file: l.file, config: l.config as unknown }));
  return loadWiringFiles([...others, { file: USER_FILE, config: draft }], DEFAULT_WIRING, () => undefined).config;
}

/**
 * Whether the draft may be saved: it must validate on its own, and the merge
 * with the other files (my file last) must validate as a whole.
 */
export function draftProblems(draft: WiringConfig, layers: readonly Layer[]): string[] {
  const alone = validateWiringConfig(draft);
  if (!alone.ok) return alone.problems;
  const others = layers.filter((l) => l.file !== USER_FILE).map((l) => ({ file: l.file, config: l.config as unknown }));
  const merged = loadWiringFiles([...others, { file: USER_FILE, config: draft }], DEFAULT_WIRING, () => undefined);
  if (merged.files.rejected.length > 0) return merged.files.rejected.flatMap((r) => r.reasons.map((x) => `${r.file}: ${x}`));
  return merged.problems.map((p) => `merged: ${p}`);
}
