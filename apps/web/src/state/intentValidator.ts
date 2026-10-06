/**
 * Relay-boundary validator. Workspace intents are contract Intents and are
 * checked by the contract's own validator (keys, idempotency key, slot pairing,
 * declared/enabled, attestation shape). Terminal/session intents keep their
 * stand-in addressing and are checked against their kind's keys with the same
 * slot rules. The guarded post refuses anything the validator refuses.
 */
import {
  validateIntent as validateContractIntent,
  validateIntentWithKeys,
  type CapabilityLookup,
  type IntentValidation,
} from '@gunnflow/contract';
import {
  isSessionIntent,
  type Intent,
  type IntentResult,
  type SessionIntent,
  type WireIntent,
  type WorkspaceProjection,
} from '../model/types.js';

export type { CapabilityLookup, IntentValidation };

/**
 * A stand-in session intent: `kindKeys` are the keys its kind carries besides
 * the shared slots; undefined means the kind itself is unknown.
 */
export function validateSessionIntent(
  intent: unknown,
  kindKeys: readonly string[] | undefined,
  lookup: CapabilityLookup,
): IntentValidation {
  const kind = (intent as { intent?: unknown } | null)?.intent;
  if (typeof intent !== 'object' || intent === null || Array.isArray(intent) || typeof kind !== 'string') {
    return { ok: false, reason: 'malformed intent' };
  }
  if (!kindKeys) return { ok: false, reason: `unknown intent kind '${kind}'` };
  if (typeof (intent as { idempotencyKey?: unknown }).idempotencyKey !== 'string') {
    return { ok: false, reason: 'idempotencyKey must be a non-empty string' };
  }
  return validateIntentWithKeys(intent, ['intent', 'idempotencyKey', ...kindKeys], kind, lookup);
}

export interface IntentChecks {
  kindKeys(intent: SessionIntent): readonly string[] | undefined;
  capabilityFor(intent: Intent, projection: WorkspaceProjection): CapabilityLookup;
}

export type RefusedIntent = { accepted: false; reason: string; invalid: true };

export function checkIntent(intent: WireIntent, checks: IntentChecks, projection: WorkspaceProjection): IntentValidation {
  const lookup = checks.capabilityFor(intent, projection);
  if (isSessionIntent(intent)) return validateSessionIntent(intent, checks.kindKeys(intent), lookup);
  return validateContractIntent(intent, lookup);
}

/** The relay boundary: a post that cannot carry an intent the validator refuses. */
export function guardPost(
  post: (intent: WireIntent) => Promise<IntentResult>,
  checks: IntentChecks,
  projection: () => WorkspaceProjection,
): (intent: WireIntent) => Promise<IntentResult | RefusedIntent> {
  return async (intent) => {
    const check = checkIntent(intent, checks, projection());
    if (!check.ok) return { accepted: false, reason: check.reason, invalid: true };
    return post(intent);
  };
}
