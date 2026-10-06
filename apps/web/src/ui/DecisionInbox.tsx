/**
 * 결정함 (Decision inbox) — design decision 2026-10-05: a WIDE right drawer (~60%) over
 * the dimmed-but-visible canvas. Left: the queue of nodes carrying received
 * attention (interrupt-mapped before ambient-mapped — wiring data, never an
 * engine reading), plus a FOLDED (never hidden, §11) decided section for
 * items whose attention cleared while the inbox was open. Right: the selected
 * node's detail (claim grade, verbatim labels) and its capability actions
 * through the existing intent machinery — a decision sent here is the same
 * pending-intent lifecycle as anywhere else.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { renderFor } from '@gunnflow/contract/wiring';
import type { WorkspaceStores } from '../state/stores.js';
import {
  accumulateSeen,
  decidedRows,
  inboxRows,
  intentBadge,
  nextPendingId,
  stepSelection,
  type InboxRow,
  type IntentBadge,
} from '../state/decisionInbox.js';
import { isTypingTarget, matchesKey, resolveKey } from '../state/keybindings.js';
import { escStack } from '../state/escStack.js';
import { glyphChar, toneColor } from '../canvas/tokens.js';
import { resolveParts } from '../canvas/parts.js';
import { manageFocus } from './focusScope.js';
import { DetailSection, NodeActions } from './nodeParts.jsx';

/** Top-right chrome entry, beside the notification toggle: the pending count is always visible. */
export function DecisionInboxToggle(props: { stores: WorkspaceStores; open: () => boolean; onToggle: () => void }) {
  const { projectionStore, wiring } = props.stores;
  const pending = createMemo(() => inboxRows(projectionStore.genericNodes()?.nodes ?? [], wiring.config));
  return (
    <div class="decision-inbox-toggle">
      <button
        data-testid="decision-inbox-toggle"
        aria-expanded={props.open()}
        aria-label={`결정함: 미결 ${pending().length}`}
        classList={{ alerting: pending().some((r) => r.mechanism === 'interrupt') }}
        onClick={props.onToggle}
      >
        결정함
        <Show when={pending().length > 0}>
          <span class="count" data-testid="decision-inbox-count">{pending().length}</span>
        </Show>
      </button>
    </div>
  );
}

