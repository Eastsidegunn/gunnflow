/**
 * ③ Work surface frame (overview-to-work depth 3): the deep surface of ONE
 * node fills the body — no context strip (design review ②: the work
 * content owns the screen; return is Esc only, via the App's dismissal
 * ladder). The ONE floating element is the decision-inbox queue chip (design decision ④:
 * 결정함 대기열이 ③에 동반된다), shown only when a queue was carried in:
 * 대기열 i/n with prev/next over that queue, auto-advancing on the decided
 * fact. Nothing else overlays the work content.
 */
import { For, Show, createEffect, createMemo, type JSX } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import { queueIndexOf } from '../state/depth.js';
import { advanceInQueue } from '../state/decisionInbox.js';
import { ArtifactViewer } from './ArtifactViewer.jsx';
import { DetailSection, NodeActions } from './nodeParts.jsx';
import { resolveParts } from '../canvas/parts.js';

export function WorkSurface(props: {
  stores: WorkspaceStores;
  /** The node the queue machinery anchors on; null when the surface is not node-addressed (live terminal). */
  nodeId: string | null;
  /** Decision-inbox queue carried into ③ (node ids, pending order at entry). */
  queue?: readonly string[];
  onLateral: (nodeId: string) => void;
  children: JSX.Element;
}) {
  const { projectionStore } = props.stores;
  const nodes = () => projectionStore.genericNodes()?.nodes ?? [];
  const pendingSet = createMemo(() => new Set(nodes().filter((n) => n.attention.length > 0).map((n) => n.id)));
  const queueAt = createMemo(() => (props.nodeId ? queueIndexOf(props.queue, props.nodeId) : -1));

  // Queue mode: when the current item's attention clears (its decision became
  // a received fact), advance to the next still-pending queue item.
  let last: { id: string | null; pending: boolean } = { id: null, pending: false };
  createEffect(() => {
    const id = props.nodeId;
    const q = props.queue;
    const pending = id !== null && pendingSet().has(id);
    if (q && id && last.id === id && last.pending && !pending) {
      const next = advanceInQueue(q, id, pendingSet());
      if (next) props.onLateral(next);
    }
    last = { id, pending };
  });

  return (
    <section class="work-surface" data-testid="work-surface">
      <Show when={props.queue && queueAt() >= 0}>
        <span class="work-queue" data-testid="work-queue">
          대기열 {queueAt() + 1}/{props.queue!.length}
          <button
            data-testid="work-prev"
            disabled={queueAt() <= 0}
            onClick={() => props.onLateral(props.queue![queueAt() - 1]!)}
          >
            ◀
          </button>
          <button
            data-testid="work-next"
            disabled={queueAt() >= props.queue!.length - 1}
            onClick={() => props.onLateral(props.queue![queueAt() + 1]!)}
          >
            ▶
          </button>
        </span>
      </Show>
      <div class="work-body">{props.children}</div>
    </section>
  );
}

/**
 * ③ fallback for a kind with no deep surface: the node's ② assembly at full
 * width — honest, nothing invented beyond space.
 */
export function AssemblySurface(props: { stores: WorkspaceStores; nodeId: string }) {
  const { projectionStore, wiring } = props.stores;
  const node = createMemo(() => projectionStore.genericNodes()?.nodes.find((n) => n.id === props.nodeId));
  const resolved = createMemo(() => {
    const n = node();
    return n ? resolveParts(n, wiring.config) : null;
  });
  return (
    <Show when={node() && resolved()} fallback={<p class="hint">node not in the received projection</p>}>
      {(_) => {
        const v = () => ({ n: node()!, r: resolved()! });
        return (
          <div class="work-assembly" data-testid="work-assembly" data-node={v().n.id}>
            <h2>{v().n.label ?? v().n.id}</h2>
            <p class="hint">
              {v().n.kind} · {v().n.state.value}
            </p>
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
            <NodeActions stores={props.stores} node={v().n} resolved={v().r} />
          </div>
        );
      }}
    </Show>
  );
}
