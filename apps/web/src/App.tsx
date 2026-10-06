/** WorkspaceShell — composition of chrome (DOM) around the canvas (load-bearing). */
import { fetchWiringFiles } from './wiring/loadWiring.js';
import { Show, createEffect, createSignal, onCleanup, onMount, createMemo } from 'solid-js';
import { createWorkspaceStores } from './state/stores.js';
import { workspaceRoot } from './state/workspaceRoot.js';
import { gateById, taskById, workspaceEmpty } from './model/selectors.js';
import { postIntent } from './transport/relayClient.js';
import { openWorkspaceStream, refreshWorkspace, type WorkspaceStream } from './transport/stream.js';
import { CanvasViewport } from './canvas/CanvasViewport.jsx';
import { WorkspaceToolbar } from './ui/WorkspaceToolbar.jsx';
import { WorkspaceSidebar } from './ui/WorkspaceSidebar.jsx';
import { WorkspaceStatusStrip } from './ui/WorkspaceStatusStrip.jsx';
import { A11yMirror } from './ui/A11yMirror.jsx';
import { EmptyState, NotificationCenter, RelayErrorToasts, SurfacePlaceholder } from './ui/overlays.jsx';
import { TaskInspector } from './ui/TaskInspector.jsx';
import { NodeStage } from './ui/NodeStage.jsx';
import { AssemblySurface, WorkSurface } from './ui/WorkSurface.jsx';
import { DecisionInbox, DecisionInboxToggle } from './ui/DecisionInbox.jsx';
import { ConnectBanner, PersonalItemPanel, PersonalList } from './personal/PersonalUi.jsx';
import { SettingsScreen } from './settings/SettingsScreen.jsx';
import { createBooleanPresence, createPresence } from './ui/presence.js';
import { DEFAULT_THEME } from './theme/defaultTheme.js';
import { HumanGateSurface } from './ui/HumanGateSurface.jsx';
import { ExecutionSurface } from './ui/ExecutionSurface.jsx';
import { dropAllExecutionStreams } from './state/executionStore.js';
import { LiveTerminalSurface } from './ui/LiveTerminalSurface.jsx';
import { dropAllTerminalStreams } from './state/terminalStore.js';
import { resolveWorkSurface, surfaceForKind } from './state/depth.js';
import { isTypingTarget, matchesKey, resolveKey } from './state/keybindings.js';
import { escStack } from './state/escStack.js';

