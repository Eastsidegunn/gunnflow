/**
 * Shared node machinery: the on-demand detail section and the assembly ×
 * capabilities action area. One implementation serves the ② stage, the ③
 * assembly fallback and the decision inbox — the invariants (claim grading,
 * digest/evidence binding, pending lifecycle) live here once.
 */
import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js';
import type { NodeProjection } from '@gunnflow/contract';
import { detailEmphasis } from '@gunnflow/contract/wiring';
import type { WorkspaceStores } from '../state/stores.js';
import type { Intent } from '../model/types.js';
import type { ResolvedAction, ResolvedParts } from '../canvas/parts.js';
import { actionGate } from '../state/genericActions.js';
import type { DisplayToken } from '../state/editorLogic.js';
import { isUndecided, type ComposingEntry, type Draft } from '../state/pendingIntents.js';
import { isSessionIntent } from '../model/types.js';
import { EvidenceView } from './EvidenceView.jsx';
import { ArtifactViewer } from './ArtifactViewer.jsx';
import { FakeEditorPart } from './FakeEditorPart.jsx';
import { fetchNodeDetail, type NodeDetailView } from '../state/nodeDetail.js';

function addresses(draft: Draft, node: NodeProjection, action: string): boolean {
  return !isUndecided(draft) && !isSessionIntent(draft) && draft.action === action && draft.nodeId === node.id;
}

/**
 * On-demand detail: fetched when a surface opens on a node (one fetch per
 * nodeId). Received values render untouched (M-17): 404 omits the section
 * silently; 501 is an explicit one-line "not served" (invariant 2). Items
 * whose label the wiring lists under detail.emphasis are visually emphasized
 * — a config match on the verbatim label, never an engine reading.
 */
export function DetailSection(props: { stores: WorkspaceStores; nodeId: string }) {
  const { projectionStore, wiring } = props.stores;
  const [view] = createResource(() => props.nodeId, fetchNodeDetail);
  const when = <K extends NodeDetailView['kind']>(kind: K) => {
    const v = view.loading ? undefined : view();
    return v?.kind === kind ? (v as Extract<NodeDetailView, { kind: K }>) : undefined;
  };
  const emphasized = (label: string) => detailEmphasis(wiring.config).includes(label);
  return (
    <>
      <Show when={view.loading}>
        <p class="hint" data-testid="node-detail-loading">loading details…</p>
      </Show>
      <Show when={when('unsupported')}>
        <p class="hint" data-testid="node-detail-unsupported">details: not served by this backend</p>
      </Show>
      <Show when={when('unavailable')}>
        {(u) => <p class="hint" data-testid="node-detail-unavailable">details unavailable — {u().reason}</p>}
      </Show>
      <Show when={when('items')}>
        {(d) => (
          <section class="node-detail" data-testid="node-detail-section">
            <h3>
              Details <span class="hint">· as of revision {d().detail.revision}</span>
            </h3>
            <For each={d().detail.items}>
              {(item, i) => (
                // The whole item — label included — is upstream vocabulary: claim grade.
                <div
                  class="node-detail-item"
                  data-grade="claim"
                  data-emphasis={emphasized(item.label) ? 'config' : undefined}
                  data-testid={`node-detail-item-${i()}`}
                >
                  <span class="field-label">{item.label}</span>
                  {item.text !== undefined ? (
                    // Plain glyphs only, no escape interpretation.
                    <pre class="detail-text">{item.text}</pre>
                  ) : item.artifact ? (
                    <ArtifactViewer
                      artifactId={item.artifact.id}
                      artifact={item.artifact}
                      snapshotBase64={projectionStore.projection().artifactSnapshots?.[item.artifact.id]}
                      config={wiring.config}
                      testIdPrefix="node-detail-viewer"
                    />
                  ) : null}
                </div>
              )}
            </For>
          </section>
        )}
      </Show>
    </>
  );
}

/**
 * The node's actions (assembly × capabilities), interactive. Inputs live in
 * composing entries; sends go through the pending store's single send
 * transition and the guarded relay. Evidence is bound by artifact id and the
 * attestation states exactly the renders made here.
 */
