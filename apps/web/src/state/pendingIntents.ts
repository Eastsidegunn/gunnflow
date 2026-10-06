/**
 * PendingIntentState — the write path (charter §15, §23; push-stage §0.2).
 *
 *   composing (local only, never sent)
 *     → send(): validate at the relay boundary → in-flight (drawn dashed)
 *     → relay POST → upstream append → projection arrives → entry dropped,
 *       the authoritative projection is the only source of the new edge/node.
 *   in-flight → rejected (upstream reason verbatim) → reopen() → composing.
 *   in-flight + unconfirmed (transport failed; may or may not have landed)
 *     → reconcile() drops it if it did land, or reopen() → composing.
 *
 * The authoritative graph is never locally mutated. What "satisfied by the
 * projection" means is injected (PendingIntentAdapter), not decided here.
 */
import { createSignal } from 'solid-js';
import type { Intent, IntentResult, WireIntent, WorkspaceProjection } from '../model/types.js';
import { checkIntent, type IntentChecks, type RefusedIntent } from './intentValidator.js';
import { sha256Hex, utf8Bytes } from './digest.js';
import { checkEditSend, displayRecord, type DisplayToken, type EditContext } from './editorLogic.js';
import type { StreamChunk } from '../model/streamTypes.js';
import type { SessionProjection } from '../model/executionTypes.js';

/**
 * Editor buffer (push-stage §3.3). Lives only here until send, where it is
 * materialized into `Intent.edit` plus the base attestation.
 */
export interface EditBuffer {
  baseArtifactId: string | null;
  mediaType: string;
  body: string;
  /**
   * Token for the rendered base (editorLogic.markRendered). Base digest and
   * attestation come only from the record behind it, never from this buffer.
   */
  display: DisplayToken | null;
}

/**
 * Evidence views: display tokens minted when evidence artifacts were rendered.
 * Which evidence is required is never taken from here — it is read from the
 * addressed capability in the current projection at send.
 */
export interface EvidenceViews {
  displays: DisplayToken[];
}

/**
 * A value whose intent kind is not chosen yet (a gate reason before
 * approve/reject). It cannot be sent until `update` gives it a kind.
 */
export interface UndecidedDraft {
  action: null;
  nodeId: string;
  text: string;
}

export type Draft = Intent | UndecidedDraft;

export function isUndecided(d: Draft): d is UndecidedDraft {
  return 'action' in d && d.action === null;
}

/**
 * The fake intent shape carries nodeId/action/values until the contract
 * Intent lands; `draft` is that value carrier.
 */
export interface ComposingEntry {
  phase: 'composing';
  localId: string;
  draft: Draft;
  editBuffer?: EditBuffer;
  evidence?: EvidenceViews;
  openedAt: number;
  /** Relay-boundary validation failure; the draft was not sent. */
  invalid?: string;
  invalidAt?: number;
  /** The rejection this draft was reopened from; reason verbatim, absent if upstream gave none. */
  priorRejection?: { reason?: string; at: number };
  /** Reopened from an unconfirmed send: the earlier attempt may have landed. */
  priorUnconfirmed?: { reason: string; at: number };
}

export interface InFlightEntry {
  phase: 'in-flight';
  localId: string;
  intent: WireIntent;
  idempotencyKey: string;
  sentAt: number;
  editBuffer?: EditBuffer;
  evidence?: EvidenceViews;
  /** sha256 of the sent `edit.body` UTF-8 bytes; set before the post leaves. */
  editDigest?: string;
  /** Transport diagnostic when the relay result never arrived. Not a rejection. */
  unconfirmed?: string;
  unconfirmedAt?: number;
}

export interface RejectedEntry {
  phase: 'rejected';
  localId: string;
  intent: WireIntent;
  idempotencyKey: string;
  editBuffer?: EditBuffer;
  evidence?: EvidenceViews;
  /** Upstream-provided reason, verbatim; absent when upstream gave none. */
  reason?: string;
  at: number;
  /** The rejection arrived after a projection had already reconciled the entry away. */
  afterReconcile?: true;
}

