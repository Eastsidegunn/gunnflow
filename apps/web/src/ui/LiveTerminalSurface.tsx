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
import { GUARD_LABEL, stdinGuard } from '../state/terminalLogic.js';
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
  idle: 'NOT CONNECTED',
  limited: 'WAITING — stream connection limit',
  connecting: 'CONNECTING…',
  live: 'STREAM LIVE',
  disconnected: 'STREAM DISCONNECTED',
  unsupported: 'STREAM NOT SUPPORTED BY UPSTREAM',
} as const;

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
        if (state === 'disconnected') terminal.markUnconfirmed('stream connection lost');
      },
    );
    onCleanup(() => {
      close();
      st.setConnection('idle');
      // Closing on purpose still removes the only channel that could confirm these.
      terminal.markUnconfirmed('confirmation channel closed');
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
          ← Execution
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
                <Show when={s().parentSessionId}> · fork of {s().parentSessionId}</Show>
              </span>
            </div>
          )}
        </Show>
        <span class="spacer" />
        <Show
          when={live()}
          fallback={
            terminal.connection() === 'unsupported' ? (
              <span class="lost" data-testid="terminal-unsupported-badge">NOT SUPPORTED</span>
            ) : (
              <span class="lost" data-testid="terminal-lost">CONNECTION LOST</span>
            )
          }
        >
          <span class="live" data-testid="terminal-live">● LIVE</span>
        </Show>
        <div class="actions">
          <Show when={controlAffordance('pause') !== 'hidden' && session()?.state === 'running'}>
            <button
              data-testid="terminal-pause"
              disabled={controlAffordance('pause') !== 'enabled'}
              onClick={() => submitControl('session.pause')}
            >
              Pause
            </button>
          </Show>
          <Show when={controlAffordance('resume') !== 'hidden' && session()?.state === 'paused'}>
            <button
              data-testid="terminal-resume"
              disabled={controlAffordance('resume') !== 'enabled'}
              onClick={() => submitControl('session.resume')}
            >
              Resume
            </button>
          </Show>
          <Show when={controlAffordance('fork') !== 'hidden'}>
            <button
              data-testid="terminal-fork"
              disabled={controlAffordance('fork') !== 'enabled'}
              onClick={() => submitControl('session.fork')}
            >
              Fork
            </button>
          </Show>
          <Show when={controlAffordance('restart') !== 'hidden'}>
            <button
              class="privileged"
              data-testid="terminal-restart"
              disabled={controlAffordance('restart') !== 'enabled'}
              onClick={() => setRestartOpen(true)}
            >
              Restart…
            </button>
          </Show>
          <Show when={controlAffordance('kill') !== 'hidden'}>
            <button
              class="privileged"
              data-testid="terminal-kill"
              disabled={controlAffordance('kill') !== 'enabled' || session()?.state === 'killed'}
              onClick={() => setKillOpen(true)}
            >
              Kill…
            </button>
          </Show>
        </div>
      </header>

      <Show when={terminal.unsupported()}>
        {(reason) => (
          <p class="gate-banner stale-banner" data-testid="terminal-unsupported">
            This upstream does not provide a terminal — {reason()}
          </p>
        )}
      </Show>
      <Show when={!live() && !terminal.unsupported()}>
        <p class="gate-banner stale-banner" data-testid="terminal-stale">
          Last confirmed output: seq {stream()?.lastSeq() ?? '—'} at {stream()?.lastAt() ?? 'unknown'}
          . Output beyond this point is unknown — never invented.
        </p>
      </Show>

      <StreamInstruments />
      <PtyViewport />

      <Show when={guard().reason}>
        <p class="terminal-guard" data-testid="stdin-guard">
          {GUARD_LABEL[guard().reason!]}
        </p>
      </Show>

      {/* InterventionComposer — audited stdin injection (brief §8–§10). */}
      <form class="composer" data-testid="composer" onSubmit={sendStdin}>
        <span class="prompt">$</span>
        <input
          data-testid="stdin-input"
          disabled={!guard().allowed}
          placeholder={guard().allowed ? 'stdin — recorded in the audit chain' : ''}
          value={terminal.stdinDraft()}
          onInput={(e) => terminal.setStdinDraft(e.currentTarget.value)}
        />
        <button
          type="submit"
          data-testid="stdin-send"
          disabled={!guard().allowed || !terminal.stdinDraft().trim()}
        >
          Send
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
          placeholder="Search output…"
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
          matches only
        </label>
      </footer>

      <Show when={killOpen()}>
        <div class="modal-backdrop" onClick={() => setKillOpen(false)}>
          <div class="modal" data-testid="kill-confirm" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Kill session</h2>
            <p>This stops the active runtime. Downstream work may be affected.</p>
            <label for="kill-reason">Reason (required)</label>
            <input
              id="kill-reason"
              data-testid="kill-reason"
              placeholder="Why are you killing this session?"
              value={killReason()}
              onInput={(e) => setKillReason(e.currentTarget.value)}
            />
            <div class="actions">
              <button data-testid="kill-cancel" onClick={() => setKillOpen(false)}>Cancel</button>
              <button
                class="privileged"
                data-testid="kill-confirm-button"
                disabled={!killReason().trim() || terminal.pendingKill()}
                onClick={() => {
                  void terminal.submitKill(killReason().trim());
                  setKillOpen(false);
                }}
              >
                Kill session
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={restartOpen()}>
        <div class="modal-backdrop" onClick={() => setRestartOpen(false)}>
          <div class="modal" data-testid="restart-entry" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Restart / model replacement</h2>
            <p class="hint">
              Restart semantics and allowed model/vendor options come from an
              upstream contract that is still BLOCKED — entry point only, nothing
              was executed.
            </p>
            <button onClick={() => setRestartOpen(false)}>Close</button>
          </div>
        </div>
      </Show>

      <Show when={rawChunk()}>
        {(e) => (
          <div class="modal-backdrop" onClick={() => setRawSeq(null)}>
            <div class="modal" data-testid="pty-raw" role="dialog" onClick={(ev) => ev.stopPropagation()}>
              <h2>Raw stream chunk</h2>
              <pre>{JSON.stringify(e(), null, 2)}</pre>
              <p class="hint">Full forensic surface (L3/L4) is a later milestone.</p>
              <button onClick={() => setRawSeq(null)}>Close</button>
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
            No PTY stream declared for this session.
          </p>
        }
      >
        {(st) => (
          <div class="stream-instruments" data-grade="warranty" data-testid="stream-instruments">
            <span data-testid="stream-connection" data-state={st().connection()}>
              {CONNECTION_LABEL[st().connection()]}
            </span>
            <span data-testid="stream-seq">seq {st().lastSeq() ?? '—'}</span>
            <Show when={st().upstreamGaps().events > 0}>
              <span data-testid="stream-upstream-gap">
                STREAM GAP (upstream): {st().upstreamGaps().seqs} {st().unit} missing ·{' '}
                {st().upstreamGaps().events} declared
              </span>
            </Show>
            <Show when={st().computedGaps().events > 0}>
              <span data-testid="stream-computed-gap">
                STREAM GAP (seq break): {st().computedGaps().seqs} {st().unit} missing ·{' '}
                {st().computedGaps().events} breaks
              </span>
            </Show>
            <Show when={st().resyncs() > 0}>
              <span data-testid="stream-resyncs">RESYNCED ×{st().resyncs()} — continuity unknown</span>
            </Show>
            <Show when={st().localDrop().chunks > 0}>
              <span data-testid="stream-local-drop">
                LOCAL BUFFER DROP: {st().localDrop().ranges.length} ranges · {st().localDrop().chunks} chunks
                discarded (
                {st()
                  .localDrop()
                  .ranges.slice(-3)
                  .map((r) => `seq ${r.fromSeq}–${r.toSeq}`)
                  .join(', ')}
                {st().localDrop().ranges.length > 3 ? ', …' : ''})
              </span>
            </Show>
            <Show when={st().malformedGaps() > 0}>
              <span data-testid="stream-malformed-gap">{st().malformedGaps()} malformed gap declarations ignored</span>
            </Show>
            <Show when={viewPaused()}>
              {(p) => (
                <span data-testid="stream-view-paused">
                  VIEW PAUSED — {st().received() - p().received} chunks held
                </span>
              )}
            </Show>
            <Show when={hiddenByFilter() > 0}>
              <span data-testid="stream-filter-hidden">{hiddenByFilter()} chunks hidden by filter</span>
            </Show>
            <button
              data-testid="stream-pause-view"
              onClick={() =>
                setViewPaused((p) => (p ? null : { rows: st().rows(), received: st().received() }))
              }
            >
              {viewPaused() ? 'Resume view' : 'Pause view'}
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
            {unseen()} new lines ↓
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
          title={`seq ${p.chunk.seq} · ${p.chunk.at} — view raw chunk`}
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
            ? 'RESYNCED — continuity with the output above is unknown'
            : `STREAM GAP: ${p.row.fromSeq}–${p.row.toSeq} (${p.row.toSeq - p.row.fromSeq + 1} ${unit()} missing)` +
              (p.row.origin === 'upstream' ? ` — upstream: ${p.row.reason}` : ' — seq break')}
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
            <em class="pending-chip"> transmitting…</em>
          </Show>
          <Show when={rejected()}>
            {(r) => (
              <>
                <em class="unconfirmed" data-testid="input-unconfirmed">
                  {' '}Input not confirmed — {r().reason ?? <span class="toast-chrome">No reason given</span>}
                </em>
                <button class="dismiss" data-testid="input-restore" onClick={() => pendingIntents.reopen(r().localId)}>
                  Restore
                </button>
                <button
                  class="dismiss"
                  aria-label="Discard refused input"
                  onClick={() => pendingIntents.discard(r().localId)}
                >
                  ✕
                </button>
              </>
            )}
          </Show>
          <Show when={unconfirmed()}>
            <em class="unconfirmed" data-testid="input-unconfirmed">
              {' '}Input not confirmed (may have reached upstream) — {unconfirmed()}
            </em>
            <button class="dismiss" onClick={() => pendingIntents.reopen(p.entry.localId)}>
              Restore
            </button>
          </Show>
        </span>
      </div>
    );
  }
}
