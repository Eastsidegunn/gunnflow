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
import { DEFAULT_KEYS, KEYBINDINGS, duplicateOf, resolveKey, sanitizeKeys } from '../state/keybindings.js';
import { fetchWiringFiles } from '../wiring/loadWiring.js';
import { loadUserWiring, removeUserWiringFile, saveUserWiring } from './client.js';
import {
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
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; reason: string };

export function SettingsScreen(props: { stores: WorkspaceStores; onClose: () => void; motion?: 'enter' | 'exit' }) {
  const { wiring, projectionStore, prefs } = props.stores;
  const [section, setSection] = createSignal<Section>('view');
  const [draft, setDraft] = createSignal<WiringConfig>(emptyUserConfig());
  const [loadProblem, setLoadProblem] = createSignal<string | null>(null);
  const [save, setSave] = createSignal<SaveState>({ kind: 'idle' });
  const [keyProblem, setKeyProblem] = createSignal<string | null>(null);
  // The person's current file is the starting draft.
  createResource(async () => {
    try {
      const raw = await loadUserWiring();
      if (raw === null) return;
      const v = validateWiringConfig(raw);
      if (v.ok) setDraft(v.config);
      else setLoadProblem(`your settings file is invalid (${v.problems[0]}); saving will replace it`);
    } catch (err) {
      setLoadProblem(err instanceof Error ? err.message : String(err));
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
  const activeTab = createMemo(() => tabs().find((t) => t.id === srcId()) ?? tabs()[0]!);
  // The workspace's nodes belong to the connected upstream: its kinds show on the first tab.
  const showsWorkspace = createMemo(() => activeTab().id === tabs()[0]!.id);
  const notOnScreen = createMemo(() => sourceUnobserved(activeTab().config, nodes()));

  const doSave = async () => {
    if (problems().length > 0) return setSave({ kind: 'failed', reason: problems()[0]! });
    setSave({ kind: 'saving' });
    try {
      await saveUserWiring(draft());
      await wiring.refresh(fetchWiringFiles);
      setSave({ kind: 'saved' });
    } catch (err) {
      setSave({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) });
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
      setSave({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) });
    }
  };

  /* ---- rows ---- */
  const Source = (p: { table: Table; k: string }) => {
    const src = () => provenance(p.table, p.k, layers(), draft());
    return (
      <span class="settings-source" data-testid={`prov-${p.table}-${p.k}`} data-mine={src() === 'my settings' ? 'yes' : 'no'}>
        {src()}
        <Show when={src() === 'my settings'}>
          {' '}
          <button class="linklike" data-testid={`reset-${p.table}-${p.k}`} onClick={() => edit(resetKey(draft(), p.table, p.k))}>
            back to default
          </button>
        </Show>
      </span>
    );
  };
  const Shared = (p: { item: SharedKey; here: string }) => (
    <Show when={p.item.kinds.length > 1}>
      <span class="settings-shared" title="One setting: changing it here changes it in every kind that uses it.">
        shared by {p.item.kinds.join(' · ')}
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
            aria-label="Glyph (any character or emoji)"
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
              aria-label="Tone colour"
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
            line{' '}
            <Seg
              options={EDGE_STYLE_IDS}
              value={style()}
              testid={(s) => `style-${p.scope}-${p.k}-${s}`}
              onPick={(s) => edit(setRelation(draft(), p.k, { style: s as EdgeStyleId, ...(arrange() !== 'none' ? { arrange: arrange() } : {}), ...withDirection(arrange(), direction()) }))}
            />
          </label>
          <label class="seg-label">
            layout{' '}
            <Seg
              options={ARRANGE_IDS}
              value={arrange()}
              testid={(a) => `arrange-${p.scope}-${p.k}-${a}`}
              onPick={(a) => edit(setRelation(draft(), p.k, { style: style(), arrange: a as ArrangeId, ...withDirection(a as ArrangeId, direction()) }))}
            />
          </label>
          <Show when={arrange() === 'contain'}>
            <label class="seg-label" title="Which end the box wraps: 'in' nests the node inside its target, 'out' nests the target inside the node">
              nest{' '}
              <Seg
                options={CONTAIN_DIRECTIONS}
                value={direction()}
                testid={(d) => `direction-${p.scope}-${p.k}-${d}`}
                onPick={(d) => edit(setRelation(draft(), p.k, { style: style(), arrange: 'contain', ...withDirection('contain', d) }))}
              />
            </label>
          </Show>
        </span>
        <Source table="relations" k={p.k} />
      </div>
    );
  };

  return (
    <div class="settings-overlay" data-motion={props.motion ?? 'enter'} data-testid="settings-screen" role="dialog" aria-label="Settings" ref={(el) => onCleanup(manageFocus(el, { trap: true }))}>
      <div class="settings-panel">
        <button data-testid="settings-close" class="settings-close" aria-label="Close settings" onClick={props.onClose}>
          ✕
        </button>

        <aside class="settings-rail" role="tablist" aria-orientation="vertical">
          <h1>Settings</h1>
          <For each={[['view', 'View'], ['attention', 'Attention'], ['viewers', 'Viewers'], ['prefs', 'Preferences'], ['keys', '단축키']] as [Section, string][]}>
            {([id, name]) => (
              <button role="tab" aria-selected={section() === id} classList={{ active: section() === id }} data-testid={`settings-tab-${id}`} onClick={() => setSection(id)}>
                {name}
              </button>
            )}
          </For>
        </aside>

        <div class="settings-main">
          <Show when={loadProblem()}>{(p) => <p class="hint warn">{p()}</p>}</Show>

          <Show when={section() === 'view'}>
            <nav class="settings-srctabs" role="tablist" aria-label="Config source">
              <For each={tabs()}>
                {(t) => (
                  <button
                    role="tab"
                    aria-selected={activeTab().id === t.id}
                    classList={{ active: activeTab().id === t.id }}
                    data-testid={`settings-src-${t.name}`}
                    onClick={() => setSrcId(t.id)}
                  >
                    {t.name}
                  </button>
                )}
              </For>
            </nav>
            <div class="settings-content">
              <Show when={showsWorkspace()}>
                <For each={view().sections} fallback={<p class="hint">The workspace shows no nodes yet.</p>}>
                  {(sec) => (
                    <section class="settings-kind" data-testid={`kind-${sec.kind}`}>
                      <h2>
                        {sec.kind} <span class="hint">· {sec.count} node{sec.count === 1 ? '' : 's'}</span>
                      </h2>
                      <h3>States</h3>
                      <For each={sec.states}>{(s) => <StateRow k={s.key} scope={sec.kind} extra={<Shared item={s} here={sec.kind} />} />}</For>
                      <Show when={sec.relations.length > 0}>
                        <h3>Relations</h3>
                        <For each={sec.relations}>{(r) => <RelationRow k={r.key} scope={sec.kind} extra={<Shared item={r} here={sec.kind} />} />}</For>
                      </Show>
                    </section>
                  )}
                </For>
              </Show>
              <Show when={notOnScreen().states.length + notOnScreen().relations.length > 0}>
                <details class="settings-kind" data-testid="settings-unobserved" open={!showsWorkspace()}>
                  <summary>
                    Mapped by {activeTab().name}, not on screen now ({notOnScreen().states.length + notOnScreen().relations.length})
                  </summary>
                  <For each={notOnScreen().states}>{(k) => <StateRow k={k} scope="unobserved" />}</For>
                  <For each={notOnScreen().relations}>{(k) => <RelationRow k={k} scope="unobserved" />}</For>
                </details>
              </Show>
            </div>
          </Show>

          <Show when={section() === 'attention'}>
            <div class="settings-content">
              <p class="hint">Which causes may interrupt you; the rest stay ambient. The causes come from the backend.</p>
              <For each={attentionCauses(nodes(), preview())} fallback={<p class="hint">No attention causes in this workspace yet.</p>}>
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
              <p class="hint">How each file type is shown. Only viewers the engine allows for the type are offered.</p>
              <For each={mediaTypes(nodes(), preview())} fallback={<p class="hint">No artifacts in this workspace yet.</p>}>
                {(k) => (
                  <div class="settings-row" data-testid={`viewer-row-${k}`}>
                    <span class="settings-key">{k}</span>
                    <span />
                    <span class="settings-pickers">
                      <select value={viewerFor(preview(), k) ?? ''} data-testid={`viewer-${k}`} onChange={(e) => e.currentTarget.value && edit(setViewer(draft(), k, e.currentTarget.value as ViewerId))}>
                        <option value="" disabled>
                          (engine fallback)
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
                This machine only (<code>~/.gunnflow/prefs.json</code>) — ergonomics, not workspace vocabulary. Changes apply and save at once.
              </p>
              <div class="settings-row" data-testid="pref-row-zoom">
                <span class="settings-key">zoom sensitivity</span>
                <span />
                <span class="settings-pickers">
                  <input
                    type="number" min="1.01" max="2" step="0.01" style={{ width: '90px' }}
                    value={prefs.prefs().zoomSensitivity}
                    data-testid="pref-zoom-sensitivity"
                    onChange={(e) => void prefs.save({ zoomSensitivity: Number(e.currentTarget.value) })}
                  />
                  <span class="hint">wheel factor per notch</span>
                </span>
                <span class="settings-source">this machine</span>
              </div>
              <div class="settings-row" data-testid="pref-row-detail">
                <span class="settings-key">detail zoom</span>
                <span />
                <span class="settings-pickers">
                  <input
                    type="number" min="0" max="4" step="0.1" style={{ width: '90px' }}
                    value={prefs.prefs().detailZoom}
                    data-testid="pref-detail-zoom"
                    onChange={(e) => void prefs.save({ detailZoom: Number(e.currentTarget.value) })}
                  />
                  <span class="hint">camera zoom at which node detail appears</span>
                </span>
                <span class="settings-source">this machine</span>
              </div>
              <div class="settings-row" data-testid="pref-row-lens">
                <span class="settings-key">default lens</span>
                <span />
                <span class="settings-pickers">
                  <select
                    value={prefs.prefs().defaultLens}
                    data-testid="pref-default-lens"
                    onChange={(e) => void prefs.save({ defaultLens: e.currentTarget.value })}
                  >
                    <option value="all">Workspace</option>
                    <For each={configLenses(preview())}>{(l) => <option value={l.id}>{l.label}</option>}</For>
                    <option value="plan">Plan</option>
                  </select>
                  <span class="hint">lens selected at boot</span>
                </span>
                <span class="settings-source">this machine</span>
              </div>
              <Show when={prefs.saveProblem()}>{(r) => <p class="hint warn">not saved — {r()}</p>}</Show>
            </div>
          </Show>

          <Show when={section() === 'keys'}>
            <div class="settings-content">
              <p class="hint">
                단축키 — 이 기기 전용(<code>~/.gunnflow/prefs.json</code>, 상류로 0바이트). 엔진은 바인딩 이름만 알고,
                키는 여기서 읽는다. 한 글자 키만 받고, 이미 쓰는 키는 거부한다.
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
                        aria-label={`${b.label} 단축키`}
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
                                ? `'${v}'는 이미 ${dup}에 할당되어 있다 — 먼저 그 바인딩을 바꿔야 한다`
                                : '한 글자 키만 받는다',
                            );
                            e.currentTarget.value = resolveKey(prefs.prefs().keys, b.name);
                          }
                        }}
                      />
                      <span class="hint">{b.label} · 기본 {DEFAULT_KEYS[b.name].toUpperCase()}</span>
                    </span>
                    <span class="settings-source">this machine</span>
                  </div>
                )}
              </For>
              <Show when={keyProblem()}>{(r) => <p class="hint warn" data-testid="key-problem">{r()}</p>}</Show>
              <Show when={prefs.saveProblem()}>{(r) => <p class="hint warn">not saved — {r()}</p>}</Show>
            </div>
          </Show>

          <footer class="settings-foot">
            <span class="hint">
              Saved as <code>{USER_FILE}</code>, merged last — it wins over every other file. Glyphs take any character, tones any colour; the rest are engine tokens.
            </span>
            <span class="spacer" />
            <span class="settings-status" data-testid="settings-status" data-state={save().kind}>
              {(() => {
                const s = save();
                if (s.kind === 'failed') return `not saved — ${s.reason}`;
                if (s.kind === 'saved') return 'saved · applied';
                if (s.kind === 'saving') return 'saving…';
                return dirty() ? (problems().length > 0 ? `cannot save — ${problems()[0]}` : 'unsaved changes') : '';
              })()}
            </span>
            <button data-testid="settings-reset-all" onClick={() => void resetAll()}>
              Reset all
            </button>
            <button data-testid="settings-save" class="primary" disabled={!dirty() || save().kind === 'saving'} onClick={() => void doSave()}>
              Save
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