export type PendingEntry = ComposingEntry | InFlightEntry | RejectedEntry;

export interface EntryError {
  /** Where the failed input belongs, for an inline receipt at its control (N-05). */
  nodeId?: string;
  action?: string;
  localId: string;
  kind: 'rejected' | 'invalid' | 'unconfirmed';
  /** Upstream text for 'rejected', local diagnostic otherwise; absent = none given. */
  reason?: string;
  at: number;
  afterReconcile?: true;
}

export type PostIntent = (intent: WireIntent) => Promise<IntentResult | RefusedIntent>;

export type SendOutcome =
  | IntentResult
  | RefusedIntent
  | { accepted: false; reason: string; unconfirmed: true };

/** Contract-shape knowledge the store must not own. */
export interface PendingIntentAdapter extends IntentChecks {
  /** Does the authoritative projection now reflect this in-flight intent? */
  isSatisfied(entry: InFlightEntry, projection: WorkspaceProjection): boolean;
  /** Does this stream chunk confirm the entry? One chunk confirms at most one entry. */
  matchesChunk?(entry: InFlightEntry, nodeId: string, chunk: StreamChunk): boolean;
  /** Capability and artifact an edit draft is addressed to, in this projection. */
  editContext?(intent: Intent, projection: WorkspaceProjection): EditContext;
  /**
   * Draft a refused/unconfirmed intent returns to on Restore. A decision whose
   * kind the human picks by clicking goes back undecided, never pre-chosen.
   */
  reopenDraft?(intent: Intent): Draft | undefined;
  /** Does this session record confirm the entry? */
  isSatisfiedBySession?(entry: InFlightEntry, session: SessionProjection): boolean;
  /** Current digest of an artifact, for re-checking viewed evidence at send. */
  artifactDigest?(artifactId: string, projection: WorkspaceProjection): string | undefined;
}

let nextLocalId = 0;


function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function withoutEditSlots(draft: Intent): Intent {
  const { edit: _e, attestation: _a, ...rest } = draft;
  return rest as Intent;
}

/** Buffer → wire slots. Base digest and attestation come from the internal display record only. */
function materialize(
  draft: Intent,
  buffer: EditBuffer | undefined,
  evidence: EvidenceViews | undefined,
  required: readonly string[],
): Intent {
  if (!buffer && required.length === 0) return draft;
  const baseRecord = buffer ? displayRecord(buffer.display) : undefined;
  const records = [
    ...(baseRecord ? [baseRecord] : []),
    ...(evidence?.displays ?? []).flatMap((t) => {
      const r = displayRecord(t);
      return r && required.includes(r.artifactId) ? [r] : [];
    }),
  ].filter((r, i, all) => all.findIndex((x) => x.artifactId === r.artifactId) === i);
  return {
    ...withoutEditSlots(draft),
    ...(buffer ? { edit: { baseDigest: baseRecord?.digest ?? null, mediaType: buffer.mediaType, body: buffer.body } } : {}),
    ...(records.length > 0
      ? {
          attestation: {
            displayed: records.map((r) => ({ artifactId: r.artifactId, digest: r.digest, at: new Date(r.at).toISOString() })),
          },
        }
      : {}),
  } as Intent;
}

function isRefused(r: IntentResult | RefusedIntent): r is RefusedIntent {
  return 'invalid' in r && r.invalid === true;
}

