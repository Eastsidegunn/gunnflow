/**
 * Bottom strip: a 36px status line, not an IDE panel (charter §13).
 * Numbers come from upstream counts. An upstream that sends nodes but no
 * counts (the direct wire) gets "need you" counted from received attention
 * instead — view status, marked as such. Connection health appears ONLY when
 * something is wrong (charter §22).
 */
import { For, Show, createMemo, createSignal } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import { inboxRows, interruptCount } from '../state/decisionInbox.js';
import { LOCALES, LOCALE_NAMES, locale, setLocale, t, tn, type Msg } from '../i18n/index.js';

export function WorkspaceStatusStrip(props: { stores: WorkspaceStores; onRefresh?: () => Promise<{ refreshed: boolean; reason?: Msg }> }) {
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
  const [refreshNote, setRefreshNote] = createSignal<Msg | null>(null);
  // A read-only pull (both legs re-opened); available in observe mode too.
  const refresh = async () => {
    if (!props.onRefresh || refreshing()) return;
    setRefreshing(true);
    setRefreshNote(null);
    const r = await props.onRefresh();
    setRefreshing(false);
    if (!r.refreshed && r.reason) setRefreshNote(r.reason);
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
          {t('strip.activityTray')}
        </div>
      </Show>
      <footer class="status-strip" classList={{ stale: stale() || unreachable() !== null }}>
        <Show
          when={!stale()}
          fallback={
            <span data-testid="connection-lost" class="lost">
              {staleSince() ? t('strip.connectionLostSince', { time: staleSince()! }) : t('strip.connectionLost')}
            </span>
          }
        >
          <Show
            when={!unreachable()}
            fallback={
              <span data-testid="backend-unreachable" class="unreachable" title={t('strip.unreachableTitle')}>
                {t('strip.unreachable', { time: unreachable()! })}
              </span>
            }
          >
            <span class="live" data-testid="live-dot">{t('strip.live')}</span>
          </Show>
        </Show>
        <Show when={props.onRefresh}>
          <button data-testid="refresh-backend" class="refresh" disabled={refreshing()} title={t('strip.refreshTitle')} onClick={() => void refresh()}>
            {refreshing() ? t('strip.refreshing') : '↻'}
          </button>
        </Show>
        <Show when={refreshNote()}>{(n) => <span class="unreachable" data-testid="refresh-note">{t('strip.refreshNote', { reason: n() })}</span>}</Show>
        {/* N-07: what needs the person comes first and loudest. */}
        <Show when={needsYou().count > 0}>
          <span
            class="needs-you"
            classList={{ view: needsYou().view }}
            data-testid="strip-needsyou"
            data-source={needsYou().view ? 'view' : 'received'}
            title={needsYou().view ? t('strip.needsYouViewTitle') : undefined}
          >
            {tn('strip.needsYou', needsYou().count)}
          </span>
        </Show>
        <Show when={counts().running > 0}>
          <span data-testid="strip-running">{t('strip.running', { count: counts().running })}</span>
        </Show>
        <Show when={counts().blocked > 0}>
          <span class="blocked" data-testid="strip-blocked">{t('strip.blocked', { count: counts().blocked })}</span>
        </Show>
        <span class="spacer" />
        {/* The interface language: a choice kept on this device (localStorage), applied at once, never sent. */}
        <span class="locale-switch" role="group" aria-label={t('locale.switch')} data-testid="locale-switch">
          <For each={LOCALES}>
            {(l, i) => (
              <>
                <Show when={i() > 0}>
                  <span class="locale-sep" aria-hidden="true">·</span>
                </Show>
                <button
                  data-testid={`locale-${l}`}
                  lang={l}
                  aria-pressed={locale() === l}
                  classList={{ active: locale() === l }}
                  onClick={() => setLocale(l)}
                >
                  {LOCALE_NAMES[l]}
                </button>
              </>
            )}
          </For>
        </span>
        <button data-testid="activity-toggle" onClick={() => setTrayOpen(!trayOpen())}>
          {t('strip.activity')} {trayOpen() ? '⌄' : '⌃'}
        </button>
      </footer>
    </>
  );
}
