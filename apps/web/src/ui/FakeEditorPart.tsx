/**
 * Editor part (push-stage §3.3), bound to the fake `artifact.edit` capability.
 * Plain-text base-relative editing only: the base is rendered as text glyphs
 * (markdown uninterpreted), the buffer lives in a composing PendingIntent
 * entry, and "Saved" appears only once a projection carries the sent digest.
 * Losing the capability blocks new edits and send, never access to existing entries.
 */
import { Match, Show, Switch, createEffect, createMemo, createResource, createSignal } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import { editCapability, taskArtifact } from '../model/selectors.js';
import { writeAffordance } from '../state/capabilities.js';
import { editorSendState, fixBase, type DisplayToken } from '../state/editorLogic.js';
import { onRendered } from './renderedToken.js';
import { isUndecided, type Draft, type PendingEntry } from '../state/pendingIntents.js';
import { isSessionIntent } from '../model/types.js';

function intentOf(e: PendingEntry): Draft {
  return e.phase === 'composing' ? e.draft : e.intent;
}

export function FakeEditorPart(props: { stores: WorkspaceStores; taskId: string }) {
  const { projectionStore, pendingIntents } = props.stores;
  const projection = () => projectionStore.projection();
  const cap = createMemo(() => editCapability(projection(), props.taskId));
  const edit = () => cap()?.edit;
  const ref = createMemo(() => {
    const id = edit()?.artifactId;
    return id ? taskArtifact(projection(), props.taskId, id) : undefined;
  });
  const [base] = createResource(
    () => {
      const e = edit();
      if (!e || e.artifactId === null) return undefined;
      const r = ref();
      return { r, b64: r ? projection().artifactSnapshots?.[r.id] : undefined, types: e.mediaTypes };
    },
    (src) => fixBase(src.r, src.b64, src.types),
  );
  const fixed = () => {
    const b = base();
    return b?.ok ? b : null;
  };
  const unpinnedReason = () => {
    const b = base();
    return b && !b.ok ? b.reason : null;
  };
  const writable = () => writeAffordance(cap()?.level) === 'enabled';
  const capEnabled = () => cap()?.level === 'enabled' && edit() !== undefined;
  // Display tokens are minted when the pinned base text is actually rendered.
  const [baseShown, setBaseShown] = createSignal<DisplayToken | undefined>();
  const [newBaseShown, setNewBaseShown] = createSignal<DisplayToken | undefined>();

  const entry = createMemo(() =>
    pendingIntents
      .entries()
      .filter((e) => {
        const i = intentOf(e);
        return !isUndecided(i) && !isSessionIntent(i) && i.action === 'artifact.edit' && i.nodeId === props.taskId;
      })
      .at(-1),
  );

  // "Saved" only when the entry left in-flight through a projection carrying the sent digest.
  const [lastSent, setLastSent] = createSignal<{ localId: string; digest: string } | null>(null);
  createEffect(() => {
    const e = entry();
    if (e?.phase === 'in-flight' && e.editDigest) setLastSent({ localId: e.localId, digest: e.editDigest });
    else if (e) setLastSent(null);
  });
  const saved = () => {
    const s = lastSent();
    return s !== null && entry() === undefined && ref()?.digest === s.digest;
  };

  const [viewingNewBase, setViewingNewBase] = createSignal(false);

  const startEditing = () => {
    const e = edit();
    const b = fixed();
    const shown = baseShown();
    if (!capEnabled() || !e || e.artifactId === null || !b || !shown) return;
    setLastSent(null);
    pendingIntents.compose(
      { nodeId: props.taskId, action: 'artifact.edit' },
      {
        baseArtifactId: e.artifactId,
        mediaType: ref()?.mediaType ?? e.mediaTypes[0] ?? 'text/plain',
        body: b.text,
        display: shown,
      },
    );
  };

  return (
    <Show when={capEnabled() || entry() !== undefined}>
        <section class="editor-part" data-testid="editor-part">
          <h3>Edit {edit()?.artifactId ?? (edit() ? 'new body' : 'artifact')}</h3>
          <Show when={!capEnabled()}>
            <p class="hint" data-testid="editor-capability-lost">
              Edit capability is not enabled — existing entries stay readable; new edits and send are blocked.
            </p>
          </Show>
          <Show when={edit()?.artifactId === null}>
            <p class="hint" data-testid="editor-unsupported">New-body editing is not supported.</p>
          </Show>
          <Show when={edit()?.artifactId && base() === undefined}>
            <p class="hint">Checking base…</p>
          </Show>
          <Show when={unpinnedReason()}>
            {(reason) => (
              <p class="hint" data-testid="editor-unpinnable">
                Base cannot be pinned — {reason()}
              </p>
            )}
          </Show>

          <Switch>
            <Match when={entry() === undefined}>
              <Show when={fixed()} keyed>
                {(b) => (
                  <pre
                    class="editor-base"
                    data-testid="editor-base"
                    ref={(el) => onRendered(el, b.pinned, setBaseShown)}
                  >
                    {b.text}
                  </pre>
                )}
              </Show>
              <Show when={saved()}>
                <p class="hint" data-testid="editor-saved">Saved</p>
              </Show>
              <Show when={capEnabled() && edit()?.artifactId && fixed()}>
                <button data-testid="editor-start" disabled={!writable() || !baseShown()} onClick={startEditing}>
                  Edit
                </button>
              </Show>
            </Match>

            <Match when={entry()?.phase === 'composing' ? entry() : null}>
              {(c) => {
                const composing = () => c() as Extract<PendingEntry, { phase: 'composing' }>;
                const buffer = () => composing().editBuffer!;
                const state = createMemo(() =>
                  editorSendState({
                    buffer: buffer(),
                    currentDigest: ref()?.digest ?? null,
                    baseText: fixed()?.text ?? null,
                    maxBytes: edit()?.maxBytes ?? 0,
                    writable: writable(),
                  }),
                );
                return (
                  <>
                    <Show when={composing().priorRejection}>
                      {(r) => (
                        <p class="hint" data-testid="editor-prior-rejection">
                          Previously rejected — {r().reason ?? <span class="toast-chrome">No reason given</span>}
                        </p>
                      )}
                    </Show>
                    <Show when={composing().priorUnconfirmed}>
                      <p class="hint">Previous send unconfirmed — it may have reached upstream.</p>
                    </Show>
                    <Show when={state().baseMoved}>
                      <div data-testid="editor-base-moved">
                        <p class="hint">Base changed since you started editing.</p>
                        <button data-testid="editor-view-new-base" onClick={() => setViewingNewBase((v) => !v)}>
                          {viewingNewBase() ? 'Hide new base' : 'View new base'}
                        </button>
                        <Show when={viewingNewBase() ? fixed() : null} keyed>
                          {(b) => (
                            <>
                              <pre
                                class="editor-base"
                                data-testid="editor-new-base"
                                ref={(el) => onRendered(el, b.pinned, setNewBaseShown)}
                              >
                                {b.text}
                              </pre>
                              <button
                                data-testid="editor-switch-base"
                                disabled={!newBaseShown()}
                                onClick={() => {
                                  const shown = newBaseShown();
                                  if (!shown) return;
                                  pendingIntents.updateEditBuffer(composing().localId, { display: shown });
                                  setViewingNewBase(false);
                                  setNewBaseShown(undefined);
                                }}
                              >
                                Switch to new base
                              </button>
                            </>
                          )}
                        </Show>
                      </div>
                    </Show>
                    <textarea
                      data-testid="editor-buffer"
                      rows="8"
                      value={buffer().body}
                      onInput={(ev) =>
                        pendingIntents.updateEditBuffer(composing().localId, { body: ev.currentTarget.value })
                      }
                    />
                    <p class="hint" data-testid="editor-bytes" classList={{ over: state().overLimit }}>
                      {state().bytes} / {state().maxBytes} bytes · not sent
                    </p>
                    <Show when={state().undisplayed}>
                      <p class="hint" data-testid="editor-undisplayed">Base was never displayed — cannot send.</p>
                    </Show>
                    <Show when={state().encodingProblem}>
                      {(problem) => <p class="hint" data-testid="editor-encoding">{problem()}</p>}
                    </Show>
                    <Show when={state().lineEndingsConverted}>
                      <p class="hint" data-testid="editor-line-endings">
                        Line endings converted (base used CRLF; the buffer now has LF).
                      </p>
                    </Show>
                    <Show when={composing().invalid}>
                      <p class="hint" data-testid="editor-invalid">Not sent — {composing().invalid}</p>
                    </Show>
                    <div class="actions">
                      <button
                        data-testid="editor-send"
                        disabled={!state().canSend}
                        onClick={() => void pendingIntents.send(composing().localId)}
                      >
                        Send
                      </button>
                      <button data-testid="editor-discard" onClick={() => pendingIntents.discard(composing().localId)}>
                        Discard
                      </button>
                    </div>
                  </>
                );
              }}
            </Match>

            <Match when={entry()?.phase === 'in-flight' ? entry() : null}>
              {(f) => {
                const inFlight = () => f() as Extract<PendingEntry, { phase: 'in-flight' }>;
                return (
                  <div data-testid="editor-in-flight">
                    <Show
                      when={inFlight().unconfirmed}
                      fallback={<p class="hint">Sending…</p>}
                    >
                      <p class="hint">
                        Delivery unconfirmed (may have reached upstream) — {inFlight().unconfirmed}
                      </p>
                      <button data-testid="editor-restore" onClick={() => pendingIntents.reopen(inFlight().localId)}>
                        Restore
                      </button>
                    </Show>
                  </div>
                );
              }}
            </Match>

            <Match when={entry()?.phase === 'rejected' ? entry() : null}>
              {(r) => {
                const rejected = () => r() as Extract<PendingEntry, { phase: 'rejected' }>;
                return (
                  <div data-testid="editor-rejected">
                    <p class="hint">
                      Rejected — {rejected().reason ?? <span class="toast-chrome">No reason given</span>}
                    </p>
                    <button data-testid="editor-restore" onClick={() => pendingIntents.reopen(rejected().localId)}>
                      Restore
                    </button>
                    <button data-testid="editor-discard" onClick={() => pendingIntents.discard(rejected().localId)}>
                      Discard
                    </button>
                  </div>
                );
              }}
            </Match>
          </Switch>
        </section>
    </Show>
  );
}
