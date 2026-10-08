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

`@gunnflow/contract` is a peer dependency (`^0.3.1 || ^0.4.0`): the port's types refer to contract types
(`IntentResult`, `NodeDetail`), so the contract version is yours to choose within that range.
0.1.1 is packaging only: the peer range widened to admit contract 0.4.x (whose change is the wiring
schema; the types the port uses are unchanged).

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
    // Optional: artifactSnapshot, nodeDetail, status, subscribeStatus, refresh.
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

## Versioning

Semver, independent of `@gunnflow/contract`. While in 0.x, a minor bump may change the interface.

## License

MIT
