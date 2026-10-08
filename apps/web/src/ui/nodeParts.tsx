/**
 * Shared node machinery: the on-demand detail section and the assembly ×
 * capabilities action area. One implementation serves the ② stage, the ③
 * assembly fallback and the decision inbox — the invariants (claim grading,
 * digest/evidence binding, pending lifecycle) live here once.
 */
import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js';
import type { NodeProjection } from '@gunnflow/contract';
import { actionLabel, detailCollapsed, detailCopyable, detailEmphasis } from '@gunnflow/contract/wiring';
import type { WorkspaceStores } from '../state/stores.js';
import type { Intent } from '../model/types.js';
import type { ResolvedAction, ResolvedParts } from '../canvas/parts.js';
import { actionGate, openGate } from '../state/genericActions.js';
import { copiedStatement, tokenizeCopyText } from '../state/copyText.js';
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
  // Config label matches (verbatim); the engine never reads what a label means.
  const emphasized = (label: string) => detailEmphasis(wiring.config).includes(label);
  const collapsed = (label: string) => detailCollapsed(wiring.config).includes(label);
  const copyable = (label: string) => detailCopyable(wiring.config).includes(label);
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
            {/* Everything inside is agent-written content: one claim stripe along its left. */}
            <div class="node-detail-claim" data-grade="claim" data-testid="node-detail-claim">
              <For each={d().detail.items}>
                {(item, i) => {
                  // Folded, never hidden: the label line stays and opens in place.
                  const folds = collapsed(item.label);
                  const [open, setOpen] = createSignal(!folds);
                  return (
                    // The whole item — label included — is upstream vocabulary: claim grade.
                    <div
                      class="node-detail-item"
                      data-grade="claim"
                      data-emphasis={emphasized(item.label) ? 'config' : undefined}
                      data-folded={folds ? (open() ? 'open' : 'folded') : undefined}
                      data-testid={`node-detail-item-${i()}`}
                    >
                      <Show when={folds} fallback={<span class="field-label detail-heading">{item.label}</span>}>
                        <button
                          class="detail-fold"
                          aria-expanded={open()}
                          data-testid={`node-detail-fold-${i()}`}
                          onClick={() => setOpen(!open())}
                        >
                          {open() ? '▾' : '▸'} {item.label}
                        </button>
                      </Show>
                      <Show when={open()}>
                        {item.text !== undefined ? (
                          copyable(item.label) ? (
                            <CopyBox text={item.text} testId={`copy-box-${i()}`} />
                          ) : (
                            // Plain glyphs only, no escape or markup interpretation.
                            <pre class="detail-text">{item.text}</pre>
                          )
                        ) : item.artifact ? (
                          <ArtifactViewer
                            artifactId={item.artifact.id}
                            artifact={item.artifact}
                            snapshotBase64={projectionStore.projection().artifactSnapshots?.[item.artifact.id]}
                            config={wiring.config}
                            testIdPrefix="node-detail-viewer"
                          />
                        ) : null}
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </section>
        )}
      </Show>
    </>
  );
}

/**
 * 결정함 F10 — an exact-bytes copy box (wiring `detail.copyable`). The text is
 * agent content (claim grade), shown with line numbers and with every
 * invisible character given a visible marker; the markers are CSS-drawn
 * beside the raw characters, so the box holds exactly the received string.
 * 복사 writes that very string (never text read back from the DOM), and the
 * statement under the button is computed from the same value. Gunnflow never
 * runs it — there is no execute affordance of any kind.
 */
