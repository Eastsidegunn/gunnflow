/**
 * Settings: an overlay panel over the cockpit (the canvas stays visible
 * behind) editing the person's wiring file (90-user.json, merged last — it
 * always wins). Left rail: sections (View / Attention / Viewers). In View,
 * one tab per loaded wiring file — named from the file name itself — plus
 * the built-in default vocabulary; the connected workspace's kinds appear on
 * the first tab. Every choice is a closed engine token; each row shows where
 * its effective value comes from; nothing is saved unless the file and the
 * resulting merge validate. Saving applies at once.
 */
import { For, Show, createMemo, createResource, createSignal, type JSX, onCleanup } from 'solid-js';
import { manageFocus } from '../ui/focusScope.js';
import {
  ARRANGE_IDS,
  ATTENTION_MECHANISMS,
  CONTAIN_DIRECTIONS,
  EDGE_STYLE_IDS,
  attentionMechanism,
  configLenses,
  relationArrangeFor,
  relationDirectionFor,
  relationStyleFor,
  renderFor,
  validateWiringConfig,
  viewerFor,
  type ArrangeId,
  type EdgeStyleId,
  type ViewerId,
  type WiringConfig,
} from '@gunnflow/contract/wiring';
import type { WorkspaceStores } from '../state/stores.js';
import { EDGE_STROKE, NEUTRAL_GLYPH, NEUTRAL_TONE, glyphChar, toneColor } from '../canvas/tokens.js';
import { DEFAULT_KEYS, KEYBINDINGS, bindingLabel, duplicateOf, resolveKey, sanitizeKeys } from '../state/keybindings.js';
import { LOCALES, LOCALE_NAMES, isLocale, locale, msg, msgOf, raw, setLocale, t, tm, tn, type MessageKey, type Msg } from '../i18n/index.js';
import { fetchWiringFiles } from '../wiring/loadWiring.js';
import { loadUserWiring, removeUserWiringFile, saveUserWiring } from './client.js';
import {
  DEFAULT_TAB_ID,
  USER_FILE,
  attentionCauses,
  draftProblems,
  emptyUserConfig,
  mediaTypes,
  previewConfig,
  provenance,
  resetKey,
  setAttention,
  setRelation,
  keptRole,
  setRender,
  setViewer,
  sourceTabs,
  sourceUnobserved,
  viewSections,
  viewerOptions,
  type SharedKey,
  type Table,
} from './settingsModel.js';

type Section = 'view' | 'attention' | 'viewers' | 'prefs' | 'keys';
/** Rail sections and the catalog key of each one's name. */
const SECTIONS: readonly [Section, MessageKey][] = [
  ['view', 'settings.section.view'],
  ['attention', 'settings.section.attention'],
  ['viewers', 'settings.section.viewers'],
  ['prefs', 'settings.section.prefs'],
  ['keys', 'settings.section.keys'],
];

/** A provenance as shown: the engine's own layer names are translated, wiring file names stay verbatim. */
function provenanceLabel(src: string): string {
  if (src === 'my settings') return t('settings.source.mine');
  if (src === 'default') return t('settings.source.default');
  if (src === 'engine default') return t('settings.source.engine');
  return src;
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; reason: Msg };

