# Dashboard Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-07-21 (supersedes the 2026-07-14 CLI spec; see "Further Notes")

## Problem Statement

Every other component in this system writes to the shared SQLite store — positions, fills, debates, verdicts, weights, the `audit_log` — but nothing lets an operator actually look at it. Right now, knowing what Samurai is doing means querying the database by hand. The vision's Definition of Done calls for exactly this: "Dashboard or CLI: current positions, pending debates, verdict history, per-analyst performance" — and it's the one MVP requirement none of the 11 backend components own.

**The Dashboard** is that missing operator view: a minimal, read-only web tool an operator opens in a browser on (or on the LAN of) the same MacBook the Orchestrator runs on, to see what the system holds, what it decided, and how it's performing — without touching anything.

## Solution

The Dashboard is a **thin, read-only presentation layer** with **zero new backend logic and zero new write path**. It queries the same shared SQLite store every other component already writes to, through the same `QueryStore` read interface the CLI originally defined, and serves one page: a single-page HTML app that polls a JSON snapshot endpoint for positions, debates, verdicts, and per-analyst performance. It can never place, block, or modify a trade — its blast radius is exactly "an operator reads something."

One process, one command (`npm run dashboard`), two `GET` routes: `/` (the HTML page) and `/api/snapshot` (the JSON payload the page polls). No separate frontend build/serve step, no push/streaming, no framework SPA — a static page and one endpoint, pipeable to `curl` for scripting if needed.

Key architectural decisions:
- **Direct SQLite reads via `QueryStore`, no new message bus or subscription layer** — simplest thing that works for a single-operator, single-host tool.
- **Client-side polling refresh** — the page re-fetches `/api/snapshot` on an interval; no real-time push.
- **Four views matching the DoD wording** — positions, debates, verdicts, performance — collapsed into one JSON payload (`DashboardSnapshot`), not four separate calls.
- **"Pending debates" scope reduction, explicitly flagged** — the Debate Engine doesn't persist in-flight round state (decision #10, unchanged); the snapshot shows recent completed debates plus a coarse "tick in progress" line from the Orchestrator, not a live debate-round view.
- **No interactivity beyond viewing** — no manual overrides, no kill-switch, no config editing in v1.
- **LAN-only opt-in, no auth** — binds `127.0.0.1` by default; reachability from another device on the operator's LAN is an explicit `HOST` env var opt-in, not a default. No auth layer, no HTTPS, no public exposure.
- **One test seam: `buildSnapshot`** — a pure function of `(QueryStore, asOf)` producing the JSON payload.

## User Stories

### Positions

1. As an operator, I want to see all open positions (instrument, side, filled size, avg entry, current stop/target, unrealized PnL), so that I know Samurai's current market exposure at a glance.
2. As an operator, I want unrealized PnL computed from the current mark, so that the position view reflects live exposure, not just entry state.

### Debates

