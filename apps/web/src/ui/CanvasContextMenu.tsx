/**
 * Radial canvas menu (design decision 2026-10-02): right-press opens a ring of items
 * around the cursor and lives only while the button is held: dragging
 * highlights by direction, releasing on an item runs it, releasing anywhere
 * else closes the ring. Only the keyboard path (Shift+F10 on a mirror node,
 * where nothing is held) opens it in click mode — items are then ordinary
 * focusable menu items (arrow keys cycle, Esc closes and returns focus).
 *
 * The menu never invents an item: received-node entries come from
 * resolveParts(node) over declared capabilities (hidden stays hidden,
 * disabled shows its reason in the hub), the empty-canvas entries are the
 * workspace root's own actions, and the personal entries are the local
 * layer's — created at the right-clicked world point. Received-node deletion
 * is an intent like any other write: the node leaves the canvas only when
 * the projection drops it.
 */
import { For, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { NodeProjection } from '@gunnflow/contract';
import { actionLabel } from '@gunnflow/contract/wiring';
import type { WorkspaceStores } from '../state/stores.js';
import { resolveParts, type ResolvedAction } from '../canvas/parts.js';
import { actionGate, opensPanel } from '../state/genericActions.js';
import { workspaceRoot } from '../state/workspaceRoot.js';
import { manageFocus, focusables } from './focusScope.js';

export type ContextTarget =
  | { kind: 'empty' }
  | { kind: 'node'; id: string }
  | { kind: 'sticky'; id: string }
  | { kind: 'box'; id: string };

export interface ContextMenuState {
  x: number;
  y: number;
  world: { x: number; y: number };
  target: ContextTarget;
  /** Opened by a held right button: drag highlights, release runs. */
  hold?: boolean;
}

interface Item {
  id: string;
  label: string;
  /** The raw action name behind a config label (shown in the tooltip). */
  raw?: string;
  danger?: boolean;
  disabled?: boolean;
  reason?: string;
  run?: () => void;
}
const MAX_ITEMS = 12;
const DEAD_ZONE = 36;
/** Presentation grouping only — no behaviour hangs on this. */
const DANGER_NAME = /(^|[.:])(delete|remove|cancel|kill|destroy)\b/;

export function CanvasContextMenu(props: {
  stores: WorkspaceStores;
  state: ContextMenuState;
  motion?: 'enter' | 'exit';
  onClose: () => void;
  onEnterRewire: (fromId: string) => void;
  onOpenPersonalList: () => void;
}) {
  const { stores } = props;
  const { projectionStore, pendingIntents, selection, personal, wiring } = stores;
  const nodes = () => projectionStore.genericNodes()?.nodes ?? [];
  const nodeOf = (id: string) => nodes().find((n) => n.id === id);

  const focusLater = (domId: string) => setTimeout(() => document.getElementById(domId)?.focus(), 50);

  /** A received action as a menu item: run = relay or open-the-panel, exactly the panel's rules. */
  const actionItem = (node: NodeProjection, a: ResolvedAction): Item => {
    const gate = actionGate(a);
    const needsPanel = opensPanel(a);
    const disabled = a.level !== 'enabled';
    return {
      id: `context-item-${a.action}`,
      label: actionLabel(wiring.config, a.action),
      raw: a.action,
      danger: DANGER_NAME.test(a.action),
      disabled,
      reason: disabled ? ((gate as { reason?: string }).reason ?? 'disabled by upstream') : undefined,
      run: disabled
        ? undefined
        : () => {
            if (needsPanel) {
              selection.select(node.id);
              focusLater(`text-${a.action}`);
            } else {
              void pendingIntents.submit({ nodeId: node.id, action: a.action });
            }
          },
    };
  };

  const items = createMemo<Item[]>(() => {
    const t = props.state.target;
    const w = props.state.world;
    const out: Item[] = [];
    if (t.kind === 'empty') {
      const root = workspaceRoot(nodes()).root;
      if (root) for (const a of resolveParts(root, wiring.config).actions) out.push(actionItem(root, a));
      out.push(
        { id: 'context-item-personal-note', label: 'Note', run: () => { const id = personal.addSticky(w.x, w.y); if (id) { selection.clear(); personal.setOpenSticky(id); } } },
        { id: 'context-item-personal-diagram', label: 'Diagram', run: () => { const id = personal.addSticky(w.x, w.y, '', 'mermaid'); if (id) { selection.clear(); personal.setOpenSticky(id); } } },
        { id: 'context-item-personal-box', label: 'Box', run: () => { personal.addBox(w.x, w.y); } },
        { id: 'context-item-personal-list', label: 'Personal items…', run: () => props.onOpenPersonalList() },
      );
    } else if (t.kind === 'node') {
      const node = nodeOf(t.id);
      if (node) {
        for (const a of resolveParts(node, wiring.config).actions) {
          if (a.action === 'edge.rewire') continue; // its own entry below
          out.push(actionItem(node, a));
        }
        if (node.capabilities.some((c) => c.action === 'edge.rewire' && c.level !== 'hidden')) {
          out.push({ id: 'context-item-rewire', label: 'Rewire from here', run: () => props.onEnterRewire(node.id) });
        }
        out.push(
          { id: 'context-item-personal-note', label: 'Note on this node', run: () => { selection.select(node.id); focusLater('personal-note-text'); } },
          { id: 'context-item-personal-link', label: 'Link to…', run: () => personal.setConnectFrom({ kind: 'node', id: node.id }) },
        );
      }
    } else {
      const personalKind = t.kind; // 'sticky' | 'box'
      out.push(
        { id: 'context-item-personal-edit', label: 'Edit', run: () => { selection.clear(); personal.setOpen({ kind: personalKind, id: t.id }); } },
        { id: 'context-item-personal-link', label: 'Link to…', run: () => personal.setConnectFrom({ kind: personalKind, id: t.id }) },
        { id: 'context-item-personal-delete', label: 'Delete', danger: true, run: () => (personalKind === 'sticky' ? personal.removeSticky(t.id) : personal.removeBox(t.id)) },
      );
    }
    // Danger items sink together; the ring rotation puts their block at the bottom.
    const safe = out.filter((i) => !i.danger);
    const danger = out.filter((i) => i.danger);
    return [...safe, ...danger].slice(0, MAX_ITEMS);
  });

  /** Ring geometry: items clockwise from `start`; the danger block is rotated onto the bottom. */
  const geometry = createMemo(() => {
    const list = items();
    const n = Math.max(list.length, 1);
    const step = 360 / n;
    const dangerCount = list.filter((i) => i.danger).length;
    const start = dangerCount > 0 ? 90 - (list.length - dangerCount + (dangerCount - 1) / 2) * step : -90;
    const radius = Math.max(100, Math.round((n * 78) / (2 * Math.PI)) + 36);
    return { step, start, radius };
  });
  const angleOf = (i: number) => ((geometry().start + i * geometry().step) * Math.PI) / 180;
  const centre = createMemo(() => {
    const { radius } = geometry();
    const mx = radius + 110;
    const my = radius + 44;
    return {
      x: Math.min(Math.max(props.state.x, mx), window.innerWidth - mx),
      y: Math.min(Math.max(props.state.y, my), window.innerHeight - my),
    };
  });

  const [holding, setHolding] = createSignal(Boolean(props.state.hold));
  const [highlight, setHighlight] = createSignal<number | null>(null);
  let movedOut = false;
  let rootEl!: HTMLDivElement;

  // Hold mode: the window sees the drag; release runs the highlighted item.
  onMount(() => {
    if (!holding()) return;
    const pick = (e: PointerEvent): number | null => {
      const dx = e.clientX - centre().x;
      const dy = e.clientY - centre().y;
      if (Math.hypot(dx, dy) < DEAD_ZONE) return null;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      const { start, step } = geometry();
      const n = items().length;
      if (n === 0) return null;
      return ((Math.round((deg - start) / step) % n) + n) % n;
    };
    const onMove = (e: PointerEvent) => {
      if (!holding()) return;
      const at = pick(e);
      if (at !== null) movedOut = true;
      setHighlight(at);
    };
    const onUp = (e: PointerEvent) => {
      if (!holding()) return;
      const at = pick(e);
      const item = at !== null ? items()[at] : undefined;
      if (movedOut && item && !item.disabled && item.run) item.run();
      // The ring lives only while the button is held.
      props.onClose();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    onCleanup(() => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    });
  });

  // Click mode: focus management + outside dismissal.
  createEffect(() => {
    if (holding()) return;
    onCleanup(manageFocus(rootEl, { trap: true }));
    const away = (e: PointerEvent) => {
      if (!rootEl.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('pointerdown', away, true);
    onCleanup(() => window.removeEventListener('pointerdown', away, true));
  });
  const onKeyDown = (e: KeyboardEvent) => {
    const f = focusables(rootEl);
    const at = f.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      props.onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      f[(at + 1) % f.length]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      f[(at - 1 + f.length) % f.length]?.focus();
    } else if (e.key === 'Home') {
      f[0]?.focus();
    } else if (e.key === 'End') {
      f[f.length - 1]?.focus();
    }
  };
  // Esc cancels a hold too.
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && holding()) {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    onCleanup(() => window.removeEventListener('keydown', key, true));
  });

  const hub = createMemo(() => {
    const at = highlight();
    const item = at !== null ? items()[at] : undefined;
    if (!item) return holding() ? 'release to cancel' : '';
    return item.reason ? `${item.label} — ${item.reason}` : item.label;
  });

  return (
    <div
      ref={rootEl}
      class="radial-menu"
      data-testid="context-menu"
      data-motion={props.motion ?? 'enter'}
      data-mode={holding() ? 'hold' : 'click'}
      role="menu"
      style={{ left: `${centre().x}px`, top: `${centre().y}px` }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div class="radial-hub" data-testid="context-hub">{hub()}</div>
      <For each={items()}>
        {(item, i) => (
          <button
            role="menuitem"
            data-testid={item.id}
            classList={{
              danger: item.danger,
              'context-disabled': item.disabled,
              highlighted: highlight() === i(),
            }}
            disabled={item.disabled}
            title={item.reason ?? (item.raw && item.raw !== item.label ? `${item.label} (${item.raw})` : item.label)}
            style={{
              left: `${Math.round(Math.cos(angleOf(i())) * geometry().radius)}px`,
              top: `${Math.round(Math.sin(angleOf(i())) * geometry().radius)}px`,
            }}
            onClick={() => {
              if (item.disabled) return;
              item.run?.();
              props.onClose();
            }}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
}
