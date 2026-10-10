/**
 * Accessible mirror of the canvas (charter §31): every node exists as a
 * focusable DOM entry, so the canvas never seals information away from
 * keyboard or assistive tech. Also what e2e uses to read the topology.
 */
import { WORKSPACE_ROOT_KIND } from '@gunnflow/contract';
import { classifyRelations } from '../canvas/genericScene.js';
import { layoutGraphOf } from '../canvas/layoutGraph.js';
import { For, Index, Show, createMemo } from 'solid-js';
import type { WorkspaceStores } from '../state/stores.js';
import type { Emphasis } from '../state/lens.js';
import { tierEmphasis } from '../state/relevance.js';

export function A11yMirror(props: { stores: WorkspaceStores }) {
  const { projectionStore, selection } = props.stores;
  // Emphasis mirrors the canvas pipeline: the published relevance tiers (dynamic-view P2).
  const emphasisOf = createMemo(() => {
    const out = new Map<string, Emphasis>();
    for (const [id, tier] of props.stores.relevance.tiers()) out.set(id, tierEmphasis(tier));
    return out;
  });
  /**
   * Relations with a node's own containers (GF-E): drawn as a chip on the
   * canvas, spoken here so keyboard and screen-reader users reach them too.
   */
  const nested = createMemo(() => {
    const nodes = (projectionStore.genericNodes()?.nodes ?? []).filter((n) => n.kind !== WORKSPACE_ROOT_KIND);
    const config = props.stores.wiring.config;
    return { links: classifyRelations(nodes, config, layoutGraphOf(nodes, config)).nestedLinks, byId: new Map(nodes.map((n) => [n.id, n])) };
  });
  const nestedDescription = (id: string): string | undefined => {
    const { links, byId } = nested();
    const list = links.get(id);
    if (!list) return undefined;
    const name = (other: string) => byId.get(other)?.label ?? other;
    return `Relations with its containers: ${list.map((l) => (l.direction === 'in' ? `${name(l.other)} ${l.type} this` : `this ${l.type} ${name(l.other)}`)).join('; ')}`;
  };
  const entries = createMemo(() => {
    const p = projectionStore.projection();
    const emphasis = emphasisOf();
    const domain = [
      ...p.tasks.map((t) => ({
        id: t.id,
        label: `${t.name} — ${t.state}${t.currentAction ? ` — ${t.currentAction}` : ''}`,
        kind: 'task',
        emphasis: emphasis.get(t.id) ?? 'normal',
      })),
      ...p.gates.map((g) => ({
        id: g.id,
        label: `Gate ${g.name} — ${g.state}${g.state === 'waiting' ? ` — ${g.requestedAction}` : ''}`,
        kind: 'gate',
        emphasis: emphasis.get(g.id) ?? 'normal',
      })),
      ...p.deliverables.map((d) => ({
        id: d.id,
        label: `Deliverable ${d.title}${d.state ? ` — ${d.state}` : ''}`,
        kind: 'deliverable',
        emphasis: emphasis.get(d.id) ?? 'normal',
      })),
    ];
    // Generic nodes the domain shape does not carry (all of them, for an upstream that sends only nodes).
    const known = new Set(domain.map((e) => e.id));
    const generic = (projectionStore.genericNodes()?.nodes ?? [])
      .filter((n) => !known.has(n.id))
      .map((n) => ({ id: n.id, label: `${n.label ?? n.id} — ${n.state.value}`, kind: n.kind, emphasis: emphasisOf().get(n.id) ?? ('normal' as const) }));
    return [...domain, ...generic];
  });
  // The contract's generic node collection, summarized (the canvas does not render from it yet).
  const generic = createMemo(() => {
    const g = projectionStore.genericNodes();
    if (!g) return null;
    const kinds = [...new Set(g.nodes.map((n) => n.kind))].sort();
    return { count: g.nodes.length, kinds, invalid: g.invalid.length };
  });
  const wiring = props.stores.wiring;
  const liveIds = createMemo(() => new Set((props.stores.projectionStore.genericNodes()?.nodes ?? []).map((n) => n.id)));
  return (
    <>
    <p class="a11y-mirror" data-testid="generic-summary">
      <Show when={generic()} fallback="Generic nodes: not provided by upstream.">
        {(g) => (
          <>
            Generic nodes: <span data-testid="generic-count">{g().count}</span> · kinds:{' '}
            <span data-testid="generic-kinds">{g().kinds.join(', ')}</span> · invalid: {g().invalid}
          </>
        )}
      </Show>{' '}
      · wiring:{' '}
      <span data-testid="wiring-state">
        {wiring.problems.length === 0
          ? `ok (${Object.keys(wiring.config.kinds ?? {}).length} kinds)`
          : `merge rejected (${wiring.problems.length} problems) — default in use`}
      </span>{' '}
      · files: <span data-testid="wiring-files-loaded">{wiring.files.loaded.length}</span> loaded,{' '}
      <span data-testid="wiring-files-rejected">{wiring.files.rejected.length}</span> rejected{' '}
      · layout: <span data-testid="layout-source">{props.stores.layout.source()}</span>
      <Show when={props.stores.layout.reason()}>
        {(r) => (
          <>
            {' '}(<span data-testid="layout-reason">{r()}</span>)
          </>
        )}
      </Show>{' '}
      · grouping withheld: <span data-testid="layout-withheld">{props.stores.layout.withheld()}</span>{' '}
      · personal: <span data-testid="personal-notes-count">{Object.keys(props.stores.personal.doc().notes).length}</span> notes (
      <span data-testid="personal-orphans-count">{props.stores.personal.orphans(liveIds()).length}</span> orphaned),{' '}
      <span data-testid="personal-stickies-count">{props.stores.personal.doc().stickies.length}</span> stickies,{' '}
      <span data-testid="personal-boxes-count">{props.stores.personal.doc().boxes.length}</span> boxes,{' '}
      <span data-testid="personal-links-count">{props.stores.personal.doc().links.length}</span> links (
      <span data-testid="personal-broken-count">{props.stores.personal.brokenLinks(liveIds()).length}</span> broken)
      <Show when={wiring.files.rejected.length > 0}>
        {' '}
        (<span data-testid="wiring-rejected-list">
          {wiring.files.rejected.map((r) => `${r.file}: ${r.reasons[0]}${r.reasons.length > 1 ? ` (+${r.reasons.length - 1})` : ''}`).join('; ')}
        </span>)
      </Show>
    </p>
    {/* Personal stickies: the person's own, outside lenses and filters. */}
    <ul class="a11y-mirror" aria-label="Personal notes">
      <For each={props.stores.personal.doc().stickies}>
        {(s) => (
          <li>
            <button data-testid={`sticky-${s.id}`} data-grade="personal" data-kind={s.kind} onClick={() => { props.stores.selection.clear(); props.stores.personal.setOpen({ kind: 'sticky', id: s.id }); }}>
              {s.kind === 'mermaid' ? 'Personal diagram' : 'Personal note'}: {s.text || '(empty)'}
            </button>
          </li>
        )}
      </For>
      <For each={props.stores.personal.doc().boxes}>
        {(b) => (
          <li>
            <button data-testid={`pbox-${b.id}`} data-grade="personal" onClick={() => { props.stores.selection.clear(); props.stores.personal.setOpen({ kind: 'box', id: b.id }); }}>
              Personal box: {b.label || '(untitled)'}
            </button>
          </li>
        )}
      </For>
    </ul>
    <ul class="a11y-mirror" aria-label="Workspace nodes">
      {/* Index keeps each button's DOM node across updates — focus survives tier re-publishes. */}
      <Index each={entries()}>
        {(entry) => (
          <li>
            <button
              data-testid={`node-${entry().id}`}
              aria-description={nestedDescription(entry().id)}
              data-kind={entry().kind}
              data-emphasis={entry().emphasis}
              aria-pressed={selection.selectedId() === entry().id}
              onClick={() => props.stores.selection.select(entry().id)}
              onContextMenu={(e) => {
                // Shift+F10 / the ContextMenu key on a focused node opens the canvas menu there.
                e.preventDefault();
                window.dispatchEvent(new CustomEvent('gunnflow:node-contextmenu', { detail: { id: entry().id } }));
              }}
            >
              {entry().label}
            </button>
          </li>
        )}
      </Index>
    </ul>
    </>
  );
}
