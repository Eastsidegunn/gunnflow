# @gunnflow/contract

The backend contract of [Gunnflow](https://github.com/Eastsidegunn/gunnflow), a backend-agnostic
human cockpit: types, runtime validators, and a conformance suite a backend runs against itself.
No runtime dependencies (only the conformance suite needs `vitest`, as an optional peer).

```sh
npm install @gunnflow/contract
```

```ts
import { CONTRACT_VERSION, validateIntent, lookupCapability, type Intent } from '@gunnflow/contract';
```

Inside the Gunnflow monorepo the package is consumed as `"@gunnflow/contract": "workspace:*"`.

## The direct wire

A backend that speaks the contract natively exposes the HTTP surfaces described in
[WIRE.md](./WIRE.md) (paths and event names are also pinned in code as `DIRECT_WIRE`). The Gunnflow
BFF connects to it with `upstream: "direct"`.

## Conformance suite

A backend author builds a `ConformanceTarget` that shows their backend in contract shape and hands
it to the suite. The suite checks the canonical shape only — speaking the contract is the backend's
job.

```ts
// my-backend.conformance.test.ts (vitest)
import { defineConformanceSuite } from '@gunnflow/contract/conformance';

defineConformanceSuite('my-backend', async () => ({
  contractVersion: '0.6.0',
  nodes: () => myBackend.nodes(),            // { id, capabilities, artifacts, streams? }[]
  snapshot: () => myBackend.snapshot(),      // required (0.6.0): the GET /nodes body { revision, nodes }
  relay: (intent) => myBackend.relay(intent), // check structure with validateIntent before acting
  settle: () => myBackend.idle(),             // optional: wait for asynchronous effects
  streams: {                                  // optional: for backends that declare streams
    open: (nodeId, streamId, lastSeenSeq) => myBackend.openStream(nodeId, streamId, lastSeenSeq),
    produce: (nodeId, streamId, count) => myBackend.emit(nodeId, streamId, count),
    declareLoss: (nodeId, streamId, count) => myBackend.drop(nodeId, streamId, count),
  },
}));
```

It checks: version compatibility (strict semver); node structure (kind, state, relations,
attention, capabilities, artifacts, streams, duplicate ids within a node, real edit targets and
evidence, the bounds of the optional decorations); the whole served snapshot (`snapshotProblem`: unique ids,
no node changed after the snapshot revision — `snapshot()` is required as of 0.6.0); refusal of intents for absent nodes, undeclared actions, out-of-schema keys,
disabled/hidden actions, pair-rule violations and missing required inputs; the digest convention;
streams (resync first, contiguous non-negative seq, upstream-only gaps, resume); and every optional
surface a target claims (detail, execution). Items with no applicable node are marked skipped, but an
adapter that declares edit/stream `features` and offers nothing to test fails. Reference
implementation: `testing/fake-contracts/test/conformance.test.ts` in the Gunnflow repository.

## What passing proves

Passing **proves** that the projection, intent handling and streams an adapter emits keep the
contract's structure: schema and pair rules, refusal of intents that must be refused, the digest
convention (sha256 of the transmitted UTF-8 bytes), stream seq continuity and gap attribution.

It does **not** prove properties of the cockpit runtime, which are guarded by Gunnflow's own tests
and invariants: that the relay is human-only, that attestations are truthful, that viewers are
isolated (separate origin, sandbox, CSP), or that the backend's judgments are right.

## Digest convention

`digest` = the **lowercase hex sha256 of the original bytes**. For `Intent.edit.body` the digest
covers the **UTF-8 serialized bytes exactly as sent** (no BOM, line endings untouched) and must match
the digest of the artifact the backend stores. `digestOfBody(body)` is the reference implementation.

## Versioning

`CONTRACT_VERSION` is semver. While in 0.x, a different minor is treated as incompatible (the suite
checks that major.minor match), so a consumer claims `contractVersion: '<major>.<minor>.x'`.

- **0.6.0** — node: optional decorations, each an upstream-stated fact (absent = that decoration is
  omitted, never inferred): `shortName` (far-zoom name, 1–32 code points, one line), `summary`
  (1–200 code points, one line, plain text like the label; "one line" refuses LF, VT, FF, CR, NEL,
  U+2028 and U+2029), `active` (absent = unknown, not false),
  `lastActivityTs` (ms epoch, integer > 0), `changedAtRevision` (integer ≥ 1; the node's own last
  change — containers do not roll up), `originNodeId` (not the node's own id; draws no edge, may
  name a node absent from the snapshot), `steps` (`{ done, total }` integers, 0 ≤ done ≤ total,
  total ≥ 1; display only — the engine never computes progress). Snapshot rule: a node's
  `changedAtRevision` must not exceed the snapshot `revision` — `snapshotNodeProblem` /
  `snapshotProblem`; a node breaking it is not shown, the rest of the snapshot stands. Wiring: a
  relation may state its `role` (`waits_on` · `blocks` · `supports` · `produces` · `contains`, read
  source → target); helper `relationRoleFor`; `arrange` stays the layout authority. Conformance:
  `ConformanceTarget.snapshot()` is now required and checked with `snapshotProblem`. Every existing
  config stays valid. **0.5 consumers reject nodes carrying the new keys** (unknown keys are
  refused), so a backend must not emit them to a 0.5 cockpit. Claim `0.6.x`.
- **0.5.0** — wiring: a kind may state its node `shape` (`rect` · `pill` · `circle` · `diamond` ·
  `hexagon`, and `band` for containers) and a `size` factor (0.5–3); `parts` becomes optional;
  helper `kindShape`. Presentation only. Every existing config stays valid. Node, detail and intent
  wire unchanged. Claim `0.5.x`.
- **0.4.0** — wiring: optional attention `group` (display group name), `actions` (display label
  per action name), and `detail.collapsed` / `detail.copyable` (with `detail.emphasis` now optional);
  helpers `attentionGroup`, `actionLabel`, `detailCollapsed`, `detailCopyable`. Every existing
  config stays valid. Node, detail and intent wire unchanged. Claim `0.4.x`.
- **0.3.2** — a live artifact URL carrying userinfo credentials (`https://user:pass@host/…`) is
  refused by `artifactRefProblem` / `nodeProblem`. Consumers claiming `0.3.x` need nothing;
  compliant backends are unaffected.
- **0.3.1** — packaging only: the optional `vitest` peer accepts `^3 || ^4 || ^5`. First version
  published to npm. No contract change; consumers claiming `0.3.x` need nothing.
- **0.3.0** — adds the optional execution surface (`ExecutionSnapshot`, `validateExecutionSnapshot`,
  `DIRECT_WIRE.execution`, WIRE.md §execution — GET plus SSE full-snapshot republish). Claim `0.3.x`.
- **0.2.0** — adds the optional node-detail surface (`NodeDetail`, `validateNodeDetail`,
  `DIRECT_WIRE.detail`, WIRE.md §detail). Claim `0.2.x`.

Releasing a new version: see [RELEASING.md](./RELEASING.md).

## License

MIT
