/**
 * PersonalState — the person's local planning board, a store of its own: not
 * projection, not view state, not pending intents, not drafts. Edits save
 * locally (debounced) and go nowhere else. If the stored document cannot be
 * read or validated, editing is refused rather than overwriting it.
 */
import { createSignal } from 'solid-js';
import type { PersonalStore } from './client.js';
import {
  PERSONAL_LIMITS,
  STICKY_DEFAULT,
  emptyPersonalDoc,
  migratePersonalDoc,
  personalDocProblem,
  type LinkEnd,
  type PersonalBox,
  type PersonalDoc,
  type PersonalLink,
  type PersonalSticky,
  type StickyKind,
} from './schema.js';

/** `unsaved`: edited, waiting for the debounced save; `ready`: everything is on disk. */
export type PersonalStatus = 'loading' | 'ready' | 'unsaved' | 'saving' | 'unavailable';
export type Rect = { x: number; y: number; w: number; h: number };
/** What the open personal panel shows. */
export type PersonalOpen = { kind: 'sticky' | 'box'; id: string } | null;

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const clampSize = (v: number) => Math.min(PERSONAL_LIMITS.maxSize, Math.max(PERSONAL_LIMITS.minSize, v));
const inside = (r: Rect, o: Rect) => r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h;

export function createPersonalState(store: PersonalStore, options: { debounceMs?: number } = {}) {
  const debounceMs = options.debounceMs ?? 400;
  const [doc, setDoc] = createSignal<PersonalDoc>(emptyPersonalDoc());
  const [status, setStatus] = createSignal<PersonalStatus>('loading');
  const [problem, setProblem] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal<PersonalOpen>(null);
  /** Link mode: the next item clicked becomes the link's other end. */
  const [connectFrom, setConnectFrom] = createSignal<LinkEnd | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();

  const writable = () => status() === 'ready' || status() === 'unsaved' || status() === 'saving';
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  };
  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (status() !== 'unsaved') return;
    setStatus('saving');
    const snapshot = doc();
    saving = saving.then(() =>
      store.save(snapshot).then(
        () => {
          if (doc() === snapshot && status() === 'saving') setStatus('ready');
        },
        (err: unknown) => {
          setStatus('unavailable');
          setProblem(`not saved: ${err instanceof Error ? err.message : String(err)}`);
        },
      ),
    );
    await saving;
  };
  const edit = (next: PersonalDoc) => {
    if (!writable()) return false;
    setDoc(next);
    setStatus('unsaved');
    persist();
    return true;
  };
  const rectOf = (end: LinkEnd): Rect | undefined =>
    end.kind === 'sticky' ? doc().stickies.find((s) => s.id === end.id) : end.kind === 'box' ? doc().boxes.find((b) => b.id === end.id) : undefined;

  return {
    doc,
    status,
    /** Whether edits are accepted (the stored document was read and is valid). */
    writable,
    /** Why the layer is read-only or unsaved, if it is. */
    problem,
    open,
    setOpen,
    /** Compatibility: the open sticky's id. */
    openSticky: () => (open()?.kind === 'sticky' ? open()!.id : null),
    setOpenSticky: (id: string | null) => setOpen(id ? { kind: 'sticky', id } : null),
    connectFrom,
    setConnectFrom,
    async load() {
      try {
        const { doc: stored } = await store.load();
        if (stored === null) {
          setDoc(emptyPersonalDoc());
        } else {
          const raw = migratePersonalDoc(stored);
          const p = personalDocProblem(raw);
          if (p) {
            setStatus('unavailable');
            setProblem(`stored personal notes are invalid (${p}); editing is off so they are not overwritten`);
            return;
          }
          setDoc(raw as PersonalDoc);
          if (raw !== stored) {
            // An older document was migrated: store the current version.
            setStatus('unsaved');
            await flush();
            return;
          }
        }
        setStatus('ready');
      } catch (err) {
        setStatus('unavailable');
        setProblem(err instanceof Error ? err.message : String(err));
      }
    },
    flush,

    /* ---- node notes ---- */
    note: (nodeId: string) => doc().notes[nodeId]?.text ?? '',
    /** An empty text removes the note. */
    setNote(nodeId: string, text: string) {
      const notes = { ...doc().notes };
      if (text.length === 0) delete notes[nodeId];
      else notes[nodeId] = { text: text.slice(0, PERSONAL_LIMITS.noteChars), updatedAt: now() };
      return edit({ ...doc(), notes });
    },
    /** Notes whose node is not in the current projection. */
    orphans(liveIds: ReadonlySet<string>) {
      return Object.entries(doc().notes)
        .filter(([id]) => !liveIds.has(id))
        .map(([nodeId, n]) => ({ nodeId, ...n }));
    },

    /* ---- stickies ---- */
    addSticky(x: number, y: number, text = '', kind: StickyKind = 'text'): string | null {
      if (doc().stickies.length >= PERSONAL_LIMITS.stickies) return null;
      const sticky: PersonalSticky = { id: newId('s'), kind, text, x, y, ...STICKY_DEFAULT, updatedAt: now() };
      return edit({ ...doc(), stickies: [...doc().stickies, sticky] }) ? sticky.id : null;
    },
    updateSticky(id: string, patch: Partial<Pick<PersonalSticky, 'text' | 'x' | 'y' | 'w' | 'h'>>) {
      const stickies = doc().stickies.map((s) =>
        s.id === id
          ? {
              ...s,
              ...patch,
              ...(patch.text !== undefined ? { text: patch.text.slice(0, PERSONAL_LIMITS.stickyChars) } : {}),
              ...(patch.w !== undefined ? { w: clampSize(patch.w) } : {}),
              ...(patch.h !== undefined ? { h: clampSize(patch.h) } : {}),
              updatedAt: now(),
            }
          : s,
      );
      return edit({ ...doc(), stickies });
    },
    removeSticky(id: string) {
      if (open()?.id === id) setOpen(null);
      const d = doc();
      return edit({
        ...d,
        stickies: d.stickies.filter((s) => s.id !== id),
        links: d.links.filter((l) => !(l.from.kind === 'sticky' && l.from.id === id) && !(l.to.kind === 'sticky' && l.to.id === id)),
      });
    },

    /* ---- boxes ---- */
    addBox(x: number, y: number, label = 'Goal', w = 520, h = 320): string | null {
      if (doc().boxes.length >= PERSONAL_LIMITS.boxes) return null;
      const box: PersonalBox = { id: newId('b'), label: label.slice(0, PERSONAL_LIMITS.labelChars), x, y, w: clampSize(w), h: clampSize(h), members: [], updatedAt: now() };
      return edit({ ...doc(), boxes: [...doc().boxes, box] }) ? box.id : null;
    },
    updateBox(id: string, patch: Partial<Pick<PersonalBox, 'label' | 'x' | 'y' | 'w' | 'h'>>) {
      const boxes = doc().boxes.map((b) =>
        b.id === id
          ? {
              ...b,
              ...patch,
              ...(patch.label !== undefined ? { label: patch.label.slice(0, PERSONAL_LIMITS.labelChars) } : {}),
              ...(patch.w !== undefined ? { w: clampSize(patch.w) } : {}),
              ...(patch.h !== undefined ? { h: clampSize(patch.h) } : {}),
              updatedAt: now(),
            }
          : b,
      );
      return edit({ ...doc(), boxes });
    },
    removeBox(id: string) {
      if (open()?.id === id) setOpen(null);
      const d = doc();
      return edit({
        ...d,
        boxes: d.boxes.filter((b) => b.id !== id),
        links: d.links.filter((l) => !(l.from.kind === 'box' && l.from.id === id) && !(l.to.kind === 'box' && l.to.id === id)),
      });
    },
    /** Personal items lying inside a box right now (visual containment, by coordinates). */
    contentsOf(boxId: string): { stickies: string[]; boxes: string[] } {
      const box = doc().boxes.find((b) => b.id === boxId);
      if (!box) return { stickies: [], boxes: [] };
      return {
        stickies: doc().stickies.filter((s) => inside(s, box)).map((s) => s.id),
        boxes: doc().boxes.filter((b) => b.id !== boxId && inside(b, box)).map((b) => b.id),
      };
    },
    /** Moves a box and everything inside it by (dx, dy) — one edit. */
    moveBoxWithContents(boxId: string, dx: number, dy: number, contents: { stickies: string[]; boxes: string[] }) {
      const d = doc();
      const s = new Set(contents.stickies);
      const b = new Set([...contents.boxes, boxId]);
      return edit({
        ...d,
        boxes: d.boxes.map((x) => (b.has(x.id) ? { ...x, x: x.x + dx, y: x.y + dy, updatedAt: now() } : x)),
        stickies: d.stickies.map((x) => (s.has(x.id) ? { ...x, x: x.x + dx, y: x.y + dy, updatedAt: now() } : x)),
      });
    },

    /**
     * Puts a received node in a personal box (null = out of every box). A node
     * is in at most one box: the last placement wins. Personal data only.
     */
    placeNode(nodeId: string, boxId: string | null) {
      const d = doc();
      const current = d.boxes.find((b) => b.members.includes(nodeId))?.id ?? null;
      if (current === boxId) return true;
      if (boxId && !d.boxes.some((b) => b.id === boxId)) return false;
      return edit({
        ...d,
        boxes: d.boxes.map((b) => {
          const members = b.members.filter((m) => m !== nodeId);
          if (b.id === boxId && members.length < PERSONAL_LIMITS.membersPerBox) members.push(nodeId);
          return members.length === b.members.length && b.id !== boxId ? b : { ...b, members, updatedAt: now() };
        }),
      });
    },
    boxOfNode: (nodeId: string) => doc().boxes.find((b) => b.members.includes(nodeId))?.id ?? null,
    /** Received nodes the board refers to: box members and link ends (the Plan lens brings these forward). */
    plannedNodes(): Set<string> {
      const out = new Set<string>();
      for (const b of doc().boxes) for (const m of b.members) out.add(m);
      for (const l of doc().links) for (const e of [l.from, l.to]) if (e.kind === 'node') out.add(e.id);
      return out;
    },
    /** Box members that are not in the current projection (kept, shown as missing). */
    missingMembers(liveIds: ReadonlySet<string>) {
      return doc().boxes.flatMap((b) => b.members.filter((m) => !liveIds.has(m)).map((nodeId) => ({ boxId: b.id, nodeId })));
    },

    /* ---- links ---- */
    addLink(from: LinkEnd, to: LinkEnd, label?: string): string | null {
      if (doc().links.length >= PERSONAL_LIMITS.links) return null;
      if (from.kind === to.kind && from.id === to.id) return null;
      for (const end of [from, to]) if (end.kind !== 'node' && !rectOf(end)) return null;
      const link: PersonalLink = { id: newId('l'), from, to, ...(label ? { label: label.slice(0, PERSONAL_LIMITS.labelChars) } : {}), updatedAt: now() };
      return edit({ ...doc(), links: [...doc().links, link] }) ? link.id : null;
    },
    updateLink(id: string, label: string) {
      return edit({
        ...doc(),
        links: doc().links.map((l) => {
          if (l.id !== id) return l;
          const { label: _old, ...rest } = l;
          return { ...rest, ...(label ? { label: label.slice(0, PERSONAL_LIMITS.labelChars) } : {}), updatedAt: now() };
        }),
      });
    },
    removeLink(id: string) {
      return edit({ ...doc(), links: doc().links.filter((l) => l.id !== id) });
    },
    /** Links with an end on a node that is not in the current projection (kept, drawn broken). */
    brokenLinks(liveIds: ReadonlySet<string>) {
      return doc().links.filter((l) => [l.from, l.to].some((e) => e.kind === 'node' && !liveIds.has(e.id)));
    },
  };
}

export type PersonalState = ReturnType<typeof createPersonalState>;
