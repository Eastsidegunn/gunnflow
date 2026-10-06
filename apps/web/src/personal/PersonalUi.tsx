/**
 * Personal-layer UI: the node note, the sticky and box editors, the link
 * banner and the personal list. Everything here carries the personal grade
 * (the person's own local items, never sent anywhere) and takes nothing but
 * the personal stores — it has no access to intents, relay or evidence.
 */
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup } from 'solid-js';
import type { DiagramCache } from './diagrams.js';
import type { PersonalState } from './personalState.js';
import type { LinkEnd } from './schema.js';

export function PersonalGradeLabel() {
  return <p class="grade-label personal-label">personal · only on this machine · never sent</p>;
}

function SaveState(p: { personal: PersonalState }) {
  return (
    <span class="personal-save" data-testid="personal-save-state" data-state={p.personal.status()}>
      {({ saving: 'saving…', unsaved: 'editing…', ready: 'saved locally', loading: 'loading…', unavailable: 'not saved' } as const)[p.personal.status()]}
    </span>
  );
}

function ConnectButton(p: { personal: PersonalState; from: LinkEnd; label?: string }) {
  return (
    <button data-testid="personal-connect" disabled={!p.personal.writable()} onClick={() => p.personal.setConnectFrom(p.from)}>
      {p.label ?? 'Link to…'}
    </button>
  );
}

/** "My note" on a node: multi-line, saved locally as you type; the node can also be linked from the board. */
export function PersonalNoteSection(p: { personal: PersonalState; nodeId: string }) {
  return (
    <section class="personal-note" data-grade="personal" data-testid="personal-note">
      <h3>
        My note <SaveState personal={p.personal} />
      </h3>
      <PersonalGradeLabel />
      <textarea
        data-testid="personal-note-text"
        rows={4}
        placeholder="Notes for yourself — kept on this machine"
        value={p.personal.note(p.nodeId)}
        disabled={!p.personal.writable()}
        onInput={(e) => p.personal.setNote(p.nodeId, e.currentTarget.value)}
      />
      <ConnectButton personal={p.personal} from={{ kind: 'node', id: p.nodeId }} label="Link this node to…" />
      <Show when={p.personal.problem()}>{(why) => <p class="hint" data-testid="personal-problem">{why()}</p>}</Show>
    </section>
  );
}

/** While linking: what is being linked, and how to finish or cancel. */
export function ConnectBanner(p: { personal: PersonalState }) {
  return (
    <Show when={p.personal.connectFrom()}>
      {(from) => (
        <div class="personal-connect-banner" data-grade="personal" data-testid="personal-connect-banner">
          Linking from {from().kind} — click a note, box or node on the canvas (Esc to cancel)
          <button onClick={() => p.personal.setConnectFrom(null)}>Cancel</button>
        </div>
      )}
    </Show>
  );
}

/** Mermaid source editing commits after a pause (and on blur), so the renderer sees settled sources only. */
function DiagramEditor(p: { personal: PersonalState; diagrams: DiagramCache; id: string; source: string }) {
  const [draft, setDraft] = createSignal(p.source);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const commit = () => {
    clearTimeout(timer);
    if (draft() !== p.source) p.personal.updateSticky(p.id, { text: draft() });
  };
  onCleanup(commit);
  const entry = createMemo(() => {
    p.diagrams.version();
    return p.source.trim() ? p.diagrams.get(p.source) : null;
  });
  return (
    <>
      <textarea
        data-testid="sticky-text"
        class="personal-source"
        rows={10}
        spellcheck={false}
        value={draft()}
        placeholder="erDiagram / flowchart … (mermaid)"
        onInput={(e) => {
          setDraft(e.currentTarget.value);
          clearTimeout(timer);
          timer = setTimeout(commit, 700);
        }}
        onBlur={commit}
      />
      <p class="hint" data-testid="sticky-diagram-state" data-state={entry()?.state ?? 'empty'}>
        <Switch>
          <Match when={!entry()}>Write a mermaid diagram above.</Match>
          <Match when={entry()?.state === 'pending'}>Rendering on the isolated origin…</Match>
          <Match when={entry()?.state === 'ok'}>Rendered on the isolated origin.</Match>
          <Match when={entry()?.state === 'error' && entry()}>
            {(e) => <>Renderer unavailable — {(e() as { reason: string }).reason}. The canvas shows the source as text.</>}
          </Match>
        </Switch>
      </p>
    </>
  );
}