export function createPendingIntentState(
  post: PostIntent,
  adapter: PendingIntentAdapter,
  projection: () => WorkspaceProjection,
) {
  const [entries, setEntries] = createSignal<readonly PendingEntry[]>([]);

  const find = (localId: string) => entries().find((e) => e.localId === localId);
  /** Replace only if the entry is still in the expected phase. */
  const replace = (
    localId: string,
    phase: PendingEntry['phase'],
    next: (current: PendingEntry) => PendingEntry,
  ) =>
    setEntries((list) =>
      list.map((e) => (e.localId === localId && e.phase === phase ? next(e) : e)),
    );

  function compose(draft: Draft, editBuffer?: EditBuffer, evidence?: EvidenceViews): string {
    const localId = `local-${++nextLocalId}`;
    setEntries((list) => [
      ...list,
      {
        phase: 'composing',
        localId,
        draft,
        openedAt: Date.now(),
        ...(editBuffer ? { editBuffer } : {}),
        ...(evidence ? { evidence } : {}),
      },
    ]);
    return localId;
  }

  /** A sent intent back as a draft: its key is dropped (a new one is minted at the next send). */
  const restoredDraft = (sent: WireIntent, materialized: boolean): Draft => {
    const { idempotencyKey: _key, ...intent } = sent;
    const bare = intent as Intent;
    return adapter.reopenDraft?.(bare) ?? (materialized ? withoutEditSlots(bare) : bare);
  };


  const refuse = (entry: ComposingEntry, reason: string): SendOutcome => {
    replace(entry.localId, 'composing', () => ({ ...entry, invalid: reason, invalidAt: Date.now() }));
    return { accepted: false, reason, invalid: true };
  };

  /** Evidence the addressed capability requires, read from the current projection. */
  const requiredEvidence = (draft: Intent): string[] => {
    const lookup = adapter.capabilityFor(draft, projection());
    return 'capability' in lookup ? (lookup.capability?.decision?.evidence ?? []) : [];
  };

  const editProblem = (entry: ComposingEntry): string | null => {
    if (isUndecided(entry.draft)) return null;
    const problem = evidenceProblem(entry.evidence, requiredEvidence(entry.draft));
    if (problem) return problem;
    if (!entry.editBuffer) return null;
    const ctx = adapter.editContext?.(entry.draft, projection()) ?? { capability: undefined, artifact: undefined };
    return checkEditSend(entry.editBuffer, ctx);
  };

  /**
   * Every currently required evidence artifact was rendered, and is still the
   * version that was rendered. An artifact whose current digest cannot be read
   * is refused: a past view cannot stand in for it.
   */
  const evidenceProblem = (evidence: EvidenceViews | undefined, required: readonly string[]): string | null => {
    for (const id of required) {
      const record = (evidence?.displays ?? []).map((t) => displayRecord(t)).find((r) => r?.artifactId === id);
      if (!record) return `evidence '${id}' has not been viewed`;
      const current = adapter.artifactDigest?.(id, projection());
      if (current === undefined) return `evidence '${id}': its current version cannot be confirmed`;
      if (current !== record.digest) return `evidence '${id}' changed since it was viewed`;
    }
    return null;
  };

  /**
   * The only composing → in-flight transition. An edit's digest is computed
   * first; the recheck, the transition and the post call then run in one
   * synchronous step, so nothing can change between the last check and the post.
   */
  async function send(localId: string): Promise<SendOutcome> {
    const first = find(localId);
    if (!first || first.phase !== 'composing') {
      return { accepted: false, reason: `no composing entry '${localId}'`, invalid: true };
    }
    if (isUndecided(first.draft)) return refuse(first, 'choose an action before sending');
    let editDigest: string | undefined;
    if (first.editBuffer) {
      const early = editProblem(first);
      if (early) return refuse(first, early);
      try {
        editDigest = await sha256Hex(utf8Bytes(first.editBuffer.body));
      } catch (err) {
        return refuse(first, `digest unavailable: ${String(err)}`);
      }
    }

    // ---- synchronous from here until post() is called ----
    const entry = find(localId);
    if (!entry || entry.phase !== 'composing') {
      return { accepted: false, reason: 'entry left composing while sending', invalid: true };
    }
    if (entry.draft !== first.draft || entry.editBuffer !== first.editBuffer) {
      return refuse(entry, 'draft changed while sending — send again');
    }
    const draft = entry.draft;
    if (isUndecided(draft)) return refuse(entry, 'choose an action before sending');
    const late = editProblem(entry);
    if (late) return refuse(entry, late);
    // Validated, stored and posted object are one frozen copy, carrying its idempotency key.
    const idempotencyKey = newIdempotencyKey();
    const intent: WireIntent = deepFreeze({
      ...structuredClone(materialize(draft, entry.editBuffer, entry.evidence, requiredEvidence(draft))),
      idempotencyKey,
    });
    const check = checkIntent(intent, adapter, projection());
    if (!check.ok) return refuse(entry, check.reason);
    const editBuffer = entry.editBuffer;
    const evidence = entry.evidence;
    replace(localId, 'composing', () => ({
      phase: 'in-flight',
      localId,
      intent,
      idempotencyKey,
      sentAt: Date.now(),
      ...(editBuffer ? { editBuffer } : {}),
      ...(evidence ? { evidence } : {}),
      ...(editDigest !== undefined ? { editDigest } : {}),
    }));
    const posting = (async () => post(intent))();
    // ---- end of synchronous section ----

    let result: IntentResult | RefusedIntent;
    try {
      result = await posting;
    } catch (err) {
      const reason = `relay unreachable: ${String(err)}`;
      replace(localId, 'in-flight', (e) => ({ ...e, unconfirmed: reason, unconfirmedAt: Date.now() }) as InFlightEntry);
      return { accepted: false, reason, unconfirmed: true };
    }
    if (isRefused(result)) {
      replace(localId, 'in-flight', () => ({ ...entry, invalid: result.reason, invalidAt: Date.now() }));
      return result;
    }
    if (!result.accepted) {
      const rejected: RejectedEntry = {
        phase: 'rejected',
        localId,
        intent,
        idempotencyKey,
        reason: result.reason || undefined,
        at: Date.now(),
        ...(editBuffer ? { editBuffer } : {}),
        ...(evidence ? { evidence } : {}),
      };
      if (find(localId)?.phase === 'in-flight') {
        replace(localId, 'in-flight', () => rejected);
      } else {
        setEntries((list) => [...list, { ...rejected, afterReconcile: true }]);
      }
    }
    return result;
  }

  return {
    entries,
    composing: () => entries().filter((e): e is ComposingEntry => e.phase === 'composing'),
    inFlight: () => entries().filter((e): e is InFlightEntry => e.phase === 'in-flight'),
    rejected: () => entries().filter((e): e is RejectedEntry => e.phase === 'rejected'),
    errors: (): EntryError[] =>
      entries().flatMap((e): EntryError[] => {
        const addr = (d: Draft): { nodeId?: string; action?: string } => {
          const x = d as { nodeId?: unknown; action?: unknown };
          return {
            ...(typeof x.nodeId === 'string' ? { nodeId: x.nodeId } : {}),
            ...(typeof x.action === 'string' ? { action: x.action } : {}),
          };
        };
        if (e.phase === 'rejected') {
          return [{ localId: e.localId, kind: 'rejected', reason: e.reason, at: e.at, ...addr(e.intent), ...(e.afterReconcile ? { afterReconcile: true as const } : {}) }];
        }
        if (e.phase === 'composing' && e.invalid !== undefined) {
          return [{ localId: e.localId, kind: 'invalid', reason: e.invalid, at: e.invalidAt ?? e.openedAt, ...addr(e.draft) }];
        }
        if (e.phase === 'in-flight' && e.unconfirmed !== undefined) {
          return [{ localId: e.localId, kind: 'unconfirmed', reason: e.unconfirmed, at: e.unconfirmedAt ?? e.sentAt, ...addr(e.intent) }];
        }
        return [];
      }),

    compose,

    /** Edit a composing draft; clears a previous validation failure. */
    update(localId: string, draft: Draft) {
      replace(localId, 'composing', (e) => {
        const { invalid: _i, invalidAt: _t, ...rest } = e as ComposingEntry;
        return { ...rest, draft };
      });
    },

    send,

    /** Record the evidence views of a composing entry (display tokens minted on render). */
    setEvidence(localId: string, evidence: EvidenceViews) {
      replace(localId, 'composing', (e) => {
        const { invalid: _i, invalidAt: _t, ...rest } = e as ComposingEntry;
        return { ...rest, evidence };
      });
    },

    /** Edit a composing buffer (body, or base after an explicit switch); clears a validation failure. */
    updateEditBuffer(localId: string, patch: Partial<EditBuffer>) {
      replace(localId, 'composing', (e) => {
        const { invalid: _i, invalidAt: _t, ...rest } = e as ComposingEntry;
        return rest.editBuffer ? { ...rest, editBuffer: { ...rest.editBuffer, ...patch } } : rest;
      });
    },

    /** Compose and send in one step, for surfaces whose value is final on click. */
    submit(intent: Intent): Promise<SendOutcome> {
      return send(compose(intent));
    },

    /**
     * rejected or unconfirmed → composing: the human's values come back, not
     * discarded. The next send gets a new idempotency key.
     */
    reopen(localId: string) {
      const entry = find(localId);
      if (entry?.phase === 'rejected') {
        replace(localId, 'rejected', () => ({
          phase: 'composing',
          localId,
          draft: restoredDraft(entry.intent, Boolean(entry.editBuffer || entry.evidence)),
          openedAt: Date.now(),
          priorRejection: { reason: entry.reason, at: entry.at },
          ...(entry.editBuffer ? { editBuffer: entry.editBuffer } : {}),
          ...(entry.evidence ? { evidence: entry.evidence } : {}),
        }));
      } else if (entry?.phase === 'in-flight' && entry.unconfirmed !== undefined) {
        const unconfirmed = entry.unconfirmed;
        replace(localId, 'in-flight', () => ({
          phase: 'composing',
          localId,
          draft: restoredDraft(entry.intent, Boolean(entry.editBuffer || entry.evidence)),
          openedAt: Date.now(),
          priorUnconfirmed: { reason: unconfirmed, at: entry.unconfirmedAt ?? entry.sentAt },
          ...(entry.editBuffer ? { editBuffer: entry.editBuffer } : {}),
          ...(entry.evidence ? { evidence: entry.evidence } : {}),
        }));
      }
    },

    /** Drop a composing or rejected entry. In-flight entries cannot be retracted. */
    discard(localId: string) {
      setEntries((list) => list.filter((e) => e.localId !== localId || e.phase === 'in-flight'));
    },

    /** Authoritative stream chunks arrived on a node's channel. */
    reconcileChunks(nodeId: string, chunks: readonly StreamChunk[]) {
      const match = adapter.matchesChunk;
      if (!match || chunks.length === 0) return;
      setEntries((list) => {
        const confirmed = new Set<string>();
        for (const chunk of chunks) {
          const hit = list.find(
            (e) => e.phase === 'in-flight' && !confirmed.has(e.localId) && match(e, nodeId, chunk),
          );
          if (hit) confirmed.add(hit.localId);
        }
        return confirmed.size === 0 ? list : list.filter((e) => !confirmed.has(e.localId));
      });
    },

    /** An authoritative session record arrived. */
    reconcileSession(session: SessionProjection) {
      const satisfied = adapter.isSatisfiedBySession;
      if (!satisfied) return;
      setEntries((list) => list.filter((e) => e.phase !== 'in-flight' || !satisfied(e, session)));
    },

    /**
     * The channel that would confirm these in-flight entries was lost: they
     * stay in-flight (they may have landed) but are marked unconfirmed.
     */
    markUnconfirmed(which: (entry: InFlightEntry) => boolean, reason: string) {
      const at = Date.now();
      setEntries((list) =>
        list.map((e) =>
          e.phase === 'in-flight' && e.unconfirmed === undefined && which(e)
            ? { ...e, unconfirmed: reason, unconfirmedAt: at }
            : e,
        ),
      );
    },

    /** Authoritative projection arrived: satisfied in-flight entries are dropped. */
    reconcile(next: WorkspaceProjection) {
      setEntries((list) =>
        list.filter((e) => e.phase !== 'in-flight' || !adapter.isSatisfied(e, next)),
      );
    },
  };
}

export type PendingIntentState = ReturnType<typeof createPendingIntentState>;
