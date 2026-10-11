/**
 * Wiring config: the per-workspace vocabulary mapping and node-kind assembly
 * a backend's vocabulary needs and the user owns. Config is data — the validator
 * enforces that reading it alone enumerates everything a kind can do:
 * closed shapes, closed engine token sets, no expression-like strings, part
 * references only to real siblings, every input carried by its action's send.
 */
import { isCompatibleContractVersion, parseSemver } from '../validate.js';

export const WIRING_SCHEMA_VERSION = '0.1.0';

/**
 * A glyph is a short literal the renderer prints verbatim (any unicode, emoji
 * included — no token indirection: the config stores what the screen shows).
 * Still data: it is a string to draw, never interpreted. Bidi/line controls
 * and C0/C1 controls are refused so a config cannot reorder or break the text
 * around it; ZWJ and variation selectors (emoji sequences) pass.
 */
const GLYPH_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
export const GLYPH_LITERAL_MAX = 16;
export function isGlyphValue(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  return v.trim().length > 0 && v.length <= GLYPH_LITERAL_MAX && !GLYPH_FORBIDDEN.test(v);
}
/** A tone is a literal hex colour — the config stores the colour itself. */
export const TONE_HEX = /^#[0-9a-fA-F]{6}$/;
export function isToneValue(v: unknown): v is string {
  return typeof v === 'string' && TONE_HEX.test(v);
}
/**
 * Engine edge styles (closed set). Dashed/dotted strokes are reserved for
 * pending and draft grades and are not configurable.
 */
export const EDGE_STYLE_IDS = ['solid', 'bold', 'muted', 'double'] as const;
/**
 * How a relation shapes layout (closed set; absent = none). `flow` lays its
 * ends out left-to-right in layers; `contain` nests one end inside the other's
 * group box — which end is the container is the entry's `direction`
 * (default 'in': the source sits inside its target, the shape of vocabularies
 * whose edge points at the parent, like member-of; 'out': the target sits
 * inside the source, for vocabularies whose edge points at the member, like
 * contains). Spacing and algorithm stay engine constants.
 */
export const ARRANGE_IDS = ['flow', 'contain', 'none'] as const;
/** Which end of a `contain` relation is the container, relative to the stored edge (source → target). */
export const CONTAIN_DIRECTIONS = ['in', 'out'] as const;
export type ContainDirection = (typeof CONTAIN_DIRECTIONS)[number];
/**
 * What a relation type is, for presentation (closed set, 0.6.0; absent =
 * unstated), read along the stored edge: the source <role> its target
 * ('waits_on': the source waits on the target; 'contains': the source holds
 * the target). The config states it for the upstream's vocabulary; the engine
 * may use it to choose how an edge reads (legend, emphasis), never to infer
 * anything about the nodes it joins. `arrange` stays the layout authority.
 */
export const RELATION_ROLES = ['waits_on', 'blocks', 'supports', 'produces', 'contains'] as const;
export type RelationRole = (typeof RELATION_ROLES)[number];
/**
 * Engine viewers (closed set). html, mermaid and excalidraw only ever render
 * on the isolated origin; mermaid and excalidraw each accept only their own
 * media types (generic JSON is never taken for a drawing).
 */
export const VIEWER_IDS = ['text', 'markdown-source', 'image', 'pdf', 'html-isolated', 'mermaid', 'excalidraw', 'fallback'] as const;
/** The only media types each diagram viewer may be mapped from. */
export const DIAGRAM_MEDIA_TYPES: Readonly<Record<'mermaid' | 'excalidraw', readonly string[]>> = {
  mermaid: ['text/vnd.mermaid', 'text/x-mermaid'],
  excalidraw: ['application/vnd.excalidraw+json'],
};
export const ATTENTION_MECHANISMS = ['interrupt', 'ambient'] as const;
/**
 * Node shapes (closed set, 0.5.0): how a kind's nodes are drawn and how much
 * room they take. Presentation only — a shape says nothing about state, risk
 * or priority. 'band' applies to containers (a wide row with a name strip on
 * top); a leaf declared 'band' is drawn as 'rect'.
 */