export function NodeActions(props: {
  stores: WorkspaceStores;
  node: NodeProjection;
  resolved: ResolvedParts;
  /** Open evidence viewers at once (the evidence is part of the surface). */
  autoOpenEvidence?: boolean;
  /** Called when a send left this surface (the pending machinery owns the rest). */
  onSent?: () => void;
}) {
  const { projectionStore, pendingIntents } = props.stores;
  // Keyed by action name so controls (and their evidence views) survive projection updates.
  const actionNames = createMemo(() => props.resolved.actions.map((a) => a.action), [], {
    equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  });
  /** Evidence renders on this surface, by artifact id. */
  const [views, setViews] = createSignal<ReadonlyMap<string, DisplayToken>>(new Map());

  return (
    <Show when={actionNames().length > 0} fallback={<p class="hint">No actions declared by upstream.</p>}>
      <div class="generic-actions">
        <For each={actionNames()}>
          {(name) => (
            <Show when={props.resolved.actions.find((a) => a.action === name)}>
              {(a) => <ActionControl node={props.node} action={a()} />}
            </Show>
          )}
        </For>
      </div>
    </Show>
  );

  function ActionControl(p: { node: NodeProjection; action: ResolvedAction }) {
    const a = () => p.action;
    const hasEditor = (() => { const x = a(); return x.kind === 'assembled' && x.inputs.some((i) => i.part === 'editor'); })();
    if (hasEditor) {
      // Edit is the editor part's own flow (base display, digest, attestation), shown where the capability declares an edit slot.
      const edit = () => p.node.capabilities.find((c) => c.action === a().action)?.edit;
      return <Show when={edit()}>{<FakeEditorPart stores={props.stores} taskId={p.node.id} />}</Show>;
    }
    const cap = () => p.node.capabilities.find((c) => c.action === a().action);
    const composing = () =>
      pendingIntents.composing().find((e): e is ComposingEntry => addresses(e.draft, p.node, a().action));
    const inFlight = () => pendingIntents.inFlight().some((e) => addresses(e.intent, p.node, a().action));
    const decision = () => {
      const d = composing()?.draft;
      return d && !isUndecided(d) && !isSessionIntent(d) ? (d.decision ?? {}) : {};
    };
    const evidence = () => a().evidence;
    const inputs = () => { const x = a(); return x.kind === 'assembled' ? x.inputs : []; };
    const hasText = () => inputs().some((i) => i.part === 'text');
    const hasChoice = () => inputs().some((i) => i.part === 'selector');

    const setDecision = (patch: { option?: string; text?: string }) => {
      const next = { ...decision(), ...patch };
      const draft = { nodeId: p.node.id, action: a().action, decision: next };
      const current = composing();
      if (current) pendingIntents.update(current.localId, draft);
      else pendingIntents.compose(draft);
    };
    const preconditions = () => {
      if (a().kind !== 'assembled') return true;
      const d = decision();
      const requiredText = cap()?.decision?.input?.required === true;
      if (hasText() && requiredText && !d.text?.trim()) return false;
      if (hasChoice() && !d.option) return false;
      return evidence().every((id) => views().has(id));
    };
    const gate = () => actionGate(a(), preconditions());

    const send = () => {
      const d = decision();
      const slots: Pick<Intent, 'decision'> = Object.keys(d).length > 0 ? { decision: d } : {};
      const draft = { nodeId: p.node.id, action: a().action, ...slots };
      // Only the display tokens travel; the store re-reads what is required from the current capability.
      const ev = evidence().length > 0 ? { displays: [...views().values()] } : undefined;
      const current = composing();
      if (current) {
        pendingIntents.update(current.localId, draft);
        if (ev) pendingIntents.setEvidence(current.localId, ev);
        void pendingIntents.send(current.localId);
      } else {
        void pendingIntents.send(pendingIntents.compose(draft, undefined, ev));
      }
      props.onSent?.();
    };

    return (
      <div class="generic-action" data-testid={`generic-action-${a().action}`} data-kind={a().kind}>
        <Show when={evidence().length > 0}>
          <For each={evidence()}>
            {(id) => (
              <EvidenceView
                artifactId={id}
                artifact={p.node.artifacts.find((x) => x.id === id)}
                snapshotBase64={projectionStore.projection().artifactSnapshots?.[id]}
                config={props.stores.wiring.config}
                viewed={views().has(id)}
                onViewed={(token) => setViews((m) => new Map([...m, [id, token]]))}
                autoOpen={props.autoOpenEvidence}
                testIdPrefix="generic-evidence"
              />
            )}
          </For>
        </Show>
        <Show when={hasChoice() && cap()?.decision?.options}>
          {(options) => (
            <select
              data-testid={`generic-choice-${a().action}`}
              value={decision().option ?? ''}
              onChange={(e) => setDecision({ option: e.currentTarget.value || undefined })}
            >
              <option value="">choose…</option>
              <For each={options()}>{(o) => <option value={o}>{o}</option>}</For>
            </select>
          )}
        </Show>
        <Show when={hasText()}>
          <label class="field-label" for={`text-${a().action}`}>
            {a().action}{cap()?.decision?.input?.required ? ' (required)' : ''}
          </label>
          <input
            id={`text-${a().action}`}
            data-testid={`generic-text-${a().action}`}
            placeholder={cap()?.decision?.input?.required ? 'required' : 'optional'}
            value={decision().text ?? ''}
            onInput={(e) => setDecision({ text: e.currentTarget.value })}
          />
        </Show>
        <button
          data-testid={`generic-send-${a().action}`}
          disabled={!gate().runnable || inFlight()}
          aria-describedby={!gate().runnable ? `reason-${a().action}` : undefined}
          title={gate().runnable ? a().action : (gate() as { reason: string }).reason}
          onClick={() => {
            if (a().kind === 'fallback') {
              void pendingIntents.submit({ nodeId: p.node.id, action: a().action });
              props.onSent?.();
            } else {
              send();
            }
          }}
        >
          {a().action}
        </button>
        <Show when={evidence().length > 0}>
          <span class="hint" data-testid={`evidence-count-${a().action}`}>
            Evidence viewed {evidence().filter((id) => views().has(id)).length}/{evidence().length}
          </span>
        </Show>
        <Show when={!gate().runnable && (gate() as { reason: string }).reason !== 'read-only — switch to Intervene'}>
          <span class="hint" data-testid={`generic-reason-${a().action}`} id={`reason-${a().action}`}>
            {(gate() as { reason: string }).reason}
          </span>
        </Show>
        <SendReceipt />
      </div>
    );

    /**
     * N-05: the receipt lives at the button. "Confirmed" appears only after
     * the projection reflected the intent (the in-flight entry left without
     * an error); a refusal shows the upstream reason with Restore/Discard
     * inline — the person's input is never destroyed.
     */
    function SendReceipt() {
      const errFor = () =>
        pendingIntents.errors().find((e) => e.nodeId === p.node.id && e.action === a().action);
      const [confirmedAt, setConfirmedAt] = createSignal<number | null>(null);
      let wasInFlight = false;
      createEffect(() => {
        const f = inFlight();
        if (wasInFlight && !f && !errFor()) {
          setConfirmedAt(Date.now());
          setTimeout(() => setConfirmedAt(null), 1500);
        }
        wasInFlight = f;
      });
      return (
        <>
          <Show when={inFlight()}>
            <span class="send-receipt" data-state="sending" data-testid={`receipt-${a().action}`}>Sending…</span>
          </Show>
          <Show when={!inFlight() && errFor()}>
            {(err) => (
              <span class="send-receipt" data-state="failed" data-testid={`receipt-${a().action}`}>
                Not confirmed — {err().reason ?? 'no reason given'}{' '}
                <Show when={err().kind !== 'invalid'}>
                  <button class="linklike" data-testid={`receipt-restore-${a().action}`} onClick={() => pendingIntents.reopen(err().localId)}>
                    Restore
                  </button>
                </Show>{' '}
                <Show when={err().kind === 'rejected'}>
                  <button class="linklike" data-testid={`receipt-discard-${a().action}`} onClick={() => pendingIntents.discard(err().localId)}>
                    Discard
                  </button>
                </Show>
              </span>
            )}
          </Show>
          <Show when={!inFlight() && !errFor() && confirmedAt()}>
            <span class="send-receipt" data-state="confirmed" data-testid={`receipt-${a().action}`}>Confirmed</span>
          </Show>
        </>
      );
    }
  }
}
