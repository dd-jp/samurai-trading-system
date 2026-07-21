# Wayfinder Map: Dashboard (minimal read-only web operator view)

**Status:** Complete — all frontier decisions resolved. Spec: [docs/specs/dashboard-spec.md](../specs/dashboard-spec.md).

**Supersedes:** this file was `cli-map.md`; it has been renamed and rewritten in place — reversing the decision it originally recorded — rather than kept as a separate historical record, per David's call during grilling on 2026-07-21. See "Reversal" below.

## Destination

Design a **minimal, read-only web dashboard** — the 12th component, closing OPEN-GAP-B (the vision's DoD #7: "dashboard or CLI: positions, pending debates, verdict history, per-analyst performance"). Destination = docs/specs/dashboard-spec.md.

## Reversal (2026-07-21)

OPEN-GAP-B originally resolved (2026-07-14) to a minimal terminal CLI, explicitly declining "a full web dashboard." `src/dashboard/` was subsequently built anyway (server, HTML page, JSON snapshot endpoint, fixture store) without a map or spec, discovered during a project health check. Grilled to a decision on 2026-07-21:

- **Dashboard replaces the CLI, not complements it.** One operator surface, not two — the dashboard subsumes every read the CLI provided (positions, debates, verdicts, performance) with better ergonomics (no terminal required), so maintaining both is duplicated surface for the same job.
- **`src/cli/` is deleted** in the same change that lands this map + the renamed spec. (Note: at reversal time `src/cli/index.ts` was still a placeholder — `export {}`, "implemented ticket-by-ticket starting with #97" — the CLI's render functions/types existed and were tested, but it had no wired entry point. The dashboard's entry point was already running end-to-end.)
- **Dashboard stays view-only** — no new write path, matching the CLI's original "strictly read-only" decision unchanged.

## Notes

- Pure presentation layer, same as the CLI it replaces. **No new write path, no new backend logic** — everything it shows already exists in the shared SQLite store per the other 11 specs (today: fixture stores everywhere, since no component has the real SQLite store wired up yet — this is a project-wide state, not dashboard-specific).
- Reads: `audit_log` (Orchestrator), `OpenPosition`/`ClosedTrade` (Execution), `DebateLog` (Debate Engine), weight/attribution state (Feedback Loop), `VerdictDecision`/audit trail (Verdict), `getMark` (Market Data Service, for unrealized PnL) — identical dependency set to the CLI's.
- Runs on the same MacBook host as the Orchestrator (CLAUDE.md deployment target) — a local HTTP server, not a hosted/public service.
- Already implemented in `src/dashboard/` (`server.ts`, `snapshot.ts`, `html.ts`, `fixture-store.ts`, `types.ts`) prior to this map being written — this document formalizes decisions the code had already made, rather than preceding the code. Flagged as a process gap (CLAUDE.md rule #1 was skipped); resolved retroactively here.

## Decisions so far

- **Read model = same `QueryStore` port the CLI defined, no competing shapes.** `src/dashboard/types.ts`'s `DashboardQueryStore` is a structural superset of the CLI's `QueryStore` (adds nothing but reuses `getOpenPositions`/`getRecentDebates`/`getTickStatus`/`getVerdictHistory`/`getAnalystWeights`/`getAttribution`/`getDailyMetrics`/`getMark` verbatim). One read seam, two transports.

- **Transport = single Node `http` server, one process serves both UI and data.** `GET /` returns an inline single-page HTML app; `GET /api/snapshot` returns the same four-views-plus-tick-status payload as JSON. Zero new runtime dependencies (Node 22's built-in `http`, no express/fastify — matches ADR-0001's dependency-light TS core). One command (`npm run dashboard`) starts everything; there is no separate frontend build/serve step.

- **Refresh cadence = client-side polling, not push.** The page re-fetches `/api/snapshot` on an interval (matches the CLI map's "a few seconds of staleness is fine, this is not the trading-decision path" reasoning). No SSE/WebSocket — added connection-lifecycle complexity with no operational benefit at single-operator scale.

- **Access = LAN-only opt-in, no auth.** Same trust boundary as the CLI (single operator, same host/network), just a browser instead of a terminal. Server binds `127.0.0.1` by default (already the case in `src/dashboard/index.ts`); reachability from another device on the operator's LAN is an explicit opt-in via `HOST` env var, not a default. No auth layer, no HTTPS, no public exposure — remote-away-from-home access is an explicit future decision (e.g. VPN/tailscale), not "open the port."

- **Four views, unchanged from the CLI's DoD-matching scope:** Positions, Debates (recent completed + coarse tick-in-progress line — the "pending debates" scope reduction is unchanged, still flagged, still true: in-flight round state is not persisted per Debate Engine decision #10), Verdicts, Performance (weights + attribution + daily `MetricsSuite`).

- **No interactivity beyond viewing, v1.** No manual override, no kill-switch trigger, no config editing. Read-only by construction — the server exposes only `GET` handlers and only ever calls `QueryStore` read methods (non-`GET` requests get a `405`, not a silent `404`, so misuse is obvious in dev tools).

- **UI: single static HTML page polling one JSON endpoint, not a framework SPA.** No React/build step/bundler — matches "minimal" and keeps the zero-new-dependency posture. Library/framework choice, if this ever grows past one page, is a techstack.md implementation detail, not a wayfinder decision.

- **Single test seam: `buildSnapshot(store, asOf)`.** A pure function of `(DashboardQueryStore, asOf)` returning the JSON-serializable snapshot — the web twin of the CLI's one-seam-per-view convention, collapsed to one seam since there's one payload, not four rendered strings.

## Frontier

All frontier decisions resolved. Map complete.

## Cross-spec reconciliation required (flag for the all-specs verification pass)

1. **Same dependency set as the CLI it replaces** — `audit_log` (Orchestrator), `OpenPosition`/`ClosedTrade` (Execution), `DebateLog` (Debate Engine), weights/attribution (Feedback Loop), verdict audit trail (Verdict), `MarketDataService.getMark`. No new writes anywhere, no new shared-store tables.
2. **`cross-spec-contracts.md`'s OPEN-GAP-B entry must be updated** to point at `dashboard-map.md`/`dashboard-spec.md` instead of `cli-map.md`/`cli-spec.md`, and record the reversal.
3. **`src/cli/` removal** — confirm no other spec/component references the CLI's `QueryStore` or render functions before deletion (expected: none, it was a leaf presentation component).

## Out of scope

- **Any write path** — no manual trade actions, no kill-switch, no config editing. Strictly read-only.
- **A terminal CLI** — superseded by this dashboard; `src/cli/` removed.
- **Real-time push / streaming updates** — polling is sufficient for an operator tool.
- **A true in-flight/live debate-round view** — the Debate Engine's ephemeral operational state is not persisted; only completed debates are observable.
- **Remote/public access, auth, HTTPS** — LAN-only opt-in on the operator's own network; a hosted multi-user product is a different problem.