/** The open sticky or box's editor. */
export function PersonalItemPanel(p: { personal: PersonalState; diagrams: DiagramCache; liveIds: () => ReadonlySet<string> }) {
  const sticky = createMemo(() => (p.personal.open()?.kind === 'sticky' ? p.personal.doc().stickies.find((s) => s.id === p.personal.open()!.id) : undefined));
  const box = createMemo(() => (p.personal.open()?.kind === 'box' ? p.personal.doc().boxes.find((b) => b.id === p.personal.open()!.id) : undefined));
  return (
    <>
      <Show when={sticky()}>
        {(s) => (
          <aside class="generic-panel personal-panel" data-grade="personal" data-testid="sticky-panel" aria-label="Personal sticky note">
            <header>
              <h2>{s().kind === 'mermaid' ? 'Diagram note' : 'Sticky note'}</h2>
              <button data-testid="sticky-close" aria-label="Close" onClick={() => p.personal.setOpen(null)}>
                ✕
              </button>
            </header>
            <PersonalGradeLabel />
            <Show
              when={s().kind === 'mermaid'}
              fallback={
                <textarea
                  data-testid="sticky-text"
                  rows={6}
                  value={s().text}
                  placeholder="Write anything — this note is yours"
                  onInput={(e) => p.personal.updateSticky(s().id, { text: e.currentTarget.value })}
                />
              }
            >
              {/* Keyed by id so switching notes starts a fresh draft. */}
              <For each={[s().id]}>{(id) => <DiagramEditor personal={p.personal} diagrams={p.diagrams} id={id} source={s().text} />}</For>
            </Show>
            <div class="generic-actions">
              <ConnectButton personal={p.personal} from={{ kind: 'sticky', id: s().id }} />
              <button data-testid="sticky-delete" onClick={() => p.personal.removeSticky(s().id)}>
                Delete note
              </button>
              <SaveState personal={p.personal} />
            </div>
          </aside>
        )}
      </Show>
      <Show when={box()}>
        {(b) => (
          <aside class="generic-panel personal-panel" data-grade="personal" data-testid="box-panel" aria-label="Personal box">
            <header>
              <h2>Box</h2>
              <button data-testid="box-close" aria-label="Close" onClick={() => p.personal.setOpen(null)}>
                ✕
              </button>
            </header>
            <PersonalGradeLabel />
            <input data-testid="box-label" value={b().label} placeholder="Goal / subgoal" onInput={(e) => p.personal.updateBox(b().id, { label: e.currentTarget.value })} />
            <p class="hint">Notes, boxes and nodes placed inside move with it — your own grouping, not the workspace's.</p>
            <Show when={b().members.length > 0} fallback={<p class="hint">Drag workspace nodes into the box to file them here.</p>}>
              <ul class="personal-items" data-testid="box-members">
                <For each={b().members}>
                  {(m) => (
                    <li data-testid={`box-member-${m}`} data-missing={p.liveIds().has(m) ? 'no' : 'yes'}>
                      {m}
                      <Show when={!p.liveIds().has(m)}>
                        <span class="hint"> · no longer in the workspace</span>
                      </Show>{' '}
                      <button onClick={() => p.personal.placeNode(m, null)}>Take out</button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <div class="generic-actions">
              <ConnectButton personal={p.personal} from={{ kind: 'box', id: b().id }} />
              <button data-testid="box-delete" onClick={() => p.personal.removeBox(b().id)}>
                Delete box
              </button>
              <SaveState personal={p.personal} />
            </div>
          </aside>
        )}
      </Show>
    </>
  );
}

/** Every personal item, including notes and links whose node is gone (never silently dropped). */
export function PersonalList(p: { personal: PersonalState; liveIds: () => ReadonlySet<string>; onOpenNode: (id: string) => void; onClose: () => void }) {
  const notes = createMemo(() => Object.entries(p.personal.doc().notes));
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const endName = (e: LinkEnd) =>
    e.kind === 'node'
      ? `node ${e.id}`
      : e.kind === 'box'
        ? `box “${p.personal.doc().boxes.find((b) => b.id === e.id)?.label ?? e.id}”`
        : `note ${e.id}`;
  const broken = createMemo(() => new Set(p.personal.brokenLinks(p.liveIds()).map((l) => l.id)));
  return (
    <aside class="generic-panel personal-panel" data-grade="personal" data-testid="personal-list" aria-label="Personal notes">
      <header>
        <h2>Personal</h2>
        <button aria-label="Close" onClick={p.onClose}>
          ✕
        </button>
      </header>
      <PersonalGradeLabel />
      <h3>Node notes</h3>
      <Show when={notes().length > 0} fallback={<p class="hint">No node notes yet.</p>}>
        <ul class="personal-items">
          <For each={notes()}>
            {([nodeId, n]) => {
              const orphan = () => !p.liveIds().has(nodeId);
              return (
                <li data-testid={`personal-item-${nodeId}`} data-orphan={orphan() ? 'yes' : 'no'}>
                  <button disabled={orphan()} onClick={() => p.onOpenNode(nodeId)}>
                    {nodeId}
                  </button>
                  <Show when={orphan()}>
                    <span class="hint"> · node no longer in the workspace</span>
                  </Show>
                  <pre class="personal-text">{n.text}</pre>
                  <Show
                    when={confirming() === nodeId}
                    fallback={<button data-testid={`personal-forget-${nodeId}`} onClick={() => setConfirming(nodeId)}>Forget</button>}
                  >
                    <button data-testid={`personal-forget-confirm-${nodeId}`} onClick={() => (p.personal.setNote(nodeId, ''), setConfirming(null))}>
                      Forget this note
                    </button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <h3>Boxes</h3>
      <Show when={p.personal.doc().boxes.length > 0} fallback={<p class="hint">No boxes yet.</p>}>
        <ul class="personal-items">
          <For each={p.personal.doc().boxes}>
            {(b) => (
              <li>
                <button data-testid={`personal-box-${b.id}`} onClick={() => p.personal.setOpen({ kind: 'box', id: b.id })}>
                  ▢ {b.label || '(untitled)'}
                </button>
                <Show when={b.members.length > 0}>
                  <span class="hint">
                    {' '}
                    · {b.members.length} filed
                    {b.members.some((m) => !p.liveIds().has(m)) ? ` (${b.members.filter((m) => !p.liveIds().has(m)).length} missing)` : ''}
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h3>Links</h3>
      <Show when={p.personal.doc().links.length > 0} fallback={<p class="hint">No links yet — use “Link to…” on a note, box or node.</p>}>
        <ul class="personal-items">
          <For each={p.personal.doc().links}>
            {(l) => (
              <li data-testid={`personal-link-${l.id}`} data-broken={broken().has(l.id) ? 'yes' : 'no'}>
                {endName(l.from)} → {endName(l.to)}
                <Show when={broken().has(l.id)}>
                  <span class="hint"> · broken: the node is no longer in the workspace</span>
                </Show>
                <input value={l.label ?? ''} placeholder="label" onInput={(e) => p.personal.updateLink(l.id, e.currentTarget.value)} />
                <button onClick={() => p.personal.removeLink(l.id)}>Remove</button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="hint">{p.personal.doc().stickies.length} sticky note(s) on the canvas.</p>
    </aside>
  );
}
