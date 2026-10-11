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
import { t, tn, type Msg } from '../i18n/index.js';

export function PersonalGradeLabel() {
  return <p class="grade-label personal-label">{t('personal.grade')}</p>;
}

function SaveState(p: { personal: PersonalState }) {
  return (
    <span class="personal-save" data-testid="personal-save-state" data-state={p.personal.status()}>
      {t(`personal.save.${p.personal.status()}` as const)}
    </span>
  );
}

function ConnectButton(p: { personal: PersonalState; from: LinkEnd; label?: string }) {
  return (
    <button data-testid="personal-connect" disabled={!p.personal.writable()} onClick={() => p.personal.setConnectFrom(p.from)}>
      {p.label ?? t('personal.linkTo')}
    </button>
  );
}

/** "My note" on a node: multi-line, saved locally as you type; the node can also be linked from the board. */
export function PersonalNoteSection(p: { personal: PersonalState; nodeId: string }) {
  return (
    <section class="personal-note" data-grade="personal" data-testid="personal-note">
      <h3>
        {t('personal.note.title')} <SaveState personal={p.personal} />
      </h3>
      <PersonalGradeLabel />
      <textarea
        data-testid="personal-note-text"
        rows={4}
        placeholder={t('personal.note.placeholder')}
        value={p.personal.note(p.nodeId)}
        disabled={!p.personal.writable()}
        onInput={(e) => p.personal.setNote(p.nodeId, e.currentTarget.value)}
      />
      <ConnectButton personal={p.personal} from={{ kind: 'node', id: p.nodeId }} label={t('personal.note.linkNode')} />
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
          {t(`personal.connect.from.${from().kind}` as const)}
          <button onClick={() => p.personal.setConnectFrom(null)}>{t('personal.cancel')}</button>
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
        placeholder={t('personal.diagram.placeholder')}
        onInput={(e) => {
          setDraft(e.currentTarget.value);
          clearTimeout(timer);
          timer = setTimeout(commit, 700);
        }}
        onBlur={commit}
      />
      <p class="hint" data-testid="sticky-diagram-state" data-state={entry()?.state ?? 'empty'}>
        <Switch>
          <Match when={!entry()}>{t('personal.diagram.write')}</Match>
          <Match when={entry()?.state === 'pending'}>{t('personal.diagram.pending')}</Match>
          <Match when={entry()?.state === 'ok'}>{t('personal.diagram.ok')}</Match>
          <Match when={entry()?.state === 'error' && entry()}>
            {(e) => <>{t('personal.diagram.error', { reason: (e() as { reason: Msg }).reason })}</>}
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
          <aside class="generic-panel personal-panel" data-grade="personal" data-testid="sticky-panel" aria-label={t('personal.sticky.aria')}>
            <header>
              <h2>{s().kind === 'mermaid' ? t('personal.sticky.diagramTitle') : t('personal.sticky.title')}</h2>
              <button data-testid="sticky-close" aria-label={t('personal.close')} onClick={() => p.personal.setOpen(null)}>
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
                  placeholder={t('personal.sticky.placeholder')}
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
                {t('personal.sticky.delete')}
              </button>
              <SaveState personal={p.personal} />
            </div>
          </aside>
        )}
      </Show>
      <Show when={box()}>
        {(b) => (
          <aside class="generic-panel personal-panel" data-grade="personal" data-testid="box-panel" aria-label={t('personal.box.aria')}>
            <header>
              <h2>{t('personal.box.title')}</h2>
              <button data-testid="box-close" aria-label={t('personal.close')} onClick={() => p.personal.setOpen(null)}>
                ✕
              </button>
            </header>
            <PersonalGradeLabel />
            <input data-testid="box-label" value={b().label} placeholder={t('personal.box.placeholder')} onInput={(e) => p.personal.updateBox(b().id, { label: e.currentTarget.value })} />
            <p class="hint">{t('personal.box.hint')}</p>
            <Show when={b().members.length > 0} fallback={<p class="hint">{t('personal.box.emptyMembers')}</p>}>
              <ul class="personal-items" data-testid="box-members">
                <For each={b().members}>
                  {(m) => (
                    <li data-testid={`box-member-${m}`} data-missing={p.liveIds().has(m) ? 'no' : 'yes'}>
                      {m}
                      <Show when={!p.liveIds().has(m)}>
                        <span class="hint"> · {t('personal.box.memberGone')}</span>
                      </Show>{' '}
                      <button onClick={() => p.personal.placeNode(m, null)}>{t('personal.box.takeOut')}</button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <div class="generic-actions">
              <ConnectButton personal={p.personal} from={{ kind: 'box', id: b().id }} />
              <button data-testid="box-delete" onClick={() => p.personal.removeBox(b().id)}>
                {t('personal.box.delete')}
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
      ? t('personal.end.node', { id: e.id })
      : e.kind === 'box'
        ? t('personal.end.box', { label: p.personal.doc().boxes.find((b) => b.id === e.id)?.label ?? e.id })
        : t('personal.end.note', { id: e.id });
  const broken = createMemo(() => new Set(p.personal.brokenLinks(p.liveIds()).map((l) => l.id)));
  return (
    <aside class="generic-panel personal-panel" data-grade="personal" data-testid="personal-list" aria-label={t('personal.list.aria')}>
      <header>
        <h2>{t('personal.list.title')}</h2>
        <button aria-label={t('personal.close')} onClick={p.onClose}>
          ✕
        </button>
      </header>
      <PersonalGradeLabel />
      <h3>{t('personal.list.notes')}</h3>
      <Show when={notes().length > 0} fallback={<p class="hint">{t('personal.list.noNotes')}</p>}>
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
                    <span class="hint"> · {t('personal.list.nodeGone')}</span>
                  </Show>
                  <pre class="personal-text">{n.text}</pre>
                  <Show
                    when={confirming() === nodeId}
                    fallback={<button data-testid={`personal-forget-${nodeId}`} onClick={() => setConfirming(nodeId)}>{t('personal.list.forget')}</button>}
                  >
                    <button data-testid={`personal-forget-confirm-${nodeId}`} onClick={() => (p.personal.setNote(nodeId, ''), setConfirming(null))}>
                      {t('personal.list.forgetConfirm')}
                    </button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <h3>{t('personal.list.boxes')}</h3>
      <Show when={p.personal.doc().boxes.length > 0} fallback={<p class="hint">{t('personal.list.noBoxes')}</p>}>
        <ul class="personal-items">
          <For each={p.personal.doc().boxes}>
            {(b) => (
              <li>
                <button data-testid={`personal-box-${b.id}`} onClick={() => p.personal.setOpen({ kind: 'box', id: b.id })}>
                  ▢ {b.label || t('personal.untitled')}
                </button>
                <Show when={b.members.length > 0}>
                  <span class="hint">
                    {' '}
                    · {tn('personal.filed', b.members.length)}
                    {b.members.some((m) => !p.liveIds().has(m)) ? ` (${tn('personal.missing', b.members.filter((m) => !p.liveIds().has(m)).length)})` : ''}
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h3>{t('personal.list.links')}</h3>
      <Show when={p.personal.doc().links.length > 0} fallback={<p class="hint">{t('personal.list.noLinks')}</p>}>
        <ul class="personal-items">
          <For each={p.personal.doc().links}>
            {(l) => (
              <li data-testid={`personal-link-${l.id}`} data-broken={broken().has(l.id) ? 'yes' : 'no'}>
                {endName(l.from)} → {endName(l.to)}
                <Show when={broken().has(l.id)}>
                  <span class="hint"> · {t('personal.list.broken')}</span>
                </Show>
                <input value={l.label ?? ''} placeholder={t('personal.list.linkLabel')} onInput={(e) => p.personal.updateLink(l.id, e.currentTarget.value)} />
                <button onClick={() => p.personal.removeLink(l.id)}>{t('personal.list.remove')}</button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="hint">{tn('personal.list.stickies', p.personal.doc().stickies.length)}</p>
    </aside>
  );
}
