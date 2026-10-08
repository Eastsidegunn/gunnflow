> 한국어: [README.ko.md](README.ko.md)

# Gunnflow

**Gunnflow is a backend-agnostic human cockpit.** It is a visualization and manipulation engine
for node-relation data, built for systems whose meaning and truth live somewhere else — in a
backend. The UI reflects the state it receives, relays human actions upstream as intents,
enforces decision procedures, shows agent-produced artifacts in isolation, and delivers
attention signals. Workspace vocabulary (which states, relations, actions and causes exist and
how they look) comes from a data-only wiring config, not from code.

Three principles:

- **Everything meaningful on screen is received.** The cockpit never infers progress, priority,
  dependency, risk or content fitness. The only things it makes up itself are node positions
  (local, meaningless) and statements about its own behaviour ("I displayed these bytes").
- **Direct control is not a bypass.** Every human intervention is a new intent recorded through
  the backend's append-only audit chain. The stronger the intervention, the stronger the trail.
- **The cockpit never invents truth.** Derived views (filters, highlights, received-history
  diffs) are labelled as views, never shown as received facts, and never sent upstream.

## Why

Agent systems produce more state than a person can read, and the dangerous moments are the ones
where a human must decide or step in. Dashboards bake one backend's semantics into the UI;
Gunnflow keeps the semantics in the backend and gives the human a single, honest place to see,
judge and steer — whatever backend is behind it.

## Status

**Alpha.** Gunnflow works end to end against the in-repo simulator (`testing/fake-contracts`) and
the reference direct-wire server. Any backend that implements
[`packages/contract/WIRE.md`](packages/contract/WIRE.md) can connect through the `direct` upstream.
A backend adapter maintained outside this repository is not verifiable here. The contract package
`@gunnflow/contract` is versioned (currently **0.4.0**) and may still change between minor
versions. Expect rough edges.

## 30-second start

Prerequisites: **Node.js 22 or newer** (`engines.node >= 22`) and **pnpm 10**
(`packageManager: pnpm@10.34.5`; `corepack enable` picks it up).

```sh
pnpm install
pnpm dev
```

Gunnflow runs from source. The workspace packages (`@gunnflow/*`) are `private` and are not
published to npm.