export function SettingsScreen(props: { stores: WorkspaceStores; onClose: () => void; motion?: 'enter' | 'exit' }) {
  const { wiring, projectionStore, prefs } = props.stores;
  const [section, setSection] = createSignal<Section>('view');
  const [draft, setDraft] = createSignal<WiringConfig>(emptyUserConfig());
  // Problems are kept as messages and translated when shown, so they follow a language switch.
  const [loadProblemMsg, setLoadProblem] = createSignal<Msg | null>(null);
  const loadProblem = () => tm(loadProblemMsg());
  const [save, setSave] = createSignal<SaveState>({ kind: 'idle' });
  const [keyProblemMsg, setKeyProblem] = createSignal<Msg | null>(null);
  const keyProblem = () => tm(keyProblemMsg());
  // The person's current file is the starting draft.
  createResource(async () => {
    try {
      const file = await loadUserWiring();
      if (file === null) return;
      const v = validateWiringConfig(file);
      if (v.ok) setDraft(v.config);
      else setLoadProblem(msg('settings.loadInvalid', { problem: v.problems[0]! }));
    } catch (err) {
      setLoadProblem(msgOf(err));
    }
  });
  const edit = (next: WiringConfig) => {
    setDraft(next);
    setSave({ kind: 'idle' });
  };
  const layers = () => wiring.layers;
  const nodes = () => projectionStore.genericNodes()?.nodes ?? [];
  const preview = createMemo(() => previewConfig(draft(), layers()));
  const view = createMemo(() => viewSections(nodes(), preview()));
  const problems = createMemo(() => draftProblems(draft(), layers()));
  const saved = () => layers().find((l) => l.file === USER_FILE)?.config ?? emptyUserConfig();
  const dirty = createMemo(() => JSON.stringify(draft()) !== JSON.stringify(saved()));

  // Backend tabs come from the loaded config files themselves.
  const tabs = createMemo(() => sourceTabs(layers()));
  const [srcId, setSrcId] = createSignal<string | null>(null);
  const activeTab = createMemo(() => tabs().find((x) => x.id === srcId()) ?? tabs()[0]!);
  // The workspace's nodes belong to the connected upstream: its kinds show on the first tab.
  const showsWorkspace = createMemo(() => activeTab().id === tabs()[0]!.id);
  const notOnScreen = createMemo(() => sourceUnobserved(activeTab().config, nodes()));

  const doSave = async () => {
    if (problems().length > 0) return setSave({ kind: 'failed', reason: raw(problems()[0]!) });
    setSave({ kind: 'saving' });
    try {
      await saveUserWiring(draft());
      await wiring.refresh(fetchWiringFiles);
      setSave({ kind: 'saved' });
    } catch (err) {
      setSave({ kind: 'failed', reason: msgOf(err) });
    }
  };
  const resetAll = async () => {
    setSave({ kind: 'saving' });
    try {
      await removeUserWiringFile();
      setDraft(emptyUserConfig());
      await wiring.refresh(fetchWiringFiles);
      setSave({ kind: 'saved' });
    } catch (err) {
      setSave({ kind: 'failed', reason: msgOf(err) });
    }
  };

  /* ---- rows ---- */
  const Source = (p: { table: Table; k: string }) => {
    const src = () => provenance(p.table, p.k, layers(), draft());
    return (
      <span class="settings-source" data-testid={`prov-${p.table}-${p.k}`} data-mine={src() === 'my settings' ? 'yes' : 'no'}>
        {provenanceLabel(src())}
        <Show when={src() === 'my settings'}>
          {' '}
          <button class="linklike" data-testid={`reset-${p.table}-${p.k}`} onClick={() => edit(resetKey(draft(), p.table, p.k))}>
            {t('settings.backToDefault')}
          </button>
        </Show>
      </span>
    );
  };
  const Shared = (p: { item: SharedKey; here: string }) => (
    <Show when={p.item.kinds.length > 1}>
      <span class="settings-shared" title={t('settings.sharedTitle')}>
        {t('settings.sharedBy', { kinds: p.item.kinds.join(' · ') })}
      </span>
    </Show>
  );
  const Seg = (p: { options: readonly string[]; value: string; testid: (o: string) => string; onPick: (o: string) => void }) => (
    <span class="seg" role="group">
      <For each={p.options}>
        {(o) => (
          <button classList={{ active: p.value === o }} aria-pressed={p.value === o} data-testid={p.testid(o)} onClick={() => p.onPick(o)}>
            {o}
          </button>
        )}
      </For>
    </span>
  );
  const StateRow = (p: { k: string; scope: string; extra?: JSX.Element }) => {
    const cur = () => renderFor(preview(), p.k) ?? { glyph: NEUTRAL_GLYPH, tone: NEUTRAL_TONE };
    return (
      <div class="settings-row" data-testid={`state-${p.scope}-${p.k}`}>
        <span class="settings-key">
          {p.k}
          {p.extra}
        </span>
        <span class="settings-preview" style={{ color: toneColor(cur().tone) }}>
          {glyphChar(cur().glyph)}
        </span>
        <span class="settings-pickers">
          <input
            class="glyph-free"
            value={cur().glyph}
            maxLength={16}
            aria-label={t('settings.glyph')}
            data-testid={`glyph-free-${p.scope}-${p.k}`}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (v.trim()) edit(setRender(draft(), p.k, { glyph: v, tone: cur().tone }));
              else e.currentTarget.value = cur().glyph;
            }}
          />
          <label class="tone-wheel">
            <input
              type="color"
              value={toneColor(cur().tone)}
              aria-label={t('settings.tone')}
              data-testid={`tone-${p.scope}-${p.k}`}
              onChange={(e) => edit(setRender(draft(), p.k, { glyph: cur().glyph, tone: e.currentTarget.value }))}
            />
            <code>{toneColor(cur().tone)}</code>
          </label>
        </span>
        <Source table="render" k={p.k} />
      </div>
    );
  };
  const RelationRow = (p: { k: string; scope: string; extra?: JSX.Element }) => {
    const style = () => (relationStyleFor(preview(), p.k) ?? 'solid') as EdgeStyleId;
    const arrange = () => relationArrangeFor(preview(), p.k);
    const direction = () => relationDirectionFor(preview(), p.k);
    // `direction` is only a contain word; the entry carries it only when it means something ('out').
    const withDirection = (arrange: ArrangeId | undefined, direction: string) =>
      arrange === 'contain' && direction === 'out' ? { direction: 'out' as const } : {};
    const stroke = () => EDGE_STROKE[style()];
    return (
      <div class="settings-row" data-testid={`relation-${p.scope}-${p.k}`}>
        <span class="settings-key">
          {p.k}
          {p.extra}
        </span>
        <svg class="settings-preview" width="40" height="14" aria-hidden="true">
          <line x1="2" y1="5" x2="38" y2="5" stroke={stroke().color} stroke-width={stroke().width} />
          <Show when={stroke().double}>
            <line x1="2" y1="10" x2="38" y2="10" stroke={stroke().color} stroke-width={stroke().width} />
          </Show>
        </svg>
        <span class="settings-pickers">
          <label class="seg-label">
            {t('settings.relation.line')}{' '}
            <Seg
              options={EDGE_STYLE_IDS}
              value={style()}
              testid={(s) => `style-${p.scope}-${p.k}-${s}`}
              onPick={(s) => edit(setRelation(draft(), p.k, { style: s as EdgeStyleId, ...(arrange() !== 'none' ? { arrange: arrange() } : {}), ...withDirection(arrange(), direction()), ...keptRole(preview(), p.k) }))}
            />
          </label>
          <label class="seg-label">
            {t('settings.relation.layout')}{' '}
            <Seg
              options={ARRANGE_IDS}
              value={arrange()}
              testid={(a) => `arrange-${p.scope}-${p.k}-${a}`}
              onPick={(a) => edit(setRelation(draft(), p.k, { style: style(), arrange: a as ArrangeId, ...withDirection(a as ArrangeId, direction()), ...keptRole(preview(), p.k) }))}
            />
          </label>
          <Show when={arrange() === 'contain'}>
            <label class="seg-label" title={t('settings.relation.nestTitle')}>
              {t('settings.relation.nest')}{' '}
              <Seg
                options={CONTAIN_DIRECTIONS}
                value={direction()}
                testid={(d) => `direction-${p.scope}-${p.k}-${d}`}
                onPick={(d) => edit(setRelation(draft(), p.k, { style: style(), arrange: 'contain', ...withDirection('contain', d), ...keptRole(preview(), p.k) }))}
              />
            </label>
          </Show>
        </span>
        <Source table="relations" k={p.k} />
      </div>
    );
  };

  return (
    <div class="settings-overlay" data-motion={props.motion ?? 'enter'} data-testid="settings-screen" role="dialog" aria-label={t('settings.title')} ref={(el) => onCleanup(manageFocus(el, { trap: true }))}>
      <div class="settings-panel">
        <button data-testid="settings-close" class="settings-close" aria-label={t('settings.close')} onClick={props.onClose}>
          ✕
        </button>

        <aside class="settings-rail" role="tablist" aria-orientation="vertical">
          <h1>{t('settings.title')}</h1>
          <For each={SECTIONS}>
            {([id, nameKey]) => (
              <button role="tab" aria-selected={section() === id} classList={{ active: section() === id }} data-testid={`settings-tab-${id}`} onClick={() => setSection(id)}>
                {t(nameKey)}
              </button>
            )}
          </For>
        </aside>

        <div class="settings-main">
          <Show when={loadProblem()}>{(p) => <p class="hint warn">{p()}</p>}</Show>

          <Show when={section() === 'view'}>
            <nav class="settings-srctabs" role="tablist" aria-label={t('settings.configSource')}>
              <For each={tabs()}>
                {(tab) => (
                  <button
                    role="tab"
                    aria-selected={activeTab().id === tab.id}
                    classList={{ active: activeTab().id === tab.id }}
                    data-testid={`settings-src-${tab.name}`}
                    onClick={() => setSrcId(tab.id)}
                  >
                    {tab.id === DEFAULT_TAB_ID ? t('settings.source.default') : tab.name}
                  </button>
                )}
              </For>
            </nav>
            <div class="settings-content">
              <Show when={showsWorkspace()}>
                <For each={view().sections} fallback={<p class="hint">{t('settings.noNodes')}</p>}>
                  {(sec) => (
                    <section class="settings-kind" data-testid={`kind-${sec.kind}`}>
                      <h2>
                        {sec.kind} <span class="hint">· {tn('settings.nodeCount', sec.count)}</span>
                      </h2>
                      <h3>{t('settings.states')}</h3>
                      <For each={sec.states}>{(s) => <StateRow k={s.key} scope={sec.kind} extra={<Shared item={s} here={sec.kind} />} />}</For>
                      <Show when={sec.relations.length > 0}>
                        <h3>{t('settings.relations')}</h3>
                        <For each={sec.relations}>{(r) => <RelationRow k={r.key} scope={sec.kind} extra={<Shared item={r} here={sec.kind} />} />}</For>
                      </Show>
                    </section>
                  )}
                </For>
              </Show>
              <Show when={notOnScreen().states.length + notOnScreen().relations.length > 0}>
                <details class="settings-kind" data-testid="settings-unobserved" open={!showsWorkspace()}>
                  <summary>
                    {t('settings.unobserved', {
                      source: activeTab().id === DEFAULT_TAB_ID ? t('settings.source.default') : activeTab().name,
                      count: notOnScreen().states.length + notOnScreen().relations.length,
                    })}
                  </summary>
                  <For each={notOnScreen().states}>{(k) => <StateRow k={k} scope="unobserved" />}</For>
                  <For each={notOnScreen().relations}>{(k) => <RelationRow k={k} scope="unobserved" />}</For>
                </details>
              </Show>
            </div>
          </Show>

          <Show when={section() === 'attention'}>
            <div class="settings-content">
              <p class="hint">{t('settings.attention.intro')}</p>
              <For each={attentionCauses(nodes(), preview())} fallback={<p class="hint">{t('settings.attention.none')}</p>}>
                {(k) => (
                  <div class="settings-row" data-testid={`attention-row-${k}`}>
                    <span class="settings-key">{k}</span>
                    <span />
                    <span class="settings-pickers">
                      <Seg
                        options={ATTENTION_MECHANISMS}
                        value={attentionMechanism(preview(), k)}
                        testid={(m) => `attention-${k}-${m}`}
                        onPick={(m) => edit(setAttention(draft(), k, m as (typeof ATTENTION_MECHANISMS)[number]))}
                      />
                    </span>
                    <Source table="attention" k={k} />
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={section() === 'viewers'}>
            <div class="settings-content">
              <p class="hint">{t('settings.viewers.intro')}</p>
              <For each={mediaTypes(nodes(), preview())} fallback={<p class="hint">{t('settings.viewers.none')}</p>}>
                {(k) => (
                  <div class="settings-row" data-testid={`viewer-row-${k}`}>
                    <span class="settings-key">{k}</span>
                    <span />
                    <span class="settings-pickers">
                      <select value={viewerFor(preview(), k) ?? ''} data-testid={`viewer-${k}`} onChange={(e) => e.currentTarget.value && edit(setViewer(draft(), k, e.currentTarget.value as ViewerId))}>
                        <option value="" disabled>
                          {t('settings.viewers.fallback')}
                        </option>
                        <For each={viewerOptions(k)}>{(v) => <option value={v}>{v}</option>}</For>
                      </select>
                    </span>
                    <Source table="viewers" k={k} />
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={section() === 'prefs'}>
            <div class="settings-content">
              <p class="hint">
                {t('settings.prefs.introBefore')}
                <code>~/.gunnflow/prefs.json</code>
                {t('settings.prefs.introAfter')}
              </p>
              <div class="settings-row" data-testid="pref-row-locale">
                <span class="settings-key">{t('settings.prefs.language')}</span>
                <span />
                <span class="settings-pickers">
                  <select
                    value={locale()}
                    data-testid="pref-locale"
                    aria-label={t('locale.switch')}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      if (isLocale(v)) setLocale(v);
                    }}
                  >
                    <For each={LOCALES}>{(l) => <option value={l} lang={l}>{LOCALE_NAMES[l]}</option>}</For>
                  </select>
                  <span class="hint">{t('settings.prefs.languageHint')}</span>
                </span>
                <span class="settings-source">{t('settings.prefs.thisBrowser')}</span>
              </div>
              <div class="settings-row" data-testid="pref-row-zoom">
                <span class="settings-key">{t('settings.prefs.zoom')}</span>
                <span />
                <span class="settings-pickers">
                  <input
                    type="number" min="1.01" max="2" step="0.01" style={{ width: '90px' }}
                    value={prefs.prefs().zoomSensitivity}
                    data-testid="pref-zoom-sensitivity"
                    onChange={(e) => void prefs.save({ zoomSensitivity: Number(e.currentTarget.value) })}
                  />
                  <span class="hint">{t('settings.prefs.zoomHint')}</span>
                </span>
                <span class="settings-source">{t('settings.prefs.thisMachine')}</span>
              </div>
              <div class="settings-row" data-testid="pref-row-detail">
                <span class="settings-key">{t('settings.prefs.detailZoom')}</span>
                <span />
                <span class="settings-pickers">
                  <input
                    type="number" min="0" max="4" step="0.1" style={{ width: '90px' }}
                    value={prefs.prefs().detailZoom}
                    data-testid="pref-detail-zoom"
                    onChange={(e) => void prefs.save({ detailZoom: Number(e.currentTarget.value) })}
                  />
                  <span class="hint">{t('settings.prefs.detailZoomHint')}</span>
                </span>
                <span class="settings-source">{t('settings.prefs.thisMachine')}</span>
              </div>
              <div class="settings-row" data-testid="pref-row-lens">
                <span class="settings-key">{t('settings.prefs.defaultLens')}</span>
                <span />
                <span class="settings-pickers">
                  <select
                    value={prefs.prefs().defaultLens}
                    data-testid="pref-default-lens"
                    onChange={(e) => void prefs.save({ defaultLens: e.currentTarget.value })}
                  >
                    <option value="all">{t('sidebar.lensAll')}</option>
                    <For each={configLenses(preview())}>{(l) => <option value={l.id}>{l.label}</option>}</For>
                    <option value="plan">{t('sidebar.lensPlan')}</option>
                  </select>
                  <span class="hint">{t('settings.prefs.defaultLensHint')}</span>
                </span>
                <span class="settings-source">{t('settings.prefs.thisMachine')}</span>
              </div>
              <div class="settings-row" data-testid="pref-row-pack-containers">
                <span class="settings-key">{t('settings.prefs.packContainers')}</span>
                <span />
                <span class="settings-pickers">
                  <input
                    type="checkbox"
                    checked={prefs.prefs().packContainers}
                    data-testid="pref-pack-containers"
                    onChange={(e) => void prefs.save({ packContainers: e.currentTarget.checked })}
                  />
                  <span class="hint">{t('settings.prefs.packContainersHint')}</span>
                </span>
                <span class="settings-source">{t('settings.prefs.thisMachine')}</span>
              </div>
              <Show when={prefs.saveProblem()}>{(r) => <p class="hint warn">{t('settings.notSaved', { reason: r() })}</p>}</Show>
            </div>
          </Show>

          <Show when={section() === 'keys'}>
            <div class="settings-content">
              <p class="hint">
                {t('settings.keys.introBefore')}
                <code>~/.gunnflow/prefs.json</code>
                {t('settings.keys.introAfter')}
              </p>
              <For each={KEYBINDINGS}>
                {(b) => (
                  <div class="settings-row" data-testid={`key-row-${b.name}`}>
                    <span class="settings-key">{b.name}</span>
                    <span />
                    <span class="settings-pickers">
                      <input
                        style={{ width: '48px', 'text-align': 'center' }}
                        value={resolveKey(prefs.prefs().keys, b.name)}
                        aria-label={t('settings.keys.inputLabel', { binding: bindingLabel(b) })}
                        data-testid={`key-input-${b.name}`}
                        onChange={(e) => {
                          // sanitizeKeys is the one gatekeeper (astral characters count as one key).
                          const v = sanitizeKeys({ [b.name]: e.currentTarget.value })[b.name];
                          const dup = v !== undefined ? duplicateOf(prefs.prefs().keys, b.name, v) : null;
                          if (v !== undefined && dup === null) {
                            setKeyProblem(null);
                            void prefs.save({ keys: { ...prefs.prefs().keys, [b.name]: v } });
                          } else {
                            setKeyProblem(
                              dup !== null
                                ? msg('settings.keys.duplicate', { key: v!, binding: dup })
                                : msg('settings.keys.oneChar'),
                            );
                            e.currentTarget.value = resolveKey(prefs.prefs().keys, b.name);
                          }
                        }}
                      />
                      <span class="hint">{t('settings.keys.hint', { binding: bindingLabel(b), key: DEFAULT_KEYS[b.name].toUpperCase() })}</span>
                    </span>
                    <span class="settings-source">{t('settings.prefs.thisMachine')}</span>
                  </div>
                )}
              </For>
              <Show when={keyProblem()}>{(r) => <p class="hint warn" data-testid="key-problem">{r()}</p>}</Show>
              <Show when={prefs.saveProblem()}>{(r) => <p class="hint warn">{t('settings.notSaved', { reason: r() })}</p>}</Show>
            </div>
          </Show>

          <footer class="settings-foot">
            <span class="hint">
              {t('settings.foot.before')}
              <code>{USER_FILE}</code>
              {t('settings.foot.after')}
            </span>
            <span class="spacer" />
            <span class="settings-status" data-testid="settings-status" data-state={save().kind}>
              {(() => {
                const s = save();
                if (s.kind === 'failed') return t('settings.notSaved', { reason: s.reason });
                if (s.kind === 'saved') return t('settings.saved');
                if (s.kind === 'saving') return t('settings.saving');
                return dirty() ? (problems().length > 0 ? t('settings.cannotSave', { problem: problems()[0]! }) : t('settings.unsaved')) : '';
              })()}
            </span>
            <button data-testid="settings-reset-all" onClick={() => void resetAll()}>
              {t('settings.resetAll')}
            </button>
            <button data-testid="settings-save" class="primary" disabled={!dirty() || save().kind === 'saving'} onClick={() => void doSave()}>
              {t('settings.save')}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
