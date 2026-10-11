/** Small DOM chrome: empty state, search stub, relay-error toasts, surface placeholders. */
import { For, Show, createSignal , createEffect, createMemo , onCleanup } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import { interruptNodes } from '../state/attention.js';
import { escStack } from '../state/escStack.js';
import type { EntryError } from '../state/pendingIntents.js';
import { t } from '../i18n/index.js';
import { workspaceRoot } from '../state/workspaceRoot.js';
import { resolveParts } from '../canvas/parts.js';
import { NodeActions } from './nodeParts.jsx';

/**
 * Charter §19.4 — quiet first-run, no onboarding dashboard. What can be
 * created is the workspace root's to declare: its capabilities, assembled by
 * the wiring's parts for its kind. A root that declares none (or no root)
 * offers no form.
 */
export function EmptyState(props: { stores: WorkspaceStores }) {
  const { projectionStore, wiring } = props.stores;
  const root = () => workspaceRoot(projectionStore.genericNodes()?.nodes ?? null).root;
  const rootActions = createMemo(() => {
    const r = root();
    if (!r) return null;
    const resolved = resolveParts(r, wiring.config);
    return resolved.actions.length > 0 ? { node: r, resolved } : null;
  });
  return (
    <div class="empty-state" data-testid="empty-state">
      <h1>{t('overlay.emptyTitle')}</h1>
      <Show when={rootActions()}>
        {(v) => (
          <div class="empty-actions" data-testid="empty-actions">
            <NodeActions stores={props.stores} node={v().node} resolved={v().resolved} />
          </div>
        )}
      </Show>
    </div>
  );
}


/**
 * Upstream rejection reasons verbatim (acceptance C4), unconfirmed sends and
 * drafts refused before sending. Chrome wording is set apart from upstream
 * text. Dismiss only hides the toast; the entry stays until restored or discarded.
 */
export function RelayErrorToasts(props: { stores: WorkspaceStores }) {
  const { pendingIntents } = props.stores;
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
  const keyOf = (e: EntryError) => `${e.localId}:${e.kind}:${e.at}`;
  const visible = () => pendingIntents.errors().filter((e) => !hidden().has(keyOf(e)));
  return (
    <div class="toasts" aria-live="assertive">
      <For each={visible()}>
        {(err) => (
          <div class="toast" data-testid="relay-error" data-kind={err.kind}>
            <span>
              <Show when={err.kind === 'invalid'}>
                <span class="toast-chrome">{t('overlay.notSent')} — </span>
              </Show>
              <Show when={err.kind === 'unconfirmed'}>
                <span class="toast-chrome">{t('overlay.unconfirmed')} — </span>
              </Show>
              <Show when={err.kind === 'rejected' && err.afterReconcile}>
                <span class="toast-chrome">{t('overlay.rejectedAfterApplied')} — </span>
              </Show>
              <Show when={err.reason !== undefined} fallback={<span class="toast-chrome">{t('overlay.noReason')}</span>}>
                {err.reason}
              </Show>
            </span>
            <Show when={err.kind !== 'invalid'}>
              <button data-testid="relay-error-restore" onClick={() => pendingIntents.reopen(err.localId)}>
                {t('overlay.restore')}
              </button>
            </Show>
            <button
              onClick={() => setHidden((s) => new Set([...s, keyOf(err)]))}
              aria-label={t('overlay.dismiss')}
            >
              ✕
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

/**
 * Placeholder for deeper surfaces (L1 Inspector, Approval, Deliverable View,
 * privileged flows). Entry points exist; the surfaces are later milestones —
 * a 🔴 flow explicitly explains it is NOT executed from here (acceptance D3).
 */
export function SurfacePlaceholder(props: {
  surface: () => { surface: string; id: string } | null;
  onClose: () => void;
}) {
  return (
    <Show when={props.surface()}>
      {(s) => (
        <div class="modal-backdrop" onClick={props.onClose}>
          <div class="modal" data-testid="surface-placeholder" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{label(s().surface)}</h2>
            <p>
              {t('overlay.target')} <code>{s().id}</code>
            </p>
            <Show when={s().surface.startsWith('privileged:')}>
              <p class="privileged-note" data-testid="privileged-note">
                {t('overlay.privilegedNote')}
              </p>
            </Show>
            <Show when={!s().surface.startsWith('privileged:')}>
              <p class="hint">{t('overlay.laterMilestone')}</p>
            </Show>
            <button onClick={props.onClose}>{t('overlay.close')}</button>
          </div>
        </div>
      )}
    </Show>
  );
}

function label(surface: string): string {
  if (surface === 'inspector') return t('overlay.surface.inspector');
  if (surface === 'execution') return t('overlay.surface.execution');
  if (surface === 'terminal') return t('overlay.surface.terminal');
  if (surface === 'approval') return t('overlay.surface.approval');
  if (surface === 'deliverable') return t('overlay.surface.deliverable');
  if (surface.startsWith('privileged:')) return t('overlay.surface.privileged');
  return surface;
}

/**
 * N-01 (design decision 2026-10-02): interrupts live behind a top-right toggle that
 * always shows how many there are. The list is the CURRENT truth — entries
 * come from received attention mapped to `interrupt` by config, and leave
 * only when upstream resolves them. Nothing here is a message log the
 * cockpit keeps; it is a reading of the projection.
 */
export function NotificationCenter(props: { stores: WorkspaceStores; onGo: (id: string) => void }) {
  const { projectionStore, wiring } = props.stores;
  const current = createMemo(() => interruptNodes(projectionStore.genericNodes()?.nodes ?? [], wiring.config));
  const [open, setOpen] = createSignal(false);
  let rootEl!: HTMLDivElement;
  createEffect(() => {
    if (!open()) return;
    // Esc ownership: only the top owner acts (one Esc, one level).
    const owner = {};
    onCleanup(escStack.push(owner));
    const away = (e: PointerEvent) => {
      if (!rootEl.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escStack.isTop(owner)) {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    onCleanup(() => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    });
  });
  return (
    <div class="notification-center" ref={rootEl}>
      <button
        data-testid="notifications-toggle"
        aria-expanded={open()}
        aria-label={t('overlay.notificationsLabel', { count: current().size })}
        classList={{ alerting: current().size > 0 }}
        onClick={() => setOpen(!open())}
      >
        ⚠
        <Show when={current().size > 0}>
          <span class="count" data-testid="notifications-count">{current().size}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="notifications-panel" data-testid="notifications-panel" role="dialog" aria-label={t('overlay.notifications')}>
          <Show when={current().size > 0} fallback={<p class="hint">{t('overlay.nothingNeedsYou')}</p>}>
            <For each={[...current()]}>
              {([id, label]) => (
                <div class="notification-row" data-testid={`notification-${id}`}>
                  <span class="notification-label">⚠ {label}</span>
                  <button data-testid={`notification-go-${id}`} onClick={() => { props.onGo(id); setOpen(false); }}>
                    {t('overlay.goToNode')}
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