`pnpm dev` starts three servers on `127.0.0.1` (see [Configuration](#configuration)):

| Port | What |
|---|---|
| 5173 | web app (SolidJS + Vite; proxies `/api` to the BFF) — open this |
| 8787 | BFF (transport only: SSE fan-out + intent relay) |
| 8788 | isolated preview origin for agent artifacts (separate origin, strict CSP) |

**Upstream selection.** The BFF reads an optional config file — `~/.gunnflow/config.json`, or a
git-ignored `gunnflow.config.json` at the repository root (see [Configuration](#configuration) for
the order). Environment variables win over the file. With no file and no
`GUNNFLOW_UPSTREAM` set, the upstream is `fake` — the in-repo simulator — so the commands above
show a demo workspace with no backend at all.

To connect a backend that speaks the direct wire, copy
[`gunnflow.config.example.json`](gunnflow.config.example.json) to `~/.gunnflow/config.json` and fill
in your backend's base URL:

```json
{ "upstream": "direct", "url": "<backend base URL>" }
```

(The placeholder itself is not a URL and is refused at startup — replace it.) To try the direct
path without a backend of your own, run the in-repo reference server
(`pnpm --filter @gunnflow-testing/fake-contracts serve:direct`, listening on
`http://127.0.0.1:8791`) and use that as the URL. Alternatively set `GUNNFLOW_UPSTREAM=direct` and `GUNNFLOW_UPSTREAM_URL=<backend base URL>`. `upstream` must be
`fake` or `direct`; `direct` without a URL refuses to start, and unknown keys are rejected. Other
accepted keys: `webOrigin`, `previewOrigin`, `wiringDir`, `personalDir`.

Workspace vocabulary and display preferences: drop wiring JSON files into `wiring/`; they are
merged in filename order over the built-in default (see [wiring/README.md](wiring/README.md)).
Nothing ships in `wiring/` by default (its `*.json` files are git-ignored, they are yours);
backend-specific examples live in [examples/wiring/](examples/wiring/README.md).
Without any wiring, unknown vocabulary still renders honestly: neutral glyph plus the raw term,
default edge, raw-label action button, ambient attention, fallback viewer.

## Configuration

Settings come from an optional config file (keys in the second column) and from environment
variables; **an environment variable wins over the file**.

**Your settings live outside the repository.** Gunnflow keeps everything that is yours — connection
config, wiring, personal notes, display preferences — in a per-user home directory, `~/.gunnflow`
by default (`GUNNFLOW_HOME` moves it). Keep your own settings there rather than in the code folder:
they survive a fresh clone, and they can never be committed by accident.

```text
~/.gunnflow/                    ($GUNNFLOW_HOME)
  config.json                   connection config (same keys as gunnflow.config.example.json)
  wiring/                       your wiring files (used when the directory exists)
  personal/                     personal layer: local notes, never sent upstream
  prefs.json                    display preferences written by the settings screen
  boundary-names.local.json     extra names for pnpm boundary-lint to check (optional)
```

Which config file is used (the first that applies). The BFF, the web dev server/build and
`pnpm render-sweep` resolve and validate it with the same code (`scripts/gunnflow-settings.mjs`); an
invalid file stops them with the reason instead of being ignored, and the BFF logs which file it
loaded:

1. `GUNNFLOW_CONFIG` — an explicit path (startup is refused if it does not exist)
2. `gunnflow.config.json` at the repository root (kept for backward compatibility)
3. `$GUNNFLOW_HOME/config.json`
4. none — built-in defaults, i.e. the simulator

Which wiring directory is used: an explicit `GUNNFLOW_WIRING_DIR` or config `wiringDir` (relative to
the repository root) > `$GUNNFLOW_HOME/wiring` if it exists > `wiring/` in the repository. The files
in it are layered in name order, as before.

| Environment variable | Config key | Meaning | Default |
|---|---|---|---|
| `GUNNFLOW_HOME` | — | Your Gunnflow home directory (a leading `~` is expanded) | `~/.gunnflow` |
| `GUNNFLOW_CONFIG` | — | Path of the config file | see the order above |
| `GUNNFLOW_UPSTREAM` | `upstream` | `fake` (in-repo simulator) or `direct` (a backend speaking the direct wire) | `fake` |
| `GUNNFLOW_UPSTREAM_URL` | `url` | Backend base URL for `direct` (required for `direct`) | — |
| `GUNNFLOW_WIRING_DIR` | `wiringDir` | Wiring config directory (relative to the repository root) | `$GUNNFLOW_HOME/wiring` if present, else `wiring` |
| `GUNNFLOW_PERSONAL_DIR` | `personalDir` | Personal-layer directory (local notes, never sent upstream) | `$GUNNFLOW_HOME/personal` |
| `GUNNFLOW_WEB_ORIGIN` | `webOrigin` | The web app's origin, the only origin the preview server lets read cross-origin | `http://127.0.0.1:5173` |
| `GUNNFLOW_PREVIEW_ORIGIN` | `previewOrigin` | Origin of the isolated preview server, as the browser reaches it (also read by the web build; its port is the preview listen port unless `GUNNFLOW_PREVIEW_PORT` is set) | `http://127.0.0.1:8788` |
| `VITE_PREVIEW_ORIGIN` | — | Same as `GUNNFLOW_PREVIEW_ORIGIN`, for the web app only (wins over it there) | — |
| `GUNNFLOW_PREFS_FILE` | — | Display-preferences file written by the settings screen | `$GUNNFLOW_HOME/prefs.json` |
| `GUNNFLOW_BIND_HOST` | — | Address the BFF, the preview server and the Vite dev server listen on | `127.0.0.1` |
| `GUNNFLOW_BFF_PORT` | — | BFF port (the web dev proxy follows it) | `8787` |
| `GUNNFLOW_PREVIEW_PORT` | — | Preview server port | port of the preview origin, else `8788` |
| `GUNNFLOW_WEB_PORT` | — | Vite dev server port | `5173` |
| `GUNNFLOW_SWEEP_URL` | — | Wire URL for `pnpm render-sweep` when `--url` is not given | — |
| `FAKE_DIRECT_PORT` | — | Test/dev only: port of the in-repo direct-wire reference server | `8791` |
| `CI` | — | Test only: when set, Playwright never reuses an already-running server | unset |
| `BOUNDARY_NAMES_FILE` | — | Test only: alternative names data file for `pnpm boundary-lint` (when set, `$GUNNFLOW_HOME/boundary-names.local.json` is not merged) | `scripts/boundary-names.json` |

**Bind host.** Everything listens on loopback by default. `GUNNFLOW_BIND_HOST` (for example
`0.0.0.0` inside a container) changes that for all three servers — but the BFF has no
authentication, so this **exposes an unauthenticated BFF** (see [SECURITY.md](SECURITY.md)). The
browser-facing origins do not follow the bind host automatically: when the app is reached under
another host name, set `GUNNFLOW_WEB_ORIGIN` and `GUNNFLOW_PREVIEW_ORIGIN` (or `previewOrigin` /
`VITE_PREVIEW_ORIGIN`) to the addresses the browser uses. The preview origin must stay a different
origin from the web app.

## Build and test

```sh
pnpm verify        # boundary-lint + typecheck + unit tests (Vitest) + build — must be green
pnpm e2e           # Playwright scenarios (first: pnpm --filter @gunnflow/web exec playwright install chromium)
pnpm render-sweep  # audit a live wire's vocabulary against wiring/ (see below)
```

`pnpm e2e` starts its own servers pinned to the simulator, both in-process (`fake`) and over a
local direct-wire reference server, with `GUNNFLOW_HOME` pointed at a temporary directory, so it
never touches your local config, your `~/.gunnflow` or a real backend.

`pnpm render-sweep --url <backend base URL>` fetches `/nodes` from a live wire (the URL may also
come from `GUNNFLOW_SWEEP_URL`, or from the config file — resolved as above — when it selects
`direct`; with none of these it exits 3; `--wiring <dir>` picks the wiring directory, otherwise it
is resolved as above) and reports every emitted state, relation, attention cause,
kind and artifact media type that no valid wiring file maps. Exit codes: 0 clean, 1 gaps,
2 wire unreachable, 3 setup error. It needs the contract build:
`pnpm --filter @gunnflow/contract build`.

## Architecture

```
Browser (web :5173)
   │  SSE (state) · SSE (streams) · POST (intents)
   ▼
BFF (:8787) — transport only: carries and condenses, never decides
   │
   ▼
single wiring port (@gunnflow/upstream-port)
   │
   ├─ fake    → in-repo simulator (testing/fake-contracts)
   └─ direct  → any backend speaking the direct wire (or its own adapter/proxy)

Isolated preview origin (:8788) — serves agent artifacts by digest, sandboxed iframe + strict CSP
```

```
apps/web                 SolidJS + Vite cockpit (canvas rendering, DOM chrome)
apps/bff                 Fastify BFF + isolated preview server
packages/contract        @gunnflow/contract — types, runtime validators, digest rules,
                         conformance suite, wiring config schema
packages/upstream-port   @gunnflow/upstream-port — the BFF's wiring port interface
testing/fake-contracts   simulator: a reference fake backend that passes conformance
scripts/                 boundary-lint (layering + no backend names in core), render-sweep
wiring/                  your wiring config files (data only; nothing shipped)
examples/wiring/         example wiring configs for specific backends
```

The contract is owned by Gunnflow. A backend connects by exposing the required HTTP surfaces
described in **[packages/contract/WIRE.md](packages/contract/WIRE.md)**: `GET /nodes`,
`GET /stream` (SSE), and `POST /intent`. Optional surfaces are `GET /artifact/:id/:digest`,
`GET /detail/:nodeId`, `GET /execution/:taskId`, and `GET /execution/:taskId/stream` (SSE).
An unsupported optional surface answers `501` and is shown as *unsupported*, never as empty. A
backend can check itself with the conformance suite (see
[packages/contract/README.md](packages/contract/README.md)).

## Related projects

Gunnflow is the cockpit UI. **Rhizome** and **JANUS** are separate projects referenced in the
design documents: Rhizome's role is board/coordinator backend work, while JANUS's role is
execution isolation and governance. The Gunnflow core does not know either by name (enforced by
`pnpm boundary-lint`).

## Design records

`docs/` holds the design and decision records, largely in Korean, kept public on purpose as part
of building in public. Contribution rules: [CONTRIBUTING.md](CONTRIBUTING.md). Upstream contracts not
yet settled: [BLOCKED.md](BLOCKED.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Changes are tracked in
[CHANGELOG.md](CHANGELOG.md).

## License

Gunnflow is released under the [MIT License](LICENSE).
