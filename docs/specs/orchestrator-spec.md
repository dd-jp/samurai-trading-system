# Orchestrator Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-07-14

## Problem Statement

Ten specs now exist — six pipeline stages plus Market Intelligence, Market Data Service, Execution, and the cost-model/backtest harness — and every one of them was written assuming something else fires the first event, holds the clock, and ties a trace together. Nothing produces the `Signal` the Analysts consume. Nothing schedules a tick, decides that a stock instrument shouldn't fire outside market hours, or bounds how many instruments run concurrently against a shared LLM rate limit. The cost-model/backtest harness explicitly depends on replaying "the exact live pipeline... via an injected clock" — but the live pipeline's tick loop, the thing the harness's simulated clock gets injected into, doesn't exist as a spec. And nobody owns trace IDs, structured log formatting, or the audit trail's storage technology, even though the vision's Definition of Done requires both.

The **Orchestrator** is that missing piece: the single-process, single-host program that actually runs Samurai on the MacBook — schedules ticks, iterates the universe, wires one instrument's pass through Analysts → Debate → Trader → Risk → Verdict → Execution, injects the clock every stage reads, and owns the cross-cutting concerns (trace IDs, structured logs, the audit spine, the dead-man's-switch heartbeat) that no single stage should own for itself.

## Solution

The Orchestrator is a **single TypeScript process** (ADR-0001: TS core, no LangGraph dependency) running one **scheduler** and one **tick loop**, with no LLM logic of its own — it is pure wiring, scheduling, and cross-cutting infrastructure.

- **Scheduler** fires ticks: crypto instruments on a fixed interval, 24/7; stock instruments gated by a market-hours/trading-calendar check.
- **Tick** = one pass through the full pipeline, per instrument in the configured universe (default: SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD — ADR-0001). Each instrument's pass: emit `Signal{asset, asset_class}` → `Analysts.run` → `DebateEngine.run` → `Trader.decide` → `Risk.evaluate` → `Verdict.decide` → (on `go`) `Execution.execute`.
- A **trace ID**, generated at Signal emission, threads through every stage call in that pass and appears on every structured log line.
- The Orchestrator injects the **`Clock`** every stage reads (wall-clock live; the cost-model/backtest harness's simulated clock in replay — same tick-loop code, different injected clock/adapters, mirroring Execution's live/paper/backtest discipline).
- It writes to a new `audit_log` table in the shared SQLite store (one row per stage-decision per trace_id) and emits a dead-man's-switch heartbeat over the trade channel Verdict already provisions.

Key architectural decisions:
- **Single process, single host** — matches the MacBook always-on deployment target; no message broker, no distributed scheduler.
- **Fixed universe iteration, not a scanner (v1)** — Signal production is a configurable instrument list, not an opportunity-ranking engine.
- **Bounded concurrency across instruments** — protects the shared LLM rate limit (Analysts/Debate), independent of any single instrument's own latency budget.
- **Trace ID as a cross-cutting envelope field** — not business data, threaded through every stage call and every log line.
- **Audit spine = a table in the existing shared SQLite store** — not a separate JSONB/Supabase system; mines the JSONB *pattern* (rich per-decision snapshots), not the storage technology.
- **Stateless-restart crash recovery** — the Orchestrator holds no unrecoverable state across a tick; each stage's own persistence (Execution's reconciliation, the shared store) carries the real state.

## User Stories

### Scheduling & Universe

1. As the Orchestrator, I want to fire a tick for crypto instruments on a fixed interval 24/7, so that crypto's always-open market is continuously covered.
2. As the Orchestrator, I want to gate stock-instrument ticks on a market-hours/trading-calendar check, so that a tick never fires into a closed market.
3. As the Orchestrator, I want to iterate a configurable instrument universe (default SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD) each tick, so that the covered universe matches ADR-0001 without a code change.
4. As the Orchestrator, I want to emit one `Signal{asset, asset_class}` per instrument per tick, so that the Analysts stage has a producer for the input it was already specced to consume (closes GAP-I).
5. As the Orchestrator, I want to run instruments within a tick concurrently up to a configured cap, so that one instrument's slow debate doesn't stall the rest, while the LLM-facing stages stay within their rate limit.

