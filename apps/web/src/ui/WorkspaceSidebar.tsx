/**
 * Sidebar = lens, not navigation (charter §11). Selecting a lens re-weights the
 * canvas; upstream state is untouched. The engine ships `Workspace` (all) and
 * `Plan`; every lens between them is config data (WiringConfig.lenses), so the
 * sidebar carries whatever vocabulary the connected backend declared — the
 * engine never knows what the words mean. Badges are view-status: how many
 * received nodes currently match a lens's table (derived, never sent).
 */
import { For, createMemo } from 'solid-js';
import { WORKSPACE_ROOT_KIND } from '@gunnflow/contract';
import { configLenses } from '@gunnflow/contract/wiring';
import type { WorkspaceStores } from '../state/stores.js';
import { lensMatcher, type LensFacts } from '../state/lens.js';
import { t } from '../i18n/index.js';

export function WorkspaceSidebar(props: { stores: WorkspaceStores; onOpenSettings?: () => void }) {
  const { lensState, projectionStore, wiring } = props.stores;
  const facts = createMemo<LensFacts[]>(() =>
    (projectionStore.genericNodes()?.nodes ?? [])
      .filter((n) => n.kind !== WORKSPACE_ROOT_KIND)
      .map((n) => ({ id: n.id, kind: n.kind, state: n.state.value, hasAttention: n.attention.length > 0, relations: n.relations })),
  );
  const entries = createMemo(() => {
    const fs = facts();
    return [
      { id: 'all', label: t('sidebar.lensAll'), count: null as number | null },
      ...configLenses(wiring.config).map((l) => ({
        id: l.id,
        label: l.label,
        count: fs.filter(lensMatcher(l.match, fs)).length,
      })),
      { id: 'plan', label: t('sidebar.lensPlan'), count: null as number | null },
    ];
  });
  return (
    <nav class="sidebar" aria-label={t('sidebar.lenses')}>
      <ul>
        <For each={entries()}>
          {(item) => (
            <li>
              <button
                data-testid={`lens-${item.id}`}
                classList={{ active: lensState.lens() === item.id }}
                onClick={() => lensState.setLens(item.id)}
              >
                <span>{item.label}</span>
                {item.count !== null && item.count > 0 && <span class="count">{item.count}</span>}
              </button>
            </li>
          )}
        </For>
      </ul>
      <div class="sidebar-footer">
        {/* Route placeholders only — later canonical surfaces. */}
        <button disabled title={t('sidebar.historyTitle')}>{t('sidebar.history')}</button>
        <button disabled title={t('sidebar.governanceTitle')}>{t('sidebar.governance')}</button>
        <button data-testid="settings-open" class="settings-entry" title={t('sidebar.settingsTitle')} onClick={() => props.onOpenSettings?.()}>
          {t('sidebar.settings')}
        </button>
      </div>
    </nav>
  );
}
