/**
 * Bottom strip: a 36px status line, not an IDE panel (charter §13).
 * Numbers come from upstream counts. Connection health appears ONLY when
 * something is wrong (charter §22).
 */
import { Show, createSignal } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';

export function WorkspaceStatusStrip(props: { stores: WorkspaceStores; onRefresh?: () => Promise<{ refreshed: boolean; reason?: string }> }) {
  const { projectionStore } = props.stores;
  const counts = () => projectionStore.projection().counts;
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
        <Show when={counts().needsYou > 0}>
          <span class="needs-you" data-testid="strip-needsyou">◆ {counts().needsYou} need you</span>
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
