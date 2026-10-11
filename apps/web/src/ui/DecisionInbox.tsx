/**
 * 결정함 (Decision inbox) — design decision 2026-10-05: a WIDE right drawer (~60%) over
 * the dimmed-but-visible canvas. Left: the queue of nodes carrying received
 * attention (interrupt-mapped before ambient-mapped — wiring data, never an
 * engine reading), plus a FOLDED (never hidden, §11) decided section for
 * items whose attention cleared while the inbox was open. Right: the selected
 * node's detail (claim grade, verbatim labels) and its capability actions
 * through the existing intent machinery — a decision sent here is the same
 * pending-intent lifecycle as anywhere else.
 *
 * v2 (2026-10-08): when the wiring names display groups (`attention[].group`)
 * the queue, header and toggle count per group — interrupt groups open,
 * ambient groups folded with their count shown; the canvas frames the
 * selected item beside the drawer (view state); waiting time comes from the
 * received `attention.since`; the actions sit in one horizontal bar.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { renderFor } from '@gunnflow/contract/wiring';
import type { WorkspaceStores } from '../state/stores.js';
import {
  accumulateSeen,
  decidedRows,
  groupKey,
  groupName,
  groupRows,
  groupStartsOpen,
  inboxRows,
  interruptCount,
  intentBadge,
  navigableRows,
  nextPendingId,
  relativeSince,
  stepSelection,
  type InboxGroup,
  type InboxRow,
  type IntentBadge,
} from '../state/decisionInbox.js';
import { isTypingTarget, matchesKey, resolveKey } from '../state/keybindings.js';
import { escStack } from '../state/escStack.js';
import { dock } from '../state/dock.js';
import { glyphChar, toneColor } from '../canvas/tokens.js';
import { resolveParts } from '../canvas/parts.js';
import { keyOwnerFocus, manageFocus } from './focusScope.js';
import { DetailSection, NodeActions } from './nodeParts.jsx';
import { t } from '../i18n/index.js';

/** A clock for relative waiting times: refreshed every 30 s while mounted. */
export function createNow() {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(timer));
  return now;
}

/** The per-group count line ("결정 1 · 할 일 0 · 확인 10"): interrupt counts emphasized, ambient muted. */
function GroupCounts(props: { groups: readonly InboxGroup[]; testIdPrefix: string }) {
  return (
    <span class="group-counts">
      <For each={props.groups}>
        {(g, i) => (
          <>
            <Show when={i() > 0}>
              <span class="group-sep"> · </span>
            </Show>
            <span
              class="group-count"
              data-mechanism={g.mechanism}
              data-count={g.rows.length}
              data-testid={`${props.testIdPrefix}-${i()}`}
            >
              {groupName(g)} {g.rows.length}
            </span>
          </>
        )}
      </For>
    </span>
  );
}

