/**
 * The terminal panel's open state and the offered terminals, shared by the
 * toolbar entry and the node stage ("Open terminal" when one is bound to the node).
 *
 * Attaching opens a new terminal (WIRE.md §터미널): the backend may list it
 * beside its target. The terminals this viewer opened that way are remembered
 * (opened id → target id, per tab) so the list shows them folded under their
 * target as one row. A backend that gives no such link elsewhere is shown as is.
 */
import { createRoot, createSignal } from 'solid-js';
import { listTerminals, type TerminalEntry, type TerminalList } from '../transport/terminalClient.js';

/** Opened terminalId → the target it attached to. */
export type Attached = ReadonlyMap<string, string>;

/** A list row: an offered terminal, plus how many terminals this viewer has open onto it. */
export type TerminalRow = TerminalEntry & { openHere: number };

/** Hides the terminals this viewer opened by attaching under their target; one whose target is not listed stays. */
export function foldAttached(terminals: TerminalEntry[], attached: Attached): TerminalRow[] {
  const listed = new Set(terminals.map((x) => x.terminalId));
  const openHere = new Map<string, number>();
  const folded = new Set<string>();
  for (const x of terminals) {
    const target = attached.get(x.terminalId);
    if (target === undefined || target === x.terminalId || !listed.has(target)) continue;
    folded.add(x.terminalId);
    if (x.state === 'running') openHere.set(target, (openHere.get(target) ?? 0) + 1);
  }
  return terminals.filter((x) => !folded.has(x.terminalId)).map((x) => ({ ...x, openHere: openHere.get(x.terminalId) ?? 0 }));
}

export function terminalsForNode(list: TerminalList | null, nodeId: string, attached: Attached = new Map()): TerminalEntry[] {
  return list?.ok ? foldAttached(list.terminals, attached).filter((x) => x.nodeId === nodeId && x.state === 'running') : [];
}

const ATTACHED_KEY = 'gunnflow.terminals.attached';

function loadAttached(): Map<string, string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(ATTACHED_KEY) ?? '[]') as unknown;
    if (Array.isArray(raw)) return new Map(raw.filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string'));
  } catch {
    // No storage, or something else's value under the key: start empty.
  }
  return new Map();
}

function saveAttached(m: Attached): void {
  try {
    sessionStorage.setItem(ATTACHED_KEY, JSON.stringify([...m]));
  } catch {
    // Memory only: the fold lasts until reload.
  }
}

export const terminalPanel = createRoot(() => {
  const [open, setOpen] = createSignal(false);
  /** The terminal on screen; null = the list. */
  const [active, setActive] = createSignal<TerminalEntry | null>(null);
  const [list, setList] = createSignal<TerminalList | null>(null);
  const [attached, setAttached] = createSignal<Attached>(loadAttached());
  /** Opened terminals still on screen: kept even when a list fetched before they opened lacks them. */
  const live = new Set<string>();
  const writeAttached = (m: Map<string, string>) => {
    saveAttached(m);
    setAttached(m);
  };
  // The latest request wins, so a list asked for after a close never loses to one asked for before it.
  let seq = 0;
  const refresh = () => {
    const mine = ++seq;
    return listTerminals().then((l) => {
      if (mine !== seq) return;
      setList(l);
      if (!l.ok) return;
      // Forget what the backend no longer lists.
      const listed = new Set(l.terminals.map((x) => x.terminalId));
      const kept = new Map([...attached()].filter(([id]) => listed.has(id) || live.has(id)));
      if (kept.size !== attached().size) writeAttached(kept);
    });
  };
  return {
    open,
    active,
    list,
    attached,
    refresh,
    /** This viewer attached to `targetId` and got `openedId`. */
    remember(openedId: string, targetId: string) {
      live.add(openedId);
      writeAttached(new Map(attached()).set(openedId, targetId));
    },
    /** The view of `openedId` left the screen; the record stays until the backend stops listing it. */
    release(openedId: string) {
      live.delete(openedId);
    },
    show(entry: TerminalEntry | null = null) {
      setActive(entry);
      setOpen(true);
      void refresh();
    },
    back() {
      setActive(null);
      void refresh();
    },
    hide() {
      setOpen(false);
      setActive(null);
    },
  };
});
