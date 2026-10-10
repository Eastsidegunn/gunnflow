/**
 * Bottom strip: a 36px status line, not an IDE panel (charter §13).
 * Numbers come from upstream counts. An upstream that sends nodes but no
 * counts (the direct wire) gets "need you" counted from received attention
 * instead — view status, marked as such. Connection health appears ONLY when
 * something is wrong (charter §22).
 */
import { Show, createMemo, createSignal } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import { inboxRows, interruptCount } from '../state/decisionInbox.js';

export function WorkspaceStatusStrip(props: { stores: WorkspaceStores; onRefresh?: () => Promise<{ refreshed: boolean; reason?: string }> }) {
  const { projectionStore } = props.stores;
  const counts = () => projectionStore.projection().counts;
  /** Received count when the upstream sends one; else nodes with interrupt-mapped attention (view). */
  const needsYou = createMemo(() => {
    if (projectionStore.countsReceived()) return { count: counts().needsYou, view: false };
    const nodes = projectionStore.genericNodes()?.nodes ?? [];
    return { count: interruptCount(inboxRows(nodes, props.stores.wiring.config)), view: true };
  });
  const [trayOpen, setTrayOpen] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshNote, setRefreshNote] = createSignal<string | null>(null);
  // A read-only pull (both legs re-opened); available in observe mode too.
  const refresh = async () => {
    if (!props.onRefresh || refreshing()) return;
    setRefreshing(true);
    setRefreshNote(null);
    const r = await props.onRefresh();
    setRefreshing(false);
    if (!r.refreshed && r.reason) setRefreshNote(`refresh: ${r.reason}`);
  };
  const instrument = () => projectionStore.instrument();
  const stale = () => instrument().kind === 'lost';
  const unreachable = () => {
    const i = instrument();
    // HH:MM:SS, local time.
    return i.kind === 'unreachable' ? new Date(i.since).toTimeString().slice(0, 8) : null;
  };
  const staleSince = () => {
    const t = projectionStore.lastSeenAt();
    return t ? new Date(t).toLocaleTimeString() : null;
  };
  return (
    <>
      <Show when={trayOpen()}>
        <div class="activity-tray" data-testid="activity-tray">
          Activity tray — transient surface, arrives with a later milestone.
        </div>
      </Show>
      <footer class="status-strip" classList={{ stale: stale() || unreachable() !== null }}>
        <Show
          when={!stale()}
          fallback={
            <span data-testid="connection-lost" class="lost">
              Connection lost{staleSince() ? ` · showing state from ${staleSince()}` : ''}
            </span>
          }
        >
          <Show
            when={!unreachable()}
            fallback={
              <span data-testid="backend-unreachable" class="unreachable" title="The BFF lost its upstream; it keeps retrying. What you see is from before this time.">
                ◐ backend unreachable since {unreachable()} · showing state from before then
              </span>
            }
          >
            <span class="live" data-testid="live-dot">● live</span>
          </Show>
        </Show>
        <Show when={props.onRefresh}>
          <button data-testid="refresh-backend" class="refresh" disabled={refreshing()} title="Re-open the backend connection and reload the workspace (read-only)" onClick={() => void refresh()}>
            {refreshing() ? 'refreshing…' : '↻'}
          </button>
        </Show>
        <Show when={refreshNote()}>{(n) => <span class="unreachable" data-testid="refresh-note">{n()}</span>}</Show>
        {/* N-07: what needs the person comes first and loudest. */}
        <Show when={needsYou().count > 0}>
          <span
            class="needs-you"
            classList={{ view: needsYou().view }}
            data-testid="strip-needsyou"
            data-source={needsYou().view ? 'view' : 'received'}
            title={needsYou().view ? 'Counted here from received attention (nodes with an interrupt cause) — the backend sends no count' : undefined}
          >
            ◆ {needsYou().count} need you
          </span>
        </Show>
        <Show when={counts().running > 0}>
          <span data-testid="strip-running">● {counts().running} running</span>
        </Show>
        <Show when={counts().blocked > 0}>
          <span class="blocked" data-testid="strip-blocked">{counts().blocked} blocked</span>
        </Show>
        <span class="spacer" />
        <button data-testid="activity-toggle" onClick={() => setTrayOpen(!trayOpen())}>
          Activity {trayOpen() ? '⌄' : '⌃'}
        </button>
      </footer>
    </>
  );
}