/** Top-right chrome entry, beside the notification toggle: the pending count is always visible. */
export function DecisionInboxToggle(props: { stores: WorkspaceStores; open: () => boolean; onToggle: () => void }) {
  const { projectionStore, wiring } = props.stores;
  const pending = createMemo(() => inboxRows(projectionStore.genericNodes()?.nodes ?? [], wiring.config));
  const groups = createMemo(() => groupRows(pending(), wiring.config));
  /** Nodes needing the person (interrupt-mapped), one per node: the total beside the per-group counts. */
  const total = createMemo(() => interruptCount(pending()));
  const summary = () => {
    const g = groups();
    return g ? `${total()} (${g.map((x) => `${groupName(x)} ${x.rows.length}`).join(' · ')})` : t('inbox.pendingCount', { count: pending().length });
  };
  return (
    <div class="decision-inbox-toggle">
      <button
        data-testid="decision-inbox-toggle"
        aria-expanded={props.open()}
        aria-label={t('inbox.toggleLabel', { summary: summary() })}
        classList={{ alerting: pending().some((r) => r.mechanism === 'interrupt') }}
        onClick={props.onToggle}
      >
        {t('inbox.title')}
        <Show
          when={groups()}
          fallback={
            <Show when={pending().length > 0}>
              <span class="count" data-testid="decision-inbox-count">{pending().length}</span>
            </Show>
          }
        >
          {(g) => (
            <>
              <span class="count total" data-count={total()} data-testid="decision-inbox-total">
                {total()}
              </span>{' '}
              <span class="toggle-paren">
                (
                <span class="toggle-groups" data-testid="decision-inbox-groups">
                  <GroupCounts groups={g()} testIdPrefix="decision-inbox-group" />
                </span>
                )
              </span>
            </>
          )}
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
  /** The pending item to open at (e.g. a waiting row of the Now list); absent → the first pending row. */
  initialId?: string | null;
}) {
  const { projectionStore, wiring, prefs } = props.stores;
  const nodes = () => projectionStore.genericNodes()?.nodes ?? [];
  const pending = createMemo(() => inboxRows(nodes(), wiring.config));
  const groups = createMemo(() => groupRows(pending(), wiring.config));
  // Fold state per open (view state): interrupt groups start open, ambient groups folded.
  const [folds, setFolds] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  const groupOpen = (g: InboxGroup) => folds().get(groupKey(g)) ?? groupStartsOpen(g);
  const toggleGroup = (g: InboxGroup) => setFolds((m) => new Map([...m, [groupKey(g), !groupOpen(g)]]));
  /** The rows ↑/↓ and auto-advance move through: every pending row, or the open groups' rows in display order. */
  const navigable = createMemo(() => {
    const g = groups();
    return g ? navigableRows(g, groupOpen) : pending();
  });
  // Rows observed since this open; what cleared folds below, nothing leaves.
  const [seen, setSeen] = createSignal<ReadonlyMap<string, InboxRow>>(new Map());
  createEffect(() => setSeen((s) => accumulateSeen(s, pending())));
  const decided = createMemo(() => decidedRows(seen(), pending()));
  const [decidedOpen, setDecidedOpen] = createSignal(false);
  const now = createNow();

  const [selectedId, setSelectedId] = createSignal<string | null>(props.initialId ?? null);
  let lastIndex = 0;
  createEffect(() => {
    const sel = selectedId();
    const inNavigable = sel !== null && navigable().some((r) => r.id === sel);
    if (inNavigable) {
      lastIndex = navigable().findIndex((r) => r.id === sel);
      return;
    }
    // A selection that folded (decided) or sits in a group the person folded stays viewable; only a missing one is replaced.
    if (sel !== null && (decided().some((r) => r.id === sel) || pending().some((r) => r.id === sel))) return;
    setSelectedId(nextPendingId(navigable(), null, lastIndex));
  });
  const advance = () => setSelectedId((sel) => nextPendingId(navigable(), sel, lastIndex) ?? sel);

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

  // F2: the canvas frames the selected item beside the drawer (view state); exit restores the camera.
  createEffect(() => {
    props.stores.viewState.setInboxFrame(props.motion === 'exit' ? undefined : { nodeId: selectedNode()?.id ?? null });
  });
  onCleanup(() => props.stores.viewState.setInboxFrame(undefined));

  const rowStyle = (r: InboxRow) => renderFor(wiring.config, r.stateValue);
  const keys = () => prefs.prefs().keys;
  const inboxKey = () => resolveKey(keys(), 'open-decision-inbox');
  /** The row's own decision-intent state, read from the pending store (no new machinery). */
  const badgeOf = (id: string): IntentBadge | null =>
    intentBadge(
      props.stores.pendingIntents.inFlight().some((e) => (e.intent as { nodeId?: unknown }).nodeId === id),
      props.stores.pendingIntents.errors().find((e) => e.nodeId === id)?.kind,
    );
  const badgeLabel = (b: IntentBadge): string =>
    b === 'sending' ? t('inbox.badge.sending') : b === 'unconfirmed' ? t('inbox.badge.unconfirmed') : t('inbox.badge.rejected');

  // Focus follows the queue selection (and vice versa via each row's onFocus),
  // so Enter-on-a-row and selectedId can never diverge.
  const focusRow = (id: string) =>
    document.querySelector<HTMLElement>(`.inbox-row[data-node="${CSS.escape(id)}"]`)?.focus();
  const move = (delta: 1 | -1) => {
    const next = stepSelection(navigable(), selectedId(), delta);
    if (next === null) return;
    setSelectedId(next);
    focusRow(next);
  };

  /**
   * Opening AT an item (a waiting row of the Now list), on every open: its
   * group unfolds if folded, it becomes the selection, and focus lands on its
   * row (after the drawer's own first-control focus).
   */
  createEffect(
    on(
      () => props.initialId,
      (id) => {
        if (!id) return;
        const target = groups()?.find((g) => g.rows.some((r) => r.id === id));
        if (target && !groupOpen(target)) setFolds((m) => new Map([...m, [groupKey(target), true]]));
        setSelectedId(id);
        setTimeout(() => focusRow(id), 0);
      },
    ),
  );

  let rootEl: HTMLElement | undefined;
  /**
   * The inbox's navigation keys act only while it owns the keyboard: it is the
   * top Esc owner (no menu or panel above it) and focus is inside the drawer —
   * or nowhere in particular (the body).
   */
  const ownsKeys = (owner: object, target: EventTarget | null) => {
    if (!escStack.isTop(owner)) return false;
    const node = target instanceof Node ? target : null;
    return keyOwnerFocus(node, rootEl ?? null, document.body);
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
      } else if (!ownsKeys(owner, e.target)) {
        // The drawer is non-modal: arrows, j/k and Enter belong to whatever holds focus elsewhere
        // (the canvas mirror, a context menu opened over it).
        return;
      } else if (e.key === 'ArrowDown' || matchesKey(e, resolveKey(keys(), 'inbox-next'))) {
        consume(e);
        move(1);
      } else if (e.key === 'ArrowUp' || matchesKey(e, resolveKey(keys(), 'inbox-prev'))) {
        consume(e);
        move(-1);
      } else if (e.key === 'Enter') {
        // Enter enters ③ only from a queue row or the list itself; any other
        // interactive element (✕, 결정됨 toggle, action buttons) keeps Enter.
        const el = e.target instanceof HTMLElement ? e.target : null;
        const rowEl = el?.closest<HTMLElement>('.inbox-row') ?? null;
        const onList = el === null || el === document.body || el.classList.contains('inbox-queue') || el.classList.contains('decision-inbox');
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
              {badgeLabel(b())}
            </span>
          )}
        </Show>
      </span>
      <span class="inbox-row-meta">
        {p.row.stateValue} · {p.row.causes.join(' · ')}
        <Show when={relativeSince(p.row.since, now())}>
          {(age) => (
            <span class="inbox-since" data-testid={`inbox-since-${p.row.id}`} title={p.row.since}>
              {' · '}
              {age()}
            </span>
          )}
        </Show>
      </span>
    </button>
  );

  return (
    <div class="inbox-scrim" data-motion={props.motion ?? 'enter'}>
      <aside
        class="decision-inbox"
        data-motion={props.motion ?? 'enter'}
        data-testid="decision-inbox"
        role="complementary"
        aria-label={t('inbox.title')}
        ref={(el) => {
          rootEl = el;
          onCleanup(manageFocus(el));
          onCleanup(dock.registerRight(el));
        }}
      >
        <header class="inbox-header">
          <strong>{t('inbox.title')}</strong>
          <Show
            when={groups()}
            fallback={
              <Show
                when={pending().length > 0}
                fallback={<span class="hint" data-testid="inbox-pending-count" data-count="0">{t('inbox.nonePending')}</span>}
              >
                <span class="count" data-testid="inbox-pending-count" data-count={pending().length}>{t('inbox.pendingCount', { count: pending().length })}</span>
              </Show>
            }
          >
            {(g) => (
              <span class="inbox-group-summary" data-testid="inbox-pending-count" data-count={pending().length}>
                <GroupCounts groups={g()} testIdPrefix="inbox-header-group" />
              </span>
            )}
          </Show>
          <span class="spacer" />
          <button data-testid="inbox-close" aria-label={t('common.close')} onClick={props.onClose}>✕</button>
        </header>
        <div class="inbox-columns">
          <div class="inbox-queue">
            <Show when={groups()} fallback={<For each={pending()}>{(r) => <Row row={r} />}</For>}>
              {(gs) => (
                <For each={gs()}>
                  {(g, i) => (
                    <div class="inbox-group" data-mechanism={g.mechanism} data-testid={`inbox-group-${i()}`}>
                      <button
                        class="inbox-group-toggle"
                        data-mechanism={g.mechanism}
                        data-default={g.name === null ? 'yes' : undefined}
                        aria-expanded={groupOpen(g)}
                        data-testid={`inbox-group-toggle-${i()}`}
                        onClick={() => toggleGroup(g)}
                      >
                        {groupOpen(g) ? '▾' : '▸'} {groupName(g)} {g.rows.length}
                      </button>
                      <Show when={groupOpen(g)}>
                        <For each={g.rows} fallback={<p class="hint inbox-group-empty">{t('inbox.groupEmpty')}</p>}>
                          {(r) => <Row row={r} />}
                        </For>
                      </Show>
                    </div>
                  )}
                </For>
              )}
            </Show>
            <Show when={decided().length > 0}>
              <button class="inbox-decided-toggle" data-testid="inbox-decided-toggle" aria-expanded={decidedOpen()} onClick={() => setDecidedOpen(!decidedOpen())}>
                {decidedOpen() ? '▾' : '▸'} {t('inbox.decided', { count: decided().length })}
              </button>
              <Show when={decidedOpen()}>
                <div data-testid="inbox-decided-list">
                  <For each={decided()}>{(r) => <Row row={r} decided />}</For>
                </div>
              </Show>
            </Show>
            <span class="spacer" />
            <p class="hint inbox-hints">{t('inbox.hints', { key: inboxKey().toUpperCase() })}</p>
          </div>
          <div class="inbox-detail">
            <Show when={selectedNode()} fallback={<p class="hint" data-testid="inbox-empty">{t('inbox.empty')}</p>}>
              {(n) => (
                <Show when={selectedId()} keyed>
                  {(_key) => (
                    <div class="inbox-detail-swap">
                      <header class="inbox-detail-header">
                        <div>
                          <h2 data-testid="inbox-detail-title">{n().label ?? n().id}</h2>
                          <p class="hint" data-testid="inbox-detail-caption">
                            {n().kind} · {n().state.value}
                            <Show when={selectedRow()}>{(r) => <> · {r().causes.join(' · ')}</>}</Show>
                            <Show when={relativeSince(selectedRow()?.since, now())}>
                              {(age) => (
                                <span data-testid="inbox-detail-since" title={selectedRow()?.since}>
                                  {' · '}
                                  {age()}
                                </span>
                              )}
                            </Show>
                          </p>
                        </div>
                        <button
                          data-testid="inbox-enter"
                          onClick={() => props.onEnterWork(n().id, pending().map((r) => r.id))}
                        >
                          {t('inbox.enter')}
                        </button>
                      </header>
                      <div class="inbox-detail-body">
                        <DetailSection stores={props.stores} nodeId={n().id} />
                      </div>
                      {/* The decision bar stays put while the detail scrolls (Main.dc layout). */}
                      <Show when={selectedResolved()}>
                        {(r) => (
                          <div class="inbox-actions">
                            <NodeActions stores={props.stores} node={n()} resolved={r()} autoOpenEvidence onSent={advance} layout="bar" />
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
