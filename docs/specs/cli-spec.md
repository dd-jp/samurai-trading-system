# CLI Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-07-14

## Problem Statement

Every other component in this system writes to the shared SQLite store — positions, fills, debates, verdicts, weights, the `audit_log` — but nothing lets an operator actually look at it. Right now, knowing what Samurai is doing means querying the database by hand. The vision's Definition of Done calls for exactly this: "Dashboard or CLI: current positions, pending debates, verdict history, per-analyst performance" — and it's the one MVP requirement none of the 11 backend components own.

**The CLI** is that missing operator view: a minimal, read-only terminal tool an operator runs on the same MacBook the Orchestrator runs on, to see what the system holds, what it decided, and how it's performing — without touching anything.

## Solution

The CLI is a **thin, read-only presentation layer** with **zero new backend logic and zero new write path**. It queries the same shared SQLite store every other component already writes to, through a small `QueryStore` interface, and renders four views as formatted terminal tables: positions, debates, verdicts, and per-analyst performance. It can never place, block, or modify a trade — its blast radius is exactly "an operator reads something."

Two run modes: a one-shot snapshot (`samurai status`) and a periodic-refresh live view (`watch`-style polling, configurable interval). No push/streaming, no full-screen TUI — simple structured tables, pipeable and grep-able.

Key architectural decisions:
- **Direct SQLite reads via `QueryStore`, no new message bus or subscription layer** — simplest thing that works for a single-operator, single-host tool.
- **Manual + polling hybrid refresh** — one-shot snapshot and a periodic-refresh mode, no real-time push.
- **Four views matching the DoD wording** — positions, debates, verdicts, performance.
- **"Pending debates" scope reduction, explicitly flagged** — the Debate Engine doesn't persist in-flight round state (decision #10, unchanged); the CLI shows recent completed debates plus a coarse "tick in progress" line from the Orchestrator, not a live debate-round view.
- **No interactivity beyond viewing** — no manual overrides, no kill-switch, no config editing in v1.
- **One test seam per view** — each render function is a pure function of `(QueryStore, asOf)`.

## User Stories

### Positions

1. As an operator, I want to see all open positions (instrument, side, filled size, avg entry, current stop/target, unrealized PnL), so that I know Samurai's current market exposure at a glance.
2. As an operator, I want unrealized PnL computed from the current mark, so that the position view reflects live exposure, not just entry state.

### Debates

