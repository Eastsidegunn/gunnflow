/**
 * Terminal session state (Live Terminal brief §38). PTY content lives in the
 * stream part (streamStore); this store holds only the upstream session
 * record and its connection. Stdin and kill are PendingIntentState entries —
 * one pending store — relayed through the guarded post; local echo is never
 * authoritative and a failed input is never shown as executed.
 */
import { createSignal } from 'solid-js';
import type { SessionProjection } from '../model/executionTypes.js';
import { isSessionIntent, type SessionIntent } from '../model/types.js';
import {
  isUndecided,
  type ComposingEntry,
  type Draft,
  type InFlightEntry,
  type PendingEntry,
  type PendingIntentState,
  type RejectedEntry,
  type SendOutcome,
} from './pendingIntents.js';
import { dropAllStreams } from '../transport/streamChannel.js';

/** 'unsupported' = the upstream does not provide a terminal surface (BFF 501). */
export type TerminalConnection = 'connecting' | 'live' | 'lost' | 'replay' | 'unsupported';

type StdinIntent = Extract<SessionIntent, { intent: 'session.stdin' }>;

let nextInputRef = 0;

function intentOf(e: PendingEntry): Draft {
  return e.phase === 'composing' ? e.draft : e.intent;
}

export function createTerminalStore(pending: PendingIntentState) {
  const [session, setSession] = createSignal<SessionProjection | null>(null);
  const [connection, setConnection] = createSignal<TerminalConnection>('connecting');
  const [unsupported, setUnsupported] = createSignal<string | null>(null);

  const forSession = (kind: 'session.stdin' | 'session.kill') => (e: PendingEntry) => {
    const i = intentOf(e);
    return !isUndecided(i) && isSessionIntent(i) && i.intent === kind && i.sessionId === session()?.id;
  };
  const isStdin = forSession('session.stdin');
  const isKill = forSession('session.kill');

  const composingStdin = () =>
    pending.composing().filter(isStdin).at(-1) as (ComposingEntry & { draft: StdinIntent }) | undefined;

  /** A confirming channel is gone: in-flight stdin/kill cannot be confirmed from here. */
  const markUnconfirmed = (reason: string) =>
    pending.markUnconfirmed((e) => isStdin(e) || isKill(e), reason);

  /** The composer's text is a composing entry: it returns with Restore after a refusal. */
  const setStdinDraft = (input: string) => {
    const s = session();
    if (!s) return;
    const current = composingStdin();
    if (current) pending.update(current.localId, { ...current.draft, input });
    else pending.compose({ intent: 'session.stdin', sessionId: s.id, input, inputRef: `in-${++nextInputRef}` });
  };

  return {
    session,
    connection,
    unsupported,
    markUnsupported(reason: string) {
      setUnsupported(reason);
      setConnection('unsupported');
      markUnconfirmed('terminal not supported by upstream');
    },

    /** Sent or refused stdin for this session, in order (local echo rows). */
    stdinEntries: () =>
      pending
        .entries()
        .filter((e): e is InFlightEntry | RejectedEntry => e.phase !== 'composing' && isStdin(e)),
    pendingKill: () => pending.inFlight().some(isKill),

    stdinDraft: () => composingStdin()?.draft.input ?? '',
    setStdinDraft,

    applySnapshot(p: { session: SessionProjection | null }) {
      setSession(p.session);
      if (p.session) pending.reconcileSession(p.session);
      setConnection('live');
    },
    applySession(s: SessionProjection) {
      setSession(s);
      pending.reconcileSession(s);
    },
    markLost() {
      setConnection('lost');
      markUnconfirmed('connection lost');
    },
    markUnconfirmed,

    /** Operator stdin: composing → send (the single transition) → in-flight until echoed. */
    async submitStdin(input?: string): Promise<SendOutcome> {
      const s = session();
      if (!s) return { accepted: false, reason: 'no session' };
      if (input !== undefined) setStdinDraft(input);
      const draft = composingStdin();
      if (!draft) return { accepted: false, reason: 'no stdin draft' };
      return pending.send(draft.localId);
    },

    submitKill(reason: string): Promise<SendOutcome> {
      const s = session();
      if (!s) return Promise.resolve({ accepted: false, reason: 'no session' });
      return pending.submit({ intent: 'session.kill', sessionId: s.id, reason });
    },
  };
}

export type TerminalStore = ReturnType<typeof createTerminalStore>;

/** A connection the browser gave up on may have been refused as unsupported (501 + reason). */
export async function unsupportedReason(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (res.status !== 501) return null;
    const body = (await res.json()) as { unsupported?: unknown };
    return typeof body.unsupported === 'string' ? body.unsupported : 'not supported by upstream';
  } catch {
    return null;
  }
}

export function connectTerminalStream(store: TerminalStore, sessionId: string): () => void {
  const url = `/api/terminal/${encodeURIComponent(sessionId)}/stream`;
  const source = new EventSource(url);
  source.addEventListener('snapshot', (e) => store.applySnapshot(JSON.parse((e as MessageEvent).data)));
  source.addEventListener('session', (e) => store.applySession(JSON.parse((e as MessageEvent).data)));
  source.onerror = () => {
    store.markLost();
    if (source.readyState === EventSource.CLOSED) {
      void unsupportedReason(url).then((reason) => {
        if (reason) store.markUnsupported(reason);
      });
    }
  };
  const drop = () => {
    source.close();
    store.markLost();
  };
  registerDrop(drop);
  return () => {
    unregisterDrop(drop);
    source.close();
  };
}

const drops = new Set<() => void>();
const registerDrop = (fn: () => void) => drops.add(fn);
const unregisterDrop = (fn: () => void) => drops.delete(fn);
export function dropAllTerminalStreams(): void {
  for (const fn of [...drops]) fn();
  dropAllStreams();
}
