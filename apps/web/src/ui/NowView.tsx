/**
 * View A "Now" (gf-p2-views §1): no graph — one list read top to bottom in
 * three sections: Waiting on you → Moving → Changed since your last look.
 * Every row reflects received nodes; "changed" is a view (a comparison with
 * the person's local mark) and says so. Received text (names, summaries) is
 * plain text only. Moving the cursor, switching views and marking seen make
 * no request at all.
 */
import { For, Show, createMemo, onCleanup, onMount, type JSX } from 'solid-js';
import type { NodeProjection } from '@gunnflow/contract';
import { renderFor } from '@gunnflow/contract/wiring';
import type { WorkspaceStores } from '../state/stores.js';
import {
  activitySupported,
  changeSupported,
  changedNodes,
  cursorKey,
  cursorNodeId,
  displayName,
  isoOf,
  movingNodes,
  stepCursor,
  waitingGroups,
  type NowSection,
} from '../state/nowView.js';
import { relativeSince } from '../state/decisionInbox.js';
import { isTypingTarget, matchesKey, resolveKey } from '../state/keybindings.js';
import { escStack } from '../state/escStack.js';
import { glyphChar, toneColor } from '../canvas/tokens.js';
import { createNow } from './DecisionInbox.jsx';
import { t, tm, tn, type CountMessage } from '../i18n/index.js';


