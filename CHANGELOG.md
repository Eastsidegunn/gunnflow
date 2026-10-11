# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
aims to follow [Semantic Versioning](https://semver.org/). The contract package
`@gunnflow/contract` is versioned separately; its version is noted where it changes.

## [Unreleased]

- `@gunnflow/contract` 0.6.0: a node may carry optional upstream-stated decorations — `shortName`, `summary`, `active`, `lastActivityTs`, `changedAtRevision`, `originNodeId`, `steps` (bounds in the package README); absent means only that decoration is omitted. Snapshot rule: a node's `changedAtRevision` must not exceed the snapshot revision (`snapshotNodeProblem`, `snapshotProblem`); the cockpit drops only the offending node, with its reason. Wiring: a relation may state its `role` (`waits_on`, `blocks`, `supports`, `produces`, `contains`; helper `relationRoleFor`), presentation only — `arrange` stays the layout authority. 0.5 consumers reject nodes carrying the new keys, so backends must not emit them to a 0.5 cockpit. Consumers claim `0.6.x`. The simulator gains a `views` fixture carrying the decorations. `@gunnflow/upstream-port` 0.1.3: packaging only — peer `@gunnflow/contract` widened to `^0.3.1 || ^0.4.0 || ^0.5.0 || ^0.6.0`.
- A relation between a container and one of its own descendants (other than the containment the nesting shows) is no longer drawn as a line from the box to something inside it — it read as the containment again. The descendant carries a small '◂' chip instead; hovering names the relation, clicking pins the detail, and a row selects the container. Decided by containment geometry only, never by a relation's name; relations between nodes that are not nested in each other keep their lines.
- `@gunnflow/contract` 0.5.0: a wiring kind may state its node `shape` (`rect`, `pill`, `circle`, `diamond`, `hexagon`; `band` for containers) and a `size` factor (0.5–3); `parts` becomes optional. Presentation only — a shape says nothing about state, risk or priority. Every existing config stays valid; node, detail and intent wire are unchanged. Consumers claim `0.5.x`. `@gunnflow/upstream-port` 0.1.2: packaging only — peer `@gunnflow/contract` widened to `^0.3.1 || ^0.4.0 || ^0.5.0`.
- Node shapes: kinds are sized, outlined and hit-tested by their shape (a diamond's corner is empty canvas); a circle's title sits beside it; shapes too small for a chip row (circle, diamond, pill) show no action chips — actions stay in the menu and the stage; band containers pack their members into a wide row under a name strip. Wiring files merge a kind field by field, so a later file can change a shape and keep the parts. While dragging, a dashed outline previews where the drop will settle.
- Zoom moves in close geometric steps (×1.22) with anchors at the zoom that fits everything or the container under the cursor; an anchor costs one extra notch to pass, and any path of notches reversed returns to the same view. A tick scale shows the steps. Double-click frames what was clicked — a container with an 8 % margin, a node together with its one-hop neighbours — beside the stage, on a ladder step; on empty canvas it goes one anchor out. A node's work surface opens with Enter or the stage button. Pinch and Alt+wheel zoom freely. Detail lines switch once per zoom move, never mid-move.
- A dropped node (or a dragged container's members, as one set) settles clear of other nodes, with a minimum gap, and never inside a container it does not belong to; if nothing fits nearer, it returns to where it was grabbed.
- Input contract: the middle button always pans, whatever lies under it, and never selects; left manipulates elements, wheel zooms, right opens the menu; back/forward buttons do nothing on the canvas.
- The status line's "need you" is counted from received attention when the backend sends no count of its own (marked as a view); the grouped inbox toggle shows the same total beside its group counts.

- `@gunnflow/contract` 0.4.0: the wiring schema gains optional presentation fields — `attention[].group` (display group name), `actions` (display label per action name), `detail.collapsed` and `detail.copyable` (`detail.emphasis` becomes optional). Every existing config stays valid; node, detail and intent wire are unchanged. Consumers claim `0.4.x`.
- Decision inbox v2: attention groups with per-group counts on the toggle (a node carrying an interrupt cause is grouped only through interrupt rules; interrupt groups expanded, ambient groups folded), the canvas frames the selected item beside the drawer and restores the camera on close (also across ③ and under reduced motion), the drawer is non-modal so the canvas beside it keeps pan, zoom and a transient selection highlight (closing puts back the selection from before; menus over the canvas keep their own arrows and Esc), a readable claim-graded detail body, config action labels (inbox bar, canvas node chips, context menu), a horizontal action bar whose text slots expand in place (only the primary optional note is inline; no hidden text is ever sent), folded detail items, waiting time from `attention.since`, and exact-bytes copy boxes that make invisible characters visible (Gunnflow never executes them).
- `@gunnflow/upstream-port` 0.1.1: packaging only — peer `@gunnflow/contract` widened to `^0.3.1 || ^0.4.0`; `pack-check` parses `||` ranges and requires both 0.3.1 and the current contract version.
- `@gunnflow/upstream-port` 0.1.0 is publishable: built `dist/` (it carries one runtime class, `UnsupportedDetail`), npm metadata, README and LICENSE; peer `@gunnflow/contract` `^0.3.1`. `scripts/pack-check.mjs` checks either package's tarball (`pnpm contract:pack-check`, `pnpm upstream-port:pack-check`).
- `@gunnflow/contract` 0.3.2: a live artifact URL carrying userinfo credentials (`user:pass@`) is refused by the validator; the problem text never echoes the URL. Compliant backends are unaffected.
- `@gunnflow/contract` 0.3.1: the optional `vitest` peer (conformance suite) accepts `^3 || ^4 || ^5`. Packaging only — no contract change.

## [0.1.0] - Unreleased

First public snapshot. Alpha: works end to end against the in-repo simulator
(`testing/fake-contracts`) and the reference direct-wire server. Any backend implementing
`packages/contract/WIRE.md` can connect through the `direct` upstream; an adapter maintained
outside this repository is not verifiable here.

### Added

- **Cockpit shell.** SolidJS + Vite web app with a canvas-rendered infinite workspace (pan, zoom,
  semantic zoom) and DOM chrome; Fastify BFF that only transports (SSE fan-out and intent relay);
  a separate isolated preview origin for agent artifacts.
- **Contract `@gunnflow/contract`** — owned by Gunnflow: types, runtime validators, digest
  rules, wiring config schema and a conformance suite for backends. Surfaces:
  - nodes (snapshot + SSE re-publication of full snapshots),
  - streams (append streams with sequence numbers and declared loss; simulator-only until the
    upstream stream contract lands),
  - intents (canonical `Intent` with optional `decision` / `edit` / `attestation` slots and
    idempotency key; actor carried out of band),
  - artifacts (digest-addressed bytes, re-hashed by the preview origin),
  - node detail (on-demand `GET /detail/:nodeId`, opaque labelled items),
  - execution (`GET /execution/:taskId` + SSE, sessions and append-only events, size
    limits and a `truncatedBefore` window marker).
  The contract went through 0.2.0 (node detail) and 0.3.0 (execution surface) during
  development; these are not described as published releases here.
- **Direct wire** ([packages/contract/WIRE.md](packages/contract/WIRE.md)): a backend that serves
  the documented HTTP endpoints connects with one config line
  (`{ "upstream": "direct", "url": … }`). Unsupported optional surfaces are shown as unsupported,
  never as empty.
- **Single wiring port** with exactly two built-in upstreams, `fake` (simulator) and `direct`;
  configuration never names code to load.
- **Generic node assembly via wiring parts.** Nodes are assembled from parts (glyphs, labels,
  viewers, live frames, streams, selector/text/editor inputs, send, attention) per kind in
  data-only wiring config. Wiring files in `wiring/` merge in filename order over a built-in
  default; invalid files are skipped and reported. Literal render vocabulary (emoji, `#rrggbb`).
  Unregistered vocabulary falls back to neutral, undistorted display.
- **Pending intent lifecycle**: composing → in-flight (± unconfirmed) → confirmed or rejected;
  rejection never destroys human input.
- **Screen grades**: assured / claim / portal / draft / personal, visually distinct.
- **Viewers** from a closed set (text, markdown source, image, PDF, isolated HTML, Excalidraw,
  Mermaid, fallback). Interpreted content renders only on the isolated preview origin. Mermaid
  has a renderer port, but no renderer is wired by default, so it shows as unavailable with a
  reason. Opaque
  bytes fall back to download. Live portals open only on explicit request.
- **Personal layer**: local-only notes, stickies and a planning board, persisted by the BFF to
  local files, never sent upstream.
- **Layout**: ELK layered flow, containment groups (directional contains-style edges), stable
  positions, fit-to-workspace.
- **Dynamic view P1–P3**: layout overhaul (P1); relevance tiers from explicit signals only —
  selection, pending, received diffs, attention, lenses — driving emphasis and per-node detail
  (P2); tier-based size and transition animation where growth stays inside local slack, with pins
  keeping position (P3).
- **Cockpit depth model**: overview → right-side stage for the selection → full work surface;
  Esc steps back one level. Depth 3 falls back to the generic assembly when the live projection
  carries no domain record.
- **Decision inbox**: a drawer queue with interrupts first, folded decided items, detail with
  wiring-configured emphasis, capability-driven actions, auto-advance and per-row intent badges.
- **Attention**: interrupt notifications behind a top-right toggle with a count; arrival toasts;
  unregistered causes default to ambient; attention passes through filters.
- **Interaction**: radial context menu (hold right button), settings overlay with configurable
  shortcuts, config-defined lenses including subtree matching, theme presets, upstream link state
  with manual refresh.
- **Domain surfaces against the simulator**: task inspector, human gate / approval, execution
  surface, live terminal (fake PTY).
- **Simulator** (`testing/fake-contracts`): a reference fake backend that passes conformance,
  in-process and as a direct-wire HTTP server, with fixtures and test controls (bursts, declared
  stream loss).
- **Tooling**: `pnpm verify` (boundary-lint, typecheck, Vitest, build); `scripts/boundary-lint.mjs`
  (layering and no backend names in the core); `pnpm render-sweep` (audits a live wire's emitted
  vocabulary against wiring mappings); Playwright e2e covering simulator and direct paths.

### Changed

- Re-chartered from an agent-supervision UI into a backend-agnostic
  cockpit: domain words moved out of the engine into wiring vocabulary.
- In-process backend adapters were removed; backends connect over the direct wire only.
- No backend vocabulary is loaded by default: `wiring/*.json` is the user's own (git-ignored);
  backend-specific wiring ships as examples under `examples/wiring/`.
- `pnpm render-sweep` has no default wire URL (`--url`, `GUNNFLOW_SWEEP_URL`, or a `direct`
  `gunnflow.config.json`); `gunnflow.config.example.json` documents the connection file.
- `GUNNFLOW_BIND_HOST` sets the listen address of the BFF, preview server and Vite dev server
  (default `127.0.0.1`); every supported environment variable is documented in the README.
- `boundary-lint` reads the backend names it checks from `scripts/boundary-names.json`.