export const SHAPE_IDS = ['rect', 'pill', 'circle', 'diamond', 'hexagon', 'band'] as const;
/** The range of a kind's size factor (1 = the engine's base size for its shape). */
export const KIND_SIZE_RANGE = { min: 0.5, max: 3 } as const;

export type EdgeStyleId = (typeof EDGE_STYLE_IDS)[number];
export type ArrangeId = (typeof ARRANGE_IDS)[number];
export type ViewerId = (typeof VIEWER_IDS)[number];
export type AttentionMechanism = (typeof ATTENTION_MECHANISMS)[number];
export type ShapeId = (typeof SHAPE_IDS)[number];

/**
 * One kind's presentation: its part assembly (absent = the engine default),
 * its shape (absent = 'rect') and size factor (absent = 1).
 */
export interface KindDecl {
  parts?: PartDecl[];
  shape?: ShapeId;
  size?: number;
}

export type PartDecl =
  | { id: string; part: 'glyph' }
  | { id: string; part: 'label'; source: 'label' | 'state' | 'kind' }
  | { id: string; part: 'viewer'; source: { artifact: number } }
  | { id: string; part: 'selector'; action: string }
  | { id: string; part: 'text'; action: string }
  | { id: string; part: 'editor'; action: string; rows: number; wrap: 'soft' | 'none' }
  | { id: string; part: 'stream'; source: { role: string }; retainItems: number; retainBytes: number }
  | { id: string; part: 'send'; action: string; requires: string[] };

/** How a `within` clause walks the stored edges (source → target) from its anchor. */
export const WITHIN_DIRECTIONS = ['out', 'in', 'any'] as const;
export type WithinDirection = (typeof WITHIN_DIRECTIONS)[number];

/**
 * A sidebar lens as config data: a name plus a match table over received
 * facts. A node matches when every present field holds (states contains its
 * state value, kinds contains its kind, attention means it carries any,
 * within means the node is in the clause's reachable set).
 * Lenses only re-weight emphasis — they never hide, filter or write.
 * `all` and `plan` are engine lenses and cannot be declared.
 */
export interface LensDecl {
  id: string;
  label: string;
  match: {
    states?: string[];
    attention?: boolean;
    kinds?: string[];
    /**
     * Subtree clause: the anchor node plus every node connected to it through
     * the named relation types, transitively. Mechanical reachability over
     * received relations only — the engine never knows what the type names
     * mean. Direction is relative to the stored edge (a node's relation
     * {type, target} is source → target): 'out' walks source→target from the
     * anchor, 'in' walks the reverse, 'any' walks both.
     */
    within?: { anchor: string; relations: string[]; direction: WithinDirection };
  };
}
export const RESERVED_LENS_IDS = ['all', 'plan'] as const;

export interface WiringConfig {
  version: string;
  /** glyph: a short literal printed verbatim; tone: a '#rrggbb' colour. */
  render?: Record<string, { glyph: string; tone: string }>;
  relations?: Record<string, { style: EdgeStyleId; arrange?: ArrangeId; direction?: ContainDirection; role?: RelationRole }>;
  /**
   * First match wins; an unmatched cause is ambient (engine invariant).
   * `group` is a display group name (a literal the screen prints, never
   * interpreted): surfaces that list attention count and show it per group.
   */
  attention?: AttentionRule[];
  viewers?: Record<string, ViewerId>;
  kinds?: Record<string, KindDecl>;
  lenses?: LensDecl[];
  /**
   * Display label per action name (upstream vocabulary, verbatim key). A
   * button prints the label instead of the raw name; an action without an
   * entry shows its raw name. Presentation only — it grants nothing.
   */
  actions?: Record<string, { label: string }>;
  /**
   * Detail presentation, all by verbatim label match (the engine never
   * interprets a label): `emphasis` — items the detail view emphasizes;
   * `collapsed` — items shown folded by default (folded, never hidden);
   * `copyable` — text items shown as exact-bytes copy boxes.
   */
  detail?: DetailPresentation;
}

