/**
 * Pure decision-surface logic (Human Gate brief §18–§23). Everything derives
 * from upstream facts plus transport health — no risk scoring, no expiration
 * inference, no outcome guessing.
 */
import type { GateProjection, WorkspaceProjection } from '../model/types.js';
import type { ConnectionState } from './projectionStore.js';
import { writeAffordance, type Affordance } from './capabilities.js';
import { gateCapabilities } from '../model/selectors.js';
import { isUndecided, type ComposingEntry, type InFlightEntry, type PendingIntentState, type SendOutcome } from './pendingIntents.js';
import { actionOf, isSessionIntent, nodeOf } from '../model/types.js';

const GATE_DECISIONS = new Set(['gate.approve', 'gate.reject', 'gate.requestChanges']);
import type { DisplayToken } from './editorLogic.js';

/** A gate accepts decisions only while upstream says it is waiting. */
export function gateActive(gate: GateProjection): boolean {
  return gate.state === 'waiting';
}

export interface GateDecisionAffordances {
  approve: Affordance;
  reject: Affordance;
  requestChanges: Affordance;
  /** Upstream-provided explanation for disabled actions, if any. */
  disabledReason?: string;
  /** Why every write is off, when a global guard applies. */
  guard?: 'stale' | 'inactive' | 'pending';
}

/**
 * Decision affordances = upstream capability × gate lifecycle ×
 * transport health × pending submission (double-submit guard).
 */
export function gateDecisionAffordances(
  projection: WorkspaceProjection,
  gate: GateProjection,
  connection: ConnectionState,
  pending: readonly InFlightEntry[],
): GateDecisionAffordances {
  const caps = gateCapabilities(projection, gate.id);
  const base: GateDecisionAffordances = {
    approve: writeAffordance(caps.approve),
    reject: writeAffordance(caps.reject),
    requestChanges: writeAffordance(caps.requestChanges),
    disabledReason: caps.disabledReason,
  };
  const disableAll = (guard: GateDecisionAffordances['guard']): GateDecisionAffordances => ({
    approve: base.approve === 'hidden' ? 'hidden' : 'disabled',
    reject: base.reject === 'hidden' ? 'hidden' : 'disabled',
    requestChanges: base.requestChanges === 'hidden' ? 'hidden' : 'disabled',
    disabledReason: base.disabledReason,
    guard,
  });
  if (!gateActive(gate)) return disableAll('inactive');
  // A stale projection must not host approvals (brief §22) — never guess validity.
  if (connection !== 'live') return disableAll('stale');
  if (hasPendingGateDecision(pending, gate.id)) return disableAll('pending');
  return base;
}

/** Double-submit guard (brief §21). */
export function hasPendingGateDecision(
  pending: readonly InFlightEntry[],
  gateId: string,
): boolean {
  return pending.some((p) => GATE_DECISIONS.has(actionOf(p.intent)) && nodeOf(p.intent) === gateId);
}

/**
 * Surface form (brief §5): external effects and evidence-heavy gates get the
 * large overlay; plain approvals sit in a contextual side panel. Chosen from
 * upstream-provided fields only.
 */
/** S-03: the panel is the default; only a privileged (external-effect) final confirmation takes the overlay. */
export function gateSurfaceForm(gate: GateProjection): 'panel' | 'overlay' {
  return gate.request?.externalEffect ? 'overlay' : 'panel';
}

type GateDecisionKind = 'gate.approve' | 'gate.reject';

/**
 * The gate's decision reason as a composing entry. Typing never fixes a kind
 * (the draft stays undecided); a draft restored from a refused decision also
 * counts, so Restore brings its reason back into the field.
 */
export function gateReasonEntry(pending: PendingIntentState, gateId: string): ComposingEntry | undefined {
  return pending
    .composing()
    .filter((e) => {
      const d = e.draft;
      if (isUndecided(d)) return d.nodeId === gateId;
      return !isSessionIntent(d) && (d.action === 'gate.approve' || d.action === 'gate.reject') && d.nodeId === gateId;
    })
    .at(-1);
}

export function gateReason(pending: PendingIntentState, gateId: string): string {
  const d = gateReasonEntry(pending, gateId)?.draft;
  if (!d) return '';
  if (isUndecided(d)) return d.text;
  return isSessionIntent(d) ? '' : (d.decision?.text ?? '');
}

export function setGateReason(pending: PendingIntentState, gateId: string, reason: string): void {
  const draft = { action: null, nodeId: gateId, text: reason };
  const e = gateReasonEntry(pending, gateId);
  if (e) pending.update(e.localId, draft);
  else pending.compose(draft);
}

/** The kind is chosen here, at the click, then the single send transition runs. */
export function decideGate(
  pending: PendingIntentState,
  gateId: string,
  kind: GateDecisionKind,
  evidence: readonly DisplayToken[] = [],
): Promise<SendOutcome> {
  const text = gateReason(pending, gateId).trim();
  const draft = { nodeId: gateId, action: kind, ...(text ? { decision: { text } } : {}) };
  const views = evidence.length > 0 ? { displays: [...evidence] } : undefined;
  const e = gateReasonEntry(pending, gateId);
  if (!e) return pending.send(pending.compose(draft, undefined, views));
  pending.update(e.localId, draft);
  if (views) pending.setEvidence(e.localId, views);
  return pending.send(e.localId);
}
