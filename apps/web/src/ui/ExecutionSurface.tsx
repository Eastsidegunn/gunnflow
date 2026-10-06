/**
 * Execution Surface (L2, Screen #3): dissects how one task actually runs —
 * sessions, events, tools, files, policy — as a chain of upstream facts.
 * It never reinterprets events, evaluates policy, or restores hidden
 * reasoning. Stronger intervention (stdin) belongs to the Live Terminal (#4).
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import {
  connectExecutionStream,
  createExecutionStore,
  EVENT_WINDOW,
} from '../state/executionStore.js';
import {
  eventRow,
  fileChanges,
  filterEvents,
  visibleRange,
  type EventFilters,
} from '../state/executionLogic.js';
import { writeAffordance } from '../state/capabilities.js';
import { missionName, taskById } from '../model/selectors.js';
import { postIntent } from '../transport/relayClient.js';
import type { ExecutionEvent, SessionIntent } from '../model/executionTypes.js';
import type { Intent } from '../model/types.js';

const TABS = ['timeline', 'messages', 'tools', 'files', 'policy'] as const;
type Tab = (typeof TABS)[number];
const ROW_HEIGHT = 30;

export function ExecutionSurface(props: {
  stores: WorkspaceStores;
  taskId: string;
  onClose: () => void;
  onEnterSurface: (surface: string, id: string) => void;
}) {
  const { projectionStore } = props.stores;
  const execution = createExecutionStore((intent: SessionIntent) =>
    postIntent(intent as unknown as Intent),
  );
  const [tab, setTab] = createSignal<Tab>('timeline');
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [failedOnly, setFailedOnly] = createSignal(false);
  const [kindFilter, setKindFilter] = createSignal<ReadonlySet<string>>(new Set());
  const [selectedSeq, setSelectedSeq] = createSignal<number | null>(null);

  onMount(() => {
    const disconnect = connectExecutionStream(execution, props.taskId);
    onCleanup(disconnect);
  });

  // Session shown = user's pick, else upstream list order (no "primary" inference).
  const session = createMemo(() => {
    const all = execution.sessions();
    return all.find((s) => s.id === sessionId()) ?? all[0] ?? null;
  });
  const filters = createMemo<EventFilters>(() => ({
    sessionId: session()?.id ?? null,
    failedOnly: failedOnly(),
    kinds: kindFilter(),
  }));
  const filtered = createMemo(() => filterEvents(execution.events(), filters()));
  const selectedEvent = createMemo(
    () => execution.events().find((e) => e.seq === selectedSeq()) ?? null,
  );
  const live = () => execution.connection() === 'live';
  // Stated upstream conditions (불변식 2): never dressed as a connection loss.
  const ended = () => execution.connection() === 'unsupported' || execution.connection() === 'none';
  const task = () => taskById(projectionStore.projection(), props.taskId);

  const affordance = (action: 'pause' | 'resume' | 'fork' | 'kill' | 'restart') =>
    writeAffordance(session()?.capabilities?.[action]);
  const control = (intent: SessionIntent['intent']) => {
    const s = session();
    if (s) void execution.submitControl({ intent, sessionId: s.id } as SessionIntent);
  };

  const toggleKind = (kind: string) => {
    const next = new Set(kindFilter());
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setKindFilter(next);
  };

  return (
    <div class="execution-surface" data-testid="execution-surface">
      <header class="execution-header">
        <button data-testid="execution-back" onClick={props.onClose}>
          ← {missionName(projectionStore.projection(), task()?.missionId ?? '') ?? ''} /{' '}
          {task()?.name ?? props.taskId}
        </button>
        <Show when={session()}>
          {(s) => (
            <div class="session-block">
              <Show
                when={execution.sessions().length > 1}
                fallback={<span class="session-label">{s().label}</span>}
              >
                <select
                  data-testid="session-selector"
                  value={s().id}
                  onChange={(e) => setSessionId(e.currentTarget.value)}
                >
                  <For each={execution.sessions()}>
                    {(opt) => (
                      <option value={opt.id}>
                        {opt.label} · {opt.state}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
              <span class="session-state" data-testid="session-state" data-state={s().state}>
                {s().state.toUpperCase()}
                <Show when={execution.hasPending(s().id, 'session.pause')}>
                  <em class="pending-chip" data-testid="session-pending">Pausing…</em>
                </Show>
                <Show when={execution.hasPending(s().id, 'session.resume')}>
                  <em class="pending-chip">Resuming…</em>
                </Show>
              </span>
              <span class="session-meta">
                {s().agentLabel}
                <Show when={s().model}> · {s().model}</Show>
                <Show when={s().parentSessionId}>
                  <span data-testid="fork-marker"> · fork of {s().parentSessionId}</span>
                </Show>
              </span>
            </div>
          )}
        </Show>
        <span class="spacer" />
        <Show
          when={live()}
          fallback={
            <Show when={!ended()}>
              <span class="lost" data-testid="execution-lost">CONNECTION LOST</span>
            </Show>
          }
        >
          <span class="live" data-testid="execution-live">● LIVE</span>
        </Show>
        <Show when={session()}>
          <div class="actions">
            <Show when={affordance('pause') !== 'hidden' && session()!.state === 'running'}>
              <button
                data-testid="session-pause"
                disabled={affordance('pause') !== 'enabled' || execution.hasPending(session()!.id)}
                onClick={() => control('session.pause')}
              >
                Pause
              </button>
            </Show>
            <Show when={affordance('resume') !== 'hidden' && session()!.state === 'paused'}>
              <button
                data-testid="session-resume"
                disabled={affordance('resume') !== 'enabled' || execution.hasPending(session()!.id)}
                onClick={() => control('session.resume')}
              >
                Resume
              </button>
            </Show>
            <Show when={affordance('fork') !== 'hidden'}>
              <button
                data-testid="session-fork"
                disabled={affordance('fork') !== 'enabled'}
                onClick={() => control('session.fork')}
              >
                Fork
              </button>
            </Show>
            <Show when={affordance('kill') !== 'hidden'}>
              <button
                class="privileged"
                data-testid="session-kill"
                disabled={affordance('kill') !== 'enabled'}
                onClick={() => props.onEnterSurface('privileged:kill', session()!.id)}
              >
                Kill…
              </button>
            </Show>
          </div>
        </Show>
      </header>

      <Show when={ended()}>
        <p class="gate-banner stale-banner" data-testid="execution-ended">
          {execution.connection() === 'unsupported'
            ? '이 백엔드는 execution 표면을 제공하지 않음'
            : '이 task의 execution 없음'}
        </p>
      </Show>
      <Show when={!live() && !ended()}>
        <p class="gate-banner stale-banner" data-testid="execution-stale">
          Showing events through{' '}
          {execution.lastEventAt()
            ? new Date(execution.lastEventAt()!).toLocaleTimeString()
            : 'unknown'}
          . Live session state is unknown — not inferred.
        </p>
      </Show>
      <Show when={execution.controlError()}>
        <p class="gate-banner stale-banner" data-testid="control-error">
          {execution.controlError()}
          <button onClick={execution.dismissControlError}>✕</button>
        </p>
      </Show>

      <Show when={execution.connection() === 'live' && execution.sessions().length === 0}>
        <p class="hint" style={{ padding: '8px 14px', margin: '0' }} data-testid="no-sessions">
          No sessions reported by upstream for this task.
        </p>
      </Show>

      <nav class="inspector-tabs" aria-label="Execution tabs">
        <For each={TABS}>
          {(t) => (
            <button
              data-testid={`exec-tab-${t}`}
              classList={{ active: tab() === t }}
              onClick={() => setTab(t)}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          )}
        </For>
      </nav>

      <div class="execution-body">
        <div class="execution-main">
          <Show when={tab() === 'timeline'}>
            <Timeline />
          </Show>
          <Show when={tab() === 'messages'}>
            <Messages />
          </Show>
          <Show when={tab() === 'tools'}>
            <Tools />
          </Show>
          <Show when={tab() === 'files'}>
            <Files />
          </Show>
          <Show when={tab() === 'policy'}>
            <Policy />
          </Show>
        </div>
        <Show when={selectedEvent()}>{(e) => <DetailPane event={e()} />}</Show>
      </div>

      <TerminalPreview />
    </div>
  );

  function Timeline() {
    let scroller!: HTMLDivElement;
    const [scrollTop, setScrollTop] = createSignal(0);
    const [viewportH, setViewportH] = createSignal(400);
    const [autoScroll, setAutoScroll] = createSignal(true);
    const [unseen, setUnseen] = createSignal(0);
    let prevCount = 0;

    const range = createMemo(() =>
      visibleRange(scrollTop(), viewportH(), ROW_HEIGHT, filtered().length),
    );
    const slice = createMemo(() => filtered().slice(range().start, range().end));

    onMount(() => {
      const observer = new ResizeObserver(() => setViewportH(scroller.clientHeight));
      observer.observe(scroller);
      setViewportH(scroller.clientHeight);
      onCleanup(() => observer.disconnect());
    });

    // Live tail (§16): follow the bottom unless the user scrolled away.
    createEffect(() => {
      const count = filtered().length;
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
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < ROW_HEIGHT * 1.5;
      setAutoScroll(nearBottom);
      if (nearBottom) setUnseen(0);
    };
    const jumpToLatest = () => {
      scroller.scrollTop = scroller.scrollHeight;
      setAutoScroll(true);
      setUnseen(0);
    };

    return (
      <div class="timeline-wrap">
        <div class="filter-bar" data-testid="filter-bar">
          <button
            classList={{ active: failedOnly() }}
            data-testid="filter-failed"
            onClick={() => setFailedOnly(!failedOnly())}
          >
            failed only
          </button>
          <For each={['tool.call', 'file.change', 'egress', 'human', 'message'] as const}>
            {(kind) => (
              <button
                classList={{ active: kindFilter().has(kind) }}
                data-testid={`filter-${kind}`}
                onClick={() => toggleKind(kind)}
              >
                {kind}
              </button>
            )}
          </For>
          <Show when={execution.truncated() > 0}>
            <span class="hint" data-testid="truncated-note">
              {execution.truncated()} older events beyond the {EVENT_WINDOW}-event window — full
              history stays upstream
            </span>
          </Show>
          <Show when={execution.upstreamTruncatedBefore() !== null}>
            {/* Upstream-declared cut (contract truncatedBefore) — stated, never counted locally. */}
            <span class="hint" data-testid="upstream-truncated-note">
              seq {execution.upstreamTruncatedBefore()} 이전 이벤트는 이 창에 없음 — 전체 이력은 상류에
            </span>
          </Show>
        </div>
        <div class="timeline" data-testid="timeline" ref={scroller} onScroll={onScroll}>
          <div style={{ height: `${range().start * ROW_HEIGHT}px` }} />
          <For each={slice()}>
            {(e) => {
              const row = eventRow(e);
              return (
                <button
                  class="timeline-row"
                  data-testid="timeline-row"
                  data-status={row.status ?? 'none'}
                  onClick={() => setSelectedSeq(e.seq)}
                >
                  <span class="t-time">{row.time}</span>
                  <span class="t-kind">{row.kind}</span>
                  <span class="t-label">{row.label}</span>
                  <span class="t-status">{row.status ?? ''}</span>
                  <span class="t-dur">{row.duration ?? ''}</span>
                </button>
              );
            }}
          </For>
          <div
            style={{ height: `${Math.max(0, (filtered().length - range().end) * ROW_HEIGHT)}px` }}
          />
        </div>
        <Show when={unseen() > 0}>
          <button class="new-events" data-testid="new-events" onClick={jumpToLatest}>
            {unseen()} new events ↓
          </button>
        </Show>
      </div>
    );
  }

  // Payload views are not carried by every wire: an empty tab asserts nothing.
  function PayloadEmpty() {
    return (
      <p class="hint" data-testid="payload-empty">
        이 연결에서 운반되지 않았거나 없음
      </p>
    );
  }

  function Messages() {
    const messages = createMemo(() => filtered().filter((e) => e.message));
    return (
      <div>
        <Show when={messages().length === 0}>
          <PayloadEmpty />
        </Show>
        <ul class="message-list" data-testid="messages-view">
        <For each={messages()}>
          {(e) => (
            <li classList={{ human: e.message!.role === 'human' }}>
              <span class="msg-role">{e.message!.role}</span>
              <p>{e.message!.content}</p>
              <span class="activity-meta">{new Date(e.at).toLocaleTimeString()}</span>
            </li>
          )}
        </For>
        </ul>
      </div>
    );
  }

  function Tools() {
    const tools = createMemo(() => filtered().filter((e) => e.tool));
    return (
      <div>
        <Show when={tools().length === 0}>
          <PayloadEmpty />
        </Show>
        <table class="tools-table" data-testid="tools-view">
        <tbody>
          <For each={tools()}>
            {(e) => (
              <tr data-status={e.status ?? 'none'} onClick={() => setSelectedSeq(e.seq)}>
                <td>{e.status === 'failed' ? '✕' : '✓'}</td>
                <td>{e.tool!.name}</td>
                <td class="t-label">{e.label}</td>
                <td>{eventRow(e).duration ?? ''}</td>
                <td>{e.tool!.costLabel ?? ''}</td>
              </tr>
            )}
          </For>
        </tbody>
        </table>
      </div>
    );
  }

  function Files() {
    const changes = createMemo(() => fileChanges(filtered()));
    return (
      <div data-testid="files-view">
        <Show when={changes().length === 0}>
          <PayloadEmpty />
        </Show>
        <ul class="file-list">
          <For each={changes()}>
            {(e) => (
              <li>
                <button class="row-link" onClick={() => setSelectedSeq(e.seq)}>
                  <span class="file-change" data-change={e.file!.change}>
                    {e.file!.change === 'create' ? '+' : e.file!.change === 'delete' ? '−' : 'M'}
                  </span>{' '}
                  {e.file!.path}
                </button>
              </li>
            )}
          </For>
        </ul>
        <p class="hint">Read-only view. Edits require a governed intervention (later surface).</p>
      </div>
    );
  }

  function Policy() {
    const policy = () => session()?.policy;
    return (
      <div data-testid="policy-view">
        <Show when={policy()} fallback={<PayloadEmpty />}>
          {(p) => (
            <>
              <section>
                <h3>Constraints</h3>
                <Show when={p().ceiling}><p>{p().ceiling}</p></Show>
                <Show when={p().missionNarrowing}><p>{p().missionNarrowing}</p></Show>
                <Show when={p().sessionNarrowing}><p>{p().sessionNarrowing}</p></Show>
              </section>
              <Show when={p().activePolicies?.length}>
                <section>
                  <h3>Active policies</h3>
                  <For each={p().activePolicies}>{(name) => <p>{name}</p>}</For>
                </section>
              </Show>
              <Show when={p().decisions?.length}>
                <section>
                  <h3>Decisions</h3>
                  <For each={p().decisions}>
                    {(d) => (
                      <p data-testid={`policy-${d.outcome}`}>
                        {new Date(d.at).toLocaleTimeString()} · {d.label} ·{' '}
                        <strong>{d.outcome}</strong>
                      </p>
                    )}
                  </For>
                </section>
              </Show>
              <Show when={p().remainingBudget}>
                <section>
                  <h3>Budget</h3>
                  <p>{p().remainingBudget}</p>
                </section>
              </Show>
            </>
          )}
        </Show>
      </div>
    );
  }

  function DetailPane(p: { event: ExecutionEvent }) {
    const row = () => eventRow(p.event);
    return (
      <aside class="detail-pane" data-testid="detail-pane">
        <header>
          <h3>{row().label}</h3>
          <button aria-label="Close detail" onClick={() => setSelectedSeq(null)}>✕</button>
        </header>
        <p class="hint">
          {row().time} · {row().kind}
          <Show when={row().status}> · {row().status}</Show>
        </p>
        <Show when={p.event.tool}>
          <section>
            <h3>Tool</h3>
            <p>{p.event.tool!.name}</p>
            <pre>{p.event.tool!.args}</pre>
            <Show when={p.event.tool!.result}><pre>{p.event.tool!.result}</pre></Show>
          </section>
        </Show>
        <Show when={p.event.file?.diff}>
          <section>
            <h3>Diff (read-only)</h3>
            <pre data-testid="file-diff">{p.event.file!.diff}</pre>
          </section>
        </Show>
        <Show when={p.event.egress}>
          <section>
            <h3>Egress</h3>
            <p>
              {p.event.egress!.destination} · <strong>{p.event.egress!.outcome}</strong>
            </p>
            <Show when={p.event.egress!.gateId}>
              <button
                data-testid="detail-open-gate"
                onClick={() => props.onEnterSurface('approval', p.event.egress!.gateId!)}
              >
                Open gate →
              </button>
            </Show>
          </section>
        </Show>
        <section>
          <h3>Raw event</h3>
          <pre data-testid="raw-event">{JSON.stringify(p.event, null, 2)}</pre>
          <p class="hint">Full raw explorer (L3) is a later surface.</p>
        </section>
      </aside>
    );
  }

  function TerminalPreview() {
    const shellTail = createMemo(() =>
      filtered()
        .filter((e) => e.kind === 'shell')
        .slice(-4),
    );
    const runtime = () => session()?.runtime;
    return (
      <Show when={runtime() || shellTail().length > 0}>
        <footer class="terminal-preview" data-testid="terminal-preview">
          <div class="terminal-lines">
            <Show when={runtime()?.cwd}>
              <span class="hint">cwd {runtime()!.cwd}</span>
            </Show>
            <Show when={runtime()?.currentCommand}>
              <span data-testid="current-command">$ {runtime()!.currentCommand}</span>
            </Show>
            <For each={shellTail()}>{(e) => <span data-status={e.status}>{e.label}</span>}</For>
            <Show when={runtime()?.maskedEnv}>
              <span class="hint" data-testid="masked-env">
                env{' '}
                {Object.entries(runtime()!.maskedEnv!)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' ')}
              </span>
            </Show>
          </div>
          <button
            data-testid="open-terminal"
            onClick={() => props.onEnterSurface('terminal', session()?.id ?? props.taskId)}
          >
            Open live terminal →
          </button>
        </footer>
      </Show>
    );
  }
}