3. As an operator, I want to see the most recent completed debates (per-analyst contributions, direction, conviction), so that I can review why a recent trade idea was accepted or rejected.
4. As an operator, I want a coarse "tick in progress for {instrument}" status line when the Orchestrator is mid-pass, so that I have *some* visibility into an in-flight cycle, even though the Debate Engine's round-by-round state isn't persisted (decision #10).

#### Invalidation panel (surface widening, 2026-08-05)

Added by [Wayfinder: Devil's Advocate](https://github.com/dd-jp/samurai-trading-system/issues/291) as a **required** section of devils-advocate-spec.md. This is a deliberate widening of the frozen positions/debates/verdicts/performance surface, resolving three prior deferrals that had all pointed here (the validator's dropped conditions, the reject alerts, and the drop counts).

4a. As an operator, I want the restated thesis and its invalidation conditions with evaluation states shown on the debate detail view, so that I can judge whether the pass understood the trade it was attacking.
4b. As an operator, I want validator-**dropped** conditions listed with their drop reasons, so that prompt quality is inspectable rather than silently degrading.
4c. As an operator, I want `no_conditions` and `unavailable` rendered as **distinct** states, so that "the pass found nothing falsifiable" is never displayed as "the pass could not run".

Driven by `invalidation_log`, joined on `(instrument, bar_timestamp)`. Showing dropped conditions is the entire reason that table stores the raw emission rather than the post-validator list.

**Limitation that must be shown, not hidden:** the panel reports what the pass *said* and what was breached at emit. It cannot report that **Risk acted on it** — a Risk reject short-circuits before Verdict, so there is no verdict row, and nothing persists `RiskDecision` ([#328](https://github.com/dd-jp/samurai-trading-system/issues/328)). A reject is inferable from a non-empty breached list but is not recorded, and the panel must not imply a certainty it does not have.

### Verdicts

5. As an operator, I want a chronological verdict history (go/no-go, the gate that fired, any HITL override), so that I can audit every decision the pipeline made, not just the ones that resulted in a trade.

### Performance

6. As an operator, I want current per-analyst weights and their rolling attribution, so that I can see which analysts are earning trust and which are being tuned down.
7. As an operator, I want the Feedback Loop's daily `MetricsSuite` (Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, exposure), so that I see the full metrics picture the research constraints require, not a single vanity number.

### Pipeline (second view, 2026-08-06)

Added by [Wayfinder: dashboard pipeline view](https://github.com/dd-jp/samurai-trading-system/issues/411). A **second tab** alongside everything above, which is unchanged and remains the default landing view. The four tables answer *what the system holds and what it decided*; this view answers *where each ticker is in the pipeline right now, and where the last one stopped*.

**Primitive: ticker lanes** ([#412](https://github.com/dd-jp/samurai-trading-system/issues/412)) — one row per instrument, one column per stage, the cell carrying what happened at that stage. Chosen over a stage rail (reads system load well, a single ticker's journey badly) and a trace waterfall (reads latency well, at-a-glance state badly).

12. As an operator, I want one row per instrument showing its progress across every stage, so that I can see at a glance which tickers are moving and which are stuck.
13. As an operator, I want a stage that was **skipped** to read differently from one that **stopped** the tick, so that routine traffic is never displayed as a halt. `invalidation` runs only for `entry`/`scale_in` intents and never terminates a tick, so "skipped" is the common case there, not an anomaly.
14. As an operator, I want a stage reached more than once in a trace to show its attempt count, so that a retry storm is visible rather than collapsed into a single cell.
15. As an operator, I want a dormant instrument (market closed, no tick) to read as idle rather than vanish, so that absence of activity is distinguishable from absence of the instrument.
16. As an operator, I want to open one lane and see that trace's stage sequence and, for a completed debate, its per-analyst contributions — with the live case stating plainly that round-by-round state is not persisted (decision #10) rather than showing a spinner that will never resolve.

**Seven stages, not six.** `analysts → debate → trader → invalidation → risk → verdict → execution`. `invalidation` is specced and not yet built, so today its column renders as never-reached for every lane; `audit_log.stage` is unconstrained TEXT, so the column fills in on its own the day the stage ships.

**Attribution — migration 0013.** This view is only possible because `audit_log` now carries `instrument`/`asset_class`. Before that, the sole trace_id → instrument links were `current_tick` (in-flight only, deleted at tick end) and `verdict_log` (only traces reaching Verdict), so **every short-circuited tick was attributable to no instrument at all** — a lane that went quiet because Risk kept rejecting it looked identical to a closed market. The writer already held both values; they were never persisted. `NULL` means "not attributable" (pre-migration rows, and the HITL callback path, which records under an existing trace_id with no `Signal` in scope) and must never be guessed into a lane.

**Bounded by a window, not a count.** A lane shows the most recent trace within a 15-minute lookback, capped at 24 lanes. The window doubles as the staleness guard: a crash deliberately leaves `current_tick` behind (`tick-runner.ts` — a stale row must be visible, not tidied away), and without the window the view would report a dead tick as running indefinitely.

**Constraints carried unchanged from v1:** read-only, poll-only on the existing 3s `/api/snapshot`, zero runtime dependencies, one payload rather than a second endpoint. Motion is confined to a single ring on cells whose state actually changed between two polls — nothing travels across the page, because the view never observed the intermediate moment and animating one would assert a continuity the data does not have. A tick shorter than the poll interval legitimately appears as a completed flash.

### Operation

8. As an operator, I want to open one URL in a browser and see current state, so that I can check status without a terminal.
9. As an operator, I want the page to refresh itself on an interval, so that I can leave a browser tab open and watch state change.
10. As an operator, I want the Dashboard to be strictly read-only, so that running it — or a bug in it — can never place, cancel, or modify a trade.
11. As an operator, I want the server to stay off my network by default, so that a stray port isn't exposed unless I explicitly ask for it.

## Implementation Decisions

### Module: Query Store

**Responsibilities**
- Wrap the shared SQLite store's read queries the snapshot needs.
- No writes, ever.

**Key Interfaces**

```typescript
// The single dependency buildSnapshot takes. Read-only by construction.
// Structural superset of the CLI's original QueryStore — no competing shapes.
interface DashboardQueryStore {
  getOpenPositions(asOf: Date): OpenPosition[];               // Execution
  getRecentDebates(limit: number, asOf: Date): DebateLog[];    // Debate Engine
  getTickStatus(asOf: Date): TickStatus | null;                // Orchestrator (coarse, in-progress only)
  getVerdictHistory(limit: number, asOf: Date): VerdictAuditEntry[];  // Verdict / audit_log
  getAnalystWeights(asOf: Date): Record<string, number>;       // Feedback Loop
  getAttribution(asOf: Date): Record<string, AttributionSummary>;    // Feedback Loop
  getDailyMetrics(asOf: Date): MetricsSuite;                   // Feedback Loop (cost-model-owned computation)
  getMark(instrument: string, asOf: Date): Mark;               // Market Data Service, for unrealized PnL
}

interface TickStatus {
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  stage: 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';
  trace_id: string;
}

interface VerdictAuditEntry {
  trace_id: string;
  instrument: string;
  status: 'go' | 'no_go';
  reason: string;          // the gate that fired, or 'approved'
  hitl_override: boolean;
  timestamp: Date;
}

interface AttributionSummary {
  analyst_id: string;
  rolling_r: number;       // rolling realized-R contribution
  window_days: number;
}
```

- `OpenPosition`, `DebateLog`, `Mark`, `MetricsSuite` reuse the exact types already defined in execution-spec.md, debate-engine-spec.md, market-data-service-spec.md, and cost-model-backtest-spec.md respectively (via cross-spec-contracts.md) — the Dashboard defines no competing shapes.
- `TickStatus` is sourced from the Orchestrator's `current_tick` table (orchestrator-spec.md, Tick Runner module) — a small upserted-per-instrument row (`instrument`, `asset_class`, `stage`, `trace_id`, `updated_at`), deleted on tick completion. Disposable/best-effort by design — a crash mid-tick just leaves a stale row that gets overwritten or cleared next tick, not a data-integrity concern.

### Module: Snapshot (presentation seam)

**Responsibilities**
- One pure function that projects `DashboardQueryStore` reads into the JSON-serializable wire payload the page polls.

**Key Interfaces**

```typescript
interface DashboardSnapshot {
  generated_at: string;
  as_of: string;
  tick_status: TickStatus | null;
  positions: PositionRow[];
  debates: DebateRow[];
  verdicts: VerdictRow[];
  analysts: AnalystPerformanceRow[];
  metrics: MetricsSuite;
}

// Primary test seam — a pure function of (store, asOf), independently
// testable against a fake DashboardQueryStore.
function buildSnapshot(store: DashboardQueryStore, asOf: Date): DashboardSnapshot;
```

- Unrealized PnL computed the same way the CLI originally specified: `(mark − entry) × filled_size` for buys, `(entry − mark) × filled_size` for sells — always `filled_size`, never `requested_size`.
- All `Date` fields are serialized to ISO strings at this boundary — `buildSnapshot` is the single place that crosses the HTTP/JSON boundary; nothing downstream of the wire sees a `Date` object.
- Composes `getRecentDebates` (completed history) with `getTickStatus` (the coarse in-progress line) — see the "pending debates" scope-reduction decision in the map.

### Module: HTTP Server

**Responsibilities**
- Serve the HTML page and the JSON snapshot; nothing else.

**Key Interfaces**

```typescript
interface DashboardServerOptions {
  port: number;
  host: string;              // defaults to 127.0.0.1
  store: DashboardQueryStore;
}

interface DashboardServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

- Two `GET` routes: `/` (and `/index.html`) → inline HTML page; `/api/snapshot` → `buildSnapshot(store, new Date())` as JSON. Everything else → `404`.
- Any non-`GET` method to a known path → `405` (not a silent `404`), so a misuse is obvious in dev tools. No `POST`/`PUT`/`DELETE` handlers exist by construction — the write-path exclusion is structural, not a convention.
- Built on Node 22's built-in `http` module — zero new runtime dependencies, matching ADR-0001's dependency-light TS core.
- `host` defaults to `127.0.0.1`; set via `HOST` env var to opt into LAN reachability. `port` defaults to `8787`, via `PORT` env var.

## Testing Decisions

- **Primary seam: `buildSnapshot`.** Good tests assert on the *returned snapshot given fixed `DashboardQueryStore` data* (e.g., a fake store returning two open positions produces two `PositionRow`s with correct PnL), not on HTTP internals or real database state.
- **Server tests** assert on HTTP status/body for each route (`GET /`, `GET /api/snapshot`, unknown path, non-`GET` method) against an injected fake store — no real network dependency beyond binding to an ephemeral port (`port: 0`) for the test process.
- **`QueryStore` implementation** is tested against a real (test) SQLite instance seeded with rows matching the other components' own fixture patterns — reuses their existing test data shapes, no new schema.
- No end-to-end trading test needed — this component cannot affect trading outcomes by construction (read-only).

## Out of Scope

- **Any write path** — no manual trade actions, kill-switch trigger, or config editing. Strictly read-only (decision, not an oversight).
- **A terminal CLI** — superseded by this dashboard; `src/cli/` removed as part of this change.
- **Real-time push/streaming** — client-side polling only.
- **A true in-flight/live debate-round view** — the Debate Engine's ephemeral operational round state isn't persisted (decision #10); only completed debates plus a coarse tick-status line are observable.
- **Remote/public access, auth, HTTPS** — LAN-only opt-in via `HOST`, matching the single-MacBook deployment target. A hosted multi-user product is a different problem, not designed here.
- **Alerting** — the dead-man's-switch heartbeat and trade notifications are the Orchestrator's/Verdict's concern (already specced); the Dashboard is a pull, not a push, mechanism.
- **Trader/Risk drill-down in the Pipeline view** — those two stages persist no decision content anywhere (no `trader_log`, no `risk_log`; `audit_log` holds only a digest), so their cells report that a stage ran and nothing about what it decided. What gets persisted is owned by [#328](https://github.com/dd-jp/samurai-trading-system/issues/328); where it surfaces is reserved in [#417](https://github.com/dd-jp/samurai-trading-system/issues/417). The view shows an honest empty slot rather than inventing content.
- **Per-tick history in the Pipeline view** — a lane holds one trace, the most recent inside the window. Chronological history across ticks is what the Verdict History table already provides; a second path to the same facts is maintenance cost, not a feature.

## Further Notes

Wayfinder decisions live in [docs/wayfinder/dashboard-map.md](../wayfinder/dashboard-map.md). This closes OPEN-GAP-B (docs/specs/cross-spec-contracts.md) — the Dashboard is the 12th and final charted/specced component. It has zero write-path risk by construction, so it can be implemented and iterated on independently of the trading-critical components without affecting their correctness.

**Supersedes the CLI spec (2026-07-14).** OPEN-GAP-B originally resolved to a terminal CLI, explicitly declining a web dashboard. That decision was reversed on 2026-07-21 after `src/dashboard/` was built ahead of any map or spec (discovered during a project health check) and grilled to a decision: the dashboard replaces the CLI rather than complementing it, since it subsumes every read the CLI provided with better ergonomics. `src/cli/` (render functions + types, tested, but with a placeholder entry point never wired to a runnable command) is removed in the same change. This file was `cli-spec.md`, renamed and rewritten in place.

**WorldMonitor Deferred-Shell Contract (forward note, #177 resolution).** The pattern — reserve a live-updating table's grid slot before its async data arrives, rather than reflowing the layout when it does — applies to this dashboard's live-updating views (`positions`, `tick_status`) once the front-end polling UI is actually built; it does not apply to the superseded `src/cli/`. No action needed now; a note for whoever scopes that UI work.
