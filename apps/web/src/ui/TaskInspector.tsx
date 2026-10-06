/**
 * Task Inspector (L1) — a persistent right drawer that deepens one task
 * without leaving the canvas. Operational summary only: no raw payloads,
 * no PTY, no logs — those belong to the Execution surface (brief §4).
 * Every fact shown is upstream-provided; every write is a relayed intent.
 */
import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { manageFocus } from './focusScope.js';
import type { WorkspaceStores } from '../state/stores.js';
import { actionOf, nodeOf, type TaskProjection } from '../model/types.js';
import {
  activityLabel,
  missionName,
  taskActivities,
  taskById,
  taskCapabilities,
  taskRelations,
  taskSessions,
} from '../model/selectors.js';
import { writeAffordance, type Affordance } from '../state/capabilities.js';
import { elapsedLabel } from '../canvas/displayModel.js';
import type { InspectorTab } from '../state/inspectorView.js';
import { FakeEditorPart } from './FakeEditorPart.jsx';

export function TaskInspector(props: {
  stores: WorkspaceStores;
  taskId: string;
  onClose: () => void;
  onEnterSurface: (surface: string, id: string) => void;
  onFocusNode: (id: string) => void;
  motion?: 'enter' | 'exit';
}) {
  const { projectionStore, pendingIntents, inspector } = props.stores;
  const projection = () => projectionStore.projection();
  const task = createMemo(() => taskById(projection(), props.taskId));
  const relations = createMemo(() => taskRelations(projection(), props.taskId));
  const capabilities = createMemo(() => taskCapabilities(projection(), props.taskId));
  const stale = () => projectionStore.connection() === 'lost';

  const pendingOf = (intentType: string) =>
    pendingIntents
      .inFlight()
      .some((p) => actionOf(p.intent) === intentType && nodeOf(p.intent) === props.taskId);

  const affordance = (action: keyof ReturnType<typeof capabilities>): Affordance =>
    writeAffordance(capabilities()[action]);

  return (
    <Show when={task()}>
      {(t) => (
        <aside class="inspector" data-motion={props.motion ?? 'enter'} data-testid="task-inspector" aria-label="Task inspector" ref={(el) => onCleanup(manageFocus(el))}>
          <header class="inspector-header">
            <div>
              <p class="breadcrumb" data-testid="inspector-breadcrumb">
                {missionName(projection(), t().missionId) ?? t().missionId} / {t().name}
              </p>
              <p class="inspector-state" data-testid="inspector-state" data-state={t().state}>
                {t().state.toUpperCase()}
                <Show when={pendingOf('task.pause')}>
                  <span class="pending-chip" data-testid="pending-pause">Pausing…</span>
                </Show>
                <Show when={pendingOf('task.resume')}>
                  <span class="pending-chip" data-testid="pending-resume">Resuming…</span>
                </Show>
              </p>
            </div>
            <button data-testid="inspector-close" aria-label="Close inspector" onClick={props.onClose}>
              ✕
            </button>
          </header>

          <Show when={stale()}>
            <p class="inspector-stale" data-testid="inspector-stale">
              Stale · showing state from{' '}
              {projectionStore.lastSeenAt()
                ? new Date(projectionStore.lastSeenAt()!).toLocaleTimeString()
                : 'unknown'}
            </p>
          </Show>

          <nav class="inspector-tabs" aria-label="Inspector tabs">
            <For each={['overview', 'activity', 'related'] as InspectorTab[]}>
              {(tabName) => (
                <button
                  data-testid={`tab-${tabName}`}
                  classList={{ active: inspector.tab() === tabName }}
                  onClick={() => inspector.setTab(tabName)}
                >
                  {tabName[0]!.toUpperCase() + tabName.slice(1)}
                </button>
              )}
            </For>
          </nav>

          <div class="inspector-body">
            <Show when={inspector.tab() === 'overview'}>
              <Overview
                stores={props.stores}
                task={t()}
                affordance={affordance}
                pendingOf={pendingOf}
                onEnterSurface={props.onEnterSurface}
              />
            </Show>
            <Show when={inspector.tab() === 'activity'}>
              <Activity stores={props.stores} taskId={props.taskId} />
            </Show>
            <Show when={inspector.tab() === 'related'}>
              <Related
                stores={props.stores}
                taskId={props.taskId}
                onEnterSurface={props.onEnterSurface}
                onFocusNode={props.onFocusNode}
              />
            </Show>
          </div>
        </aside>
      )}
    </Show>
  );

  function Overview(p: {
    stores: WorkspaceStores;
    task: TaskProjection;
    affordance: (a: 'pause' | 'resume' | 'instruct' | 'cancel' | 'forceReplan') => Affordance;
    pendingOf: (t: string) => boolean;
    onEnterSurface: (surface: string, id: string) => void;
  }) {
    const [instruction, setInstruction] = createSignal('');
    const sessions = createMemo(() => taskSessions(projection(), p.task.id));
    const gate = createMemo(() => relations().gates.find((g) => g.state === 'waiting') ?? null);

    return (
      <>
        {/* "Why is it stopped?" answers first (brief §9) — upstream reason verbatim. */}
        <Show when={p.task.blockedReason}>
          <section class="blocked-panel" data-testid="inspector-blocked">
            <h3>BLOCKED</h3>
            <p>{p.task.blockedReason}</p>
            <Show when={gate()}>
              <button data-testid="review-gate" onClick={() => p.onEnterSurface('approval', gate()!.id)}>
                Review gate →
              </button>
            </Show>
          </section>
        </Show>

        <Show when={p.task.currentAction}>
          <section>
            <h3>Current</h3>
            <p data-testid="inspector-current">{p.task.currentAction}</p>
          </section>
        </Show>

        <Show when={elapsedLabel(p.task.startedAt, p.task.updatedAt, Date.now())}>
          <section>
            <h3>Timing</h3>
            <p>{elapsedLabel(p.task.startedAt, p.task.updatedAt, Date.now())} elapsed</p>
          </section>
        </Show>

        {/* Execution entry is always available (the surface itself reports
            whatever upstream provides); session rows only when linked. */}
        <section data-testid="inspector-execution">
          <h3>Execution</h3>
          <For each={sessions()}>
            {(s) => (
              <p class="session-row">
                {s.label} · {s.state}
                {s.startedAt ? ` · ${elapsedLabel(s.startedAt, undefined, Date.now())}` : ''}
                {s.forkCount ? ` · ${s.forkCount} forks` : ''}
              </p>
            )}
          </For>
          <button
            data-testid="open-execution"
            onClick={() => p.onEnterSurface('execution', p.task.id)}
          >
            Open execution →
          </button>
        </section>

        <Show when={relations().deliverables.length > 0}>
          <section data-testid="inspector-deliverables">
            <h3>Deliverables</h3>
            <For each={relations().deliverables}>
              {(d) => (
                <button
                  class="row-link"
                  data-testid={`open-deliverable-${d.id}`}
                  onClick={() => p.onEnterSurface('deliverable', d.id)}
                >
                  ▤ {d.title}{d.state ? ` · ${d.state}` : ''} →
                </button>
              )}
            </For>
          </section>
        </Show>

        <section class="inspector-actions" data-testid="inspector-actions">
          <h3>Actions</h3>
          <div class="actions">
            <Show when={p.affordance('pause') !== 'hidden' && p.task.state === 'running'}>
              <button
                data-testid="inspector-pause"
                disabled={p.affordance('pause') !== 'enabled' || p.pendingOf('task.pause')}
                onClick={() => void pendingIntents.submit({ nodeId: p.task.id, action: 'task.pause' })}
              >
                Pause
              </button>
            </Show>
            <Show when={p.affordance('resume') !== 'hidden' && (p.task.state === 'paused' || p.task.state === 'queued')}>
              <button
                data-testid="inspector-resume"
                disabled={p.affordance('resume') !== 'enabled' || p.pendingOf('task.resume')}
                onClick={() => void pendingIntents.submit({ nodeId: p.task.id, action: 'task.resume' })}
              >
                Resume
              </button>
            </Show>
            <Show when={p.affordance('cancel') !== 'hidden'}>
              {/* 🔴 entry point only — the dangerous-action surface is a later milestone. */}
              <button
                class="privileged"
                data-testid="inspector-cancel"
                disabled={p.affordance('cancel') !== 'enabled'}
                onClick={() => p.onEnterSurface('privileged:cancel', p.task.id)}
              >
                Cancel…
              </button>
            </Show>
            <Show when={p.affordance('forceReplan') !== 'hidden'}>
              <button
                class="privileged"
                data-testid="inspector-force-replan"
                disabled={p.affordance('forceReplan') !== 'enabled'}
                onClick={() => p.onEnterSurface('privileged:force-replan', p.task.id)}
              >
                Force replan…
              </button>
            </Show>
          </div>

          {/* Human intent added to the task's future execution — not a chat (brief §11). */}
          <Show when={p.affordance('instruct') !== 'hidden'}>
            <form
              class="instruct"
              data-testid="instruct-form"
              onSubmit={(e) => {
                e.preventDefault();
                const text = instruction().trim();
                if (!text) return;
                void pendingIntents.submit({ nodeId: p.task.id, action: 'task.instruct', decision: { text } });
                setInstruction('');
              }}
            >
              <label for="instruct-input">Send instruction</label>
              <textarea
                id="instruct-input"
                data-testid="instruct-input"
                rows="2"
                placeholder="Add human intent to this task's future execution…"
                value={instruction()}
                onInput={(e) => setInstruction(e.currentTarget.value)}
                disabled={p.affordance('instruct') !== 'enabled'}
              />
              <button
                type="submit"
                data-testid="instruct-send"
                disabled={p.affordance('instruct') !== 'enabled' || !instruction().trim()}
              >
                Send
              </button>
            </form>
          </Show>
        </section>

        <FakeEditorPart stores={p.stores} taskId={p.task.id} />
      </>
    );
  }

  function Activity(p: { stores: WorkspaceStores; taskId: string }) {
    const items = createMemo(() => taskActivities(projection(), p.taskId));
    return (
      <section data-testid="inspector-activity">
        <h3>Recent activity</h3>
        <Show when={items().length > 0} fallback={<p class="hint">No activity reported by upstream.</p>}>
          <ul class="activity-list">
            <For each={items()}>
              {(a) => (
                <li classList={{ human: a.actor === 'human' }}>
                  <span class="activity-label">{activityLabel(a)}</span>
                  <span class="activity-meta">
                    {a.actor === 'human' ? '⟶ human' : a.actor}
                    {' · '}
                    {new Date(a.at).toLocaleTimeString()}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    );
  }

  function Related(p: {
    stores: WorkspaceStores;
    taskId: string;
    onEnterSurface: (surface: string, id: string) => void;
    onFocusNode: (id: string) => void;
  }) {
    const rel = createMemo(() => taskRelations(projection(), p.taskId));
    const mission = () => missionName(projection(), task()!.missionId);
    return (
      <section data-testid="inspector-related">
        <Show when={mission()}>
          <h3>Mission</h3>
          <p>{mission()}</p>
        </Show>
        <Show when={rel().upstream.length > 0}>
          <h3>Upstream</h3>
          <For each={rel().upstream}>
            {(u) => (
              <button class="row-link" data-testid={`related-${u.id}`} onClick={() => p.onFocusNode(u.id)}>
                {u.name} · {u.state}
              </button>
            )}
          </For>
        </Show>
        <Show when={rel().downstream.length > 0}>
          <h3>Downstream</h3>
          <For each={rel().downstream}>
            {(d) => (
              <button class="row-link" data-testid={`related-${d.id}`} onClick={() => p.onFocusNode(d.id)}>
                {d.name} · {d.state}
              </button>
            )}
          </For>
        </Show>
        <Show when={rel().gates.length > 0}>
          <h3>Gates</h3>
          <For each={rel().gates}>
            {(g) => (
              <button
                class="row-link"
                data-testid={`open-gate-${g.id}`}
                onClick={() => p.onEnterSurface('approval', g.id)}
              >
                ◆ {g.name} · {g.state} →
              </button>
            )}
          </For>
        </Show>
        <Show when={rel().deliverables.length > 0}>
          <h3>Deliverables</h3>
          <For each={rel().deliverables}>
            {(d) => (
              <button
                class="row-link"
                data-testid={`related-open-deliverable-${d.id}`}
                onClick={() => p.onEnterSurface('deliverable', d.id)}
              >
                ▤ {d.title}{d.state ? ` · ${d.state}` : ''} →
              </button>
            )}
          </For>
        </Show>
      </section>
    );
  }
}
