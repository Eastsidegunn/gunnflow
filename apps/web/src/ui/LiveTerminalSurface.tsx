/**
 * Live Terminal / Intervention (Screen #4). The PTY is the protagonist; the
 * chrome keeps identity, connection, and authority always visible. Direct
 * control is not a bypass: every keystroke is a relayed, attributed intent —
 * local echo is pending until the authoritative stream returns it, and a
 * failed input is never displayed as executed.
 */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import { connectTerminalStream, createTerminalStore, type TerminalConnection } from '../state/terminalStore.js';
import { guardLabel, stdinGuard } from '../state/terminalLogic.js';
import { visibleRange } from '../state/executionLogic.js';
import { writeAffordance } from '../state/capabilities.js';
import {
  bindStream,
  chunkText,
  chunksOf,
  createStreamStore,
  visibleControls,
  type StreamPartParams,
  type StreamRow,
} from '../state/streamStore.js';
import { connectStream } from '../transport/streamChannel.js';
import type { StreamChunk } from '../model/streamTypes.js';
import { isSessionIntent } from '../model/types.js';
import type { InFlightEntry, RejectedEntry } from '../state/pendingIntents.js';
import { msg, msgN, t, tn, type MessageKey, type Msg } from '../i18n/index.js';

/** A count of stream units (lines or chunks), worded per locale and number. */
const units = (unit: string, count: number): Msg => msgN(unit === 'lines' ? 'stream.units.lines' : 'stream.units.chunks', count);

const ROW_HEIGHT = 22;

/** Stream part param for the PTY (engine clamps the limits). */
const PTY_STREAM_PARAMS: StreamPartParams = {
  source: { role: 'pty' },
  retainItems: 5000,
  retainBytes: 8 * 1024 * 1024,
};

/** Display mapping for upstream channel labels; unregistered labels are shown verbatim. */
const CHANNEL_CLASS: Record<string, string> = {
  stdout: '',
  stderr: 'stderr',
  control: 'control',
  operator: 'operator',
};

const CONNECTION_LABEL = {
  idle: 'stream.connection.idle',
  limited: 'stream.connection.limited',
  connecting: 'stream.connection.connecting',
  live: 'stream.connection.live',
  disconnected: 'stream.connection.disconnected',
  unsupported: 'stream.connection.unsupported',
} as const satisfies Record<string, MessageKey>;

type StdinRow = InFlightEntry | RejectedEntry;
type ViewRow = { kind: 'stream'; row: StreamRow } | { kind: 'pending'; entry: StdinRow };

