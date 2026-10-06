# Contributing to Gunnflow

Gunnflow is alpha software built in public. Issues and small pull requests are welcome.

## Setup

- Node.js 22+, pnpm 10 (`corepack enable` picks the version pinned in `package.json`).
- `pnpm install`, then `pnpm dev` (web :5173, BFF :8787, isolated preview :8788). With no config
  file (`~/.gunnflow/config.json` or `gunnflow.config.json`), the BFF runs the in-repo simulator.

## Before opening a pull request

- `pnpm verify` must pass (boundary-lint, data-scan, typecheck, Vitest, build) — CI runs the same.
- No personal data or environment details in the tree: `pnpm data-scan` flags home paths with a
  username, private/CGNAT IPv4 addresses, tailnet hosts and tracked data files (mark a deliberate
  fixture line with `data-scan:allow`); patterns of your own can go in
  `~/.gunnflow/data-scan.local.json` (array of `{ name, pattern, flags }`) without being published.
- UI behaviour changes: run `pnpm e2e` (first `pnpm --filter @gunnflow/web exec playwright install chromium`),
  add or update a scenario in `apps/web/e2e/`, and attach a screenshot to the PR.
- Keep each PR to one behaviour.

## Rules that keep the cockpit honest

- **Meaning comes from the backend.** If something is semantic (progress, priority, risk,
  relevance of content), the backend must send it; the UI never infers it.
- **The core names no backend.** `apps/`, `packages/` and `testing/` stay backend-agnostic;
  `pnpm boundary-lint` enforces it (names to check are data in `scripts/boundary-names.json`).
  Backend vocabulary belongs in wiring JSON — shareable examples go in `examples/wiring/`.
- **Every write is an intent.** Human actions are relayed upstream as intents with a visible
  pending lifecycle; nothing writes around that path. The personal layer stays on the machine.
- **Agent content is isolated.** Anything that needs interpretation renders only in the
  sandboxed preview origin; plain text in the cockpit is escaped and marked as a claim.

## Contract changes

`packages/contract` is the wire between Gunnflow and every backend. Changing its types, validators
or HTTP behaviour needs a version bump (`package.json` and `src/version.ts`), an update to
[packages/contract/WIRE.md](packages/contract/WIRE.md), conformance coverage, and a CHANGELOG entry.

## Commits and reports

Commit subjects are one plain sentence about the behaviour or decision (no `feat:` prefixes); the
body says why and what was verified. Use the issue templates; report security issues privately as
described in [SECURITY.md](SECURITY.md).