### Wiring the Pipeline

6. As the Orchestrator, I want to drive one instrument's pass through Analysts → Debate → Trader → Risk → Verdict → Execution in sequence, so that each stage's own contract (already specced) is satisfied without reimplementing stage logic here.
7. As the Orchestrator, I want to only call Execution when Verdict returns `go`, so that the gate-vs-actor separation (verdict-spec / execution-spec) holds.
8. As the Orchestrator, I want to inject a `Clock` into every stage that needs one, so that live and replay share the exact same tick-loop code path (the guarantee cost-model-backtest-spec's harness depends on).

### Trace IDs & Structured Logging

9. As the Orchestrator, I want to generate one trace ID at Signal emission and thread it through every stage call in that instrument's pass, so that a single trade's full journey is reconstructable from logs (DoD #8).
10. As any stage, I want to log through a shared structured-logging interface the Orchestrator configures (JSON: timestamp, trace_id, stage, level, message, payload), so that log format is consistent without each stage reinventing it.
11. As the Orchestrator, I want to own the log sink (stdout + rotated file), so that log retention/rotation is configured once, not per stage.

### Audit Spine

12. As the Orchestrator, I want an `audit_log` table in the shared SQLite store (one row per stage-decision per trace_id: stage, decision, input digest, output digest, timestamp), so that the full per-trade decision history is queryable (DoD #5) without a separate audit database.
13. As the CLI (cli-spec.md, closes OPEN-GAP-B), I want the `audit_log` table to already contain everything a positions/debates/verdicts/per-analyst-performance view would need, so that building that surface is a read-only consumer, not a new write path.
13b. As the CLI, I want a `current_tick` row per in-progress instrument (instrument, stage, trace_id), so that a separate process can show "tick in progress for {instrument}" without reading the Orchestrator's memory.

### Reliability

14. As the Orchestrator, I want to emit a heartbeat over the trade channel Verdict already provisions (Telegram/Discord) on a fixed interval, so that an external watchdog can alert on silence (dead-man's-switch), not on the Orchestrator polling itself.
15. As the Orchestrator, I want to hold no unrecoverable in-memory state across a tick, so that a crash-restart just resumes the schedule while Execution's own reconciliation (already specced) recovers in-flight orders. (`current_tick` is the one exception: disposable, best-effort progress state, not a system-of-record — losing it on crash costs nothing but a stale progress indicator.)

## Implementation Decisions

### Module: Scheduler

**Responsibilities**
- Fire crypto ticks on a fixed interval (24/7).
- Fire stock ticks gated by a market-hours/trading-calendar source (open/closed, holidays).
- Own the configured universe list and per-tick instrument iteration.

**Key Interfaces**

```typescript
// The primary test seam: given a clock and a universe, decide what fires this tick.
interface Scheduler {
  nextTick(clock: Clock): TickPlan;
}

interface TickPlan {
  instruments: { asset: string; asset_class: 'crypto' | 'stocks' }[];
  tick_time: Date;   // = clock.now()
}
```

- Crypto instruments always included. Stock instruments included only if the trading-calendar source reports the market open at `tick_time`.
- Trading-calendar source is a small injected dependency (holiday/session table), not designed in depth here — flagged as a light dependency, not a new component (OPEN-GAP: trading-calendar, LOW severity, noted in cross-spec-contracts.md).

### Module: Tick Runner (pipeline wiring)

**Responsibilities**
- For each instrument in a `TickPlan`, generate a trace ID, emit a `Signal`, and drive the sequential stage pipeline.
- Bound concurrency across instruments.
- Only call Execution on a Verdict `go`.

**Key Interfaces**

```typescript
// Primary seam. One call per instrument per tick.
interface TickRunner {
  runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome>;
}

interface TickContext {
  clock: Clock;              // wall-clock live; simulated in replay
  trace_id: string;          // generated at Signal emission
  logger: Logger;            // shared structured-logging interface
  auditLog: AuditLog;        // shared_store.audit_log writer
  // stage dependencies (marketData, store, broker, costModel, etc.)
  // are each stage's own concern per its spec; the Orchestrator wires
  // the concrete instances into each stage call, it does not redefine them.
}

interface TickOutcome {
  trace_id: string;
  final_stage: 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';
  verdict_status?: 'go' | 'no_go';
  execution_result?: ExecutionResult;   // from execution-spec, only if go
}

interface Logger {
  log(entry: { trace_id: string; stage: string; level: 'info'|'warn'|'error'; message: string; payload?: unknown }): void;
}

interface AuditLog {
  record(entry: { trace_id: string; stage: string; decision: string; input_digest: string; output_digest: string; timestamp: Date }): void;
}
```

- `runInstrument` is a straight-line sequential call chain through the already-specced stage interfaces (`Analysts.run`, `DebateEngine.run`, `Trader.decide`, `Risk.evaluate`, `Verdict.decide`, `Execution.execute`) — the Orchestrator does not reimplement any stage's decision logic.
- Concurrency across instruments is bounded by a configured cap (`max_concurrent_instruments`), primarily to respect the LLM rate limit on Analysts/Debate (CLAUDE.md HARD STOP governs LLM usage, not broker calls).
- Every stage call passes `trace_id` through its input envelope; every stage's structured log line carries it (propagation note below).
- **`current_tick` row — the one piece of persisted-but-transient state (cross-spec fix, resolves the CLI's tick-status dependency).** Before calling each stage, `runInstrument` upserts a single-row-per-instrument `current_tick` record (`instrument`, `asset_class`, `stage`, `trace_id`, `updated_at`) into the shared store; on tick completion (any terminal outcome — `execution` done, or an earlier no-go) the row is deleted. This does NOT contradict the "no unrecoverable in-memory state" decision below: `current_tick` is disposable, best-effort, coarse-grained status — losing it on crash loses nothing but a stale progress indicator (the row is simply re-upserted next tick), unlike `OpenPosition`/`Fill`/`audit_log` which are the actual system-of-record. It exists solely so a separate process (the CLI) can observe "tick in progress for {instrument}" without reading another process's memory.
  ```typescript
  interface CurrentTick {
    instrument: string;
    asset_class: 'crypto' | 'stocks';
    stage: 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';
    trace_id: string;
    updated_at: Date;
  }
  ```

### Module: Structured Logging & Audit Spine

**Responsibilities**
- Provide the shared `Logger` interface every stage logs through.
- Own log-sink configuration (stdout + rotated file).
- Own the `audit_log` table schema in the shared SQLite store.

**Key Interfaces**

```typescript
interface AuditLogEntry {
  trace_id: string;
  stage: string;              // 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution'
  decision: string;            // stage-specific summary, e.g. 'go' | 'no_go' | 'reject' | 'modify'
  input_digest: string;        // hash or compact serialization of the stage input
  output_digest: string;       // hash or compact serialization of the stage output
  timestamp: Date;
}
```

- One `audit_log` row per stage per trace_id — the full per-trade journey is `SELECT * FROM audit_log WHERE trace_id = ? ORDER BY timestamp`.
- Mines the JSONB pattern from sentient-trader (rich per-decision snapshots) for the row shape; storage stays the project's existing shared SQLite (ADR-0001), not a separate database.
- This table is additive to the shared store schema already accumulated by other specs (`bars`/`latest_mark` — MDS; `OpenPosition`/`Fill`/`ClosedTrade` — Execution; `config_trials` — cost-model; weights/params/thresholds — Feedback Loop), alongside the `current_tick` row this spec also adds (Tick Runner module, above) — both are Orchestrator-owned additions to the same shared store.

### Module: Heartbeat

**Responsibilities**
- Emit a periodic liveness signal over the existing trade channel.

**Key Interfaces**

```typescript
interface Heartbeat {
  emit(clock: Clock): void;   // posts a lightweight message to the trade channel on a fixed interval
}
```

- Reuses Verdict's already-provisioned Telegram/Discord trade channel (verdict-spec story 14) — a different message type on the same channel, not a new integration.
- The alert signal is **silence**, not content: an external watchdog (a separate cron/monitor, out of scope here) checks last-heartbeat-age and alerts if it grows stale. The Orchestrator does not monitor itself.

### Module: Determinism & Backtest

- The Orchestrator's tick loop runs unchanged in backtest — only the injected `Clock`, `BrokerAdapter`/`DataSource` implementations, and `MarketDataService`/`MarketIntelligence` sources differ (Simulated adapter, historical data, simulated clock advancing deterministically). This is the seam cost-model-backtest-spec.md's "same code path" guarantee depends on (resolves cross-spec-contracts.md OPEN-GAP-D).
- Concurrency cap is disabled or set to run sequentially in backtest for determinism (config-driven), since walk-forward replay needs deterministic ordering, not throughput.

## Testing Decisions

- **Primary seam:** `TickRunner.runInstrument(signal, ctx)` — given a signal and a context (real or fake stage dependencies), assert the correct sequential call order, correct short-circuiting on a Risk reject or Verdict no-go (Execution never called), and correct trace_id propagation through every log/audit entry produced.
- **Scheduler seam:** `Scheduler.nextTick(clock)` — given a clock and a trading-calendar fake, assert crypto always included and stocks included/excluded correctly around market open/close boundaries and holidays.
- Good tests here assert *wiring and sequencing*, not stage decision logic — each stage's own spec/tests own its decision correctness. Prior art: the same seam-testing discipline as every other stage spec (one high-level function, fakes for dependencies, assert on outputs/side-effects not internals).
- Determinism test: same seed + injected simulated clock + fixed universe → byte-identical `TickOutcome` sequence and `audit_log` rows across two runs (mirrors cost-model-backtest-spec's determinism story).

## Out of Scope

- **Any stage's internal decision logic** — Analysts/Debate/Trader/Risk/Verdict/Execution each own their own domain logic per their specs; the Orchestrator only sequences calls.
- **The opportunity-scanner / instrument-ranking engine** — v1 Signal production is a fixed configurable universe list; a smarter scanner that ranks/filters a larger universe is a v2 direction, explicitly deferred.
- **The dashboard/CLI** (OPEN-GAP-B) — the Orchestrator produces the `audit_log` data a dashboard would read; building the dashboard itself is separate and unspecced.
- **Multi-host / distributed deployment** — single-process, single-host only, matching the MacBook deployment target.
- **The backtest harness's replay/validation logic** — the Orchestrator's tick loop is what the harness drives via the injected simulated clock; walk-forward/CPCV splitting and metrics computation stay in cost-model-backtest-spec.
- **The trading-calendar/holiday data source itself** — treated as a small injected dependency, not designed here.
- **The external heartbeat watchdog** — the Orchestrator emits the heartbeat; a separate, unspecced monitor consumes its absence.

## Further Notes

Wayfinder decisions for this component live in [docs/wayfinder/orchestrator-map.md](../wayfinder/orchestrator-map.md). This is the last of the 11 components (6 pipeline stages + Market Intelligence + Market Data Service + Execution + cost-model/backtest + Orchestrator) to be charted and specced. With this spec in place, all cross-spec dependencies flagged across the design phase (GAP-I's Signal producer, OPEN-GAP-C's trace-IDs/logging/audit-spine, OPEN-GAP-D's tick-loop seam) resolve to a concrete owner. Remaining before `/to-tickets`: OPEN-GAP-B (dashboard/CLI) can be ticketed as a deferred v2 item without further charting; the trading-calendar dependency can be ticketed as a small infra task.