export function NowView(props: {
  stores: WorkspaceStores;
  /** Open a node from the list (Enter / click). */
  onOpen: (nodeId: string) => void;
  /** Go to the full view without opening anything. */
  onShowAll: () => void;
  /** Keys are live only while nothing above the view owns the keyboard (settings, inbox, ③). */
  keysActive: () => boolean;
}) {
  const { projectionStore, wiring, viewState, seen, prefs } = props.stores;
  const nodes = () => projectionStore.genericNodes()?.nodes ?? [];
  const byId = createMemo(() => new Map(nodes().map((n) => [n.id, n])));
  const revision = () => projectionStore.projection().revision;
  const now = createNow();

  const waiting = createMemo(() => waitingGroups(nodes(), wiring.config));
  const waitingCount = () => waiting().reduce((s, g) => s + g.rows.length, 0);
  const movingOk = createMemo(() => activitySupported(nodes()));
  const moving = createMemo(() => (movingOk() ? movingNodes(nodes()) : []));
  const changedOk = createMemo(() => changeSupported(nodes()));
  const changed = createMemo(() => {
    const rec = seen.record();
    return changedOk() && rec ? changedNodes(nodes(), rec) : [];
  });

  /** The one list, in display order: the cursor walks it across sections. */
  const keys = createMemo(() => [
    ...waiting().flatMap((g) => g.rows.map((r) => cursorKey('waiting', r.id))),
    ...moving().map((n) => cursorKey('moving', n.id)),
    ...changed().map((n) => cursorKey('changed', n.id)),
  ]);
  /** Every section has no rows (a Changed section still reading its mark is not empty yet). */
  const allEmpty = () => keys().length === 0 && (!changedOk() || seen.record() !== null);

  let rootEl: HTMLElement | undefined;
  const focusKey = (key: string) =>
    rootEl?.querySelector<HTMLElement>(`[data-now-key="${CSS.escape(key)}"]`)?.focus();
  const move = (delta: 1 | -1) => {
    const next = stepCursor(keys(), viewState.nowCursor(), delta);
    if (next === null) return;
    viewState.setNowCursor(next);
    focusKey(next);
  };

  onMount(() => {
    // A return to the list lands where it left (the cursor is view state).
    const cur = viewState.nowCursor();
    if (cur !== null && keys().includes(cur)) queueMicrotask(() => focusKey(cur));
    const onKey = (e: KeyboardEvent) => {
      if (!props.keysActive() || !escStack.isEmpty() || isTypingTarget(e.target)) return;
      // The list owns ↑↓ wherever focus rests (the body, a row, the view switch just clicked);
      // a control with arrow keys of its own keeps them.
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.tagName === 'SELECT' || t.getAttribute('role') === 'menu' || t.closest('[role="menu"]'))) return;
      const k = prefs.prefs().keys;
      if (e.key === 'ArrowDown' || matchesKey(e, resolveKey(k, 'inbox-next'))) {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp' || matchesKey(e, resolveKey(k, 'inbox-prev'))) {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // A focused row or button activates itself (native); Enter elsewhere opens the cursor row.
        if (t && ['BUTTON', 'A', 'SELECT', 'SUMMARY'].includes(t.tagName)) return;
        const cur = viewState.nowCursor();
        if (cur === null || !keys().includes(cur)) return;
        e.preventDefault();
        props.onOpen(cursorNodeId(cur));
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  const open = (section: NowSection, id: string) => {
    viewState.setNowCursor(cursorKey(section, id));
    props.onOpen(id);
  };

  const Glyph = (p: { node: NodeProjection | undefined; stateValue: string }) => {
    const r = () => renderFor(wiring.config, p.stateValue);
    return (
      <span class="now-glyph" aria-hidden="true" style={{ color: toneColor(r()?.tone) }}>
        {glyphChar(r()?.glyph)}
      </span>
    );
  };

  /** One row: glyph · name · [steps] · time · summary (one line, ellipsized). */
  const Row = (p: { section: NowSection; id: string; stateValue: string; time?: string; timeTitle?: string; extra?: JSX.Element }) => {
    const node = () => byId().get(p.id);
    const name = () => (node() ? displayName(node()!) : p.id);
    const key = cursorKey(p.section, p.id);
    return (
      <li class="now-row-item">
        <button
          class="now-row"
          data-now-key={key}
          data-testid={`now-row-${p.section}-${p.id}`}
          data-cursor={viewState.nowCursor() === key ? 'yes' : 'no'}
          onFocus={() => viewState.setNowCursor(key)}
          onClick={() => open(p.section, p.id)}
        >
          <Glyph node={node()} stateValue={p.stateValue} />
          <span class="now-name">{name()}</span>
          <span class="sr-only">, {p.stateValue}</span>
          {p.extra}
          <Show when={p.time}>
            {(t) => (
              <span class="now-time" title={p.timeTitle}>
                {' · '}
                {t()}
              </span>
            )}
          </Show>
          <Show when={node()?.summary}>
            {(s) => (
              <span class="now-summary">
                {' · '}
                {s()}
              </span>
            )}
          </Show>
        </button>
      </li>
    );
  };

  const absolute = (iso: string | undefined) => {
    if (iso === undefined) return undefined;
    const at = Date.parse(iso);
    return Number.isNaN(at) ? iso : new Date(at).toLocaleString();
  };
  const activityTime = (n: NodeProjection) => ({
    time: relativeSince(isoOf(n.lastActivityTs), now()) ?? undefined,
    timeTitle: absolute(isoOf(n.lastActivityTs)),
  });

  const Steps = (p: { node: NodeProjection }) => (
    <Show when={p.node.steps}>
      {(s) => (
        <span class="now-steps" data-testid={`now-steps-${p.node.id}`}>
          <span class="now-steps-bar" aria-hidden="true">
            <span class="now-steps-fill" style={{ width: `${(100 * s().done) / s().total}%` }} />
          </span>
          <span class="sr-only">{t('now.steps')} </span>
          {s().done}/{s().total}
        </span>
      )}
    </Show>
  );

  /** A section whose heading carries its count (a count form of the catalog). */
  const Section = (p: { id: NowSection; heading: CountMessage; count: number; children: JSX.Element; aside?: JSX.Element; note?: JSX.Element }) => (
    <section class="now-section" data-testid={`now-section-${p.id}`} aria-labelledby={`now-h-${p.id}`}>
      <header class="now-section-header">
        <h2 id={`now-h-${p.id}`} data-testid={`now-count-${p.id}`} data-count={p.count}>
          {tn(p.heading, p.count)}
        </h2>
        {p.note}
        <span class="spacer" />
        {p.aside}
      </header>
      {p.children}
    </section>
  );

  const Line = (p: { testid: string; text: string }) => (
    <p class="hint now-line" data-testid={p.testid}>
      {p.text}
    </p>
  );

  /** Changed-section notes: its view status, a first visit, a record kept in memory only. */
  const ChangedNotes = () => (
    <>
      <span class="now-view-note">{t('now.changed.viewNote')}</span>
      <Show when={seen.firstLook()}>
        <span class="now-view-note" data-testid="now-changed-first-look">{t('now.changed.firstLook')}</span>
      </Show>
      <Show when={seen.bound() && !seen.persistent()}>
        <span class="now-view-note warn" data-testid="now-changed-memory-only">
          {t('now.changed.memoryOnly')}
        </span>
      </Show>
    </>
  );

  return (
    <main class="now-view" data-testid="now-view" aria-label={t('view.now')} ref={(el) => (rootEl = el)}>
      <Show when={projectionStore.hasSnapshot()} fallback={<Line testid="now-no-snapshot" text={t('now.noSnapshot')} />}>
        <Show
          when={!allEmpty()}
          fallback={
            <div class="now-calm" data-testid="now-calm">
              {/* Emptiness is claimed only for sections this backend supports; the rest say they are unsupported. */}
              <Line testid="now-waiting-empty" text={t('now.waiting.empty')} />
              <Show when={movingOk()} fallback={<Line testid="now-moving-unsupported" text={t('now.moving.unsupported')} />}>
                <Line testid="now-moving-empty" text={t('now.moving.empty')} />
              </Show>
              <Show when={changedOk()} fallback={<Line testid="now-changed-unsupported" text={t('now.changed.unsupported')} />}>
                <Line testid="now-changed-empty" text={t('now.changed.empty')} />
                <p class="now-calm-notes">
                  <ChangedNotes />
                </p>
              </Show>
              <button data-testid="now-show-all" onClick={props.onShowAll}>
                {t('now.showAll')}
              </button>
            </div>
          }
        >
          <Section id="waiting" heading="now.waiting.heading" count={waitingCount()}>
            <Show when={waitingCount() > 0} fallback={<Line testid="now-waiting-empty" text={t('now.waiting.empty')} />}>
              <For each={waiting()}>
                {(g) => (
                  <div class="now-group">
                    <Show when={g.name}>
                      {(name) => (
                        <h3 class="now-group-name">
                          {tm(name())} <span class="now-count">{g.rows.length}</span>
                        </h3>
                      )}
                    </Show>
                    <ul class="now-list" aria-label={tm(g.name) ?? t('now.waiting.list')}>
                      <For each={g.rows}>
                        {(r) => (
                          <Row
                            section="waiting"
                            id={r.id}
                            stateValue={r.stateValue}
                            time={relativeSince(r.since, now()) ?? undefined}
                            timeTitle={absolute(r.since)}
                          />
                        )}
                      </For>
                    </ul>
                  </div>
                )}
              </For>
            </Show>
          </Section>

          <Section id="moving" heading="now.moving.heading" count={moving().length}>
            <Show when={movingOk()} fallback={<Line testid="now-moving-unsupported" text={t('now.moving.unsupported')} />}>
              <Show when={moving().length > 0} fallback={<Line testid="now-moving-empty" text={t('now.moving.empty')} />}>
                <ul class="now-list" aria-label={t('now.moving.list')}>
                  <For each={moving()}>
                    {(n) => <Row section="moving" id={n.id} stateValue={n.state.value} {...activityTime(n)} extra={<Steps node={n} />} />}
                  </For>
                </ul>
              </Show>
            </Show>
          </Section>

          <Section
            id="changed"
            heading="now.changed.heading"
            count={changed().length}
            note={changedOk() ? <ChangedNotes /> : undefined}
            aside={
              <Show when={changedOk() && seen.record()}>
                <button data-testid="now-mark-all-seen" disabled={changed().length === 0} onClick={() => seen.markAll(revision())}>
                  {t('now.changed.markAll')}
                </button>
              </Show>
            }
          >
            <Show when={changedOk()} fallback={<Line testid="now-changed-unsupported" text={t('now.changed.unsupported')} />}>
              <Show when={seen.record()} fallback={<Line testid="now-changed-loading" text={t('now.changed.loading')} />}>
                <Show when={changed().length > 0} fallback={<Line testid="now-changed-empty" text={t('now.changed.empty')} />}>
                  <ul class="now-list" aria-label={t('now.changed.list')}>
                    <For each={changed()}>
                      {(n) => <Row section="changed" id={n.id} stateValue={n.state.value} time={t('now.changed.rev', { rev: n.changedAtRevision! })} timeTitle={t('now.changed.revTitle', { rev: n.changedAtRevision! })} />}
                    </For>
                  </ul>
                </Show>
              </Show>
            </Show>
          </Section>
          <p class="hint now-hints">
            {t('now.hints', {
              next: resolveKey(prefs.prefs().keys, 'inbox-next').toUpperCase(),
              prev: resolveKey(prefs.prefs().keys, 'inbox-prev').toUpperCase(),
              inbox: resolveKey(prefs.prefs().keys, 'open-decision-inbox').toUpperCase(),
              view: resolveKey(prefs.prefs().keys, 'switch-view').toUpperCase(),
            })}
          </p>
        </Show>
      </Show>
    </main>
  );
}
