/**
 * Human Gate / Approval surface (Screen #5). Not a confirmation modal: it must
 * let the operator understand → inspect evidence → decide → see the intent
 * recorded — and it never mutates state itself. Approve/Reject/Request-changes
 * are attributed human intents relayed upstream; approval and effect outcome
 * stay separate facts.
 */
import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { manageFocus } from './focusScope.js';
import type { WorkspaceStores } from '../state/stores.js';
import type { GateProjection } from '../model/types.js';
import {
  gateById,
  gateEffects,
  gateRelations,
  missionName,
} from '../model/selectors.js';
import {
  decideGate,
  gateDecisionAffordances,
  gateReason,
  gateSurfaceForm,
  hasPendingGateDecision,
  setGateReason,
} from '../state/gateLogic.js';
import { elapsedLabel } from '../canvas/displayModel.js';
import { pageIsolationProblem, previewUrl } from '../transport/previewOrigin.js';
import { EvidenceView } from './EvidenceView.jsx';
import type { DisplayToken } from '../state/editorLogic.js';

export function HumanGateSurface(props: {
  stores: WorkspaceStores;
  gateId: string;
  onClose: () => void;
  onOpenGate: (gateId: string) => void;
  onOpenTask: (taskId: string) => void;
  motion?: 'enter' | 'exit';
}) {
  const { projectionStore, pendingIntents, wiring } = props.stores;
  const projection = () => projectionStore.projection();
  const gate = createMemo(() => gateById(projection(), props.gateId));

  return (
    <Show when={gate()}>
      {(g) => {
        const form = gateSurfaceForm(g());
        const body = (
          <GateBody
            stores={props.stores}
            gate={g()}
            onClose={props.onClose}
            onOpenGate={props.onOpenGate}
            onOpenTask={props.onOpenTask}
          />
        );
        return form === 'overlay' ? (
          <div class="modal-backdrop" data-motion={props.motion ?? 'enter'} onClick={props.onClose}>
            <div
              class="gate-surface overlay"
              data-motion={props.motion ?? 'enter'}
              ref={(el) => onCleanup(manageFocus(el, { trap: true }))}
              data-testid="gate-surface"
              data-form="overlay"
              role="dialog"
              aria-label={g().name}
              onClick={(e) => e.stopPropagation()}
            >
              {body}
            </div>
          </div>
        ) : (
          <aside class="gate-surface panel" data-motion={props.motion ?? 'enter'} data-testid="gate-surface" data-form="panel" aria-label={g().name} ref={(el) => onCleanup(manageFocus(el))}>
            {body}
          </aside>
        );
      }}
    </Show>
  );

  function GateBody(p: {
    stores: WorkspaceStores;
    gate: GateProjection;
    onClose: () => void;
    onOpenGate: (gateId: string) => void;
    onOpenTask: (taskId: string) => void;
  }) {
    const g = () => p.gate;
    const relations = createMemo(() => gateRelations(projection(), g().id));
    const effects = createMemo(() => gateEffects(projection(), g().id));
    const affordances = createMemo(() =>
      gateDecisionAffordances(
        projection(),
        g(),
        projectionStore.connection(),
        pendingIntents.inFlight(),
      ),
    );
    const pendingDecision = () => hasPendingGateDecision(pendingIntents.inFlight(), g().id);
    const stale = () => projectionStore.connection() !== 'live';
    const privileged = () => g().riskTier === 'privileged';
    // The decision reason is an undecided composing entry: it survives a refusal and returns with Restore.
    const reason = () => gateReason(pendingIntents, g().id);
    const setReason = (text: string) => setGateReason(pendingIntents, g().id, text);
    // Evidence the approval is conditioned on (the gate's capability, by artifact id), rendered here.
    const evidenceIds = createMemo(
      () =>
        projectionStore
          .genericNodes()
          ?.nodes.find((n) => n.id === g().id)
          ?.capabilities.find((c) => c.action === 'gate.approve')?.decision?.evidence ?? [],
    );
    const evidenceArtifact = (id: string) =>
      projectionStore.genericNodes()?.nodes.find((n) => n.id === g().id)?.artifacts.find((a) => a.id === id);
    const [evidenceViews, setEvidenceViews] = createSignal<ReadonlyMap<string, DisplayToken>>(new Map());
    const decide = (kind: 'gate.approve' | 'gate.reject') =>
      void decideGate(pendingIntents, g().id, kind, kind === 'gate.approve' ? [...evidenceViews().values()] : []);
    const [confirming, setConfirming] = createSignal(false);
    const [changesOpen, setChangesOpen] = createSignal(false);
    const [instruction, setInstruction] = createSignal('');

    const submitApprove = () => {
      decide('gate.approve');
      setConfirming(false);
    };

    return (
      <>
        <header class="gate-header">
          <div>
            <p class="breadcrumb">
              {missionName(projection(), g().missionId) ?? g().missionId}
              <For each={relations().tasks}>
                {(t) => (
                  <>
                    {' / '}
                    <button class="crumb-link" onClick={() => p.onOpenTask(t.id)}>
                      {t.name}
                    </button>
                  </>
                )}
              </For>
            </p>
            <h2 data-testid="gate-title">◆ {g().name}</h2>
            <p class="gate-state-line" data-testid="gate-state" data-state={g().state}>
              {g().state.toUpperCase()}
              <Show when={g().urgency === 'high'}>
                <span class="urgency">urgent</span>
              </Show>
              <Show when={privileged()}>
                <span class="risk-badge" data-testid="gate-risk">privileged</span>
              </Show>
            </p>
          </div>
          <button data-testid="gate-close" aria-label="Close gate" onClick={p.onClose}>✕</button>
        </header>

        <Show when={stale()}>
          <p class="gate-banner stale-banner" data-testid="gate-stale">
            Stale · showing state from{' '}
            {projectionStore.lastSeenAt()
              ? new Date(projectionStore.lastSeenAt()!).toLocaleTimeString()
              : 'unknown'}
            . Reconnect before approving — the outcome of any decision would not be confirmed.
          </p>
        </Show>

        <Show when={g().state === 'superseded' || g().state === 'expired' || g().state === 'canceled'}>
          <div class="gate-banner inactive-banner" data-testid="gate-inactive">
            <p>This request is no longer active.</p>
            <Show when={g().supersededBy}>
              <button data-testid="open-latest-gate" onClick={() => p.onOpenGate(g().supersededBy!)}>
                Open latest request →
              </button>
            </Show>
          </div>
        </Show>

        <div class="gate-body">
          <section>
            <h3>What is being requested</h3>
            <p data-testid="gate-requested-action">{g().requestedAction}</p>
            <dl class="gate-facts">
              <Show when={g().request?.target}>
                <dt>Target</dt>
                <dd>{g().request!.target}</dd>
              </Show>
              <Show when={g().request?.destination}>
                <dt>Destination</dt>
                <dd data-testid="gate-destination">{g().request!.destination}</dd>
              </Show>
              <Show when={g().request?.scope}>
                <dt>Scope</dt>
                <dd>{g().request!.scope}</dd>
              </Show>
              <Show when={g().request?.requestedBy}>
                <dt>Requested by</dt>
                <dd data-testid="gate-requested-by">{g().request!.requestedBy}</dd>
              </Show>
              <Show when={g().request?.requestedAt}>
                <dt>Waiting</dt>
                <dd>{elapsedLabel(g().request!.requestedAt, undefined, Date.now())}</dd>
              </Show>
            </dl>
          </section>

          <Show when={g().request?.reason}>
            <section>
              <h3>Why this needs you</h3>
              <p data-testid="gate-reason">{g().request!.reason}</p>
            </section>
          </Show>

          <Show when={g().request?.impact}>
            <section>
              <h3>Impact</h3>
              <p data-testid="gate-impact">
                {g().request!.impact}
                <Show when={g().request?.externalEffect}>
                  <span class="external-marker"> · external effect</span>
                </Show>
              </p>
            </section>
          </Show>

          <Show when={evidenceIds().length > 0}>
            <section data-testid="gate-attested-evidence">
              <h3>Evidence</h3>
              <For each={evidenceIds()}>
                {(id) => (
                  <EvidenceView
                    artifactId={id}
                    artifact={evidenceArtifact(id)}
                    snapshotBase64={projectionStore.projection().artifactSnapshots?.[id]}
                    config={wiring.config}
                    viewed={evidenceViews().has(id)}
                    onViewed={(t) => setEvidenceViews((m) => new Map([...m, [id, t]]))}
                    autoOpen
                    testIdPrefix="gate-evidence-artifact"
                  />
                )}
              </For>
            </section>
          </Show>

          <Show when={relations().deliverable}>
            {(d) => (
              <section data-testid="gate-evidence">
                <h3>Preview</h3>
                {/* Evidence lives inside the decision context (brief §9); the
                    content itself loads ONLY from the isolated preview origin,
                    sandboxed (charter §25 / acceptance H). */}
                <Show
                  when={!pageIsolationProblem()}
                  fallback={<p class="hint" data-testid="gate-preview-refused">Preview refused — {pageIsolationProblem()}</p>}
                >
                  <iframe
                    data-testid="gate-preview-frame"
                    src={previewUrl(d().id)}
                    sandbox=""
                    title={`Preview of ${d().title}`}
                  />
                </Show>
                <p class="hint">▤ {d().title}{d().state ? ` · ${d().state}` : ''} · isolated origin</p>
              </section>
            )}
          </Show>

          <Show when={g().policy}>
            <section data-testid="gate-policy">
              <h3>Policy context</h3>
              <Show when={g().policy?.policyLabel}>
                <p>{g().policy!.policyLabel}</p>
              </Show>
              <dl class="gate-facts">
                <Show when={g().policy?.requiredAuthority}>
                  <dt>Requires</dt>
                  <dd>{g().policy!.requiredAuthority}</dd>
                </Show>
                <Show when={g().policy?.credentialLabel}>
                  {/* Credential METADATA only — no reveal/copy affordance exists. */}
                  <dt>Credential</dt>
                  <dd data-testid="gate-credential">
                    {g().policy!.credentialLabel}
                    <Show when={g().policy?.credentialScope}> · {g().policy!.credentialScope}</Show>
                    <Show when={g().policy?.credentialExpiresIn}>
                      {' '}· expires {g().policy!.credentialExpiresIn}
                    </Show>
                  </dd>
                </Show>
              </dl>
            </section>
          </Show>

          <Show when={g().decision}>
            <section data-testid="gate-decision">
              <h3>Approval</h3>
              <p>
                {g().decision!.choice} by {g().decision!.by} ·{' '}
                {new Date(g().decision!.at).toLocaleTimeString()}
              </p>
              <Show when={g().decision!.reason}>
                <p class="hint">Reason: {g().decision!.reason}</p>
              </Show>
            </section>
          </Show>

          <Show when={effects().length > 0}>
            <section data-testid="gate-effects">
              <h3>Effect</h3>
              <For each={effects()}>
                {(e) => (
                  <p data-testid={`effect-${e.state}`}>
                    {e.label} · <strong>{e.state}</strong>
                    <Show when={e.detail}>
                      <span class="hint"> — {e.detail}</span>
                    </Show>
                  </p>
                )}
              </For>
            </section>
          </Show>

          <Show when={gateActiveForActions()}>
            <section class="gate-actions-area">
              <p class="audit-notice" data-testid="audit-notice">
                Your decision will be recorded in the audit chain.
              </p>
              <Show when={affordances().disabledReason && affordances().approve === 'disabled'}>
                <p class="hint" data-testid="gate-disabled-reason">{affordances().disabledReason}</p>
              </Show>
              <Show when={pendingDecision()}>
                <p class="pending-chip" data-testid="gate-pending">Submitting decision…</p>
              </Show>

              <div class="actions gate-actions">
                <Show when={affordances().reject !== 'hidden'}>
                  <button
                    data-testid="gate-reject"
                    disabled={affordances().reject !== 'enabled'}
                    onClick={() => decide('gate.reject')}
                  >
                    Reject
                  </button>
                </Show>
                <Show when={affordances().requestChanges !== 'hidden'}>
                  <button
                    data-testid="gate-request-changes"
                    disabled={affordances().requestChanges !== 'enabled'}
                    onClick={() => setChangesOpen(!changesOpen())}
                  >
                    Request changes
                  </button>
                </Show>
                <Show when={affordances().approve !== 'hidden'}>
                  <Show
                    when={privileged()}
                    fallback={
                      <button
                        class="approve"
                        data-testid="gate-approve"
                        disabled={affordances().approve !== 'enabled'}
                        onClick={submitApprove}
                      >
                        Approve
                      </button>
                    }
                  >
                    <button
                      class="approve privileged-approve"
                      data-testid="gate-approve"
                      disabled={affordances().approve !== 'enabled'}
                      onClick={() => setConfirming(true)}
                    >
                      Approve…
                    </button>
                  </Show>
                </Show>
              </div>

              {/* 🔴 friction: impact + reason (when upstream requires) + confirm. */}
              <Show when={confirming()}>
                <div class="privileged-confirm" data-testid="privileged-confirm">
                  <p>{g().request?.impact ?? 'This is a privileged action.'}</p>
                  <Show when={g().reasonRequired}>
                    <label for="gate-reason">Reason (required)</label>
                  </Show>
                  <Show when={g().reasonRequired}>
                    <input
                      id="gate-reason"
                      data-testid="gate-reason-input"
                      placeholder="Why are you approving this?"
                      value={reason()}
                      onInput={(e) => setReason(e.currentTarget.value)}
                    />
                  </Show>
                  <div class="actions">
                    <button data-testid="confirm-cancel" onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                    <button
                      class="approve"
                      data-testid="confirm-approve"
                      disabled={Boolean(g().reasonRequired) && !reason().trim()}
                      onClick={submitApprove}
                    >
                      Confirm approval
                    </button>
                  </div>
                </div>
              </Show>

              <Show when={changesOpen()}>
                <form
                  class="instruct"
                  data-testid="gate-changes-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = instruction().trim();
                    if (!text) return;
                    void pendingIntents.submit({ nodeId: g().id, action: 'gate.requestChanges', decision: { text } });
                    setInstruction('');
                    setChangesOpen(false);
                  }}
                >
                  <textarea
                    data-testid="gate-changes-input"
                    rows="2"
                    placeholder="What should change before this can be approved?"
                    value={instruction()}
                    onInput={(e) => setInstruction(e.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    data-testid="gate-changes-send"
                    disabled={affordances().requestChanges !== 'enabled' || !instruction().trim()}
                  >
                    Send
                  </button>
                </form>
              </Show>
            </section>
          </Show>
        </div>
      </>
    );

    function gateActiveForActions(): boolean {
      // Decided/inactive gates show their record instead of action buttons.
      return g().state === 'waiting';
    }
  }
}
