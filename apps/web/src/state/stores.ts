/**
 * Store wiring. The three worlds stay separate (charter §28):
 *   WorkspaceProjectionStore — upstream truth
 *   WorkspaceViewState/Lens/Selection — local presentation
 *   PendingIntentState — not-yet-authoritative human intents
 */
import { createProjectionStore } from './projectionStore.js';
import { createViewState } from './viewState.js';
import { createLensState } from './lens.js';
import { createSelectionState } from './selection.js';
import { createPendingIntentState } from './pendingIntents.js';
import type { Intent, IntentResult } from '../model/types.js';
import { createFakeIntentAdapter } from './fakeIntentAdapter.js';
import { guardPost } from './intentValidator.js';
import { createInspectorViewState } from './inspectorView.js';
import { createGateViewState } from './gateView.js';
import { createWiringState } from '../wiring/loadWiring.js';
import { createLayoutState } from './layoutState.js';
import { createPersonalState } from '../personal/personalState.js';
import { httpPersonalStore } from '../personal/client.js';
import { createDiagramCache } from '../personal/diagrams.js';
import { PREVIEW_ORIGIN } from '../transport/previewOrigin.js';
import { createPrefsState } from '../prefs/prefsState.js';
import { createChangeLog, type Tier } from './relevance.js';
import { createSignal } from 'solid-js';

export function createWorkspaceStores(post: (intent: Intent) => Promise<IntentResult>) {
  const projectionStore = createProjectionStore();
  // The store only ever holds the guarded post: no unvalidated intent reaches the relay.
  // Capabilities come from the upstream's generic nodes when it sends them.
  const adapter = createFakeIntentAdapter(() => projectionStore.genericNodes()?.nodes ?? null);
  const guarded = guardPost(post, adapter, projectionStore.projection);
  const pendingIntents = createPendingIntentState(guarded, adapter, projectionStore.projection);
  return {
    projectionStore,
    viewState: createViewState(),
    /** Computed node layout: view state (local-only), never projection. */
    layout: createLayoutState(),
    lensState: createLensState(),
    selection: createSelectionState(),
    pendingIntents,
    inspector: createInspectorViewState(),
    gateView: createGateViewState(),
    /** The personal layer: the person's local notes. Its own store — never projection, view, pending or relay. */
    personal: createPersonalState(httpPersonalStore),
    /** Personal mermaid diagrams rendered on the isolated origin (images only). */
    diagrams: createDiagramCache(PREVIEW_ORIGIN),
    /** Wiring config (data: default + the wiring directory's files, validated); not one of the three state worlds. */
    wiring: createWiringState(),
    /** Machine-local ergonomics (zoom feel, default lens); its own store, never upstream. */
    prefs: createPrefsState(),
    /** Received-change log (snapshot diff — a permitted view input) for relevance tiers. */
    changeLog: createChangeLog(),
    /** The relevance tiers (dynamic-view P2): computed once by the canvas pipeline, read by every mirror. */
    relevance: (() => {
      const same = (a: ReadonlyMap<string, Tier>, b: ReadonlyMap<string, Tier>) => {
        if (a.size !== b.size) return false;
        for (const [k, v] of a) if (b.get(k) !== v) return false;
        return true;
      };
      const [tiers, setTiers] = createSignal<ReadonlyMap<string, Tier>>(new Map(), { equals: same });
      return { tiers, setTiers };
    })(),
  };
}

export type WorkspaceStores = ReturnType<typeof createWorkspaceStores>;