export function DecisionInbox(props: {
  stores: WorkspaceStores;
  onClose: () => void;
  onEnterWork: (nodeId: string, queue: readonly string[]) => void;
  motion?: 'enter' | 'exit';
}) {
  const { projectionStore, wiring, prefs } = props.stores;
  const nodes = () => projectionStore.genericNodes()?.nodes ?? [];
  const pending = createMemo(() => inboxRows(nodes(), wiring.config));
  // Rows observed since this open; what cleared folds below, nothing leaves.
  const [seen, setSeen] = createSignal<ReadonlyMap<string, InboxRow>>(new Map());
  createEffect(() => setSeen((s) => accumulateSeen(s, pending())));
  const decided = createMemo(() => decidedRows(seen(), pending()));
  const [decidedOpen, setDecidedOpen] = createSignal(false);

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  let lastIndex = 0;
  createEffect(() => {
    const sel = selectedId();
    const inPending = sel !== null && pending().some((r) => r.id === sel);
    if (inPending) {
      lastIndex = pending().findIndex((r) => r.id === sel);
      return;
    }
    // A selection that folded stays viewable; only a missing one is replaced.
    if (sel !== null && decided().some((r) => r.id === sel)) return;
    setSelectedId(nextPendingId(pending(), null, lastIndex));
  });
  const advance = () => setSelectedId((sel) => nextPendingId(pending(), sel, lastIndex) ?? sel);

  const selectedNode = createMemo(() => {
    const sel = selectedId();
    return sel ? nodes().find((n) => n.id === sel) : undefined;
  });
  const selectedResolved = createMemo(() => {
    const n = selectedNode();
    return n ? resolveParts(n, wiring.config) : null;
  });
  const selectedRow = createMemo(() => {
    const sel = selectedId();
    return sel ? (pending().find((r) => r.id === sel) ?? decided().find((r) => r.id === sel)) : undefined;
  });

  const rowStyle = (r: InboxRow) => renderFor(wiring.config, r.stateValue);
  const keys = () => prefs.prefs().keys;
  const inboxKey = () => resolveKey(keys(), 'open-decision-inbox');
  /** The row's own decision-intent state, read from the pending store (no new machinery). */
  const badgeOf = (id: string): IntentBadge | null =>
    intentBadge(
      props.stores.pendingIntents.inFlight().some((e) => (e.intent as { nodeId?: unknown }).nodeId === id),
      props.stores.pendingIntents.errors().find((e) => e.nodeId === id)?.kind,
    );
  const BADGE_LABEL: Record<IntentBadge, string> = { sending: '전송중', unconfirmed: '미확정', rejected: '거부됨' };

  // Focus follows the queue selection (and vice versa via each row's onFocus),
  // so Enter-on-a-row and selectedId can never diverge.
  const focusRow = (id: string) =>
    document.querySelector<HTMLElement>(`.inbox-row[data-node="${CSS.escape(id)}"]`)?.focus();
  const move = (delta: 1 | -1) => {
    const next = stepSelection(pending(), selectedId(), delta);
    if (next === null) return;
    setSelectedId(next);
    focusRow(next);
  };

  onMount(() => {
    const owner = {};
    onCleanup(escStack.push(owner));
    const consume = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Escape') {
        // Only the top Esc owner acts — one Esc, one level.
        if (!escStack.isTop(owner)) return;
        consume(e);
        props.onClose();
      } else if (e.key === 'ArrowDown' || matchesKey(e, resolveKey(keys(), 'inbox-next'))) {
        consume(e);
        move(1);
      } else if (e.key === 'ArrowUp' || matchesKey(e, resolveKey(keys(), 'inbox-prev'))) {
        consume(e);
        move(-1);
      } else if (e.key === 'Enter') {
        // Enter enters ③ only from a queue row or the list itself; any other
        // interactive element (✕, 결정됨 toggle, action buttons) keeps Enter.
        const t = e.target instanceof HTMLElement ? e.target : null;
        const rowEl = t?.closest<HTMLElement>('.inbox-row') ?? null;
        const onList = t === null || t === document.body || t.classList.contains('inbox-queue') || t.classList.contains('decision-inbox');
        if (!rowEl && !onList) return;
        const id = rowEl?.dataset.node ?? selectedId();
        if (!id) return;
        consume(e);
        props.onEnterWork(id, pending().map((r) => r.id));
      }
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  const Row = (p: { row: InboxRow; decided?: boolean }) => (
    <button
      class="inbox-row"
      classList={{ decided: p.decided === true }}
      data-testid={`inbox-row-${p.row.id}`}
      data-node={p.row.id}
      data-selected={selectedId() === p.row.id ? 'yes' : 'no'}
      data-mechanism={p.row.mechanism}
      onFocus={() => setSelectedId(p.row.id)}
      onClick={() => setSelectedId(p.row.id)}
    >
      <span class="inbox-row-main">
        <span style={{ color: toneColor(rowStyle(p.row)?.tone) }}>{glyphChar(rowStyle(p.row)?.glyph)}</span> {p.row.label}
        <Show when={badgeOf(p.row.id)}>
          {(b) => (
            <span class="inbox-badge" data-state={b()} data-testid={`inbox-badge-${p.row.id}`}>
              {BADGE_LABEL[b()]}
            </span>
          )}
        </Show>
      </span>
      <span class="inbox-row-meta">
        {p.row.stateValue} · {p.row.causes.join(' · ')}
      </span>
    </button>
  );

  return (
    <div class="inbox-scrim" data-motion={props.motion ?? 'enter'}>
      <aside
        class="decision-inbox"
        data-motion={props.motion ?? 'enter'}
        data-testid="decision-inbox"
        role="dialog"
        aria-label="결정함"
        ref={(el) => onCleanup(manageFocus(el))}
      >
        <header class="inbox-header">
          <strong>결정함</strong>
          <Show
            when={pending().length > 0}
            fallback={<span class="hint" data-testid="inbox-pending-count" data-count="0">미결 없음</span>}
          >
            <span class="count" data-testid="inbox-pending-count" data-count={pending().length}>미결 {pending().length}</span>
          </Show>
          <span class="spacer" />
          <button data-testid="inbox-close" aria-label="닫기" onClick={props.onClose}>✕</button>
        </header>
        <div class="inbox-columns">
          <div class="inbox-queue">
            <For each={pending()}>{(r) => <Row row={r} />}</For>
            <Show when={decided().length > 0}>
              <button class="inbox-decided-toggle" data-testid="inbox-decided-toggle" aria-expanded={decidedOpen()} onClick={() => setDecidedOpen(!decidedOpen())}>
                {decidedOpen() ? '▾' : '▸'} 결정됨 {decided().length}
              </button>
              <Show when={decidedOpen()}>
                <div data-testid="inbox-decided-list">
                  <For each={decided()}>{(r) => <Row row={r} decided />}</For>
                </div>
              </Show>
            </Show>
            <span class="spacer" />
            <p class="hint inbox-hints">↑↓/jk 이동 · ↵ 들어가기 · Esc 닫기 · {inboxKey().toUpperCase()} 열기(설정 가능)</p>
          </div>
          <div class="inbox-detail">
            <Show when={selectedNode()} fallback={<p class="hint" data-testid="inbox-empty">읽을 항목이 없습니다.</p>}>
              {(n) => (
                <Show when={selectedId()} keyed>
                  {(_key) => (
                    <div class="inbox-detail-swap">
                      <header class="inbox-detail-header">
                        <div>
                          <h2 data-testid="inbox-detail-title">{n().label ?? n().id}</h2>
                          <p class="hint">
                            {n().kind} · {n().state.value}
                            <Show when={selectedRow()}>{(r) => <> · {r().causes.join(' · ')}</>}</Show>
                          </p>
                        </div>
                        <button
                          data-testid="inbox-enter"
                          onClick={() => props.onEnterWork(n().id, pending().map((r) => r.id))}
                        >
                          들어가기 ↵
                        </button>
                      </header>
                      <div class="inbox-detail-body">
                        <DetailSection stores={props.stores} nodeId={n().id} />
                      </div>
                      {/* The decision bar stays put while the detail scrolls (Main.dc layout). */}
                      <Show when={selectedResolved()}>
                        {(r) => (
                          <div class="inbox-actions">
                            <NodeActions stores={props.stores} node={n()} resolved={r()} autoOpenEvidence onSent={advance} />
                          </div>
                        )}
                      </Show>
                    </div>
                  )}
                </Show>
              )}
            </Show>
          </div>
        </div>
      </aside>
    </div>
  );
}