export function App() {
  const stores = createWorkspaceStores(postIntent);
  const [rewireArmed, setRewireArmed] = createSignal(false);
  let searchEl: HTMLInputElement | undefined;
  const [surface, setSurface] = createSignal<{ surface: string; id: string } | null>(null);
  // ③ for a node-addressed surface; the surface itself resolves from the node's kind.
  const [work, setWork] = createSignal<{ nodeId: string; queue?: readonly string[] } | null>(null);
  const [executionTaskId, setExecutionTaskId] = createSignal<string | null>(null);
  const [terminalSessionId, setTerminalSessionId] = createSignal<string | null>(null);
  const [personalOpen, setPersonalOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [inboxOpen, setInboxOpen] = createSignal(false);
  let stream: WorkspaceStream | undefined;
  // Exit presences (M-02/M-06/M-08): each surface outlives its close by its exit duration.
  const D = DEFAULT_THEME.motion.durations;
  const settingsPresence = createBooleanPresence(settingsOpen, D.moderate01);
  const inboxPresence = createBooleanPresence(inboxOpen, D.moderate01);
  const stagePresence = createPresence(() => stores.selection.selectedId(), D.moderate01);
  // N-02: unreachable for 5s+ pins a warning line under the toolbar until recovery.
  const [unreachableLong, setUnreachableLong] = createSignal(false);
  createEffect(() => {
    const i = stores.projectionStore.instrument();
    if (i.kind === 'unreachable') {
      const t = setTimeout(() => setUnreachableLong(true), 5000);
      onCleanup(() => clearTimeout(t));
    } else {
      setUnreachableLong(false);
    }
  });
  const unreachableSince = () => {
    const i = stores.projectionStore.instrument();
    return i.kind === 'unreachable' ? new Date(i.since).toTimeString().slice(0, 8) : '';
  };
  const liveIds = createMemo(() => new Set((stores.projectionStore.genericNodes()?.nodes ?? []).map((n) => n.id)));

  const kindOf = (id: string) => stores.projectionStore.genericNodes()?.nodes.find((n) => n.id === id)?.kind;
  /** Whether ③ (a work surface of any flavor) owns the body. */
  const workActive = () => Boolean(terminalSessionId() || executionTaskId() || work());

  /** The ONE ③ entry: canvas double-click, Enter on the stage, the stage button, an inbox item. */
  const enterWork = (nodeId: string, queue?: readonly string[]) => {
    stores.selection.select(nodeId);
    setWork({ nodeId, ...(queue ? { queue } : {}) });
  };
  /** ③ → ②: the selection (and its stage) stays. */
  const exitWork = () => setWork(null);

  onMount(() => {
    // The wiring directory's config files, merged over the default (offline: the default stays).
    void stores.wiring.refresh(fetchWiringFiles);
    // The personal layer: this machine's local notes (never sent upstream).
    void stores.personal.load();
    // Prefs apply once at boot; the default lens is only a starting point, never a lock.
    void stores.prefs.load().then((p) => {
      if (p.defaultLens !== 'all') stores.lensState.setLens(p.defaultLens);
    });
    const cancelLink = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stores.personal.setConnectFrom(null);
    };
    window.addEventListener('keydown', cancelLink);
    onCleanup(() => window.removeEventListener('keydown', cancelLink));
    stream = openWorkspaceStream(stores.projectionStore, (p) => stores.pendingIntents.reconcile(p));
    const disconnect = () => stream?.close();
    if (import.meta.env.DEV) {
      // Dev/e2e-only hook to simulate transport loss (F6). Not in prod builds.
      const w = window as unknown as { __gunnflowDebug?: Record<string, unknown> };
      w.__gunnflowDebug = {
        ...(w.__gunnflowDebug ?? {}),
        dropStream: () => {
          disconnect();
          stores.projectionStore.markLost();
          dropAllExecutionStreams();
          dropAllTerminalStreams();
        },
        // Perf/e2e entry for tasks without a workspace session link.
        openExecution: (taskId: string) => setExecutionTaskId(taskId),
        camera: () => stores.viewState.camera(),
      };
    }
    // Deep link: restore task selection + its work surface from the URL hash.
    const match = /(?:^|[#&])task=([\w.-]+)/.exec(location.hash);
    if (match) enterWork(match[1]!);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchEl?.focus();
      }
      // Named bindings resolve through prefs — no key literal at a use site.
      if (
        matchesKey(e, resolveKey(stores.prefs.prefs().keys, 'open-decision-inbox')) &&
        !isTypingTarget(e.target) &&
        !settingsOpen()
      ) {
        e.preventDefault();
        setInboxOpen(!inboxOpen());
        return;
      }
      // Enter = one depth in (② → ③). Esc is its mirror. Chrome grammar, not a binding.
      if (
        e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey &&
        !workActive() && !settingsOpen() && !surface() && !inboxOpen() &&
        !isTypingTarget(e.target) &&
        !(e.target instanceof HTMLElement && ['BUTTON', 'A', 'SELECT', 'SUMMARY'].includes(e.target.tagName))
      ) {
        const sel = stores.selection.selectedId();
        if (sel) {
          e.preventDefault();
          enterWork(sel);
          return;
        }
      }
      if (e.key === 'Escape') {
        // The ladder is the BASE Esc owner: surfaces on the esc stack (inbox,
        // notification panel) handle their own Esc; one Esc means one level.
        if (!escStack.isEmpty()) return;
        // Layered dismissal: settings → modal → ③ layers (terminal → execution → work) → rewire → selection.
        if (settingsOpen()) {
          setSettingsOpen(false);
        } else if (surface()) {
          setSurface(null);
        } else if (inboxOpen()) {
          // Unreachable while the inbox owns the stack; kept as a safe fallback.
          setInboxOpen(false);
        } else if (terminalSessionId()) {
          setTerminalSessionId(null);
        } else if (executionTaskId()) {
          // Execution's exit is "back to workspace" (its own breadcrumb says so): ② directly.
          setExecutionTaskId(null);
          setWork(null);
        } else if (work()) {
          exitWork();
        } else if (rewireArmed()) {
          setRewireArmed(false);
        } else {
          stores.selection.clear();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => {
      disconnect();
      window.removeEventListener('keydown', onKey);
    });
  });

  const isEmpty = () =>
    stores.projectionStore.hasSnapshot() &&
    workspaceEmpty(stores.projectionStore.projection(), stores.projectionStore.genericNodes()?.nodes ?? null);

  // Creation is the workspace root's capability; without a root there is nothing to address.
  const rootId = () => workspaceRoot(stores.projectionStore.genericNodes()?.nodes ?? null).root?.id;
  const startMission = (name: string) => {
    const nodeId = rootId();
    if (nodeId) void stores.pendingIntents.submit({ nodeId, action: 'mission.create', decision: { text: name } });
  };

  const enterSurface = (surfaceName: string, id: string) => {
    if (surfaceName === 'inspector' || surfaceName === 'approval') {
      // Node-addressed deep surfaces are ③ of the one continuum (queue carried on lateral moves).
      setTerminalSessionId(null);
      setExecutionTaskId(null);
      enterWork(id, work()?.queue);
    } else if (surfaceName === 'execution') {
      setExecutionTaskId(id);
    } else if (surfaceName === 'terminal') {
      setTerminalSessionId(id);
    } else {
      setSurface({ surface: surfaceName, id });
    }
  };

  // The legacy view stores follow the work surface (deep-link hash, relevance focus).
  createEffect(() => {
    const w = work();
    const kind = w ? kindOf(w.nodeId) : undefined;
    if (w && kind === 'task') {
      stores.inspector.open(w.nodeId);
      stores.gateView.close();
    } else if (w && kind === 'gate') {
      stores.gateView.open(w.nodeId);
      stores.inspector.close();
    } else {
      stores.inspector.close();
      stores.gateView.close();
    }
  });

  // Selecting a different node while at ③ is a lateral move: the work surface follows.
  createEffect(() => {
    const selected = stores.selection.selectedId();
    const w = work();
    if (!w || !selected || selected === w.nodeId) return;
    setWork({ nodeId: selected, ...(w.queue ? { queue: w.queue } : {}) });
  });

  // If the worked node vanishes from the projection (e.g. scenario swap), return to ②.
  createEffect(() => {
    const w = work();
    if (!w) return;
    if (stores.projectionStore.hasSnapshot() && stores.projectionStore.genericNodes() && !kindOf(w.nodeId)) setWork(null);
  });

  // Keep the deep-link hash in sync with the open task work surface (no history spam).
  createEffect(() => {
    const open = stores.inspector.openTaskId();
    history.replaceState(null, '', open ? `#task=${open}` : location.pathname + location.search);
  });

  /** ③ content: the node's kind assembly picks the surface; no deep surface = the ② assembly, full width. */
  const WorkContent = (p: { nodeId: string }) => {
    // A deep surface shows DOMAIN facts; a live upstream may carry the node
    // generically only — then depth 3 honestly falls back to the assembly.
    const hasDomainRecord = () => {
      const kind = kindOf(p.nodeId);
      const projection = stores.projectionStore.projection();
      if (kind === 'task') return taskById(projection, p.nodeId) !== null;
      if (kind === 'gate') return gateById(projection, p.nodeId) !== null;
      return false;
    };
    const resolvedSurface = () => resolveWorkSurface(kindOf(p.nodeId), hasDomainRecord());
    return (
      <>
        <Show when={resolvedSurface() === 'approval'}>
          <HumanGateSurface
            stores={stores}
            gateId={p.nodeId}
            motion="enter"
            onClose={exitWork}
            onOpenGate={(id) => enterWork(id, work()?.queue)}
            onOpenTask={(id) => enterWork(id, work()?.queue)}
          />
        </Show>
        <Show when={resolvedSurface() === 'inspector'}>
          <TaskInspector
            stores={stores}
            taskId={p.nodeId}
            motion="enter"
            onClose={exitWork}
            onEnterSurface={enterSurface}
            onFocusNode={(id) => stores.selection.select(id)}
          />
        </Show>
        <Show when={resolvedSurface() === 'assembly'}>
          <AssemblySurface stores={stores} nodeId={p.nodeId} />
        </Show>
      </>
    );
  };

  return (
    <div class="shell">
      <WorkspaceToolbar stores={stores} searchRef={(el) => (searchEl = el)} />
      <Show when={unreachableLong()}>
        <div class="unreachable-banner" data-testid="unreachable-banner" role="alert">
          ⚠ Backend unreachable since {unreachableSince()} — showing earlier state. It keeps retrying; ↻ below retries now.
        </div>
      </Show>
      <div class="body">
        <Show when={!workActive()}>
          <WorkspaceSidebar stores={stores} onOpenSettings={() => setSettingsOpen(true)} />
          <main class="canvas-area">
            <Show when={!isEmpty()} fallback={<EmptyState stores={stores} onStartMission={startMission} />}>
              <CanvasViewport
                stores={stores}
                rewireArmed={rewireArmed}
                onArmRewire={() => setRewireArmed(true)}
                onDisarmRewire={() => setRewireArmed(false)}
                onOpenPersonalList={() => setPersonalOpen(true)}
                onOpenNode={(id, _kind) => enterWork(id)}
              />
            </Show>
            {/* The personal layer's panels yield to a selected node. */}
            <Show when={!stores.selection.selectedId()}>
              <PersonalItemPanel personal={stores.personal} diagrams={stores.diagrams} liveIds={liveIds} />
              <Show when={personalOpen() && !stores.personal.open()}>
                <PersonalList
                  personal={stores.personal}
                  liveIds={liveIds}
                  onOpenNode={(id) => stores.selection.select(id)}
                  onClose={() => setPersonalOpen(false)}
                />
              </Show>
            </Show>
            <Show when={rewireArmed()}>
              <div class="rewire-banner" data-testid="rewire-armed">Rewire armed — drag from a node to its new target · Esc cancels</div>
            </Show>
            <ConnectBanner personal={stores.personal} />
            <A11yMirror stores={stores} />
            {/* ② stage: an OVERLAY over the canvas (the canvas never reflows, so a
                double-click's two hits see one coordinate space); the canvas pans
                the selected node clear of it instead (CanvasViewport). */}
            <Show when={stagePresence.held()}>
              {(id) => (
                <NodeStage
                  stores={stores}
                  nodeId={id()}
                  onClose={() => stores.selection.clear()}
                  onEnterWork={(nodeId) => enterWork(nodeId)}
                  onEnterSurface={enterSurface}
                  motion={stagePresence.phase()}
                />
              )}
            </Show>
          </main>
        </Show>
        <Show when={workActive()}>
          <WorkSurface
            stores={stores}
            nodeId={terminalSessionId() ? null : (executionTaskId() ?? work()?.nodeId ?? null)}
            queue={work()?.queue}
            onLateral={(id) => enterWork(id, work()?.queue)}
          >
            <Show when={terminalSessionId()}>
              {(sessionId) => (
                <LiveTerminalSurface
                  stores={stores}
                  sessionId={sessionId()}
                  onClose={() => setTerminalSessionId(null)}
                  onEnterSurface={enterSurface}
                />
              )}
            </Show>
            <Show when={!terminalSessionId() && executionTaskId()}>
              {(taskId) => (
                <ExecutionSurface
                  stores={stores}
                  taskId={taskId()}
                  onClose={() => {
                    // Execution's exit is "back to workspace": ② directly.
                    setExecutionTaskId(null);
                    setWork(null);
                  }}
                  onEnterSurface={enterSurface}
                />
              )}
            </Show>
            <Show when={!terminalSessionId() && !executionTaskId() && work()?.nodeId} keyed>
              {(nodeId) => <WorkContent nodeId={nodeId} />}
            </Show>
          </WorkSurface>
        </Show>
      </div>
      <WorkspaceStatusStrip stores={stores} onRefresh={() => (stream ? refreshWorkspace(stream) : Promise.resolve({ refreshed: false }))} />
      <RelayErrorToasts stores={stores} />
      <NotificationCenter
        stores={stores}
        onGo={(id) => {
          setTerminalSessionId(null);
          setExecutionTaskId(null);
          setWork(null);
          stores.selection.select(id);
        }}
      />
      <DecisionInboxToggle stores={stores} open={inboxOpen} onToggle={() => setInboxOpen(!inboxOpen())} />
      <Show when={inboxPresence.mounted()}>
        <DecisionInbox
          stores={stores}
          motion={inboxPresence.phase()}
          onClose={() => setInboxOpen(false)}
          onEnterWork={(nodeId, queue) => {
            setInboxOpen(false);
            enterWork(nodeId, queue);
          }}
        />
      </Show>
      <SurfacePlaceholder surface={surface} onClose={() => setSurface(null)} />
      {/* Settings: an overlay panel over the cockpit. */}
      <Show when={settingsPresence.mounted()}>
        <SettingsScreen stores={stores} onClose={() => setSettingsOpen(false)} motion={settingsPresence.phase()} />
      </Show>
    </div>
  );
}