export function LiveTerminalSurface(props: {
  stores: WorkspaceStores;
  sessionId: string;
  onClose: () => void;
  onEnterSurface: (surface: string, id: string) => void;
}) {
  const { pendingIntents } = props.stores;
  const terminal = createTerminalStore(pendingIntents);
  const [search, setSearch] = createSignal('');
  const [filterMatches, setFilterMatches] = createSignal(false);
  const [viewPaused, setViewPaused] = createSignal<{ rows: readonly StreamRow[]; received: number } | null>(null);
  const [killOpen, setKillOpen] = createSignal(false);
  const [killReason, setKillReason] = createSignal('');
  const [restartOpen, setRestartOpen] = createSignal(false);
  const [rawSeq, setRawSeq] = createSignal<number | null>(null);
  const [pageVisible, setPageVisible] = createSignal(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  onMount(() => {
    const disconnect = connectTerminalStream(terminal, props.sessionId);
    const onVisibility = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    onCleanup(() => {
      disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    });
  });

  const session = terminal.session;
  // The stream part binds by role among the session's declared streams.
  const streamRef = createMemo(() => bindStream(session()?.streams, PTY_STREAM_PARAMS.source));
  const streamId = createMemo(() => streamRef()?.id);
  // Rebind when any declared field changes, not only the id; the old stream's rows never mix in.
  const streamKey = createMemo(() => {
    const r = streamRef();
    return r ? JSON.stringify([r.id, r.mediaType, r.sequence, r.encoding, r.framing]) : null;
  });
  const stream = createMemo(() => {
    const key = streamKey();
    if (!key) return null;
    // View state belongs to the stream it was set on.
    untrack(() => {
      setViewPaused(null);
      setFilterMatches(false);
      setSearch('');
      setRawSeq(null);
    });
    return untrack(() => createStreamStore(streamRef()!, PTY_STREAM_PARAMS));
  });

  // Connect while shown; close when hidden or closed.
  createEffect(() => {
    const st = stream();
    const id = streamId();
    if (!st || !id || !pageVisible()) return;
    const close = connectStream(
      props.sessionId,
      id,
      untrack(st.lastSeq),
      (event) => {
        st.apply(event);
        pendingIntents.reconcileChunks(props.sessionId, chunksOf(event));
      },
      (state) => {
        st.setConnection(state);
        if (state === 'disconnected') terminal.markUnconfirmed(msg('terminal.unconfirmed.streamLost'));
      },
    );
    onCleanup(() => {
      close();
      st.setConnection('idle');
      // Closing on purpose still removes the only channel that could confirm these.
      terminal.markUnconfirmed(msg('terminal.unconfirmed.channelClosed'));
    });
  });

  const guardConnection = (): TerminalConnection => {
    if (terminal.connection() !== 'live') return terminal.connection();
    return stream()?.connection() === 'live' ? 'live' : 'lost';
  };
  const guard = createMemo(() => stdinGuard(session(), guardConnection()));
  const live = () => guardConnection() === 'live';
  const controlAffordance = (action: 'pause' | 'resume' | 'fork' | 'kill' | 'restart') =>
    writeAffordance(session()?.capabilities?.[action]);
  const rawChunk = createMemo(() => {
    const seq = rawSeq();
    const row = stream()?.rows().find((r) => r.kind === 'chunk' && r.chunk.seq === seq);
    return row?.kind === 'chunk' ? row.chunk : null;
  });

  const submitControl = (intent: 'session.pause' | 'session.resume' | 'session.fork') => {
    const s = session();
    if (s) void pendingIntents.submit({ intent, sessionId: s.id });
  };

  const sendStdin = (e: SubmitEvent) => {
    e.preventDefault();
    if (!terminal.stdinDraft().trim() || !guard().allowed) return;
    void terminal.submitStdin();
  };

  const textOf = (c: StreamChunk) => chunkText(stream()?.encoding ?? 'utf-8', c.data);
  const displayedRows = (): readonly StreamRow[] => viewPaused()?.rows ?? stream()?.rows() ?? [];
  const matches = createMemo(() => {
    const q = search().trim().toLowerCase();
    if (!q) return null;
    return new Set(
      displayedRows().flatMap((r) =>
        r.kind === 'chunk' && textOf(r.chunk).toLowerCase().includes(q) ? [r.chunk.seq] : [],
      ),
    );
  });
  const filtering = () => filterMatches() && matches() !== null;
  const hiddenByFilter = createMemo(() =>
    filtering()
      ? displayedRows().filter((r) => r.kind === 'chunk' && !matches()!.has(r.chunk.seq)).length
      : 0,
  );
  // Rendered rows = stream rows (claims + instrument markers) + local stdin echoes (marked).
  const viewRows = createMemo((): ViewRow[] => [
    ...displayedRows()
      .filter((r) => !(filtering() && r.kind === 'chunk' && !matches()!.has(r.chunk.seq)))
      .map((row) => ({ kind: 'stream' as const, row })),
    ...terminal.stdinEntries().map((entry) => ({ kind: 'pending' as const, entry })),
  ]);

  return (
    <div class="terminal-surface" data-testid="terminal-surface">
      <header class="execution-header">
        <button data-testid="terminal-back" onClick={props.onClose}>
          {t('terminal.back')}
        </button>
        <Show when={session()}>
          {(s) => (
            <div class="session-block">
              <span class="session-label">{s().label}</span>
              <span class="session-state" data-testid="terminal-session-state" data-state={s().state}>
                {s().state.toUpperCase()}
              </span>
              <span class="session-meta">
                {s().agentLabel}
                <Show when={s().parentSessionId}> · {t('session.forkOf', { id: s().parentSessionId! })}</Show>
              </span>
            </div>
          )}
        </Show>
        <span class="spacer" />
        <Show
          when={live()}
          fallback={
            terminal.connection() === 'unsupported' ? (
              <span class="lost" data-testid="terminal-unsupported-badge">{t('terminal.notSupported')}</span>
            ) : (
              <span class="lost" data-testid="terminal-lost">{t('session.connectionLost')}</span>
            )
          }
        >
          <span class="live" data-testid="terminal-live">{t('session.live')}</span>
        </Show>
        <div class="actions">
          <Show when={controlAffordance('pause') !== 'hidden' && session()?.state === 'running'}>
            <button
              data-testid="terminal-pause"
              disabled={controlAffordance('pause') !== 'enabled'}
              onClick={() => submitControl('session.pause')}
            >
              {t('session.pause')}
            </button>
          </Show>
          <Show when={controlAffordance('resume') !== 'hidden' && session()?.state === 'paused'}>
            <button
              data-testid="terminal-resume"
              disabled={controlAffordance('resume') !== 'enabled'}
              onClick={() => submitControl('session.resume')}
            >
              {t('session.resume')}
            </button>
          </Show>
          <Show when={controlAffordance('fork') !== 'hidden'}>
            <button
              data-testid="terminal-fork"
              disabled={controlAffordance('fork') !== 'enabled'}
              onClick={() => submitControl('session.fork')}
            >
              {t('session.fork')}
            </button>
          </Show>
          <Show when={controlAffordance('restart') !== 'hidden'}>
            <button
              class="privileged"
              data-testid="terminal-restart"
              disabled={controlAffordance('restart') !== 'enabled'}
              onClick={() => setRestartOpen(true)}
            >
              {t('session.restart')}
            </button>
          </Show>
          <Show when={controlAffordance('kill') !== 'hidden'}>
            <button
              class="privileged"
              data-testid="terminal-kill"
              disabled={controlAffordance('kill') !== 'enabled' || session()?.state === 'killed'}
              onClick={() => setKillOpen(true)}
            >
              {t('session.kill')}
            </button>
          </Show>
        </div>
      </header>

      <Show when={terminal.unsupported()}>
        {(reason) => (
          <p class="gate-banner stale-banner" data-testid="terminal-unsupported">
            {t('terminal.unsupported', { reason: reason() })}
          </p>
        )}
      </Show>
      <Show when={!live() && !terminal.unsupported()}>
        <p class="gate-banner stale-banner" data-testid="terminal-stale">
          {t('terminal.stale', { seq: stream()?.lastSeq() ?? '—', at: stream()?.lastAt() ?? t('terminal.stale.unknownTime') })}
        </p>
      </Show>

      <StreamInstruments />
      <PtyViewport />

      <Show when={guard().reason}>
        <p class="terminal-guard" data-testid="stdin-guard">
          {guardLabel(guard().reason!)}
        </p>
      </Show>

      {/* InterventionComposer — audited stdin injection (brief §8–§10). */}
      <form class="composer" data-testid="composer" onSubmit={sendStdin}>
        <span class="prompt">$</span>
        <input
          data-testid="stdin-input"
          disabled={!guard().allowed}
          placeholder={guard().allowed ? t('terminal.stdin.placeholder') : ''}
          value={terminal.stdinDraft()}
          onInput={(e) => terminal.setStdinDraft(e.currentTarget.value)}
        />
        <button
          type="submit"
          data-testid="stdin-send"
          disabled={!guard().allowed || !terminal.stdinDraft().trim()}
        >
          {t('terminal.stdin.send')}
        </button>
      </form>

      <footer class="runtime-bar" data-testid="runtime-bar">
        <Show when={session()?.runtime?.cwd}>
          <span>cwd {session()!.runtime!.cwd}</span>
        </Show>
        <Show when={session()?.runtime?.currentCommand}>
          <span>cmd {session()!.runtime!.currentCommand}</span>
        </Show>
        <Show when={session()?.runtime?.maskedEnv}>
          <span data-testid="terminal-masked-env">
            env{' '}
            {Object.entries(session()!.runtime!.maskedEnv!)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')}
          </span>
        </Show>
        <Show when={session()?.policy?.sessionNarrowing}>
          <span>policy {session()!.policy!.sessionNarrowing}</span>
        </Show>
        <span class="spacer" />
        <input
          data-testid="terminal-search"
          placeholder={t('terminal.search.placeholder')}
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <label>
          <input
            type="checkbox"
            data-testid="terminal-filter"
            checked={filterMatches()}
            onChange={(e) => setFilterMatches(e.currentTarget.checked)}
          />{' '}
          {t('terminal.matchesOnly')}
        </label>
      </footer>

      <Show when={killOpen()}>
        <div class="modal-backdrop" onClick={() => setKillOpen(false)}>
          <div class="modal" data-testid="kill-confirm" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{t('terminal.kill.title')}</h2>
            <p>{t('terminal.kill.body')}</p>
            <label for="kill-reason">{t('terminal.kill.reasonLabel')}</label>
            <input
              id="kill-reason"
              data-testid="kill-reason"
              placeholder={t('terminal.kill.reasonPlaceholder')}
              value={killReason()}
              onInput={(e) => setKillReason(e.currentTarget.value)}
            />
            <div class="actions">
              <button data-testid="kill-cancel" onClick={() => setKillOpen(false)}>{t('terminal.kill.cancel')}</button>
              <button
                class="privileged"
                data-testid="kill-confirm-button"
                disabled={!killReason().trim() || terminal.pendingKill()}
                onClick={() => {
                  void terminal.submitKill(killReason().trim());
                  setKillOpen(false);
                }}
              >
                {t('terminal.kill.confirm')}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={restartOpen()}>
        <div class="modal-backdrop" onClick={() => setRestartOpen(false)}>
          <div class="modal" data-testid="restart-entry" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{t('terminal.restart.title')}</h2>
            <p class="hint">
              {t('terminal.restart.body')}
            </p>
            <button onClick={() => setRestartOpen(false)}>{t('terminal.close')}</button>
          </div>
        </div>
      </Show>

      <Show when={rawChunk()}>
        {(e) => (
          <div class="modal-backdrop" onClick={() => setRawSeq(null)}>
            <div class="modal" data-testid="pty-raw" role="dialog" onClick={(ev) => ev.stopPropagation()}>
              <h2>{t('terminal.raw.title')}</h2>
              <pre>{JSON.stringify(e(), null, 2)}</pre>
              <p class="hint">{t('terminal.raw.later')}</p>
              <button onClick={() => setRawSeq(null)}>{t('terminal.close')}</button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );

  function StreamInstruments() {
    return (
      <Show
        when={stream()}
        fallback={
          <p class="stream-instruments" data-grade="warranty" data-testid="stream-instruments">
            {t('stream.noPty')}
          </p>
        }
      >
        {(st) => (
          <div class="stream-instruments" data-grade="warranty" data-testid="stream-instruments">
            <span data-testid="stream-connection" data-state={st().connection()}>
              {t(CONNECTION_LABEL[st().connection()])}
            </span>
            <span data-testid="stream-seq">seq {st().lastSeq() ?? '—'}</span>
            <Show when={st().upstreamGaps().events > 0}>
              <span data-testid="stream-upstream-gap">
                {t('stream.upstreamGap', { missing: units(st().unit, st().upstreamGaps().seqs), events: st().upstreamGaps().events })}
              </span>
            </Show>
            <Show when={st().computedGaps().events > 0}>
              <span data-testid="stream-computed-gap">
                {t('stream.computedGap', { missing: units(st().unit, st().computedGaps().seqs), breaks: msgN('stream.breaks', st().computedGaps().events) })}
              </span>
            </Show>
            <Show when={st().resyncs() > 0}>
              <span data-testid="stream-resyncs">{t('stream.resyncs', { count: st().resyncs() })}</span>
            </Show>
            <Show when={st().localDrop().chunks > 0}>
              <span data-testid="stream-local-drop">
                {t('stream.localDrop', {
                  ranges: msgN('stream.ranges', st().localDrop().ranges.length),
                  chunks: units('chunks', st().localDrop().chunks),
                  list:
                    st()
                      .localDrop()
                      .ranges.slice(-3)
                      .map((r) => `seq ${r.fromSeq}–${r.toSeq}`)
                      .join(', ') + (st().localDrop().ranges.length > 3 ? ', …' : ''),
                })}
              </span>
            </Show>
            <Show when={st().malformedGaps() > 0}>
              <span data-testid="stream-malformed-gap">{tn('stream.malformedGaps', st().malformedGaps())}</span>
            </Show>
            <Show when={viewPaused()}>
              {(p) => (
                <span data-testid="stream-view-paused">
                  {t('stream.viewPaused', { chunks: units('chunks', st().received() - p().received) })}
                </span>
              )}
            </Show>
            <Show when={hiddenByFilter() > 0}>
              <span data-testid="stream-filter-hidden">{t('stream.filterHidden', { chunks: units('chunks', hiddenByFilter()) })}</span>
            </Show>
            <button
              data-testid="stream-pause-view"
              onClick={() =>
                setViewPaused((p) => (p ? null : { rows: st().rows(), received: st().received() }))
              }
            >
              {viewPaused() ? t('stream.resumeView') : t('stream.pauseView')}
            </button>
          </div>
        )}
      </Show>
    );
  }

  function PtyViewport() {
    let scroller!: HTMLDivElement;
    const [scrollTop, setScrollTop] = createSignal(0);
    const [viewportH, setViewportH] = createSignal(400);
    const [autoScroll, setAutoScroll] = createSignal(true);
    const [unseen, setUnseen] = createSignal(0);
    let prevCount = 0;

    const range = createMemo(() => visibleRange(scrollTop(), viewportH(), ROW_HEIGHT, viewRows().length));
    const slice = createMemo(() => viewRows().slice(range().start, range().end));

    onMount(() => {
      const observer = new ResizeObserver(() => setViewportH(scroller.clientHeight));
      observer.observe(scroller);
      setViewportH(scroller.clientHeight);
      onCleanup(() => observer.disconnect());
    });

    createEffect(() => {
      const count = viewRows().length;
      const added = count - prevCount;
      prevCount = count;
      if (added <= 0) return;
      if (autoScroll()) {
        queueMicrotask(() => {
          scroller.scrollTop = scroller.scrollHeight;
        });
      } else {
        setUnseen((u) => u + added);
      }
    });

    const onScroll = () => {
      setScrollTop(scroller.scrollTop);
      const nearBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < ROW_HEIGHT * 2;
      setAutoScroll(nearBottom);
      if (nearBottom) setUnseen(0);
    };

    return (
      <div class="pty-wrap">
        <div class="pty" data-testid="pty" ref={scroller} onScroll={onScroll}>
          <div style={{ height: `${range().start * ROW_HEIGHT}px` }} />
          <For each={slice()}>
            {(v) =>
              v.kind === 'pending' ? (
                <PendingLine entry={v.entry} />
              ) : v.row.kind === 'chunk' ? (
                <PtyLine chunk={v.row.chunk} />
              ) : (
                <MarkerLine row={v.row} />
              )
            }
          </For>
          <div style={{ height: `${Math.max(0, (viewRows().length - range().end) * ROW_HEIGHT)}px` }} />
        </div>
        <Show when={unseen() > 0}>
          <button
            class="new-events"
            data-testid="pty-new-output"
            onClick={() => {
              scroller.scrollTop = scroller.scrollHeight;
              setAutoScroll(true);
              setUnseen(0);
            }}
          >
            {tn('terminal.newLines', unseen())}
          </button>
        </Show>
      </div>
    );
  }

  /** Chunk body: a claim, rendered verbatim (escapes shown, never interpreted). */
  function PtyLine(p: { chunk: StreamChunk }) {
    const channel = () => p.chunk.channel;
    const known = () => channel() === undefined || Object.hasOwn(CHANNEL_CLASS, channel()!);
    const operator = () => channel() === 'operator';
    return (
      <div
        class="pty-line claim"
        data-testid="pty-line"
        data-channel={channel()}
        classList={{ operator: operator(), match: matches()?.has(p.chunk.seq) ?? false }}
      >
        <button
          class="gutter"
          data-testid={operator() ? 'operator-marker' : undefined}
          title={t('terminal.chunkTitle', { seq: p.chunk.seq, at: p.chunk.at })}
          onClick={() => setRawSeq(p.chunk.seq)}
        >
          {operator() ? '👤' : ' '}
        </button>
        <Show when={!known()}>
          <span class="channel-label">[{channel()}]</span>
        </Show>
        <span class="pty-text">{visibleControls(textOf(p.chunk)) || ' '}</span>
      </div>
    );
  }

  /** Instrument rows: computed or declared by the cockpit's own bookkeeping, not the stream body. */
  function MarkerLine(p: { row: Exclude<StreamRow, { kind: 'chunk' }> }) {
    const unit = () => stream()?.unit ?? 'chunks';
    return (
      <div class="pty-line stream-marker" data-testid={`stream-${p.row.kind}-row`}>
        <span class="gutter">▍</span>
        <span class="pty-text">
          {p.row.kind === 'resync'
            ? t('stream.marker.resync')
            : t('stream.marker.gap', { from: p.row.fromSeq, to: p.row.toSeq, missing: units(unit(), p.row.toSeq - p.row.fromSeq + 1) }) +
              (p.row.origin === 'upstream' ? t('stream.marker.gapUpstream', { reason: p.row.reason }) : t('stream.marker.gapSeqBreak'))}
        </span>
      </div>
    );
  }

  function PendingLine(p: { entry: StdinRow }) {
    const input = () => {
      const i = p.entry.intent;
      return isSessionIntent(i) && i.intent === 'session.stdin' ? i.input : '';
    };
    const rejected = () => (p.entry.phase === 'rejected' ? p.entry : null);
    const unconfirmed = () => (p.entry.phase === 'in-flight' ? p.entry.unconfirmed : undefined);
    const state = () => (rejected() || unconfirmed() ? 'unconfirmed' : 'pending');
    return (
      <div class="pty-line pending-line" data-testid="pending-line" data-state={state()}>
        <span class="gutter">⋯</span>
        <span class="pty-text">
          $ {input()}
          <Show when={state() === 'pending'}>
            <em class="pending-chip">{t('terminal.pending.transmitting')}</em>
          </Show>
          <Show when={rejected()}>
            {(r) => (
              <>
                <em class="unconfirmed" data-testid="input-unconfirmed">
                  {' '}{t('terminal.input.refused')}{r().reason ?? <span class="toast-chrome">{t('terminal.input.noReason')}</span>}
                </em>
                <button class="dismiss" data-testid="input-restore" onClick={() => pendingIntents.reopen(r().localId)}>
                  {t('terminal.input.restore')}
                </button>
                <button
                  class="dismiss"
                  aria-label={t('terminal.input.discard')}
                  onClick={() => pendingIntents.discard(r().localId)}
                >
                  ✕
                </button>
              </>
            )}
          </Show>
          <Show when={unconfirmed()}>
            <em class="unconfirmed" data-testid="input-unconfirmed">
              {' '}{t('terminal.input.unconfirmed', { reason: unconfirmed()! })}
            </em>
            <button class="dismiss" onClick={() => pendingIntents.reopen(p.entry.localId)}>
              {t('terminal.input.restore')}
            </button>
          </Show>
        </span>
      </div>
    );
  }
}
