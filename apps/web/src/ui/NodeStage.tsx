/**
 * ② Stage — the selected node's surface (overview-to-work depth 2). Succeeds
 * the bottom-left GenericNodePanel: the same content machinery (assembly ×
 * capabilities, on-demand detail, pending/send receipts), now standing beside
 * the node as a right-side stage sized for deciding in place. "들어가기 ↵"
 * (and Enter / canvas double-click) descends to the node's ③ work surface.
 */
import { For, Show, createEffect, createMemo } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import { resolveParts } from '../canvas/parts.js';
import { writeAffordance } from '../state/capabilities.js';
import { taskCapabilities } from '../model/selectors.js';
import { ArtifactViewer } from './ArtifactViewer.jsx';
import { PersonalNoteSection } from '../personal/PersonalUi.jsx';
import { DetailSection, NodeActions } from './nodeParts.jsx';

export function NodeStage(props: {
  stores: WorkspaceStores;
  nodeId: string;
  onClose: () => void;
  onEnterWork: (nodeId: string) => void;
  onEnterSurface?: (surface: string, id: string) => void;
  motion?: 'enter' | 'exit';
}) {
  const { projectionStore, pendingIntents, wiring } = props.stores;
  const node = createMemo(() => projectionStore.genericNodes()?.nodes.find((n) => n.id === props.nodeId));
  const resolved = createMemo(() => {
    const n = node();
    return n ? resolveParts(n, wiring.config) : null;
  });
  // A double-click that began on a canvas node can END on this stage (it
  // slides over the point between the two clicks). Inside the gesture window
  // that is still the ③ entry; later double-clicks are content gestures.
  let openedAt = Date.now();
  createEffect(() => {
    void props.nodeId;
    openedAt = Date.now();
  });
  const onStageDblClick = () => {
    if (Date.now() - openedAt < 600 && node()) props.onEnterWork(node()!.id);
  };

  return (
    <Show when={node() && resolved()}>
      {(_) => {
        const v = () => ({ n: node()!, r: resolved()! });
        return (
          <aside class="node-stage" data-motion={props.motion ?? 'enter'} data-testid="node-stage" data-node={v().n.id} aria-label={`Node ${v().n.label ?? v().n.id}`} onDblClick={onStageDblClick}>
            {/* Keyed on the node: picking another node keeps the stage in place and crossfades its content. */}
            <Show when={props.nodeId} keyed>
              {(_key) => (
                <div class="panel-swap stage-swap">
                  <header class="stage-header">
                    <div class="stage-heading">
                      <h2 data-testid="node-stage-title">{v().n.label ?? v().n.id}</h2>
                      <p class="hint" data-testid="node-stage-state">
                        {v().n.kind} · {v().n.state.value}
                      </p>
                      <Show when={v().n.attention.length > 0}>
                        <p class="hint" data-testid="node-stage-attention">
                          attention: {v().n.attention.map((a) => a.cause).join(', ')}
                        </p>
                      </Show>
                    </div>
                    <button class="stage-enter" data-testid="stage-enter" onClick={() => props.onEnterWork(v().n.id)}>
                      들어가기 ↵
                    </button>
                    <button data-testid="node-stage-close" aria-label="Close" onClick={props.onClose}>
                      ✕
                    </button>
                  </header>
                  <div class="stage-body">
                    <For each={v().r.display}>
                      {(d) =>
                        d.part === 'label' ? (
                          <p class="generic-label">{d.text}</p>
                        ) : d.part === 'viewer' && d.artifactId ? (
                          <ArtifactViewer
                            artifactId={d.artifactId}
                            artifact={v().n.artifacts.find((x) => x.id === d.artifactId)}
                            snapshotBase64={projectionStore.projection().artifactSnapshots?.[d.artifactId]}
                            config={wiring.config}
                            testIdPrefix="generic-viewer"
                          />
                        ) : d.part === 'stream' && d.streamId ? (
                          <p class="hint">stream {d.streamId}</p>
                        ) : null
                      }
                    </For>
                    <DetailSection stores={props.stores} nodeId={v().n.id} />
                    <DomainQuickSection nodeId={v().n.id} />
                    <PersonalNoteSection personal={props.stores.personal} nodeId={v().n.id} />
                    <NodeActions stores={props.stores} node={v().n} resolved={v().r} />
                  </div>
                  <footer class="stage-foot hint">Enter 들어가기 · Esc 닫기</footer>
                </div>
              )}
            </Show>
          </aside>
        );
      }}
    </Show>
  );

  /**
   * S-01 transitional: the stage also carries what the Quick Card used to —
   * surface entries and the fake domain path's quick affordances. Domain
   * fields here are received verbatim (B4); this section retires with the
   * domain projection.
   */
  function DomainQuickSection(q: { nodeId: string }) {
    const p = () => projectionStore.projection();
    const task = () => p().tasks.find((t) => t.id === q.nodeId);
    const gate = () => p().gates.find((g) => g.id === q.nodeId);
    const deliverable = () => p().deliverables.find((d) => d.id === q.nodeId);
    const aff = (action: 'pause' | 'resume' | 'cancel') =>
      writeAffordance(taskCapabilities(p(), q.nodeId)[action]);
    return (
      <>
        <Show when={task()}>
          {(t) => (
            <>
              <p class="state" data-testid="sel-state">{t().state}</p>
              <Show when={t().currentAction}><p class="hint">{t().currentAction}</p></Show>
              <Show when={t().blockedReason}>
                <p class="blocked-reason" data-testid="blocked-reason">{t().blockedReason}</p>
              </Show>
              <div class="actions">
                <button data-testid="enter-inspector" onClick={() => props.onEnterSurface?.('inspector', t().id)}>
                  Inspector →
                </button>
                <Show when={t().state === 'running' && aff('pause') !== 'hidden'}>
                  <button data-testid="pause-task" disabled={aff('pause') !== 'enabled'}
                    onClick={() => void pendingIntents.submit({ nodeId: t().id, action: 'task.pause' })}>
                    Pause
                  </button>
                </Show>
                <Show when={(t().state === 'queued' || t().state === 'paused') && aff('resume') !== 'hidden'}>
                  <button data-testid="resume-task" disabled={aff('resume') !== 'enabled'}
                    onClick={() => void pendingIntents.submit({ nodeId: t().id, action: 'task.resume' })}>
                    Resume
                  </button>
                </Show>
                <Show when={aff('cancel') !== 'hidden'}>
                  <button data-testid="cancel-task" class="privileged" disabled={aff('cancel') !== 'enabled'}
                    onClick={() => props.onEnterSurface?.('privileged:cancel', t().id)}>
                    Cancel…
                  </button>
                </Show>
              </div>
            </>
          )}
        </Show>
        <Show when={gate()}>
          {(g) => (
            <>
              <Show when={g().requestedAction}><p class="hint">{g().requestedAction}</p></Show>
              <div class="actions">
                <button data-testid="enter-approval" onClick={() => props.onEnterSurface?.('approval', g().id)}>
                  Open gate →
                </button>
              </div>
            </>
          )}
        </Show>
        <Show when={deliverable()}>
          {(d) => (
            <div class="actions">
              <button data-testid="enter-deliverable" onClick={() => props.onEnterSurface?.('deliverable', d().id)}>
                Open deliverable →
              </button>
            </div>
          )}
        </Show>
      </>
    );
  }
}
