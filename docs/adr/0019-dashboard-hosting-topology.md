# ADR-0019 — Dashboard stays co-located, LAN-only

- **Status:** Accepted
- **Date:** 2026-08-27
- **Decided by:** David — grilled live in [Grilling: dashboard hosting topology + auth](https://github.com/dd-jp/samurai-trading-system/issues/589), 2026-08-27
- **Related:** [#589](https://github.com/dd-jp/samurai-trading-system/issues/589) (this decision's grilling ticket), [#887](https://github.com/dd-jp/samurai-trading-system/issues/887) (the auth guard this topology depends on), [ADR-0007](0007-fully-automatic-execution.md) (no operator in any decision path), [ADR-0013](0013-no-human-gate-anywhere.md) (every human gate removed), [ADR-0010](0010-dashboard-vite-react-rewrite.md) (framework), `docs/research/40-dashboard-framework-and-hosting.md` §4.3/§8 (the option ranking and ADR title this record adopts)

## Context

The dashboard has been reachable only from the machine it runs on since ADR-0010. Whether that should change — reachable remotely, and if so how — was never decided; `docs/adr/` ran 0001–0018 with no hosting-topology entry, and #589 tracked the gap since 2026-07.

Two things narrowed the question before it reached David. ADR-0013 removed every remaining human gate (breaker re-arm, risk-threshold loosening both automatic), on top of ADR-0007's baseline that no operator sits in any decision path — so **no action a human takes through the dashboard is one the system waits on.** Unreachability delays *knowing*, never *doing*. Separately, alerting is an independent transport with compiler-enforced channel coverage (`AlertChannelSlots`), so "how do I find out something is wrong while I'm out" already has an answer that isn't hosting topology. A research pass on #589 (2026-08-19) verified both premises directly against the working tree: the client has exactly one network primitive (`useSnapshot.ts`, a bodyless GET), the two buttons in the whole client are local-state-only, and the server rejects every non-GET method with 405 — nothing displayed can be acted on through the dashboard.

The same research pass also surfaced a countervailing fact: `server/apps/supervisor/supervisor.ts` ties the dashboard and orchestrator processes together — either dying takes the other down. So the dashboard is not a free-standing observability layer; a co-located host is unreachable exactly when the orchestrator itself has stopped, which is also the moment someone would most want to look.

Auth was the other live half of #589's scope and was split out to #887 on 2026-08-19, since it binds regardless of how this decision landed: `GET /api/snapshot` ships with no auth, gated only by `HOST`'s unset-env-var default (`server/apps/service-api/index.ts:38`).

## Decision

**The dashboard stays co-located with the orchestrator. It is not remotely reachable — no tunnel, no VPN overlay, LAN-only.**

David's ruling, taken live against the case above: the dashboard need not be reachable when the Mac is off. The intraday horizon (ADR-0014) makes this cheaper than it would have been under the old multi-day horizon — the interesting window is a single session, concentrated in market hours, so "reachable when the Mac is off" mostly means "reachable when there is nothing running to observe" anyway.

Exposure beyond localhost, once it exists, is **LAN-only** — reachable from other devices on the same home network, no Cloudflare Tunnel, no Tailscale. This was chosen over doc 40 §4.3's top-ranked Cloudflare Tunnel + Access specifically to avoid routing live positions and P&L through a third party's edge, and over Tailscale to sidestep its Personal tier's individual/homelab framing for a live-money console. LAN-only exposure still requires #887's fail-closed bind guard to land first — the guard binds independent of this decision, but LAN-only is the concrete case it exists to gate.

## Consequences

- **The store stays local SQLite, undecoupled.** No hosting-topology change forces the store migration doc 40 §4.4 priced for a decoupled host.
- **Dashboard downtime tracks orchestrator downtime**, confirmed rather than assumed: the supervisor's shared-fault-domain coupling means a dead dashboard process is also a dead trading process. This is acceptable *only because* the alert path — not the dashboard — is the load-bearing observability channel. If the alert path is ever weakened or removed, this decision's premise weakens with it and #589's reachability question should be re-grilled.
- **Remote monitoring is out of reach entirely**, not just deferred behind a cost. Checking positions from outside the home network requires being on the LAN (e.g. via home VPN/router-level access set up independently of this system) or waiting until back at the machine.
- **#887's implementation now has an unblocked answer to its own open question** ("which ADR does the auth decision record against") — it points here, and its LAN-only guard work can proceed without waiting on a tunnel/VPN integration that this decision rules out.

## Alternatives considered

- **Cloudflare Tunnel + Access** — doc 40 §4.3's top rank; identity enforced at Cloudflare's edge before the request reaches Node, so no application code owns auth. Rejected: live positions and P&L would transit a third party's edge even though the tunnel itself is outbound-only, for a system whose whole premise is a small live book that does not need remote convenience badly enough to accept that.
- **Tailscale** — private overlay, no third-party data path for the traffic itself. Rejected: Tailscale Personal's terms frame the product for individuals and homelabs, a closer commercial-use question for a live-money trading console than doc 40 originally examined, and the reachability case for remote access was already weak once ADR-0013's "nothing waits on a human" argument held.
- **Decoupled host** (the branch #589 was filed to weigh) — reachable independent of the orchestrator's own process health. Rejected on the same grounds Vercel was rejected for originally (read-only FS, archived-function lifetime) plus the store-migration cost of moving off local SQLite, now confirmed unnecessary since nothing acted on through the dashboard needed that reachability.
