/**
 * Top header: brand, the view switch (지금 · 전체 — gf-p2-views) and one search field (design decision 2026-10-02).
 * Creation, personal items and rewire live in the canvas context menu; zoom
 * is wheel/pinch; interrupt arrivals notify at the top right. The search
 * field is a placeholder: it takes focus (⌘/Ctrl+K) and does nothing yet.
 */
import { For } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import { t, type MessageKey } from '../i18n/index.js';
import { COCKPIT_VIEWS, type CockpitView } from '../state/nowView.js';
import { resolveKey } from '../state/keybindings.js';
import { TerminalPanelToggle } from './TerminalPanel.jsx';

const VIEW_LABEL: Record<CockpitView, MessageKey> = { now: 'view.now', all: 'view.all' };

export function WorkspaceToolbar(props: {
  stores: WorkspaceStores;
  searchRef?: (el: HTMLInputElement) => void;
  view: () => CockpitView | null;
  onView: (v: CockpitView) => void;
}) {
  const switchKey = () => resolveKey(props.stores.prefs.prefs().keys, 'switch-view').toUpperCase();
  return (
    <header class="toolbar">
      <span class="brand">Gunnflow</span>
      <span class="seg view-switch" role="group" aria-label={t('view.switchGroup')} title={t('view.switchTitle', { key: switchKey() })}>
        <For each={COCKPIT_VIEWS}>
          {(v) => (
            <button
              classList={{ active: props.view() === v }}
              aria-pressed={props.view() === v}
              data-testid={`view-switch-${v}`}
              onClick={() => props.onView(v)}
            >
              {t(VIEW_LABEL[v])}
            </button>
          )}
        </For>
      </span>
      <label class="sr-only" for="workspace-search">
        {t('toolbar.searchLabel')}
      </label>
      <input
        id="workspace-search"
        data-testid="workspace-search"
        class="workspace-search"
        type="search"
        placeholder={t('toolbar.search')}
        ref={(el) => props.searchRef?.(el)}
      />
      <span class="spacer" />
      <TerminalPanelToggle />
    </header>
  );
}