export function CopyBox(props: { text: string; testId: string }) {
  const lines = createMemo(() => tokenizeCopyText(props.text));
  const [status, setStatus] = createSignal<{ kind: 'copied'; statement: string } | { kind: 'failed' } | null>(null);
  let code: HTMLElement | undefined;
  const selectBox = () => {
    const sel = window.getSelection();
    if (!sel || !code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const copy = () => {
    // The value rendered above — the same string, never re-derived from the page.
    const value = props.text;
    const failed = () => {
      setStatus({ kind: 'failed' });
      selectBox();
    };
    try {
      const writing = navigator.clipboard?.writeText(value);
      if (!writing) return failed();
      writing.then(() => setStatus({ kind: 'copied', statement: copiedStatement(value) }), failed);
    } catch {
      failed();
    }
  };
  return (
    <div class="copy-box" data-grade="claim" data-testid={props.testId}>
      <div class="copy-box-frame">
        <div class="copy-gutter" aria-hidden="true">
          <For each={lines()}>{(l) => <span data-testid={`${props.testId}-line`}>{l.number}</span>}</For>
        </div>
        <code class="copy-code" ref={(el) => (code = el)} data-testid={`${props.testId}-code`}>
          <For each={lines()}>
            {(l) => (
              <For each={l.tokens}>
                {(t) =>
                  t.kind === 'text' ? (
                    t.raw
                  ) : (
                    <span class="copy-mark" data-cls={t.cls} data-mark={t.mark} data-testid={`${props.testId}-mark`}>
                      <span class="copy-raw">{t.raw}</span>
                    </span>
                  )
                }
              </For>
            )}
          </For>
        </code>
        <button
          class="copy-button"
          data-testid={`${props.testId}-copy`}
          data-state={status()?.kind ?? 'idle'}
          onClick={copy}
        >
          {(() => {
            const s = status();
            return s?.kind === 'copied' ? s.statement : '복사';
          })()}
        </button>
      </div>
      <Show when={status()?.kind === 'failed'}>
        <p class="copy-failed" role="alert" data-testid={`${props.testId}-failed`}>
          복사 실패 — 직접 선택해 복사하세요
        </p>
      </Show>
      <p class="hint copy-note">Gunnflow는 명령을 실행하지 않습니다 — 터미널에서 실행하세요</p>
    </div>
  );
}


/**
 * The node's actions (assembly × capabilities), interactive. Inputs live in
 * composing entries; sends go through the pending store's single send
 * transition and the guarded relay. Evidence is bound by artifact id and the
 * attestation states exactly the renders made here. Buttons print the
 * wiring's action label (`actions[name].label`), else the raw action name.
 *
 * layout 'bar' (결정함 F5): one horizontal bar, the first action primary. An
 * action whose capability REQUIRES text opens a multi-line field above the
 * bar (보내기 / 취소); the primary action's OPTIONAL text sits inline in the
 * bar; other optional inputs are not collected there (the click sends).
 */
export function NodeActions(props: {
  stores: WorkspaceStores;
  node: NodeProjection;
  resolved: ResolvedParts;
  /** Open evidence viewers at once (the evidence is part of the surface). */
  autoOpenEvidence?: boolean;
  /** Called when a send left this surface (the pending machinery owns the rest). */
  onSent?: () => void;
  /** 'bar': the decision inbox's horizontal action bar; default: the stacked controls. */
  layout?: 'stack' | 'bar';
}) {
  const { projectionStore, pendingIntents, wiring } = props.stores;
  // Keyed by action name so controls (and their evidence views) survive projection updates.
  const actionNames = createMemo(() => props.resolved.actions.map((a) => a.action), [], {
    equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  });
  /** Evidence renders on this surface, by artifact id. */
  const [views, setViews] = createSignal<ReadonlyMap<string, DisplayToken>>(new Map());
  const bar = props.layout === 'bar';
  /** The bar's one open reason field (by action name). */
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const labelOf = (action: string) => actionLabel(wiring.config, action);

  return (
    <Show
      when={actionNames().length > 0}
      fallback={
        <p class="no-actions" data-testid="no-actions">
          이 항목에 상류가 선언한 행동이 없습니다
        </p>
      }
    >
      <div class={bar ? 'action-bar' : 'generic-actions'} data-testid={bar ? 'action-bar' : undefined}>
        <For each={actionNames()}>
          {(name, i) => (
            <Show when={props.resolved.actions.find((a) => a.action === name)}>
              {(a) => <ActionControl node={props.node} action={a()} primary={i() === 0} />}
            </Show>
          )}
        </For>
      </div>
    </Show>
  );

  function ActionControl(p: { node: NodeProjection; action: ResolvedAction; primary: boolean }) {
    const a = () => p.action;
    const label = () => labelOf(a().action);
    const hasEditor = (() => { const x = a(); return x.kind === 'assembled' && x.inputs.some((i) => i.part === 'editor'); })();
    if (hasEditor) {
      // Edit is the editor part's own flow (base display, digest, attestation), shown where the capability declares an edit slot.
      const edit = () => p.node.capabilities.find((c) => c.action === a().action)?.edit;
      return (
        <div class={bar ? 'bar-wide' : undefined}>
          <Show when={edit()}>{<FakeEditorPart stores={props.stores} taskId={p.node.id} />}</Show>
        </div>
      );
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
    const requiredText = () => cap()?.decision?.input?.required === true;
    /** Where this action's text input lives: the stacked field, the bar's expanding field, inline in the bar, or nowhere. */
    const textMode = (): 'field' | 'expand' | 'inline' | 'none' => {
      if (!hasText()) return 'none';
      if (!bar) return 'field';
      if (requiredText()) return 'expand';
      return p.primary ? 'inline' : 'none';
    };
    const isExpanded = () => expanded() === a().action;

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
      if (hasText() && requiredText() && !d.text?.trim()) return false;
      if (hasChoice() && !d.option) return false;
      return evidence().every((id) => views().has(id));
    };
    const gate = () => actionGate(a(), preconditions());
    const reason = () => (gate().runnable ? null : (gate() as { reason: string }).reason);

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
      if (isExpanded()) setExpanded(null);
      props.onSent?.();
    };
    const onSendClick = () => {
      if (a().kind === 'fallback') {
        void pendingIntents.submit({ nodeId: p.node.id, action: a().action });
        props.onSent?.();
      } else {
        send();
      }
    };
    // The bar hides the "fill in" reason while a required field is still closed (the click opens it).
    const showReason = () => {
      const r = reason();
      if (r === null || r === 'read-only — switch to Intervene') return false;
      return !(textMode() === 'expand' && !isExpanded() && r === 'fill in what this action requires');
    };

    return (
      <div class="generic-action" data-testid={`generic-action-${a().action}`} data-kind={a().kind}>
        <Show when={evidence().length > 0}>
          <div class={bar ? 'bar-wide bar-evidence' : 'evidence-list'}>
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
          </div>
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
        <Show when={textMode() === 'field'}>
          <label class="field-label" for={`text-${a().action}`}>
            {label()}{requiredText() ? ' (required)' : ''}
          </label>
          <input
            id={`text-${a().action}`}
            data-testid={`generic-text-${a().action}`}
            placeholder={requiredText() ? 'required' : 'optional'}
            value={decision().text ?? ''}
            onInput={(e) => setDecision({ text: e.currentTarget.value })}
          />
        </Show>
        <Show when={textMode() === 'inline'}>
          <input
            class="bar-inline-text"
            data-testid={`generic-text-${a().action}`}
            aria-label={`${label()} 메모 (선택)`}
            placeholder={`${label()} 메모 (선택)`}
            value={decision().text ?? ''}
            onInput={(e) => setDecision({ text: e.currentTarget.value })}
          />
        </Show>
        <Show when={textMode() === 'expand' && isExpanded()}>
          <div class="bar-expand" data-testid={`action-expand-${a().action}`}>
            <textarea
              rows={3}
              data-testid={`generic-text-${a().action}`}
              aria-label={`${label()} 사유`}
              placeholder={`${label()} 사유`}
              value={decision().text ?? ''}
              onInput={(e) => setDecision({ text: e.currentTarget.value })}
              ref={(el) => queueMicrotask(() => el.focus())}
            />
            <div class="bar-expand-buttons">
              <button
                class="primary"
                data-testid={`generic-send-${a().action}`}
                disabled={!gate().runnable || inFlight()}
                title={gate().runnable ? a().action : (reason() ?? undefined)}
                onClick={send}
              >
                보내기
              </button>
              {/* Closing keeps what was typed (the composing entry stays); nothing is discarded here. */}
              <button data-testid={`generic-cancel-${a().action}`} onClick={() => setExpanded(null)}>
                취소
              </button>
            </div>
          </div>
        </Show>
        <Show
          when={textMode() === 'expand'}
          fallback={
            <button
              classList={{ primary: bar && p.primary }}
              data-testid={`generic-send-${a().action}`}
              disabled={!gate().runnable || inFlight()}
              aria-describedby={!gate().runnable ? `reason-${a().action}` : undefined}
              title={gate().runnable ? a().action : (reason() ?? undefined)}
              onClick={onSendClick}
            >
              {label()}
            </button>
          }
        >
          <button
            classList={{ primary: p.primary }}
            data-testid={`generic-open-${a().action}`}
            aria-expanded={isExpanded()}
            disabled={!openGate(a()).runnable || inFlight()}
            title={a().action}
            onClick={() => setExpanded(isExpanded() ? null : a().action)}
          >
            {label()}
          </button>
        </Show>
        <Show when={evidence().length > 0}>
          <span class="hint bar-note" data-testid={`evidence-count-${a().action}`}>
            Evidence viewed {evidence().filter((id) => views().has(id)).length}/{evidence().length}
          </span>
        </Show>
        <Show when={showReason()}>
          <span class="hint bar-note" data-testid={`generic-reason-${a().action}`} id={`reason-${a().action}`}>
            {reason()}
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
            <span class="send-receipt bar-note" data-state="sending" data-testid={`receipt-${a().action}`}>Sending…</span>
          </Show>
          <Show when={!inFlight() && errFor()}>
            {(err) => (
              <span class="send-receipt bar-note" data-state="failed" data-testid={`receipt-${a().action}`}>
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
            <span class="send-receipt bar-note" data-state="confirmed" data-testid={`receipt-${a().action}`}>Confirmed</span>
          </Show>
        </>
      );
    }
  }
}
