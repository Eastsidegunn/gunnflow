# Security policy

Gunnflow is alpha software. There are no supported releases yet; security fixes land on `main`.

## Reporting a vulnerability

Please **do not open a public issue.** Once the repository is published, open a private security
advisory on the repository ("Report a vulnerability" under the Security tab). Include steps to
reproduce, the affected component (web, BFF, preview origin, contract) and the impact you see.

## Design invariants (what is in scope)

Reports that break any of these properties are in scope:

- **Agent content isolation.** Agent-produced content that needs interpretation (HTML/JS, rendered
  markup, prototypes) is served only from a separate preview origin (default :8788), addressed by
  sha256 digest (bytes are re-hashed and checked), shown in a sandboxed iframe under a strict
  Content-Security-Policy. Uninterpreted plain text may appear in the cockpit DOM, escaped and
  marked as an agent claim. Any way for agent content to execute in, or read from, the cockpit
  origin is in scope.
- **No credentials in browser or BFF.** Neither the browser app nor the BFF holds raw credential
  values. The config file refuses URLs that carry credentials.
- **Human-only intent relay.** The cockpit relay is for authenticated human sessions only; the
  in-cockpit copilot has no channel to it. The BFF passes intents through with a field whitelist
  and does not let callers overwrite the actor.
- **Transport-only BFF.** The BFF carries and condenses; it must not synthesize facts or drop
  events silently.
- **Live portals** never connect before a human explicitly opens them.
- **Personal layer** notes stay on the local machine and are never sent upstream.

## Known limitations

- Authentication is not wired yet. The BFF currently relays with the fixed development actor
  `fake-actor:local-dev` until an identity provider contract lands (see [BLOCKED.md](BLOCKED.md)).
  Do not expose the BFF beyond localhost.
- The dev servers bind to `127.0.0.1` by default and are not hardened for network exposure.
  `GUNNFLOW_BIND_HOST` can change the bind address (for a container or reverse proxy), but doing
  so **exposes an unauthenticated BFF** that relays intents as the fixed development actor to
  anyone who can reach it. Only change it behind your own access control.
- Backend authorization, audit-chain integrity and agent-side permissions are the backend's
  responsibility, outside this repository.
