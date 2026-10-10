/**
 * CanvasViewport — the infinite canvas. The framework is chrome; this canvas
 * carries the load (charter §30). Pan/zoom/select/drag live here.
 *
 * Node drag is a VISUAL layout move (local-only). Semantic rewire happens only
 * in explicit rewire mode while intervening, and only as a relayed intent.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { layoutBounds, type NodeBox } from './layout.js';
import { drawGeneric } from './draw.js';
import { CanvasContextMenu, type ContextMenuState } from '../ui/CanvasContextMenu.jsx';
import { createPresence, prefersReducedMotion } from '../ui/presence.js';
import { DEFAULT_THEME } from '../theme/defaultTheme.js';
import { buildScene, endpointBox, genericEmphasis, nestedChipRect } from './genericScene.js';
import { containerRects, layoutGraphOf, sizedGraph } from './layoutGraph.js';
import { resolveDrop } from './dropResolve.js';
import { escStack } from '../state/escStack.js';
import { hitsLeaf, leafBaseSize, type LeafShape } from './shapes.js';
import { FRAME_NODE_EVENT, anchorOut, fitZoom, fitZoomRelative, ladderKey, snapDown, ladderThreshold, ladderWith, stepZoom, wheelNotches, wheelPixels, zoomAtPoint, ZOOM_MAX, ZOOM_MIN, type Ladder, type Slot } from './zoomLadder.js';
import {
  TIDY_EVENT,
  cubicBezierEase,
  displaySizes,
  planSettled,
  planTransition,
  rectMapEquals,
  rectsAt,
  sizeMapEquals,
  spaceTargets,
  tierMapEquals,
  tierSizes,
  transitionCause,
  type Size,
  type TransitionKey,
  type TransitionPlan,
} from './space.js';
import { DIAGRAM_HEADER, drawPersonal, handleRect, type Rect } from './personalDraw.js';
import { STICKY_DEFAULT } from '../personal/schema.js';
import { endpointBox as sceneEndpoint } from './genericScene.js';
import type { LinkEnd } from '../personal/schema.js';
import { planEmphasis } from '../state/lens.js';
import { computeSpatialTiers, computeTiers, spatialNeighbors, type LensVerdict, type Tier } from '../state/relevance.js';
import { computeFocusAlpha } from '../state/focus.js';
import type { WorkspaceStores } from '../state/stores.js';
import type { Camera } from '../state/viewState.js';
import { asideCamera, lerpCamera } from '../state/inboxCamera.js';
import { finalFrameBounds } from './inboxFrame.js';

export interface CanvasViewportProps {
  stores: WorkspaceStores;
  rewireArmed: () => boolean;
  onArmRewire: () => void;
  onDisarmRewire: () => void;
  onOpenPersonalList: () => void;
  onOpenNode: (id: string, kind: string) => void;
}

/** The ladder without anchors: the detail threshold is fixed against it, so it never moves during a zoom. */
const PLAIN_LADDER = ladderWith([]);

