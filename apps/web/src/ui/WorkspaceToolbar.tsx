/**
 * Top header: brand and one search field — nothing else (design decision 2026-10-02).
 * Creation, personal items and rewire live in the canvas context menu; zoom
 * is wheel/pinch; interrupt arrivals notify at the top right. The search
 * field is a placeholder: it takes focus (⌘/Ctrl+K) and does nothing yet.
 */
import type { WorkspaceStores } from '../state/stores.js';

export function WorkspaceToolbar(props: { stores: WorkspaceStores; searchRef?: (el: HTMLInputElement) => void }) {
  void props.stores;
  return (
    <header class="toolbar">
      <span class="brand">Gunnflow</span>
      <label class="sr-only" for="workspace-search">
        Search the workspace
      </label>
      <input
        id="workspace-search"
        data-testid="workspace-search"
        class="workspace-search"
        type="search"
        placeholder="Search"
        ref={(el) => props.searchRef?.(el)}
      />
      <span class="spacer" />
    </header>
  );
}
