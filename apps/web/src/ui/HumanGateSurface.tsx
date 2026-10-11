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
import { t } from '../i18n/index.js';

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
                {(task) => (
                  <>
                    {' / '}
                    <button class="crumb-link" onClick={() => p.onOpenTask(task.id)}>
                      {task.name}
                    </button>
                  </>
                )}
              </For>
            </p>
            <h2 data-testid="gate-title">◆ {g().name}</h2>
            <p class="gate-state-line" data-testid="gate-state" data-state={g().state}>
              {g().state.toUpperCase()}
              <Show when={g().urgency === 'high'}>
                <span class="urgency">{t('gate.urgent')}</span>
              </Show>
              <Show when={privileged()}>
                <span class="risk-badge" data-testid="gate-risk">{t('gate.privileged')}</span>
              </Show>
            </p>
          </div>
          <button data-testid="gate-close" aria-label={t('gate.close')} onClick={p.onClose}>✕</button>
        </header>

        <Show when={stale()}>
          <p class="gate-banner stale-banner" data-testid="gate-stale">
            {t('gate.stale', {
              time: projectionStore.lastSeenAt()
                ? new Date(projectionStore.lastSeenAt()!).toLocaleTimeString()
                : t('gate.staleUnknown'),
            })}
          </p>
        </Show>

        <Show when={g().state === 'superseded' || g().state === 'expired' || g().state === 'canceled'}>
          <div class="gate-banner inactive-banner" data-testid="gate-inactive">
            <p>{t('gate.inactive')}</p>
            <Show when={g().supersededBy}>
              <button data-testid="open-latest-gate" onClick={() => p.onOpenGate(g().supersededBy!)}>
                {t('gate.openLatest')}
              </button>
            </Show>
          </div>
        </Show>

        <div class="gate-body">
          <section>
            <h3>{t('gate.requested')}</h3>
            <p data-testid="gate-requested-action">{g().requestedAction}</p>
            <dl class="gate-facts">
              <Show when={g().request?.target}>
                <dt>{t('gate.target')}</dt>
                <dd>{g().request!.target}</dd>
              </Show>
              <Show when={g().request?.destination}>
                <dt>{t('gate.destination')}</dt>
                <dd data-testid="gate-destination">{g().request!.destination}</dd>
              </Show>
              <Show when={g().request?.scope}>
                <dt>{t('gate.scope')}</dt>
                <dd>{g().request!.scope}</dd>
              </Show>
              <Show when={g().request?.requestedBy}>
                <dt>{t('gate.requestedBy')}</dt>
                <dd data-testid="gate-requested-by">{g().request!.requestedBy}</dd>
              </Show>
              <Show when={g().request?.requestedAt}>
                <dt>{t('gate.waiting')}</dt>
                <dd>{elapsedLabel(g().request!.requestedAt, undefined, Date.now())}</dd>
              </Show>
            </dl>
          </section>

          <Show when={g().request?.reason}>
            <section>
              <h3>{t('gate.why')}</h3>
              <p data-testid="gate-reason">{g().request!.reason}</p>
            </section>
          </Show>

          <Show when={g().request?.impact}>
            <section>
              <h3>{t('gate.impact')}</h3>
              <p data-testid="gate-impact">
                {g().request!.impact}
                <Show when={g().request?.externalEffect}>
                  <span class="external-marker"> · {t('gate.externalEffect')}</span>
                </Show>
              </p>
            </section>
          </Show>

          <Show when={evidenceIds().length > 0}>
            <section data-testid="gate-attested-evidence">
              <h3>{t('gate.evidence')}</h3>
              <For each={evidenceIds()}>
                {(id) => (
                  <EvidenceView
                    artifactId={id}
                    artifact={evidenceArtifact(id)}
                    snapshotBase64={projectionStore.projection().artifactSnapshots?.[id]}
                    config={wiring.config}
                    viewed={evidenceViews().has(id)}
                    onViewed={(token) => setEvidenceViews((m) => new Map([...m, [id, token]]))}
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
                <h3>{t('gate.preview')}</h3>
                {/* Evidence lives inside the decision context (brief §9); the
                    content itself loads ONLY from the isolated preview origin,
                    sandboxed (charter §25 / acceptance H). */}
                <Show
                  when={!pageIsolationProblem()}
                  fallback={<p class="hint" data-testid="gate-preview-refused">{t('gate.previewRefused', { reason: pageIsolationProblem() ?? '' })}</p>}
                >
                  <iframe
                    data-testid="gate-preview-frame"
                    src={previewUrl(d().id)}
                    sandbox=""
                    title={t('gate.previewOf', { title: d().title })}
                  />
                </Show>
                <p class="hint">▤ {d().title}{d().state ? ` · ${d().state}` : ''} · {t('gate.isolatedOrigin')}</p>
              </section>
            )}
          </Show>

          <Show when={g().policy}>
            <section data-testid="gate-policy">
              <h3>{t('gate.policy')}</h3>
              <Show when={g().policy?.policyLabel}>
                <p>{g().policy!.policyLabel}</p>
              </Show>
              <dl class="gate-facts">
                <Show when={g().policy?.requiredAuthority}>
                  <dt>{t('gate.requires')}</dt>
                  <dd>{g().policy!.requiredAuthority}</dd>
                </Show>
                <Show when={g().policy?.credentialLabel}>
                  {/* Credential METADATA only — no reveal/copy affordance exists. */}
                  <dt>{t('gate.credential')}</dt>
                  <dd data-testid="gate-credential">
                    {g().policy!.credentialLabel}
                    <Show when={g().policy?.credentialScope}> · {g().policy!.credentialScope}</Show>
                    <Show when={g().policy?.credentialExpiresIn}>
                      {' '}· {t('gate.expires', { in: g().policy!.credentialExpiresIn! })}
                    </Show>
                  </dd>
                </Show>
              </dl>
            </section>
          </Show>

          <Show when={g().decision}>
            <section data-testid="gate-decision">
              <h3>{t('gate.approval')}</h3>
              <p>
                {t('gate.decidedBy', {
                  choice: g().decision!.choice,
                  by: g().decision!.by,
                  time: new Date(g().decision!.at).toLocaleTimeString(),
                })}
              </p>
              <Show when={g().decision!.reason}>
                <p class="hint">{t('gate.decisionReason', { reason: g().decision!.reason! })}</p>
              </Show>
            </section>
          </Show>

          <Show when={effects().length > 0}>
            <section data-testid="gate-effects">
              <h3>{t('gate.effect')}</h3>
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
                {t('gate.auditNotice')}
              </p>
              <Show when={affordances().disabledReason && affordances().approve === 'disabled'}>
                <p class="hint" data-testid="gate-disabled-reason">{affordances().disabledReason}</p>
              </Show>
              <Show when={pendingDecision()}>
                <p class="pending-chip" data-testid="gate-pending">{t('gate.submitting')}</p>
              </Show>

              <div class="actions gate-actions">
                <Show when={affordances().reject !== 'hidden'}>
                  <button
                    data-testid="gate-reject"
                    disabled={affordances().reject !== 'enabled'}
                    onClick={() => decide('gate.reject')}
                  >
                    {t('gate.reject')}
                  </button>
                </Show>
                <Show when={affordances().requestChanges !== 'hidden'}>
                  <button
                    data-testid="gate-request-changes"
                    disabled={affordances().requestChanges !== 'enabled'}
                    onClick={() => setChangesOpen(!changesOpen())}
                  >
                    {t('gate.requestChanges')}
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
                        {t('gate.approve')}
                      </button>
                    }
                  >
                    <button
                      class="approve privileged-approve"
                      data-testid="gate-approve"
                      disabled={affordances().approve !== 'enabled'}
                      onClick={() => setConfirming(true)}
                    >
                      {t('gate.approveEllipsis')}
                    </button>
                  </Show>
                </Show>
              </div>

              {/* 🔴 friction: impact + reason (when upstream requires) + confirm. */}
              <Show when={confirming()}>
                <div class="privileged-confirm" data-testid="privileged-confirm">
                  <p>{g().request?.impact ?? t('gate.privilegedAction')}</p>
                  <Show when={g().reasonRequired}>
                    <label for="gate-reason">{t('gate.reasonRequired')}</label>
                  </Show>
                  <Show when={g().reasonRequired}>
                    <input
                      id="gate-reason"
                      data-testid="gate-reason-input"
                      placeholder={t('gate.reasonPlaceholder')}
                      value={reason()}
                      onInput={(e) => setReason(e.currentTarget.value)}
                    />
                  </Show>
                  <div class="actions">
                    <button data-testid="confirm-cancel" onClick={() => setConfirming(false)}>
                      {t('gate.cancel')}
                    </button>
                    <button
                      class="approve"
                      data-testid="confirm-approve"
                      disabled={Boolean(g().reasonRequired) && !reason().trim()}
                      onClick={submitApprove}
                    >
                      {t('gate.confirmApproval')}
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
                    placeholder={t('gate.changesPlaceholder')}
                    value={instruction()}
                    onInput={(e) => setInstruction(e.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    data-testid="gate-changes-send"
                    disabled={affordances().requestChanges !== 'enabled' || !instruction().trim()}
                  >
                    {t('gate.send')}
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
