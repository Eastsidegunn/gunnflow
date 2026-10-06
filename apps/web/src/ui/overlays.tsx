/** Small DOM chrome: empty state, search stub, relay-error toasts, surface placeholders. */
import { For, Show, createSignal , createEffect, createMemo , onCleanup } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import { interruptNodes } from '../state/attention.js';
import { escStack } from '../state/escStack.js';
import type { EntryError } from '../state/pendingIntents.js';

/** Charter §19.4 — quiet first-run, no onboarding dashboard. */
export function EmptyState(props: {
  stores: WorkspaceStores;
  onStartMission: (name: string) => void;
}) {
  const [name, setName] = createSignal('');
  return (
    <div class="empty-state" data-testid="empty-state">
      <h1>What are we working on?</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name().trim()) props.onStartMission(name().trim());
        }}
      >
        <input
          data-testid="mission-name"
          placeholder="Describe the mission…"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <button type="submit" data-testid="start-mission" disabled={!name().trim()}>
          + Start a mission
        </button>
      </form>
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
                <span class="toast-chrome">Not sent — </span>
              </Show>
              <Show when={err.kind === 'unconfirmed'}>
                <span class="toast-chrome">Delivery unconfirmed (may have reached upstream) — </span>
              </Show>
              <Show when={err.kind === 'rejected' && err.afterReconcile}>
                <span class="toast-chrome">Rejected after it appeared applied — </span>
              </Show>
              <Show when={err.reason !== undefined} fallback={<span class="toast-chrome">No reason given</span>}>
                {err.reason}
              </Show>
            </span>
            <Show when={err.kind !== 'invalid'}>
              <button data-testid="relay-error-restore" onClick={() => pendingIntents.reopen(err.localId)}>
                Restore
              </button>
            </Show>
            <button
              onClick={() => setHidden((s) => new Set([...s, keyOf(err)]))}
              aria-label="Dismiss"
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
              Target: <code>{s().id}</code>
            </p>
            <Show when={s().surface.startsWith('privileged:')}>
              <p class="privileged-note" data-testid="privileged-note">
                Privileged intervention — requires impact explanation, a reason, and
                confirmation. This flow is a later surface; nothing was executed.
              </p>
            </Show>
            <Show when={!s().surface.startsWith('privileged:')}>
              <p class="hint">This surface is a later milestone. (Entry point only.)</p>
            </Show>
            <button onClick={props.onClose}>Close</button>
          </div>
        </div>
      )}
    </Show>
  );
}

function label(surface: string): string {
  if (surface === 'inspector') return 'Inspector (L1)';
  if (surface === 'execution') return 'Execution (L2)';
  if (surface === 'terminal') return 'Live Terminal (#4)';
  if (surface === 'approval') return 'Approval';
  if (surface === 'deliverable') return 'Deliverable View';
  if (surface.startsWith('privileged:')) return 'Privileged flow entry';
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
        aria-label={`Notifications: ${current().size} needing you`}
        classList={{ alerting: current().size > 0 }}
        onClick={() => setOpen(!open())}
      >
        ⚠
        <Show when={current().size > 0}>
          <span class="count" data-testid="notifications-count">{current().size}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="notifications-panel" data-testid="notifications-panel" role="dialog" aria-label="Notifications">
          <Show when={current().size > 0} fallback={<p class="hint">Nothing needs you right now.</p>}>
            <For each={[...current()]}>
              {([id, label]) => (
                <div class="notification-row" data-testid={`notification-${id}`}>
                  <span class="notification-label">⚠ {label}</span>
                  <button data-testid={`notification-go-${id}`} onClick={() => { props.onGo(id); setOpen(false); }}>
                    Go to node
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