export function CanvasViewport(props: CanvasViewportProps) {
  const { projectionStore, viewState, lensState, selection, pendingIntents, inspector, layout: layoutState, personal } =
    props.stores;
  let canvas!: HTMLCanvasElement;
  const [menu, setMenu] = createSignal<ContextMenuState | null>(null);
  const menuPresence = createPresence(menu, DEFAULT_THEME.motion.durations.fast02);
  let dirty = true;
  let raf = 0;
  let rewireDrag: { fromId: string; toX: number; toY: number } | null = null;

  const geo = DEFAULT_THEME.geometry;
  /**
   * Each node's tier-1 box: its kind's shape and size factor (wiring); the
   * classic node size otherwise. From the received nodes and the config only —
   * never from the scene, which itself depends on these sizes.
   */
  const baseSizes = createMemo(() => {
    const config = props.stores.wiring.config;
    return new Map((projectionStore.genericNodes()?.nodes ?? []).map((n) => [n.id, leafBaseSize(config, n.kind)] as const));
  });
  const baseSizeOf = (id: string) => baseSizes().get(id) ?? geo.node;
  const sizedGeo = () => ({ ...geo, node: baseSizeOf });
  const motion = DEFAULT_THEME.motion;
  // On-screen rects (dynamic-view P3): tier-sized, push-aside'd, ANIMATED geometry.
  // The scene is built from these, so hit-testing follows what is on screen mid-animation.
  const [displayed, setDisplayed] = createSignal<ReadonlyMap<string, Rect>>(new Map());
  // A new mermaid sticky takes its rendered diagram's aspect ratio once (the person can resize after).
  createEffect(() => {
    props.stores.diagrams.version();
    for (const s of personal.doc().stickies) {
      if (s.kind !== 'mermaid' || s.w !== STICKY_DEFAULT.w || s.h !== STICKY_DEFAULT.h || !s.text.trim()) continue;
      const d = props.stores.diagrams.get(s.text);
      if (d.state !== 'ok' || d.width <= 0) continue;
      const w = Math.min(560, Math.max(240, d.width));
      personal.updateSticky(s.id, { w, h: Math.round((w - 12) * (d.height / d.width)) + DIAGRAM_HEADER + 6 });
    }
  });
  // Every upstream speaks the contract; before the first snapshot the scene is simply empty.
  const scene = createMemo(() =>
    buildScene(
      projectionStore.genericNodes()?.nodes ?? [],
      props.stores.wiring.config,
      viewState.positions(),
      layoutState.positions(),
      displayed(),
      { packContainers: props.stores.prefs.prefs().packContainers },
    ),
  );
  const layout = createMemo(() => scene().layout);
  /** Nodes the personal board refers to, with planned groups' members. */
  const planned = createMemo(() => {
    const out = personal.plannedNodes();
    for (const g of scene()?.groups ?? []) if (out.has(g.id)) for (const m of g.members) out.add(m);
    return out;
  });
  const emphasis = createMemo(() => {
    if (lensState.lens() === 'plan') return planEmphasis([...scene().nodes.keys()], planned());
    return genericEmphasis(scene(), lensState.lens(), props.stores.wiring.config);
  });
  // ---- Relevance tiers (dynamic-view P2): ONE pipeline; the mirror reads the published map.
  createEffect(() => {
    const g = projectionStore.genericNodes();
    if (g) props.stores.changeLog.note(g.nodes);
  });
  /** Person-caused signals only: selection, open surfaces, pending intents. */
  const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  const personInputs = createMemo(
    () => {
      const focusIds = new Set(
        [selection.selectedId(), inspector.openTaskId(), props.stores.gateView.openGateId()].filter(
          (x): x is string => x !== null,
        ),
      );
      const pendingIds = new Set<string>();
      for (const e of [...pendingIntents.inFlight(), ...pendingIntents.rejected()]) {
        const nodeId = (e.intent as { nodeId?: unknown }).nodeId;
        if (typeof nodeId === 'string') pendingIds.add(nodeId);
      }
      return { focusIds, pendingIds };
    },
    undefined,
    // Content equality: the ripple snapshot below recaptures only on a REAL person action.
    { equals: (a, b) => sameIds(a.focusIds, b.focusIds) && sameIds(a.pendingIds, b.pendingIds) },
  );
  /** The received-fact tier inputs (lens verdict, change recency). */
  const receivedInputs = () => {
    const em = emphasis();
    const verdict = (id: string): LensVerdict => {
      const e = em.get(id);
      return e === 'dim' ? 'dim' : e === 'highlight' ? 'match' : 'neutral';
    };
    return { lensVerdict: verdict, changedAt: (id: string) => props.stores.changeLog.changedAt(id), now: Date.now() };
  };
  const tiers = createMemo(() => {
    props.stores.changeLog.tick(); // decay re-evaluation
    const nodes = projectionStore.genericNodes()?.nodes ?? [];
    return computeTiers(nodes, { ...personInputs(), ...receivedInputs() });
  });
  createEffect(() => props.stores.relevance.setTiers(tiers()));

  // ---- Dynamic-view P3: geometry changes ONLY at transition moments -------
  // topology / lens / sort key (P4 seam) / explicit tidy. At such a moment the
  // FULL then-current tiers are baked: `layout` sizes feed the relayout (size
  // is a layout input) and `ambient` keeps the received-fact share of those
  // sizes as the display floor until the next moment. Between moments only
  // person-caused spatial tiers resize anything (ruling 2026-10-05).
  const topoGraph = createMemo(() => {
    const generic = projectionStore.genericNodes();
    // The packing pref is a layout input: it joins the signature, so flipping it
    // is a topology-like transition moment (one relayout), never a live track.
    return generic
      ? layoutGraphOf(generic.nodes, props.stores.wiring.config, { packContainers: props.stores.prefs.prefs().packContainers })
      : null;
  });
  const [lock, setLock] = createSignal<{ layout: ReadonlyMap<string, Size>; ambient: ReadonlyMap<string, Size> }>({
    layout: new Map(),
    ambient: new Map(),
  });
  const [tidyCount, setTidyCount] = createSignal(0);
  /** Bumped at every transition moment: the ripple snapshot below re-captures then. */
  const [transitionTick, setTransitionTick] = createSignal(0);
  let lastKey: TransitionKey | null = null;
  createEffect(() => {
    const graph = topoGraph();
    if (!graph) return;
    const key: TransitionKey = {
      topology: graph.signature,
      lens: lensState.lens(),
      sortKey: viewState.sortKey(),
      tidy: tidyCount(),
    };
    const cause = transitionCause(lastKey, key);
    lastKey = key;
    if (cause) {
      setTransitionTick((t) => t + 1);
      untrack(() => {
        const nodes = projectionStore.genericNodes()?.nodes ?? [];
        const received = receivedInputs();
        setLock({
          layout: tierSizes(computeTiers(nodes, { ...personInputs(), ...received }), sizedGeo()),
          ambient: tierSizes(
            computeTiers(nodes, { focusIds: new Set(), pendingIds: new Set(), ...received }),
            sizedGeo(),
          ),
        });
      });
    }
    layoutState.update(sizedGraph(graph, untrack(lock).layout));
  });

  // Between transitions, geometry responds to PERSON-caused tier changes only:
  // the node resizes in place and push-aside clears the theme margin around
  // it; pins and the focus never move; the ripple stays inside its container
  // and is displacement-capped. Pure derivation — deselect reverts it
  // symmetrically. While a drag is live, push-aside is deferred: targets are
  // patched from the pins and settle once on release.
  // The 1-hop ripple is a SNAPSHOT (ruling, round 2): re-derived only on a
  // person action (personInputs change) or a transition moment — the node
  // list is read untracked, so a backend adding a relation to the focused
  // node cannot grow anything mid-flight. Pending confirm/removal IS a
  // person-input change, so the gesture's shrink stays immediate.
  const spatialTiers = createMemo(
    () => {
      transitionTick();
      const person = personInputs();
      return untrack(() => {
        const nodes = projectionStore.genericNodes()?.nodes ?? [];
        return computeSpatialTiers(nodes, person, spatialNeighbors(nodes, person));
      });
    },
    undefined,
    { equals: tierMapEquals },
  );
  const currentSizes = createMemo(() => displaySizes(spatialTiers(), lock().ambient, sizedGeo()), undefined, {
    equals: sizeMapEquals,
  });
  const [dragLive, setDragLive] = createSignal(false);
  let lastTargets: Map<string, Rect> = new Map();
  const targets = createMemo(
    () => {
      const base = layoutState.positions();
      const pins = viewState.positions();
      const sizes = currentSizes();
      if (dragLive()) {
        const patched = new Map(lastTargets);
        for (const [id, p] of pins) {
          if (!base.has(id)) continue;
          const s = sizes.get(id) ?? baseSizeOf(id);
          patched.set(id, { x: p.x, y: p.y, w: s.w, h: s.h });
        }
        lastTargets = patched;
        return patched;
      }
      lastTargets = spaceTargets({
        base,
        lockedSizes: lock().layout,
        sizes,
        pins,
        baseSize: baseSizeOf,
        margin: geo.focusMargin,
        hops: geo.pushHops,
        anchors: new Set([...spatialTiers()].filter(([, t]) => t === 3).map(([id]) => id)),
        parentOf: topoGraph()?.parentOf,
      });
      return lastTargets;
    },
    undefined,
    { equals: rectMapEquals },
  );

  // Every geometry change animates (theme motion tokens): full transitions
  // flow (slow01), local push-asides step (moderate02). No input lock — the
  // plan only retargets, and displayed() is what the hit tests read.
  const ease = cubicBezierEase(motion.easings.standard);
  let plan: TransitionPlan | null = null;
  let lastBase: ReturnType<typeof layoutState.positions> | null = null;
  createEffect(() => {
    const next = targets();
    const base = layoutState.positions();
    const full = base !== lastBase;
    lastBase = base;
    const duration = full ? motion.durations.slow01 : motion.durations.moderate02;
    const now = performance.now();
    // An actively dragged pin tracks the hand: its position snaps, only size eases.
    const snap = new Set(untrack(viewState.positions).keys());
    plan = planTransition(untrack(displayed), next, now, duration, snap);
    setDisplayed(rectsAt(plan, now, ease));
    if (planSettled(plan, now)) plan = null;
  });

  const focusAlpha = createMemo(() => {
    const focusId = inspector.openTaskId();
    return focusId ? computeFocusAlpha(projectionStore.projection(), focusId) : null;
  });

  // ---- ② stage pan-aside (depth model; clearly-delimited addition) -------
  // The stage is an OVERLAY: opening it never reflows the canvas, so the two
  // hits of a double-click share one coordinate space. If the selected node
  // would sit under the stage region, the camera pans it clear (overlap+24px)
  // — a local view-state move, delayed past the double-click window and
  // cancelled by any new pointer gesture (the person owns the camera).
  let panTimer: ReturnType<typeof setTimeout> | undefined;
  let panRaf = 0;
  const cancelStagePan = () => {
    if (panTimer) clearTimeout(panTimer);
    panTimer = undefined;
    cancelAnimationFrame(panRaf);
  };
  // A camera held by an inbox restore (결정함 F2) is consumed by exactly ONE
  // canvas initialization: this mount's initial fits and first stage pan
  // leave it alone; the shared flag is cleared at once, so later mounts fit.
  let suppressInitialFits = untrack(viewState.cameraHeld);
  if (suppressInitialFits) viewState.setCameraHeld(false);
  let mounted = true;
  onCleanup(() => (mounted = false));
  let skipFirstPan = suppressInitialFits;
  createEffect(() => {
    const id = selection.selectedId();
    cancelStagePan();
    if (skipFirstPan) {
      skipFirstPan = false;
      return;
    }
    if (!id) return;
    panTimer = setTimeout(() => {
      // While the inbox is open no stage stands over the canvas, and its framing owns the camera.
      if (viewState.inboxFrame() !== undefined) return;
      const r = nodeRect(id);
      const rect = canvas.getBoundingClientRect();
      if (!r || rect.width === 0) return;
      const cam = viewState.camera();
      // Mirrors the stage's CSS: 40% of the canvas area, clamped 360..620px.
      const stageW = Math.min(620, Math.max(360, rect.width * 0.4));
      const nodeRight = rect.width / 2 + (r.x + r.w - cam.x) * cam.zoom;
      const total = nodeRight - (rect.width - stageW) + 24;
      if (total <= 24) return;
      if (prefersReducedMotion()) {
        viewState.panBy(-total, 0);
        return;
      }
      const dur = DEFAULT_THEME.motion.durations.moderate02;
      const start = performance.now();
      let moved = 0;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - (1 - t) * (1 - t); // ease-out, compositor-cheap
        viewState.panBy(-(total * eased - moved), 0);
        moved = total * eased;
        if (t < 1) panRaf = requestAnimationFrame(step);
      };
      panRaf = requestAnimationFrame(step);
    }, DEFAULT_THEME.motion.durations.slow01);
  });
  onCleanup(cancelStagePan);
  // ---- end stage pan-aside -------------------------------------------------

  // ---- 결정함 F2: inbox-aside framing (view state only) --------------------
  // While the decision inbox is open, the canvas left of its drawer frames the
  // selected item, its nearest container and its received-relation
  // neighbours; closing the inbox restores the camera the person had before
  // it opened. Animated with the theme's motion unless reduced motion is set.
  let cameraRaf = 0;
  /** The running tween's destination (a person's gesture abandons it; unmounting lands it). */
  let tweenTarget: Camera | null = null;
  const cancelCameraTween = () => {
    cancelAnimationFrame(cameraRaf);
    tweenTarget = null;
  };
  const moveCamera = (to: Camera) => {
    cancelCameraTween();
    if (prefersReducedMotion()) {
      viewState.setCameraView(to);
      return;
    }
    tweenTarget = to;
    const from = viewState.camera();
    const dur = DEFAULT_THEME.motion.durations.moderate02;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      viewState.setCameraView(t >= 1 ? to : lerpCamera(from, to, ease(t)));
      if (t < 1) cameraRaf = requestAnimationFrame(step);
      else tweenTarget = null;
    };
    cameraRaf = requestAnimationFrame(step);
  };
  const frameAside = (id: string) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const nodes = projectionStore.genericNodes()?.nodes ?? [];
    const config = props.stores.wiring.config;
    // The FINAL geometry (transition targets), not the rects mid-animation.
    const bounds = finalFrameBounds(nodes, config, id, viewState.positions(), layoutState.positions(), targets(), topoGraph()?.parentOf, {
      packContainers: props.stores.prefs.prefs().packContainers,
    });
    if (!bounds) return;
    // The drawer's laid-out left edge (offsetLeft ignores its entrance transform).
    const drawer = document.querySelector<HTMLElement>('[data-testid="decision-inbox"]');
    const drawerLeft = drawer ? drawer.offsetLeft : window.innerWidth * 0.4;
    const visibleWidth = drawerLeft - rect.left;
    if (visibleWidth < 160) return;
    moveCamera(asideCamera(bounds, { width: rect.width, height: rect.height, visibleWidth }));
  };
  /** The deferred framing pass (one frame after a selection change); a gesture, a newer selection, close or unmount cancel it. */
  let frameRaf = 0;
  const cancelFraming = () => {
    cancelAnimationFrame(frameRaf);
    frameRaf = 0;
  };
  /** A person's gesture owns the camera: pending framing and any running tween yield. */
  const yieldCamera = () => {
    cancelFraming();
    cancelCameraTween();
    personTookCamera = true;
  };
  /** The item last framed, and whether a gesture took the camera since (then layout changes do not re-frame it). */
  let lastFramedId: string | null | undefined;
  let personTookCamera = false;
  createEffect(() => {
    const frame = viewState.inboxFrame();
    cancelFraming();
    if (frame) {
      // The camera from before the inbox opened lives in view state, so it is
      // restored even when the canvas was away (③) at the moment of closing.
      if (!untrack(viewState.inboxSavedCamera)) {
        viewState.setInboxSavedCamera(untrack(viewState.camera));
        viewState.setCameraHeld(false);
      }
      const id = frame.nodeId;
      // A new layout (e.g. the first layered pass) re-frames the same item —
      // unless the person has taken the camera since that item was framed.
      layoutState.positions();
      if (id !== lastFramedId) {
        lastFramedId = id;
        personTookCamera = false;
      } else if (personTookCamera) {
        return;
      }
      // After the drawer has laid out (one frame), never inside the reactive pass.
      if (id) frameRaf = requestAnimationFrame(() => {
        frameRaf = 0;
        untrack(() => viewState.inboxFrame()?.nodeId === id && frameAside(id));
      });
    } else {
      lastFramedId = undefined;
      const back = untrack(viewState.inboxSavedCamera);
      if (!back) return;
      viewState.setInboxSavedCamera(null);
      // This mount's remaining initial fits leave the restored camera alone.
      suppressInitialFits = true;
      // Held for the NEXT mount only if this canvas goes away right now (closing
      // the inbox into ③ unmounts it in the same tick); a canvas still mounted a
      // frame later releases the hold, so nothing lingers for unrelated mounts.
      viewState.setCameraHeld(true);
      requestAnimationFrame(() => {
        if (mounted) viewState.setCameraHeld(false);
      });
      cancelStagePan();
      moveCamera(back);
    }
  });
  onCleanup(() => {
    const landing = tweenTarget;
    cancelFraming();
    cancelCameraTween();
    if (landing) viewState.setCameraView(landing);
  });
  // ---- end inbox-aside framing --------------------------------------------

  const markDirty = () => {
    dirty = true;
  };
  createEffect(() => {
    layout();
    emphasis();
    tiers();
    focusAlpha();
    viewState.camera();
    selection.selectedId();
    pendingIntents.inFlight();
    personal.doc();
    personal.open();
    personal.connectFrom();
    props.stores.diagrams.version();
    props.stores.prefs.prefs();
    markDirty();
  });

  const screenToWorld = (sx: number, sy: number) => {
    const rect = canvas.getBoundingClientRect();
    const cam = viewState.camera();
    return {
      x: cam.x + (sx - rect.left - rect.width / 2) / cam.zoom,
      y: cam.y + (sy - rect.top - rect.height / 2) / cam.zoom,
    };
  };

  const inside = (b: { x: number; y: number; w: number; h: number }, wx: number, wy: number) =>
    wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
  const hitTest = (wx: number, wy: number): NodeBox | null => {
    const boxes = [...layout().nodes.values()];
    const sc = scene();
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i]!;
      // Inside the drawn shape (or its label strip), not merely its box: a diamond's corners are empty canvas.
      if (hitsLeaf(sc?.nodes.get(b.id)?.shape ?? 'rect', b, wx, wy)) return b;
    }
    return null;
  };
  /** The topmost personal sticky under the point. */
  const hitSticky = (wx: number, wy: number) => {
    const list = personal.doc().stickies;
    for (let i = list.length - 1; i >= 0; i--) if (inside(list[i]!, wx, wy)) return list[i]!;
    return null;
  };
  /** The innermost (smallest) personal box under the point. */
  const hitBox = (wx: number, wy: number) =>
    [...personal.doc().boxes].sort((a, b) => a.w * a.h - b.w * b.h).find((b) => inside(b, wx, wy)) ?? null;
  /** A received node's drawn rect (generic scene or domain layout). */
  const nodeRect = (id: string): Rect | undefined => {
    const sc = scene();
    return sc ? sceneEndpoint(sc, id) : layout().nodes.get(id);
  };
  /** The innermost group box under the point (generic path). */
  const hitGroup = (wx: number, wy: number) => {
    const groups = scene()?.groups ?? [];
    for (let i = groups.length - 1; i >= 0; i--) if (inside(groups[i]!, wx, wy)) return groups[i]!;
    return null;
  };

  onMount(() => {
    if (import.meta.env.DEV) {
      // Dev/e2e-only: where a node is drawn (world coordinates).
      const w = window as unknown as { __gunnflowDebug?: Record<string, unknown> };
      // …and how it is drawn (glyph and tone), as the canvas uses them.
      const nodeStyle = (id: string) => {
        const n = scene()?.nodes.get(id);
        return n ? { glyph: n.glyph, tone: n.tone } : undefined;
      };
      // The drag's landing preview, as drawn (shape and rect per outline); [] when none.
      const dropPreview = () => (dropGhost ?? []).map((g) => ({ shape: g.shape, ...g.rect }));
      // Drawn relation lines and nested-link chips, as the scene has them.
      const sceneEdges = () => (scene()?.edges ?? []).map((e) => ({ from: e.from, to: e.to, type: e.type }));
      const nestedLinks = () => Object.fromEntries([...(scene()?.nestedLinks ?? new Map())].map(([id, l]) => [id, [...l]]));
      const chipRect = (id: string) => {
        const sc = scene();
        const box = sc && endpointBox(sc, id);
        const links = sc?.nestedLinks.get(id);
        return box && links ? nestedChipRect(box, links.length) : undefined;
      };
      w.__gunnflowDebug = { ...(w.__gunnflowDebug ?? {}), nodeRect, nodeStyle, dropPreview, sceneEdges, nestedLinks, chipRect };
    }
    const ctx = canvas.getContext('2d')!;
    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      setViewSize({ w: rect.width, h: rect.height });
      markDirty();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement!);
    resize();

    const loop = () => {
      raf = requestAnimationFrame(loop);
      // Animation stepping: pure interpolation toward the plan's targets. The
      // scene (and so every hit test) rebuilds from these interpolated rects.
      if (plan) {
        const t = performance.now();
        setDisplayed(rectsAt(plan, t, ease));
        if (planSettled(plan, t)) plan = null;
      }
      if (!dirty) return;
      dirty = false;
      const dpr = window.devicePixelRatio || 1;
      ctx.save();
      ctx.scale(dpr, dpr);
      const common = {
        camera: viewState.camera(),
        emphasis: emphasis(),
        selectedId: selection.selectedId(),
        focusAlpha: focusAlpha(),
        pending: pendingIntents.inFlight(),
        rewireDrag,
        now: Date.now(),
        detailZoom: ladderThreshold(PLAIN_LADDER, props.stores.prefs.prefs().detailZoom),
        labelZoom: (tweenTarget ?? viewState.camera()).zoom,
        tiers: tiers() as ReadonlyMap<string, Tier>,
        ghost: dropGhost,
      };
      drawGeneric(ctx, canvas.width / dpr, canvas.height / dpr, { ...common, scene: scene() });
      // The personal layer, on top: the person's own notes, outside layout and lenses.
      drawPersonal(ctx, canvas.width / dpr, canvas.height / dpr, common.camera, {
        doc: personal.doc(),
        open: personal.open(),
        connectFrom: personal.connectFrom(),
        diagram: (source) => props.stores.diagrams.get(source),
        nodeRect,
      });
      ctx.restore();
    };
    raf = requestAnimationFrame(loop);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(ghostRaf);
      observer.disconnect();
    });
  });

  // ---- pointer interaction -------------------------------------------------
  let drag:
    | { type: 'pan'; lastX: number; lastY: number; moved: boolean; middle?: boolean }
    | { type: 'node'; id: string; offsetX: number; offsetY: number; moved: boolean; origin: Map<string, Rect> }
    | { type: 'group'; id: string; members: readonly string[]; lastX: number; lastY: number; moved: boolean; origin: Map<string, Rect> }
    | { type: 'sticky'; id: string; offsetX: number; offsetY: number; moved: boolean }
    | { type: 'box'; id: string; lastX: number; lastY: number; moved: boolean; contents: { stickies: string[]; boxes: string[] } }
    | { type: 'resize'; kind: 'sticky' | 'box'; id: string; x: number; y: number }
    | { type: 'rewire'; fromId: string }
    | null = null;

  /** The pointer that owns the current gesture; other pointers neither start, move, end nor cancel it. */
  let gesturePointer: number | null = null;
  const foreign = (e: PointerEvent) => gesturePointer !== null && e.pointerId !== gesturePointer;

  // ---- nested-link chips (GF-E) -------------------------------------------
  /** The chip popover: the descendant whose container relations it lists, where (client px), and whether a click pinned it. */
  const [chipPopover, setChipPopover] = createSignal<{ id: string; x: number; y: number; pinned: boolean } | null>(null);
  /** The descendant whose '◂' chip is under a world point, or null. */
  const hitChip = (wx: number, wy: number): string | null => {
    const sc = scene();
    if (!sc) return null;
    for (const [id, links] of sc.nestedLinks) {
      const box = endpointBox(sc, id);
      if (box && inside(nestedChipRect(box, links.length), wx, wy)) return id;
    }
    return null;
  };
  // A pinned popover owns Esc (one Esc closes it and nothing else) and closes on any press outside it.
  const chipEscOwner = {};
  let chipPopoverEl: HTMLDivElement | undefined;
  createEffect(() => {
    if (!chipPopover()?.pinned) return;
    onCleanup(escStack.push(chipEscOwner));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escStack.isTop(chipEscOwner)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setChipPopover(null);
      }
    };
    const onPress = (e: PointerEvent) => {
      if (chipPopoverEl && e.target instanceof Node && chipPopoverEl.contains(e.target)) return;
      setChipPopover(null);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPress, true);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPress, true);
    });
  });

  const onPointerDown = (e: PointerEvent) => {
    // Buttons beyond right (back/forward) start nothing on the canvas — not even a camera hand-over.
    if (e.button > 2) return;
    // A second pointer while one already owns a gesture is ignored.
    if (foreign(e)) return;
    // A fresh gesture owns the camera: a scheduled stage pan-aside (or inbox framing) yields.
    cancelStagePan();
    yieldCamera();
    // Right press: the radial menu holds the gesture; nothing else starts.
    if (e.button === 2) {
      e.preventDefault();
      swallowContextMenu = true;
      const w = screenToWorld(e.clientX, e.clientY);
      setMenu({ x: e.clientX, y: e.clientY, world: w, target: targetAt(w.x, w.y), hold: true });
      return;
    }
    // Input contract: the middle button always moves the view, whatever lies under it
    // (nodes, groups, personal items and link mode ignore it); it never selects.
    if (e.button === 1) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      gesturePointer = e.pointerId;
      drag = { type: 'pan', lastX: e.clientX, lastY: e.clientY, moved: false, middle: true };
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    gesturePointer = e.pointerId;
    const w = screenToWorld(e.clientX, e.clientY);
    const sticky = hitSticky(w.x, w.y);
    const box = sticky ? null : hitBox(w.x, w.y);
    // Link mode: the item clicked becomes the other end (a personal item or a received node).
    const from = personal.connectFrom();
    if (from) {
      const node = hitTest(w.x, w.y) ?? hitGroup(w.x, w.y);
      const to: LinkEnd | null = sticky
        ? { kind: 'sticky', id: sticky.id }
        : node
          ? { kind: 'node', id: node.id }
          : box
            ? { kind: 'box', id: box.id }
            : null;
      if (to) personal.addLink(from, to);
      personal.setConnectFrom(null);
      drag = null;
      return;
    }
    for (const [kind, item] of [['sticky', sticky], ['box', box]] as const) {
      if (item && inside(handleRect(item), w.x, w.y)) {
        drag = { type: 'resize', kind, id: item.id, x: item.x, y: item.y };
        return;
      }
    }
    if (sticky) {
      drag = { type: 'sticky', id: sticky.id, offsetX: w.x - sticky.x, offsetY: w.y - sticky.y, moved: false };
      return;
    }
    // A nested-link chip (above the received node it sits on, below the personal layer and link mode):
    // the press pins its popover — the relation detail — and starts nothing else.
    const chip = hitChip(w.x, w.y);
    if (chip) {
      drag = null;
      setChipPopover({ id: chip, x: e.clientX, y: e.clientY, pinned: true });
      return;
    }
    const hit = hitTest(w.x, w.y);
    if (!hit && box && !props.rewireArmed()) {
      drag = { type: 'box', id: box.id, lastX: w.x, lastY: w.y, moved: false, contents: personal.contentsOf(box.id) };
      setDragLive(true);
      return;
    }
    const armed = props.rewireArmed();
    const source = hit ?? (armed ? hitGroup(w.x, w.y) : null);
    if (source && armed) {
      drag = { type: 'rewire', fromId: source.id };
      rewireDrag = { fromId: source.id, toX: w.x, toY: w.y };
      markDirty();
    } else if (hit) {
      drag = { type: 'node', id: hit.id, offsetX: w.x - hit.x, offsetY: w.y - hit.y, moved: false, origin: originOf([hit.id]) };
      setDragLive(true);
    } else if (hitGroup(w.x, w.y)) {
      const group = hitGroup(w.x, w.y)!;
      // The member set is fixed for the gesture: a containment update mid-drag neither adds nor drops movers.
      drag = { type: 'group', id: group.id, members: [...group.members], lastX: w.x, lastY: w.y, moved: false, origin: originOf(group.members) };
      setDragLive(true);
    } else {
      drag = { type: 'pan', lastX: e.clientX, lastY: e.clientY, moved: false };
    }
  };

  /** The drawn rects of the given leaves at drag start — what the person grabbed (the drop's fallback). */
  const originOf = (ids: readonly string[]) => {
    const out = new Map<string, Rect>();
    const rects = untrack(layout).nodes;
    for (const id of ids) {
      const r = rects.get(id);
      if (r) out.set(id, { ...r });
    }
    return out;
  };
  /**
   * Drop (GF-P1b B): the moved leaves settle as one rigid set at the nearest
   * place that overlaps no other node and no container they do not belong to
   * (dropResolve). View state only — the move animates like any local change.
   */
  /**
   * Where the moved leaves would settle if released now: each one's landing
   * rect, or null when they stay exactly where they are (the drop fits, or is
   * unresolved — which needs a missing origin, never left by originOf).
   */
  const planDrop = (origin: ReadonlyMap<string, Rect>): Map<string, Rect> | null => {
    const parentOf = untrack(topoGraph)?.parentOf ?? new Map<string, string>();
    const rects = untrack(targets);
    const d = resolveDrop({
      parentOf,
      rects,
      moved: new Set(origin.keys()),
      origin,
      gap: geo.dropGap,
      groupPad: geo.groupPad,
      groupHeader: geo.groupHeader,
    });
    if (d.kind === 'unresolved') return null;
    if (d.kind === 'origin') return new Map(origin);
    if (d.dx === 0 && d.dy === 0) return null;
    const out = new Map<string, Rect>();
    for (const id of origin.keys()) {
      const r = rects.get(id);
      if (r) out.set(id, { ...r, x: r.x + d.dx, y: r.y + d.dy });
    }
    return out;
  };
  /** Whether the moved leaves, placed at `plan`, fit the canvas as it is now (nothing changed under them). */
  const stillFits = (plan: ReadonlyMap<string, Rect>, origin: ReadonlyMap<string, Rect>) => {
    const rects = new Map(untrack(targets));
    for (const [id, r] of plan) rects.set(id, r);
    const d = resolveDrop({
      parentOf: untrack(topoGraph)?.parentOf ?? new Map<string, string>(),
      rects,
      moved: new Set(origin.keys()),
      origin,
      gap: geo.dropGap,
      groupPad: geo.groupPad,
      groupHeader: geo.groupHeader,
    });
    return d.kind === 'offset' && d.dx === 0 && d.dy === 0;
  };
  const settleDrop = (origin: ReadonlyMap<string, Rect>) => {
    // The preview on screen is the landing — unless something moved under it since (a projection
    // update mid-drag); then, and when none is shown, plan now.
    const shown = dropGhostPlan;
    clearGhost();
    const plan = shown && stillFits(shown, origin) ? shown : planDrop(origin);
    if (plan) for (const [id, r] of plan) viewState.moveNode(id, r.x, r.y);
  };
  /**
   * The landing preview while dragging (approved mockup ③): a dashed outline
   * where the drag would settle, recomputed at most once per frame. Absent
   * when the drop would stay where it is held.
   */
  let dropGhost: { shape: LeafShape; rect: Rect }[] | null = null;
  /** The plan behind the preview on screen: a release lands exactly where the person saw it. */
  let dropGhostPlan: Map<string, Rect> | null = null;
  let ghostRaf = 0;
  const clearGhost = () => {
    cancelAnimationFrame(ghostRaf);
    ghostRaf = 0;
    dropGhostPlan = null;
    if (dropGhost) {
      dropGhost = null;
      markDirty();
    }
  };
  const scheduleGhost = (origin: ReadonlyMap<string, Rect>) => {
    if (ghostRaf) return;
    ghostRaf = requestAnimationFrame(() => {
      ghostRaf = 0;
      if (!drag || (drag.type !== 'node' && drag.type !== 'group')) return;
      const plan = planDrop(origin);
      const sc = untrack(scene);
      dropGhostPlan = plan;
      dropGhost = plan ? [...plan].map(([id, rect]) => ({ shape: sc?.nodes.get(id)?.shape ?? 'rect', rect })) : null;
      markDirty();
    });
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!drag) {
      // Hover: a chip shows its relations (a tooltip) until the pointer leaves it; a pinned popover stays.
      const pop = chipPopover();
      if (pop?.pinned) return;
      const w = screenToWorld(e.clientX, e.clientY);
      const chip = hitChip(w.x, w.y);
      if (chip) {
        if (pop?.id !== chip) setChipPopover({ id: chip, x: e.clientX, y: e.clientY, pinned: false });
      } else if (pop) setChipPopover(null);
      return;
    }
    if (foreign(e)) return;
    if (drag.type === 'pan') {
      viewState.panBy(e.clientX - drag.lastX, e.clientY - drag.lastY);
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.moved = true;
    } else if (drag.type === 'node') {
      const w = screenToWorld(e.clientX, e.clientY);
      viewState.moveNode(drag.id, w.x - drag.offsetX, w.y - drag.offsetY);
      drag.moved = true;
      scheduleGhost(drag.origin);
    } else if (drag.type === 'sticky') {
      const w = screenToWorld(e.clientX, e.clientY);
      personal.updateSticky(drag.id, { x: w.x - drag.offsetX, y: w.y - drag.offsetY });
      drag.moved = true;
    } else if (drag.type === 'box') {
      // A box carries what lies inside it (visual containment only).
      const w = screenToWorld(e.clientX, e.clientY);
      const dx = w.x - drag.lastX;
      const dy = w.y - drag.lastY;
      personal.moveBoxWithContents(drag.id, dx, dy, drag.contents);
      // Received nodes filed in the moved boxes follow, as view-state moves (pinned against re-layout).
      const nodes = layout().nodes;
      for (const boxId of [drag.id, ...drag.contents.boxes]) {
        for (const member of personal.doc().boxes.find((b) => b.id === boxId)?.members ?? []) {
          const leaves = scene()?.groups.find((g) => g.id === member)?.members ?? [member];
          for (const id of leaves) {
            const b = nodes.get(id);
            if (b) viewState.moveNode(id, b.x + dx, b.y + dy);
          }
        }
      }
      drag.lastX = w.x;
      drag.lastY = w.y;
      drag.moved = true;
    } else if (drag.type === 'resize') {
      const w = screenToWorld(e.clientX, e.clientY);
      const size = { w: w.x - drag.x, h: w.y - drag.y };
      if (drag.kind === 'sticky') personal.updateSticky(drag.id, size);
      else personal.updateBox(drag.id, size);
    } else if (drag.type === 'group') {
      // Moving a group moves its members (visual only, like any node drag).
      const w = screenToWorld(e.clientX, e.clientY);
      const dx = w.x - drag.lastX;
      const dy = w.y - drag.lastY;
      const nodes = layout().nodes;
      for (const id of drag.members) {
        const b = nodes.get(id);
        if (b) viewState.moveNode(id, b.x + dx, b.y + dy);
      }
      drag.lastX = w.x;
      drag.lastY = w.y;
      drag.moved = true;
      scheduleGhost(drag.origin);
    } else if (drag.type === 'rewire') {
      const w = screenToWorld(e.clientX, e.clientY);
      rewireDrag = { fromId: drag.fromId, toX: w.x, toY: w.y };
      markDirty();
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (foreign(e)) return;
    gesturePointer = null;
    if (!drag) return;
    const w = screenToWorld(e.clientX, e.clientY);
    if (drag.type === 'rewire') {
      const target = hitTest(w.x, w.y) ?? hitGroup(w.x, w.y);
      rewireDrag = null;
      markDirty();
      if (target && target.id !== drag.fromId) {
        // Semantic rewire = intent relay, never a local graph mutation (C1).
        void pendingIntents.submit({ nodeId: drag.fromId, action: 'edge.rewire', decision: { option: target.id } });
      }
    } else if (drag.type === 'sticky' && !drag.moved) {
      selection.clear();
      personal.setOpen({ kind: 'sticky', id: drag.id });
    } else if (drag.type === 'box' && !drag.moved) {
      selection.clear();
      personal.setOpen({ kind: 'box', id: drag.id });
    } else if ((drag.type === 'node' || drag.type === 'group') && drag.moved) {
      settleDrop(drag.origin);
      // Dropping a received node (or group) into a personal box files it there; dropping it outside takes it out.
      const r = nodeRect(drag.id);
      if (r) {
        const target = hitBox(r.x + r.w / 2, r.y + r.h / 2);
        personal.placeNode(drag.id, target?.id ?? null);
      }
    } else if ((drag.type === 'node' || drag.type === 'group') && !drag.moved) {
      personal.setOpen(null);
      selection.select(drag.id);
    } else if (drag.type === 'pan' && !drag.moved && !drag.middle) {
      selection.clear();
    }
    drag = null;
    clearGhost();
    // Drag over: the deferred push-aside settles once, animated (perf: it never ran per pointermove).
    setDragLive(false);
  };

  // A cancelled touch/pen drag (or lost capture) must not leave targets frozen
  // on the drag-patched map: drop the gesture and let push-aside settle.
  const onPointerCancel = (e: PointerEvent) => {
    if (foreign(e)) return;
    gesturePointer = null;
    if (drag?.type === 'rewire') {
      rewireDrag = null;
      markDirty();
    }
    drag = null;
    clearGhost();
    setDragLive(false);
  };

  // The browser's own defaults for the middle (autoscroll, X11 paste) and back/forward buttons never run on the canvas.
  const onButtonDefault = (e: MouseEvent) => {
    if (e.button === 1 || e.button > 2) e.preventDefault();
  };

  /** The margin a double-click framing keeps around what it frames (share of the visible width and height). */
  const FRAME_MARGIN = 0.08;
  /**
   * The canvas area not covered by the stage (a selection opens it on the
   * right; it mirrors the stage's CSS: 40 % clamped 360..620 px) or by the
   * open inbox drawer: [left, width] in canvas pixels.
   */
  const visibleArea = (): { left: number; width: number } => {
    const { w } = viewSize();
    if (viewState.inboxFrame() !== undefined) {
      const drawer = document.querySelector<HTMLElement>('[data-testid="decision-inbox"]');
      const rect = canvas.getBoundingClientRect();
      const drawerLeft = drawer ? drawer.offsetLeft - rect.left : w * 0.4;
      return { left: 0, width: Math.max(160, Math.min(w, drawerLeft)) };
    }
    if (selection.selectedId() === null) return { left: 0, width: w };
    return { left: 0, width: Math.max(160, w - Math.min(620, Math.max(360, w * 0.4))) };
  };
  /** The final rects (transition targets) of leaves and containers: what a framing must fit once growth settles. */
  const finalRectOf = (id: string): Rect | undefined => {
    const t = targets();
    const leafRect = t.get(id);
    if (leafRect) return leafRect;
    const graph = topoGraph();
    return graph ? containerRects(graph, (k) => t.get(k)).get(id) : undefined;
  };
  /**
   * Double-click framing (decision 2026-10-10, [H] review): the view moves so
   * `bounds` fits the visible area with a margin, centred there; the zoom is
   * snapped onto the ladder (at or below the fit) so notches stay reversible.
   */
  const frameView = (bounds: Rect) => {
    const { h: vh } = viewSize();
    const area = visibleArea();
    if (area.width === 0 || vh === 0) return;
    const c = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    const zoom = snapDown(ladderAt(c.x, c.y), fitZoomRelative(bounds, area.width, vh, FRAME_MARGIN));
    // Centre the bounds in the visible area, not the whole canvas.
    const offset = area.left + area.width / 2 - viewSize().w / 2;
    cancelStagePan();
    yieldCamera();
    viewState.takeCamera();
    zoomSlot = null;
    setLadderPoint(c);
    moveCamera({ x: c.x - offset / zoom, y: c.y, zoom });
  };
  /**
   * Frames a node: a leaf with its one-hop neighbours (received relations,
   * either direction), a container by itself — each by its FINAL box (the
   * double-click's first click selected it, and selection can grow it).
   */
  const frameNode = (id: string) => {
    if (layout().nodes.has(id)) {
      const ids = new Set([id]);
      for (const edge of scene()?.edges ?? []) {
        if (edge.from === id) ids.add(edge.to);
        if (edge.to === id) ids.add(edge.from);
      }
      const rects = [...ids].map(finalRectOf).filter((r): r is Rect => r !== undefined);
      if (rects.length === 0) return;
      const minX = Math.min(...rects.map((r) => r.x));
      const minY = Math.min(...rects.map((r) => r.y));
      const maxX = Math.max(...rects.map((r) => r.x + r.w));
      const maxY = Math.max(...rects.map((r) => r.y + r.h));
      frameView({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
      return;
    }
    const box = finalRectOf(id) ?? scene()?.groups.find((g) => g.id === id);
    if (box) frameView(box);
  };
  onMount(() => {
    const onFrameNode = (e: Event) => frameNode((e as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener(FRAME_NODE_EVENT, onFrameNode);
    onCleanup(() => window.removeEventListener(FRAME_NODE_EVENT, onFrameNode));
  });
  const onDblClick = (e: MouseEvent) => {
    const w = screenToWorld(e.clientX, e.clientY);
    if (hitSticky(w.x, w.y) || hitBox(w.x, w.y)) return;
    // A node or a container: frame it. A node's work surface (③) opens with Enter or the stage button.
    const hit = hitTest(w.x, w.y) ?? hitGroup(w.x, w.y);
    if (hit) {
      frameNode(hit.id);
      return;
    }
    // Empty canvas: one anchor out (the next containment level that fits on screen), at the point.
    if (hitSticky(w.x, w.y) || hitBox(w.x, w.y)) return;
    const base = zoomBase();
    const p = worldAt(base, e.clientX, e.clientY);
    const out = anchorOut(ladderAt(p.x, p.y), base.zoom);
    if (out === null) return;
    yieldCamera();
    viewState.takeCamera();
    zoomSlot = null;
    setLadderPoint(p);
    moveCamera(zoomAtPoint(base, out, p.x, p.y));
  };

  // Right-click: the context menu for whatever is under the cursor.
  function targetAt(wx: number, wy: number): ContextMenuState['target'] {
    const sticky = hitSticky(wx, wy);
    if (sticky) return { kind: 'sticky', id: sticky.id };
    const node = hitTest(wx, wy) ?? hitGroup(wx, wy);
    if (node) return { kind: 'node', id: node.id };
    const box = hitBox(wx, wy);
    if (box) return { kind: 'box', id: box.id };
    return { kind: 'empty' };
  }
  let swallowContextMenu = false;
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    // The contextmenu that trails a hold session must not reopen the ring.
    if (swallowContextMenu) {
      swallowContextMenu = false;
      return;
    }
    // This path serves synthetic events only (tests, keyboards without pointer).
    if (!menu()) {
      const w = screenToWorld(e.clientX, e.clientY);
      setMenu({ x: e.clientX, y: e.clientY, world: w, target: targetAt(w.x, w.y) });
    }
  };
  // Keyboard path (Shift+F10 / ContextMenu key on a mirror node): anchored at the node's drawn box.
  onMount(() => {
    const onNodeMenu = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail.id;
      const box = nodeRect(id);
      const rect = canvas.getBoundingClientRect();
      const cam = viewState.camera();
      const sx = box ? rect.left + rect.width / 2 + (box.x + box.w / 2 - cam.x) * cam.zoom : rect.left + rect.width / 2;
      const sy = box ? rect.top + rect.height / 2 + (box.y + box.h / 2 - cam.y) * cam.zoom : rect.top + rect.height / 2;
      setMenu({ x: sx, y: sy, world: screenToWorld(sx, sy), target: { kind: 'node', id } });
    };
    window.addEventListener('gunnflow:node-contextmenu', onNodeMenu);
    onCleanup(() => window.removeEventListener('gunnflow:node-contextmenu', onNodeMenu));
  });
  // Explicit tidy (chrome hook, see space.ts): a TRANSITION MOMENT — full
  // relayout with then-current tier sizes, then a re-fit once it settles.
  onMount(() => {
    const onTidy = () => {
      setTidyCount((c) => c + 1);
      void layoutState.settled().then(() => fit());
    };
    window.addEventListener(TIDY_EVENT, onTidy);
    onCleanup(() => window.removeEventListener(TIDY_EVENT, onTidy));
  });

  // ---- zoom ladder (GF-P1b C) ---------------------------------------------
  /** The canvas size in CSS pixels (0 before layout); kept by the resize observer. */
  const [viewSize, setViewSize] = createSignal({ w: 0, h: 0 });
  /**
   * The ladder at a world point: anchors are the fit zooms of everything
   * (containment depth 0) and of the containers under the point at depths
   * 1 and 2. View math only.
   */
  const ladderAt = (wx: number, wy: number): Ladder => {
    const { w, h } = viewSize();
    if (w === 0 || h === 0) return ladderWith([]);
    const anchors: number[] = [];
    const all = layoutBounds(layout());
    if (all) anchors.push(fitZoom(all, w, h));
    for (const g of scene()?.groups ?? []) {
      if (g.depth <= 1 && inside(g, wx, wy)) anchors.push(fitZoom(g, w, h));
    }
    return ladderWith(anchors);
  };
  /** Where the last zoom move happened (world); the tick scale shows the ladder there. Null = the view centre at that time. */
  const [ladderPoint, setLadderPoint] = createSignal<{ x: number; y: number } | null>(null);
  /** The tick scale's ladder: recomputed on layout, resize or a new zoom point — never per animation frame. */
  const viewLadder = createMemo(() => {
    layout();
    viewSize();
    const p = ladderPoint() ?? untrack(viewState.camera);
    return ladderAt(p.x, p.y);
  });
  /** A zoom's place on the tick scale (0 = ZOOM_MIN, 1 = ZOOM_MAX, log scale). */
  const ladderPos = (z: number) => (Math.log(z) - Math.log(ZOOM_MIN)) / (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN));
  let zoomSlot: Slot | null = null;
  let wheelAcc = 0;
  /** The ladder the accumulated trackpad input belongs to: input never carries over to another ladder. */
  let wheelLadderKey = '';
  let lastWheelAt = 0;
  /** A pause this long ends a trackpad gesture: what it left in the accumulator is dropped. */
  const WHEEL_IDLE_MS = 250;
  /** The camera a zoom move starts from: where a running move is heading, else the camera itself. */
  const zoomBase = () => tweenTarget ?? viewState.camera();
  /** The world point under a client point, as seen from `cam`. */
  const worldAt = (cam: { x: number; y: number; zoom: number }, sx: number, sy: number) => {
    const rect = canvas.getBoundingClientRect();
    return { x: cam.x + (sx - rect.left - rect.width / 2) / cam.zoom, y: cam.y + (sy - rect.top - rect.height / 2) / cam.zoom };
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt > WHEEL_IDLE_MS) wheelAcc = 0;
    lastWheelAt = now;
    // Escape hatch: pinch (ctrl+wheel on trackpads) and Alt+wheel zoom freely, off the ladder,
    // from the view as displayed (a running step move stops where it is).
    if (e.ctrlKey || e.altKey) {
      const shown = viewState.camera();
      const p = worldAt(shown, e.clientX, e.clientY);
      const px = wheelPixels(e.deltaY, e.deltaMode);
      const sens = props.stores.prefs.prefs().zoomSensitivity;
      const factor = e.ctrlKey ? Math.exp(-px * 0.01) : sens ** (-px / 100);
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, shown.zoom * factor));
      yieldCamera();
      viewState.takeCamera();
      viewState.setCameraView(zoomAtPoint(shown, zoom, p.x, p.y));
      setLadderPoint(p);
      zoomSlot = null;
      wheelAcc = 0;
      return;
    }
    const base = zoomBase();
    const p = worldAt(base, e.clientX, e.clientY);
    const ladder = ladderAt(p.x, p.y);
    const key = ladderKey(ladder);
    if (key !== wheelLadderKey) {
      wheelLadderKey = key;
      wheelAcc = 0;
    }
    const { notches, acc } = wheelNotches(wheelAcc, e.deltaY, e.deltaMode);
    wheelAcc = acc;
    if (notches === 0) return;
    setLadderPoint(p);
    let zoom = base.zoom;
    for (let k = 0; k < Math.abs(notches); k++) {
      const r = stepZoom(ladder, zoom, notches > 0 ? 1 : -1, zoomSlot);
      zoom = r.zoom;
      zoomSlot = r.slot;
    }
    // An absorbed notch (anchor stickiness, ladder end) leaves a running move alone.
    if (zoom === base.zoom) return;
    yieldCamera();
    viewState.takeCamera();
    moveCamera(zoomAtPoint(base, zoom, p.x, p.y));
  };

  const fit = () => {
    const bounds = layoutBounds(layout());
    if (!bounds) return;
    const rect = canvas?.parentElement?.getBoundingClientRect();
    if (rect && rect.width > 0) viewState.fitBounds(bounds, rect.width, rect.height);
    else viewState.centerOn(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2);
  };
  /**
   * The automatic fits (mount, first snapshot, first layered pass) leave a
   * held camera alone: one the inbox restored on close (결정함 F2) survives
   * the remount after ③, until the person moves the view themselves.
   */
  const autoFit = () => {
    if (!suppressInitialFits) fit();
  };
  onMount(autoFit);
  // The first layered pass replaces the first layout: frame it again then — unless the user has already moved the view.
  let refitted = false;
  createEffect(() => {
    if (!refitted && layoutState.source() === 'layered') {
      refitted = true;
      if (!viewState.userMoved()) autoFit();
    }
  });
  let fitted = false;
  createEffect(() => {
    if (!fitted && projectionStore.hasSnapshot()) {
      fitted = true;
      // A view the person already zoomed or panned (before the first snapshot landed) is left alone.
      if (!untrack(viewState.userMoved)) autoFit();
    }
  });

  return (
    <div class="canvas-host" data-testid="canvas-host">
      <canvas
        ref={canvas}
        aria-label="Workspace topology canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => {
          if (chipPopover() && !chipPopover()!.pinned) setChipPopover(null);
        }}
        onLostPointerCapture={onPointerCancel}
        onMouseDown={onButtonDefault}
        onMouseUp={onButtonDefault}
        onAuxClick={onButtonDefault}
        onDblClick={onDblClick}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
      />
      <Show when={chipPopover()}>
        {(pop) => {
          const links = () => scene()?.nestedLinks.get(pop().id) ?? [];
          const titleOf = (id: string) => scene()?.nodes.get(id)?.title ?? id;
          const host = () => canvas.getBoundingClientRect();
          return (
            <div
              ref={chipPopoverEl}
              class="nested-popover"
              data-testid="nested-link-popover"
              data-pinned={pop().pinned ? 'yes' : 'no'}
              role="dialog"
              aria-label={`Relations with containers of ${titleOf(pop().id)}`}
              style={{ left: `${pop().x - host().left + 12}px`, top: `${pop().y - host().top + 12}px` }}
            >
              <For each={links()}>
                {(l, i) => (
                  <button
                    data-testid={`nested-link-${i()}`}
                    title={`${l.type} (${l.direction === 'in' ? `${titleOf(l.other)} → this` : `this → ${titleOf(l.other)}`})`}
                    onClick={() => {
                      selection.select(l.other);
                      setChipPopover(null);
                    }}
                  >
                    {l.direction === 'in' ? `◂ ${titleOf(l.other)} — ${l.type} →` : `◂ — ${l.type} → ${titleOf(l.other)}`}
                  </button>
                )}
              </For>
            </div>
          );
        }}
      </Show>
      {/* The zoom ladder's tick scale: every step, anchors larger, the current zoom marked (view chrome). */}
      <div class="zoom-ladder" data-testid="zoom-ladder" aria-hidden="true">
        <For each={viewLadder().steps}>
          {(s) => (
            <span
              class="zoom-tick"
              classList={{ anchor: viewLadder().anchors.includes(s) }}
              data-zoom={s.toFixed(4)}
              style={{ bottom: `${ladderPos(s) * 100}%` }}
            />
          )}
        </For>
        <span class="zoom-current" data-testid="zoom-current" data-zoom={viewState.camera().zoom.toFixed(4)} style={{ bottom: `${ladderPos(viewState.camera().zoom) * 100}%` }} />
      </div>
      <Show when={menuPresence.held()}>
        {(state) => (
          <CanvasContextMenu
            stores={props.stores}
            state={state()}
            motion={menuPresence.phase()}
            onClose={() => setMenu(null)}
            onEnterRewire={() => props.onArmRewire()}
            onOpenPersonalList={() => props.onOpenPersonalList()}
          />
        )}
      </Show>
    </div>
  );
}