export interface AttentionRule {
  match: { cause: string };
  mechanism: AttentionMechanism;
  group?: string;
}

export interface DetailPresentation {
  emphasis?: string[];
  collapsed?: string[];
  copyable?: string[];
}
/** The detail presentation lists (each optional, same shape and ceiling). */
export const DETAIL_LISTS = ['emphasis', 'collapsed', 'copyable'] as const;

export type WiringValidation = { ok: true; config: WiringConfig } | { ok: false; problems: string[] };

const INPUT_PARTS = new Set(['selector', 'text', 'editor']);
const PART_KEYS: Record<PartDecl['part'], readonly string[]> = {
  glyph: ['id', 'part'],
  label: ['id', 'part', 'source'],
  viewer: ['id', 'part', 'source'],
  selector: ['id', 'part', 'action'],
  text: ['id', 'part', 'action'],
  editor: ['id', 'part', 'action', 'rows', 'wrap'],
  stream: ['id', 'part', 'source', 'retainItems', 'retainBytes'],
  send: ['id', 'part', 'action', 'requires'],
};
const EXPRESSION = /\{\{|\$\{|=>|\bfunction\b|`/;
/** Keys that would reach the prototype chain in a naive lookup. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Size ceilings: config stays small, inspectable data. */
export const WIRING_LIMITS = {
  string: 256,
  tableEntries: 256,
  attentionRules: 128,
  lenses: 32,
  lensMatchEntries: 64,
  kinds: 128,
  partsPerKind: 32,
  requires: 16,
  /** Per detail list (emphasis, collapsed, copyable). */
  detailEmphasis: 32,
  /** Bytes per config file; a file within the other limits stays well below it. */
  fileBytes: 256 * 1024,
} as const;
/** SVG can run script: it never maps through `image/*`, and only to an isolated or fallback viewer. */
const SVG = 'image/svg+xml';
const RESERVED_TOKEN = /^--draft-/;
const PART_ID = /^[a-z][a-z0-9-]*$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/([a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a wiring config. Collects every problem rather than stopping at the first. */
export function validateWiringConfig(value: unknown): WiringValidation {
  const problems: string[] = [];
  const p = (path: string, msg: string) => problems.push(`${path}: ${msg}`);

  // Data-only: no string anywhere (keys included) may look like code or a reserved token.
  const scan = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (EXPRESSION.test(v)) p(path, `expression-like string ${JSON.stringify(v).slice(0, 80)}`);
      if (RESERVED_TOKEN.test(v)) p(path, `reserved token ${JSON.stringify(v).slice(0, 80)}`);
      if (v.length > WIRING_LIMITS.string) p(path, `string longer than ${WIRING_LIMITS.string}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => scan(x, `${path}[${i}]`));
    } else if (isRecord(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k)) p(path, `forbidden key '${k}'`);
        if (EXPRESSION.test(k)) p(`${path}.${k.slice(0, 80)}`, 'expression-like key');
        if (RESERVED_TOKEN.test(k)) p(`${path}.${k.slice(0, 80)}`, 'reserved token as key');
        if (k.length > WIRING_LIMITS.string) p(path, `key longer than ${WIRING_LIMITS.string}`);
        scan(x, `${path}.${k.slice(0, 80)}`);
      }
    }
  };
  scan(value, 'config');

  const closed = (v: Record<string, unknown>, keys: readonly string[], path: string) => {
    for (const k of Object.keys(v)) if (!keys.includes(k)) p(path, `unknown key '${k}'`);
  };
  const oneOf = (v: unknown, set: readonly string[], path: string) => {
    if (typeof v !== 'string' || !set.includes(v)) p(path, `must be one of ${set.join('|')}, got ${JSON.stringify(v)}`);
  };
  const nonEmptyString = (v: unknown, path: string) => {
    if (typeof v !== 'string' || v === '') p(path, 'must be a non-empty string');
  };
  /** A literal the screen prints as a name (group, action label): non-blank, no control/bidi characters. */
  const printable = (v: unknown, path: string) => {
    if (typeof v !== 'string' || v.trim() === '') p(path, 'must be a non-blank string');
    else if (GLYPH_FORBIDDEN.test(v)) p(path, 'must not contain control or bidi characters');
  };
  const record = (
    v: unknown,
    path: string,
    each: (k: string, x: unknown, at: string) => void,
    max: number = WIRING_LIMITS.tableEntries,
  ) => {
    if (v === undefined) return;
    if (!isRecord(v)) return p(path, 'must be an object');
    const entries = Object.entries(v);
    if (entries.length > max) return p(path, `more than ${max} entries`);
    for (const [k, x] of entries) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      if (k === '') p(path, 'empty key');
      each(k, x, `${path}.${k}`);
    }
  };

  if (!isRecord(value)) return { ok: false, problems: ['config: must be an object'] };
  closed(value, ['version', 'render', 'relations', 'attention', 'viewers', 'kinds', 'lenses', 'actions', 'detail'], 'config');

  if (typeof value.version !== 'string' || !parseSemver(value.version)) {
    p('config.version', 'must be a semver string');
  } else if (!isCompatibleContractVersion(value.version, WIRING_SCHEMA_VERSION)) {
    p('config.version', `${value.version} is incompatible with wiring schema ${WIRING_SCHEMA_VERSION}`);
  }

  record(value.render, 'config.render', (_k, x, at) => {
    if (!isRecord(x)) return p(at, 'must be { glyph, tone }');
    closed(x, ['glyph', 'tone'], at);
    if (!isGlyphValue(x.glyph)) {
      p(`${at}.glyph`, `must be a literal to print (1..${GLYPH_LITERAL_MAX} chars, no control/bidi characters), got ${JSON.stringify(x.glyph)}`);
    }
    if (!isToneValue(x.tone)) {
      p(`${at}.tone`, `must be a hex colour '#rrggbb', got ${JSON.stringify(x.tone)}`);
    }
  });

  record(value.relations, 'config.relations', (_k, x, at) => {
    if (!isRecord(x)) return p(at, 'must be { style, arrange?, direction?, role? }');
    closed(x, ['style', 'arrange', 'direction', 'role'], at);
    oneOf(x.style, EDGE_STYLE_IDS, `${at}.style`);
    if (x.arrange !== undefined) oneOf(x.arrange, ARRANGE_IDS, `${at}.arrange`);
    if (x.direction !== undefined) {
      oneOf(x.direction, CONTAIN_DIRECTIONS, `${at}.direction`);
      if (x.arrange !== 'contain') p(`${at}.direction`, "only a 'contain' relation has a direction");
    }
    if (x.role !== undefined) oneOf(x.role, RELATION_ROLES, `${at}.role`);
  });

  if (value.attention !== undefined) {
    if (!Array.isArray(value.attention)) {
      p('config.attention', 'must be an array');
    } else if (value.attention.length > WIRING_LIMITS.attentionRules) {
      p('config.attention', `more than ${WIRING_LIMITS.attentionRules} rules`);
    } else {
      const seen = new Set<string>();
      value.attention.forEach((rule, i) => {
        const at = `config.attention[${i}]`;
        if (!isRecord(rule)) return p(at, 'must be { match, mechanism, group? }');
        closed(rule, ['match', 'mechanism', 'group'], at);
        oneOf(rule.mechanism, ATTENTION_MECHANISMS, `${at}.mechanism`);
        if (rule.group !== undefined) printable(rule.group, `${at}.group`);
        if (!isRecord(rule.match)) return p(`${at}.match`, 'must be { cause }');
        closed(rule.match, ['cause'], `${at}.match`);
        nonEmptyString(rule.match.cause, `${at}.match.cause`);
        const cause = rule.match.cause as string;
        if (seen.has(cause)) p(at, `cause '${cause}' already matched by an earlier rule (unreachable)`);
        seen.add(cause);
      });
    }
  }

  record(value.viewers, 'config.viewers', (k, x, at) => {
    if (!MEDIA_TYPE.test(k)) p(at, 'key must be a media type (type/subtype or type/*)');
    oneOf(x, VIEWER_IDS, at);
    if (x === 'html-isolated' && k !== 'text/html' && k !== SVG) p(at, "'html-isolated' is only for text/html and image/svg+xml");
    if (k === SVG && x !== 'html-isolated' && x !== 'fallback') p(at, 'image/svg+xml may only map to html-isolated or fallback');
    if ((x === 'mermaid' || x === 'excalidraw') && !DIAGRAM_MEDIA_TYPES[x].includes(k)) {
      p(at, `'${x}' is only for ${DIAGRAM_MEDIA_TYPES[x].join(', ')}`);
    }
  });

  if (value.lenses !== undefined) {
    if (!Array.isArray(value.lenses)) {
      p('config.lenses', 'must be an array');
    } else if (value.lenses.length > WIRING_LIMITS.lenses) {
      p('config.lenses', `more than ${WIRING_LIMITS.lenses} lenses`);
    } else {
      const seen = new Set<string>();
      const LENS_ID = /^[a-z][a-z0-9-]*$/;
      value.lenses.forEach((lens, i) => {
        const at = `config.lenses[${i}]`;
        if (!isRecord(lens)) return p(at, 'must be { id, label, match }');
        closed(lens, ['id', 'label', 'match'], at);
        if (typeof lens.id !== 'string' || !LENS_ID.test(lens.id)) p(`${at}.id`, 'must match [a-z][a-z0-9-]*');
        else if ((RESERVED_LENS_IDS as readonly string[]).includes(lens.id)) p(`${at}.id`, `'${lens.id}' is an engine lens`);
        else if (seen.has(lens.id)) p(`${at}.id`, `duplicate lens id '${lens.id}'`);
        else seen.add(lens.id);
        nonEmptyString(lens.label, `${at}.label`);
        if (!isRecord(lens.match)) return p(`${at}.match`, 'must be { states?, attention?, kinds?, within? }');
        closed(lens.match, ['states', 'attention', 'kinds', 'within'], `${at}.match`);
        const m = lens.match as { states?: unknown; attention?: unknown; kinds?: unknown; within?: unknown };
        if (m.states === undefined && m.attention === undefined && m.kinds === undefined && m.within === undefined) {
          p(`${at}.match`, 'must name at least one of states, attention, kinds, within');
        }
        for (const key of ['states', 'kinds'] as const) {
          const v = m[key];
          if (v === undefined) continue;
          if (!Array.isArray(v) || v.length === 0) p(`${at}.match.${key}`, 'must be a non-empty array of strings');
          else if (v.length > WIRING_LIMITS.lensMatchEntries) p(`${at}.match.${key}`, `more than ${WIRING_LIMITS.lensMatchEntries} entries`);
          else v.forEach((x, j) => nonEmptyString(x, `${at}.match.${key}[${j}]`));
        }
        if (m.attention !== undefined && m.attention !== true) {
          p(`${at}.match.attention`, 'must be true when present');
        }
        if (m.within !== undefined) {
          const wat = `${at}.match.within`;
          if (!isRecord(m.within)) {
            p(wat, 'must be { anchor, relations, direction }');
          } else {
            closed(m.within, ['anchor', 'relations', 'direction'], wat);
            nonEmptyString(m.within.anchor, `${wat}.anchor`);
            const rels = m.within.relations;
            if (!Array.isArray(rels) || rels.length === 0) p(`${wat}.relations`, 'must be a non-empty array of relation types');
            else if (rels.length > WIRING_LIMITS.lensMatchEntries) p(`${wat}.relations`, `more than ${WIRING_LIMITS.lensMatchEntries} entries`);
            else rels.forEach((x, j) => nonEmptyString(x, `${wat}.relations[${j}]`));
            oneOf(m.within.direction, WITHIN_DIRECTIONS, `${wat}.direction`);
          }
        }
      });
    }
  }

  record(value.actions, 'config.actions', (_k, x, at) => {
    if (!isRecord(x)) return p(at, 'must be { label }');
    closed(x, ['label'], at);
    printable(x.label, `${at}.label`);
  });

  if (value.detail !== undefined) {
    const at = 'config.detail';
    if (!isRecord(value.detail)) {
      p(at, 'must be { emphasis?, collapsed?, copyable? }');
    } else {
      closed(value.detail, DETAIL_LISTS, at);
      for (const key of DETAIL_LISTS) {
        const list = value.detail[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) p(`${at}.${key}`, 'must be an array of labels');
        else if (list.length > WIRING_LIMITS.detailEmphasis) p(`${at}.${key}`, `more than ${WIRING_LIMITS.detailEmphasis} entries`);
        else list.forEach((x, i) => nonEmptyString(x, `${at}.${key}[${i}]`));
      }
    }
  }

  record(value.kinds, 'config.kinds', (_kind, x, at) => {
    if (!isRecord(x)) return p(at, 'must be { parts?, shape?, size? }');
    closed(x, ['parts', 'shape', 'size'], at);
    if (x.shape !== undefined) oneOf(x.shape, SHAPE_IDS, `${at}.shape`);
    if (x.size !== undefined && !(typeof x.size === 'number' && Number.isFinite(x.size) && x.size >= KIND_SIZE_RANGE.min && x.size <= KIND_SIZE_RANGE.max)) {
      p(`${at}.size`, `must be a number from ${KIND_SIZE_RANGE.min} to ${KIND_SIZE_RANGE.max}, got ${JSON.stringify(x.size)}`);
    }
    if (x.parts === undefined) return;
    if (!Array.isArray(x.parts)) return p(`${at}.parts`, 'must be an array');
    if (x.parts.length > WIRING_LIMITS.partsPerKind) return p(`${at}.parts`, `more than ${WIRING_LIMITS.partsPerKind} parts`);
    validateParts(x.parts, `${at}.parts`, p, closed, oneOf, nonEmptyString);
  }, WIRING_LIMITS.kinds);

  return problems.length === 0 ? { ok: true, config: value as unknown as WiringConfig } : { ok: false, problems };
}

function validateParts(
  parts: unknown[],
  at: string,
  p: (path: string, msg: string) => void,
  closed: (v: Record<string, unknown>, keys: readonly string[], path: string) => void,
  oneOf: (v: unknown, set: readonly string[], path: string) => void,
  nonEmptyString: (v: unknown, path: string) => void,
) {
  const byId = new Map<string, Record<string, unknown>>();
  parts.forEach((part, i) => {
    const pat = `${at}[${i}]`;
    if (!isRecord(part)) return p(pat, 'must be an object');
    const kind = part.part as PartDecl['part'];
    if (!(kind in PART_KEYS)) return p(`${pat}.part`, `unknown part ${JSON.stringify(part.part)}`);
    closed(part, PART_KEYS[kind], pat);
    if (typeof part.id !== 'string' || !PART_ID.test(part.id)) return p(`${pat}.id`, 'must match [a-z][a-z0-9-]*');
    if (byId.has(part.id)) p(`${pat}.id`, `duplicate part id '${part.id}'`);
    byId.set(part.id, part);
    const intInRange = (v: unknown, lo: number, hi: number, path: string) => {
      if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) p(path, `must be an integer in ${lo}..${hi}`);
    };
    switch (kind) {
      case 'label':
        oneOf(part.source, ['label', 'state', 'kind'], `${pat}.source`);
        break;
      case 'viewer':
        if (!isRecord(part.source)) {
          p(`${pat}.source`, 'must be { artifact: index }');
        } else {
          closed(part.source, ['artifact'], `${pat}.source`);
          intInRange(part.source.artifact, 0, 1000, `${pat}.source.artifact`);
        }
        break;
      case 'selector':
      case 'text':
        nonEmptyString(part.action, `${pat}.action`);
        break;
      case 'editor':
        nonEmptyString(part.action, `${pat}.action`);
        intInRange(part.rows, 1, 200, `${pat}.rows`);
        oneOf(part.wrap, ['soft', 'none'], `${pat}.wrap`);
        break;
      case 'stream':
        if (!isRecord(part.source)) {
          p(`${pat}.source`, 'must be { role }');
        } else {
          closed(part.source, ['role'], `${pat}.source`);
          nonEmptyString(part.source.role, `${pat}.source.role`);
        }
        intInRange(part.retainItems, 1, Number.MAX_SAFE_INTEGER, `${pat}.retainItems`);
        intInRange(part.retainBytes, 1, Number.MAX_SAFE_INTEGER, `${pat}.retainBytes`);
        break;
      case 'send':
        nonEmptyString(part.action, `${pat}.action`);
        if (!Array.isArray(part.requires) || !part.requires.every((r) => typeof r === 'string')) {
          p(`${pat}.requires`, 'must be an array of sibling part ids');
        } else if (part.requires.length > WIRING_LIMITS.requires) {
          p(`${pat}.requires`, `more than ${WIRING_LIMITS.requires} entries`);
        }
        break;
      default:
        break;
    }
  });

  // Cross-part rules: sends own their action; inputs feed exactly the send of their action.
  const sends = [...byId.values()].filter((x) => x.part === 'send');
  const sendActions = new Map<string, string>();
  for (const s of sends) {
    const action = s.action as string;
    if (sendActions.has(action)) p(`${at}`, `action '${action}' has two sends ('${sendActions.get(action)}', '${s.id}')`);
    sendActions.set(action, s.id as string);
    const requires = Array.isArray(s.requires) ? (s.requires as string[]) : [];
    if (new Set(requires).size !== requires.length) p(`${at}.${s.id}`, 'requires lists a part twice');
    for (const r of requires) {
      const target = byId.get(r);
      if (!target) p(`${at}.${s.id}`, `requires unknown sibling '${r}'`);
      else if (r === s.id) p(`${at}.${s.id}`, 'requires itself');
      else if (target.part === 'send') p(`${at}.${s.id}`, `requires another send '${r}'`);
      else if (INPUT_PARTS.has(target.part as string) && target.action !== action) {
        p(`${at}.${s.id}`, `requires '${r}', an input for a different action ('${String(target.action)}')`);
      }
    }
  }
  // One input of each part type per action: an intent carries a single option, text and edit.
  const seenInput = new Set<string>();
  for (const input of [...byId.values()].filter((x) => INPUT_PARTS.has(x.part as string))) {
    const slot = `${String(input.part)}:${String(input.action)}`;
    if (seenInput.has(slot)) p(`${at}.${input.id}`, `second ${String(input.part)} for action '${String(input.action)}'`);
    seenInput.add(slot);
  }
  // An input is carried by the send of its action; `requires` lists only the preconditions.
  for (const input of [...byId.values()].filter((x) => INPUT_PARTS.has(x.part as string))) {
    if (!sends.some((s) => s.action === input.action)) {
      p(`${at}.${input.id}`, `input for action '${String(input.action)}' has no send`);
    }
  }
}

const own = <T>(table: Record<string, T> | undefined, key: string): T | undefined =>
  table && Object.hasOwn(table, key) ? table[key] : undefined;

/**
 * Actions a kind's assembly gives a presentation to (its sends). The source of
 * what a node can do is its capabilities; the assembly only covers some of it.
 */
export function coveredActions(config: WiringConfig, kind: string): string[] {
  return (own(config.kinds, kind)?.parts ?? []).flatMap((part) => (part.part === 'send' ? [part.action] : []));
}

/** The config-declared lenses, in order (empty when none). */
export function configLenses(config: WiringConfig): LensDecl[] {
  return config.lenses ?? [];
}

/** Labels the detail view emphasizes (verbatim match, no interpretation); empty when unconfigured. */
export function detailEmphasis(config: WiringConfig): readonly string[] {
  return config.detail?.emphasis ?? [];
}
/** Labels whose detail items start folded (verbatim match); empty when unconfigured. */
export function detailCollapsed(config: WiringConfig): readonly string[] {
  return config.detail?.collapsed ?? [];
}
/** Labels whose text items render as exact-bytes copy boxes (verbatim match); empty when unconfigured. */
export function detailCopyable(config: WiringConfig): readonly string[] {
  return config.detail?.copyable ?? [];
}

/** Attention mechanism for a cause: first matching rule, else ambient (engine invariant). */
export function attentionMechanism(config: WiringConfig, cause: string): AttentionMechanism {
  return config.attention?.find((r) => r.match.cause === cause)?.mechanism ?? 'ambient';
}

/** Display group of a cause: the first matching rule's group; undefined when unmatched or ungrouped. */
export function attentionGroup(config: WiringConfig, cause: string): string | undefined {
  return config.attention?.find((r) => r.match.cause === cause)?.group;
}

/** Display label for an action: the config's literal, else the raw action name (own-property lookup). */
export function actionLabel(config: WiringConfig, action: string): string {
  return own(config.actions, action)?.label ?? action;
}

/** Own-property lookups for the tables (never the prototype chain). */
export function renderFor(config: WiringConfig, stateValue: string) {
  return own(config.render, stateValue);
}
export function relationStyleFor(config: WiringConfig, type: string) {
  return own(config.relations, type)?.style;
}
/** Presentation role of a relation type; undefined when unregistered or unstated. */
export function relationRoleFor(config: WiringConfig, type: string): RelationRole | undefined {
  return own(config.relations, type)?.role;
}
/** Layout role of a relation type; unregistered or unstated = none. */
export function relationArrangeFor(config: WiringConfig, type: string): ArrangeId {
  return own(config.relations, type)?.arrange ?? 'none';
}
/** Container end of a `contain` relation; unstated = 'in' (the source sits inside its target). */
export function relationDirectionFor(config: WiringConfig, type: string): ContainDirection {
  return own(config.relations, type)?.direction ?? 'in';
}
export function kindParts(config: WiringConfig, kind: string): PartDecl[] | undefined {
  return own(config.kinds, kind)?.parts;
}
/** A kind's shape and size factor; unstated = 'rect' at 1. */
export function kindShape(config: WiringConfig, kind: string): { shape: ShapeId; size: number } {
  const k = own(config.kinds, kind);
  return { shape: k?.shape ?? 'rect', size: k?.size ?? 1 };
}

/** Viewer for a media type: exact entry, else `type/*` (never for SVG), else undefined. */
export function viewerFor(config: WiringConfig, mediaType: string): ViewerId | undefined {
  const exact = own(config.viewers, mediaType);
  if (exact) return exact;
  if (mediaType === SVG) return undefined;
  const slash = mediaType.indexOf('/');
  return slash > 0 ? own(config.viewers, `${mediaType.slice(0, slash)}/*`) : undefined;
}
