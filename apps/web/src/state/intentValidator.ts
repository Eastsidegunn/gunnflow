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
import { isMsg, msg, raw, tm, type Msg } from '../i18n/index.js';

export type { CapabilityLookup, IntentValidation };

/**
 * A check result whose refusal is a message: the engine's own reasons as catalog
 * descriptors, the contract validator's problems verbatim (they are the contract's text).
 */
export type IntentCheck = { ok: true } | { ok: false; reason: Msg };

const fromContract = (v: IntentValidation): IntentCheck => (v.ok ? { ok: true } : { ok: false, reason: raw(v.reason) });

/**
 * A stand-in session intent: `kindKeys` are the keys its kind carries besides
 * the shared slots; undefined means the kind itself is unknown.
 */
export function validateSessionIntent(
  intent: unknown,
  kindKeys: readonly string[] | undefined,
  lookup: CapabilityLookup,
): IntentCheck {
  const kind = (intent as { intent?: unknown } | null)?.intent;
  if (typeof intent !== 'object' || intent === null || Array.isArray(intent) || typeof kind !== 'string') {
    return { ok: false, reason: msg('intent.check.malformed') };
  }
  if (!kindKeys) return { ok: false, reason: msg('intent.check.unknownKind', { kind }) };
  if (typeof (intent as { idempotencyKey?: unknown }).idempotencyKey !== 'string') {
    return { ok: false, reason: msg('intent.check.noIdempotencyKey') };
  }
  return fromContract(validateIntentWithKeys(intent, ['intent', 'idempotencyKey', ...kindKeys], kind, lookup));
}

export interface IntentChecks {
  kindKeys(intent: SessionIntent): readonly string[] | undefined;
  capabilityFor(intent: Intent, projection: WorkspaceProjection): CapabilityLookup;
}

/**
 * A send refused before the relay. `reason` is the refusal in the current locale
 * (for whoever reads the outcome now); `why` is the message itself, for anything
 * that keeps it and must show it again after a language switch.
 */
export type RefusedIntent = { accepted: false; reason: string; why: Msg; invalid: true; local: true; upstream?: never };

export function refusedIntent(why: Msg): RefusedIntent {
  return { accepted: false, reason: tm(why), why, invalid: true, local: true };
}

/**
 * The relay's answer, normalized: only `accepted` and the upstream's `reason`
 * survive. Disjoint from a local refusal — it can never carry `local`, `why` or
 * `invalid`, whatever arrived on the wire.
 */
export type RelayResult = { accepted: boolean; reason?: string; local?: never; why?: never; invalid?: never };

/** Keeps `accepted` (only a literal true counts) and a string `reason`; every other field is dropped. */
export function relayResult(body: unknown): RelayResult {
  const o = typeof body === 'object' && body !== null ? (body as { accepted?: unknown; reason?: unknown }) : {};
  if (o.accepted === true) return { accepted: true };
  return typeof o.reason === 'string' ? { accepted: false, reason: o.reason } : { accepted: false };
}

/** A refusal made locally: tagged `local`, with a well-formed message. Nothing from the wire qualifies (see relayResult). */
export function isRefused(r: RelayResult | RefusedIntent): r is RefusedIntent {
  return r.local === true && r.invalid === true && isMsg(r.why);
}

export function checkIntent(intent: WireIntent, checks: IntentChecks, projection: WorkspaceProjection): IntentCheck {
  const lookup = checks.capabilityFor(intent, projection);
  if (isSessionIntent(intent)) return validateSessionIntent(intent, checks.kindKeys(intent), lookup);
  return fromContract(validateContractIntent(intent, lookup));
}

/** The relay boundary: a post that cannot carry an intent the validator refuses. */
export function guardPost(
  post: (intent: WireIntent) => Promise<IntentResult>,
  checks: IntentChecks,
  projection: () => WorkspaceProjection,
): (intent: WireIntent) => Promise<RelayResult | RefusedIntent> {
  return async (intent) => {
    const check = checkIntent(intent, checks, projection());
    if (!check.ok) return refusedIntent(check.reason);
    // The relay's answer crosses here: normalized, so nothing it carries can pass as a local refusal.
    return relayResult(await post(intent));
  };
}