3. As an operator, I want to see the most recent completed debates (per-analyst contributions, direction, conviction), so that I can review why a recent trade idea was accepted or rejected.
4. As an operator, I want a coarse "tick in progress for {instrument}" status line when the Orchestrator is mid-pass, so that I have *some* visibility into an in-flight cycle, even though the Debate Engine's round-by-round state isn't persisted (decision #10).

### Verdicts

5. As an operator, I want a chronological verdict history (go/no-go, the gate that fired, any HITL override), so that I can audit every decision the pipeline made, not just the ones that resulted in a trade.

### Performance

6. As an operator, I want current per-analyst weights and their rolling attribution, so that I can see which analysts are earning trust and which are being tuned down.
7. As an operator, I want the Feedback Loop's daily `MetricsSuite` (Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, exposure), so that I see the full metrics picture the research constraints require, not a single vanity number.

### Operation

8. As an operator, I want a one-shot snapshot command, so that I can quickly check status without leaving a process running.
9. As an operator, I want a periodic-refresh live view with a configurable interval, so that I can leave a terminal pane open and watch state change.
10. As an operator, I want the CLI to be strictly read-only, so that running it — or a bug in it — can never place, cancel, or modify a trade.

## Implementation Decisions

### Module: Query Store

**Responsibilities**
- Wrap the shared SQLite store's read queries the four views need.
- No writes, ever.

**Key Interfaces**

```typescript
// The single dependency every render function takes. Read-only by construction.
interface QueryStore {
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

- `OpenPosition`, `DebateLog`, `Mark`, `MetricsSuite` reuse the exact types already defined in execution-spec.md, debate-engine-spec.md, market-data-service-spec.md, and cost-model-backtest-spec.md respectively (via cross-spec-contracts.md) — the CLI defines no competing shapes.
- `TickStatus` is sourced from the Orchestrator's `current_tick` table (orchestrator-spec.md, Tick Runner module) — a small upserted-per-instrument row (`instrument`, `asset_class`, `stage`, `trace_id`, `updated_at`), deleted on tick completion. The CLI is a separate process and cannot read the Orchestrator's in-memory state; `current_tick` is the persisted artifact that makes this view possible. Disposable/best-effort by design — a crash mid-tick just leaves a stale row that gets overwritten or cleared next tick, not a data-integrity concern.

### Module: Views (render functions)

**Responsibilities**
- One pure render function per view; formats `QueryStore` reads into terminal-printable tables.

**Key Interfaces**

```typescript
// Primary test seam — one function per view, each independently testable
// against a fake QueryStore.
interface CLIViews {
  renderPositions(store: QueryStore, asOf: Date): string;
  renderDebates(store: QueryStore, asOf: Date): string;
  renderVerdicts(store: QueryStore, asOf: Date): string;
  renderPerformance(store: QueryStore, asOf: Date): string;
}
```

- Each function: query via `QueryStore`, format as a table, return a string. No side effects, no I/O beyond the injected `QueryStore` — trivially testable with a fake store returning fixed data.
- `renderDebates` composes `getRecentDebates` (completed history) with `getTickStatus` (the coarse in-progress line) — see the "pending debates" scope-reduction decision in the map.

### Module: Run Modes

**Responsibilities**
- One-shot snapshot vs periodic-refresh live view.

**Key Interfaces**

```typescript
interface CLIRunner {
  runOnce(views: CLIViews, store: QueryStore): void;                    // samurai status
  runWatch(views: CLIViews, store: QueryStore, intervalMs: number): void; // samurai watch [--interval]
}
```

- `runOnce`: calls all four render functions once, prints, exits.
- `runWatch`: calls all four on an interval, clears/redraws the terminal. No push subscriptions — a few seconds of staleness is acceptable for an operator view (this is not on the trading-decision path).

## Testing Decisions

- **Primary seam: the four `CLIViews` render functions.** Good tests here assert on the *formatted output given fixed `QueryStore` data* (e.g., a fake store returning two open positions renders a two-row table with correct PnL), not on terminal-rendering internals or real database state.
- **`QueryStore` implementation** is tested against a real (test) SQLite instance seeded with rows matching the other components' own fixture patterns — reuses their existing test data shapes, no new schema.
- Prior art: the same seam-testing discipline as every other component spec (one high-level function/interface per concern, fakes for dependencies, assert on outputs not internals).
- No end-to-end trading test needed — this component cannot affect trading outcomes by construction (read-only).

## Out of Scope

- **Any write path** — no manual trade actions, kill-switch trigger, or config editing. Strictly read-only (decision, not an oversight).
- **A full web dashboard** — explicitly declined in favor of a terminal CLI.
- **Real-time push/streaming** — polling/manual refresh only.
- **A true in-flight/live debate-round view** — the Debate Engine's ephemeral operational round state isn't persisted (decision #10); only completed debates plus a coarse tick-status line are observable.
- **Mobile/remote access** — local terminal on the same host as the Orchestrator, matching the single-MacBook deployment target.
- **Alerting** — the dead-man's-switch heartbeat and trade notifications are the Orchestrator's/Verdict's concern (already specced); the CLI is a pull, not a push, mechanism.

## Further Notes

Wayfinder decisions live in [docs/wayfinder/cli-map.md](../wayfinder/cli-map.md). This closes OPEN-GAP-B (docs/specs/cross-spec-contracts.md) — the CLI is now the 12th and final charted/specced component. It has zero write-path risk by construction, so it can be implemented and iterated on independently of the trading-critical components without affecting their correctness.
