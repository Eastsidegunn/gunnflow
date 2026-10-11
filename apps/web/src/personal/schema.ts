/**
 * The personal layer's document: the person's own planning board on this
 * workspace — notes on nodes, sticky notes (text or mermaid diagrams), labelled
 * boxes (goals and subgoals) and links between them and received nodes. It is
 * a fifth display grade (personal) beside warranty/claim/portal/draft, held
 * apart from the three state worlds and from drafts, with no path to the relay:
 * nothing here can become an intent, an attestation or evidence.
 *
 * Containment on the board is visual only (coordinates); no parent is stored
 * and none is claimed.
 */
import { msg, type Msg } from '../i18n/index.js';

export const PERSONAL_VERSION = 2;
export const PERSONAL_LIMITS = {
  noteChars: 20_000,
  stickyChars: 20_000,
  labelChars: 200,
  stickies: 500,
  boxes: 200,
  links: 1_000,
  membersPerBox: 500,
  notes: 5_000,
  idChars: 256,
  minSize: 60,
  maxSize: 4_000,
} as const;

export const STICKY_DEFAULT = { w: 190, h: 112 } as const;

export interface PersonalNote {
  text: string;
  /** ISO time of the last edit (local clock). */
  updatedAt: string;
}

export type StickyKind = 'text' | 'mermaid';

export interface PersonalSticky {
  id: string;
  kind: StickyKind;
  /** The note text, or the mermaid source. */
  text: string;
  /** World rect — the person's placement, never laid out. */
  x: number;
  y: number;
  w: number;
  h: number;
  updatedAt: string;
}

export interface PersonalBox {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Received nodes the person put in this box — their own classification, no
   * claim about the backend's structure. A node is in at most one box (the
   * last placement wins). Members that leave the projection stay listed (orphans).
   */
  members: string[];
  updatedAt: string;
}

export type LinkEnd = { kind: 'box' | 'sticky' | 'node'; id: string };

export interface PersonalLink {
  id: string;
  from: LinkEnd;
  to: LinkEnd;
  label?: string;
  updatedAt: string;
}

export interface PersonalDoc {
  version: typeof PERSONAL_VERSION;
  /** By node id. A note outlives its node: orphaned notes stay listed, never dropped. */
  notes: Record<string, PersonalNote>;
  stickies: PersonalSticky[];
  boxes: PersonalBox[];
  /** A link to a node that is gone stays, drawn as broken. */
  links: PersonalLink[];
}

export const emptyPersonalDoc = (): PersonalDoc => ({ version: PERSONAL_VERSION, notes: {}, stickies: [], boxes: [], links: [] });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const closed = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).find((k) => !keys.includes(k));
const isIso = (v: unknown) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const finite = (...xs: unknown[]) => xs.every((x) => typeof x === 'number' && Number.isFinite(x));
const sized = (w: unknown, h: unknown) =>
  finite(w, h) && (w as number) >= PERSONAL_LIMITS.minSize && (h as number) >= PERSONAL_LIMITS.minSize &&
  (w as number) <= PERSONAL_LIMITS.maxSize && (h as number) <= PERSONAL_LIMITS.maxSize;

/**
 * Brings an older stored document to the current version (v1: notes and text
 * stickies only). Returns the input unchanged when it is not an older version.
 */
export function migratePersonalDoc(raw: unknown): unknown {
  // Early v2 boxes had no members list.
  if (isRecord(raw) && raw.version === 2 && Array.isArray(raw.boxes) && raw.boxes.some((b) => isRecord(b) && !('members' in b))) {
    return { ...raw, boxes: raw.boxes.map((b) => (isRecord(b) && !('members' in b) ? { ...b, members: [] } : b)) };
  }
  if (!isRecord(raw) || raw.version !== 1) return raw;
  const stickies = Array.isArray(raw.stickies)
    ? raw.stickies.map((s) => (isRecord(s) ? { kind: 'text', ...s, w: STICKY_DEFAULT.w, h: STICKY_DEFAULT.h } : s))
    : raw.stickies;
  return { version: 2, notes: raw.notes, stickies, boxes: [], links: [] };
}

type SchemaItem = 'note' | 'sticky' | 'box' | 'link';
const itemName = (item: SchemaItem): Msg => msg(`personal.schema.item.${item}`);
/** "<item> '<id>' <field>": the field is a schema token, kept as written. */
const field = (item: SchemaItem, id: string, name: string): Msg => msg('personal.schema.field', { item: itemName(item), id, field: name });
const shape = (item: SchemaItem, form: string, id?: string): Msg =>
  id === undefined ? msg('personal.schema.shape', { item: itemName(item), shape: form }) : msg('personal.schema.shapeOf', { item: itemName(item), id, shape: form });
const badId = (item: SchemaItem): Msg => msg('personal.schema.id', { item: itemName(item) });
const mustBeArray = (list: string): Msg => msg('personal.schema.array', { list });
const tooMany = (list: string, max: number): Msg => msg('personal.schema.tooMany', { list, max });

