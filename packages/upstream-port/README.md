# @gunnflow/upstream-port

The single upstream interface a [Gunnflow](https://github.com/Eastsidegunn/gunnflow) BFF talks
to. The BFF holds exactly one `WorkspaceUpstream`: it reads node snapshots from it, subscribes to
changes, relays human intents through it, and fetches artifact bytes, node detail, execution and
stream data from it. The interface is transport-shaped only: no policy, risk, progress or status
judgment lives in it.

Gunnflow ships two implementations: the in-repo simulator and the client of the direct wire.

## Do you need this package?

Usually not. **A backend normally speaks the direct wire**: it serves the HTTP endpoints described
in [`@gunnflow/contract`'s WIRE.md](https://github.com/Eastsidegunn/gunnflow/blob/main/packages/contract/WIRE.md)
and connects with one config line (`{ "upstream": "direct", "url": … }`). That needs only
`@gunnflow/contract`, not this package.

Use this package when you:

- implement an **in-process upstream**: code that runs inside a Gunnflow BFF and implements
  `WorkspaceUpstream` directly, or
- want to **reuse the types** (for example, a test double of an upstream).

## Install

```sh
npm install @gunnflow/upstream-port @gunnflow/contract
```

`@gunnflow/contract` is a peer dependency (`^0.3.1 || ^0.4.0 || ^0.5.0 || ^0.6.0`): the port's types refer to contract types
(`IntentResult`, `NodeDetail`), so the contract version is yours to choose within that range.
0.1.1, 0.1.2 and 0.1.3 are packaging only: the peer range widened to admit contract 0.4.x, 0.5.x and
0.6.x (whose changes are the wiring schema and optional node fields; the types the port uses are unchanged).

## Usage

```ts
import type {
  UpstreamFactory,
  UpstreamProjectionEnvelope,
  WorkspaceUpstream,
} from '@gunnflow/upstream-port';
import { UnsupportedDetail } from '@gunnflow/upstream-port';

export const createMyUpstream: UpstreamFactory = async ({ url }) => {
  let current: UpstreamProjectionEnvelope = { revision: 0, body: { nodes: [] } };
  const upstream: WorkspaceUpstream = {
    snapshot: () => current,
    subscribe: (listener) => { /* call listener(next) on every new snapshot */ return () => {}; },
    relayIntent: async (intent, actor) => ({ accepted: false, reason: 'not implemented' }),
    // Surfaces you do not provide answer UpstreamUnsupported, never an empty stand-in:
    executionSnapshot: () => ({ unsupported: 'no execution surface' }),
    subscribeExecution: () => () => {},
    terminalSnapshot: () => ({ unsupported: 'no terminal surface' }),
    subscribeTerminal: () => ({ unsupported: 'no terminal surface' }),
    subscribeStream: () => ({ unsupported: 'no stream surface' }),
    // Optional: artifactSnapshot, nodeDetail, status, subscribeStatus, refresh,
    // and the interactive terminal set (listTerminals … closeTerminal, below).
    // nodeDetail may throw new UnsupportedDetail() when support is only discovered at call time.
  };
  return upstream;
};
```

Exports: `WorkspaceUpstream`, `UpstreamFactory`, `UpstreamFactoryOptions`,
`UpstreamProjectionEnvelope`, `UpstreamIntentResult`, `UpstreamUnsupported`, `UpstreamStatus`,
`UpstreamRefreshResult`, `UpstreamArtifactSnapshot`, `Unsubscribe` (types) and
`UnsupportedDetail` (an `Error` subclass, the package's only runtime code). The doc comments in
the type declarations state the meaning of each return value (`undefined` vs. unsupported vs. a
rejection).

### Interactive terminals (0.2.0, optional)

An upstream that already runs terminals may offer them to the cockpit as a dumb byte pipe. All
six methods are optional; leave them out and every terminal route answers 501.

| Method | Meaning | BFF route |
|---|---|---|
| `listTerminals()` | `UpstreamTerminal[]`: `{ terminalId, label, kind: 'attachable' \| 'shell', state: 'running' \| 'exited', nodeId? }` | `GET /api/terminals` |
| `openTerminal({ target, cols, rows })` | `target` = `{ attach: terminalId }` (join one, stating this viewer's size) or `{ shell: { cwd } }` (a new shell); `{ ok, terminalId }` or `{ ok: false, reason }`. Either way the answer names a **new** terminal (below) | `POST /api/terminals` (422 on refusal) |
| `subscribeTerminalOutput(id, listener)` | `snapshot` (retained bytes) first — on every subscribe, so a reconnect restarts from it — then `data`, then `exit { code }`; `undefined` = no such terminal | `GET /api/terminals/:id/output` (SSE) |
| `terminalInput(id, bytesBase64)` | raw bytes typed or pasted | `POST /api/terminals/:id/input` (≤ 64 KiB base64) |
| `terminalResize(id, cols, rows)` | the viewer's size (1–1000) | `POST /api/terminals/:id/resize` |
| `closeTerminal(id)` | end it | `DELETE /api/terminals/:id` |

Opening always opens a new terminal: the `terminalId` it answers is the one every later input,
resize, output and close for that viewer uses. An `attach` id names the target to join, not a
terminal to talk to — I/O on it may answer `unknown`. Closing an attached terminal ends that
terminal only; the target keeps running, and when the target ends the attached terminal exits too.
`listTerminals` may list attached terminals beside their target; nothing on the wire links them,
so the cockpit folds under a target only the ones it opened itself.

Any method may also answer `UpstreamUnsupported` when support is only learned at call time (the
direct wire's `/terminals` answering 404/501): the BFF answers 501. A rejection is a reasoned 502.
`subscribeTerminalOutput` may resolve asynchronously, may send a later `snapshot` (it reconnected
underneath: the screen restarts), and may finish with `end { reason }` instead of `exit` — the BFF
then closes the viewer's stream without an exit frame. The built-in direct upstream maps all six
onto WIRE.md §터미널.

Acks are `{ ok: true }` or `{ ok: false, reason: 'unknown' | 'exited' }` (404 / 409). Bytes travel
base64; neither the BFF nor the cockpit interprets them. Until remote authentication exists the BFF
takes the steering routes (open, input, resize, close) from loopback callers only, and refuses a
browser `Origin` that is not loopback. The older `terminalSnapshot` / `subscribeTerminal` pair
(session record + line tail, read-only) is unchanged.

## Versioning

Semver, independent of `@gunnflow/contract`. While in 0.x, a minor bump may change the interface.

## License

MIT