/** Validates a (current-version) document; the first problem, or null. */
export function personalDocProblem(raw: unknown): Msg | null {
  if (!isRecord(raw)) return msg('personal.schema.notObject');
  const extra = closed(raw, ['version', 'notes', 'stickies', 'boxes', 'links']);
  if (extra) return msg('personal.schema.unknownKey', { key: extra });
  if (raw.version !== PERSONAL_VERSION) return msg('personal.schema.version', { version: String(raw.version) });
  if (!isRecord(raw.notes)) return msg('personal.schema.notesObject');
  const noteIds = Object.keys(raw.notes);
  if (noteIds.length > PERSONAL_LIMITS.notes) return tooMany('notes', PERSONAL_LIMITS.notes);
  for (const id of noteIds) {
    const n = raw.notes[id];
    if (id.length === 0 || id.length > PERSONAL_LIMITS.idChars) return msg('personal.schema.noteIdLength');
    if (!isRecord(n) || closed(n, ['text', 'updatedAt'])) return shape('note', '{ text, updatedAt }', id);
    if (typeof n.text !== 'string' || n.text.length > PERSONAL_LIMITS.noteChars) return field('note', id, 'text');
    if (!isIso(n.updatedAt)) return field('note', id, 'updatedAt');
  }
  const ids = { sticky: new Set<string>(), box: new Set<string>() };
  const memberOf = new Set<string>();
  if (!Array.isArray(raw.stickies)) return mustBeArray('stickies');
  if (raw.stickies.length > PERSONAL_LIMITS.stickies) return tooMany('stickies', PERSONAL_LIMITS.stickies);
  for (const s of raw.stickies) {
    if (!isRecord(s) || closed(s, ['id', 'kind', 'text', 'x', 'y', 'w', 'h', 'updatedAt'])) return shape('sticky', '{ id, kind, text, x, y, w, h, updatedAt }');
    if (typeof s.id !== 'string' || !ID.test(s.id) || ids.sticky.has(s.id)) return badId('sticky');
    ids.sticky.add(s.id);
    if (s.kind !== 'text' && s.kind !== 'mermaid') return field('sticky', s.id, 'kind');
    if (typeof s.text !== 'string' || s.text.length > PERSONAL_LIMITS.stickyChars) return field('sticky', s.id, 'text');
    if (!finite(s.x, s.y) || !sized(s.w, s.h)) return field('sticky', s.id, 'rect');
    if (!isIso(s.updatedAt)) return field('sticky', s.id, 'updatedAt');
  }
  if (!Array.isArray(raw.boxes)) return mustBeArray('boxes');
  if (raw.boxes.length > PERSONAL_LIMITS.boxes) return tooMany('boxes', PERSONAL_LIMITS.boxes);
  for (const b of raw.boxes) {
    if (!isRecord(b) || closed(b, ['id', 'label', 'x', 'y', 'w', 'h', 'members', 'updatedAt'])) return shape('box', '{ id, label, x, y, w, h, members, updatedAt }');
    if (typeof b.id !== 'string' || !ID.test(b.id) || ids.box.has(b.id)) return badId('box');
    ids.box.add(b.id);
    if (typeof b.label !== 'string' || b.label.length > PERSONAL_LIMITS.labelChars) return field('box', b.id, 'label');
    if (!finite(b.x, b.y) || !sized(b.w, b.h)) return field('box', b.id, 'rect');
    if (!isIso(b.updatedAt)) return field('box', b.id, 'updatedAt');
    if (!Array.isArray(b.members) || b.members.length > PERSONAL_LIMITS.membersPerBox) return field('box', b.id, 'members');
    for (const m of b.members) {
      if (typeof m !== 'string' || m.length === 0 || m.length > PERSONAL_LIMITS.idChars) return field('box', b.id, 'member id');
      if (memberOf.has(m)) return msg('personal.schema.multiBox', { id: m });
      memberOf.add(m);
    }
  }
  if (!Array.isArray(raw.links)) return mustBeArray('links');
  if (raw.links.length > PERSONAL_LIMITS.links) return tooMany('links', PERSONAL_LIMITS.links);
  const linkIds = new Set<string>();
  const endOk = (e: unknown) => {
    if (!isRecord(e) || closed(e, ['kind', 'id']) || typeof e.id !== 'string') return false;
    // Personal ends must exist; a node end may be gone (the link is then shown as broken).
    if (e.kind === 'box') return ids.box.has(e.id);
    if (e.kind === 'sticky') return ids.sticky.has(e.id);
    return e.kind === 'node' && e.id.length > 0 && e.id.length <= PERSONAL_LIMITS.idChars;
  };
  for (const l of raw.links) {
    if (!isRecord(l) || closed(l, ['id', 'from', 'to', 'label', 'updatedAt'])) return shape('link', '{ id, from, to, label?, updatedAt }');
    if (typeof l.id !== 'string' || !ID.test(l.id) || linkIds.has(l.id)) return badId('link');
    linkIds.add(l.id);
    if (!endOk(l.from) || !endOk(l.to)) return field('link', l.id, 'end');
    if (l.label !== undefined && (typeof l.label !== 'string' || l.label.length > PERSONAL_LIMITS.labelChars)) return field('link', l.id, 'label');
    if (!isIso(l.updatedAt)) return field('link', l.id, 'updatedAt');
  }
  return null;
}
