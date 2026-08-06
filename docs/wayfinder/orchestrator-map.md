# Wayfinder Map: Orchestrator (cross-cutting — wires all stages + Stage 0 services)

**Status:** Complete — all frontier decisions resolved. Spec: [docs/specs/orchestrator-spec.md](../specs/orchestrator-spec.md).

## Destination

Design the **Orchestrator** — the process that actually runs Samurai. Not a pipeline stage; the thing that wires all 6 stages + Market Intelligence + Market Data Service + Execution + cost-model/backtest into one running system: schedules the universe scan, injects the shared `Clock` every stage reads, drives one tick end-to-end (scan → analysts → debate → trader → risk → verdict → execution), and owns the cross-cutting concerns no single stage owns (trace IDs, structured logs, the audit spine, the dead-man's-switch heartbeat). Destination = docs/specs/orchestrator-spec.md.

## Notes

- Surfaced late in the design (2026-07-13/14) as an uncharted dependency once multiple specs converged on needing it: cost-model-backtest-spec's "same code path" guarantee needs a tick-loop seam to inject into (OPEN-GAP-D); nothing produces the `Signal` the Analysts consume (GAP-I); trace-IDs/structured-logs/JSONB-audit-spine had no owner (OPEN-GAP-C).
- Depends on ADR-0001's now-resolved open questions: **TypeScript core**, debate substrate **reimplemented** (not a LangGraph dependency) — so the Orchestrator is a TS process, not a Python one wrapping a LangGraph graph.
- CLAUDE.md deployment target: MacBook, always-on, single process. Dead-man's-switch / heartbeat alerting recommended for silent failure (macOS auto-update reboot, power/WiFi drop, lid-close mid-position).
- Apply research constraints: point-in-time discipline threads through every stage via the injected `Clock` — the Orchestrator is the thing that actually injects it, live and in replay.

## Decisions so far

- **Single-process tick loop, not a distributed system.** One Node/TS process. A scheduler fires ticks: crypto instruments on a fixed interval (24/7), stock instruments gated by a market-hours/calendar check (no tick fires into a closed market). Matches the MacBook-single-host deployment target — no message broker, no separate services.

- **Tick = one pass through the pipeline per instrument in the universe.** Default universe (ADR-0001): SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD, configurable. Per tick, per instrument: emit `Signal{asset, asset_class}` (closes GAP-I) → `Analysts.run(signal)` → `DebateEngine.run(views)` → `Trader.decide(...)` → `Risk.evaluate(...)` → `Verdict.decide(...)` → on `go`, `Execution.execute(...)`. Instruments within a tick run independently (one instrument's debate timeout doesn't block another's).

- **Orchestrator owns and injects the `Clock`.** Live: wall-clock. Backtest: the cost-model/backtest harness's simulated clock, injected in place of wall-clock — same orchestrator code, same tick loop, only the `Clock` and the `BrokerAdapter`/`DataSource` implementations differ (mirrors Execution's live/paper/backtest one-code-path decision). This is the seam cost-model-backtest-spec's "same code path" guarantee depends on (resolves OPEN-GAP-D).

- **Trace IDs: one per tick-instrument pass, threaded through every stage call.** Generated at Signal emission, passed through Analysts → Debate → Trader → Risk → Verdict → Execution as part of each stage's input/output envelope (not business data — a cross-cutting correlation ID). Every stage's structured log line carries it. Resolves OPEN-GAP-C's trace-ID half.

- **Structured logging: one format, one sink, Orchestrator-configured.** Every stage emits structured (JSON) log lines; the Orchestrator owns the sink configuration (stdout + file, rotated) and the shared schema (timestamp, trace_id, stage, level, message, payload). Stages log through a shared logger interface the Orchestrator provides/injects — they don't each reinvent formatting.

- **Audit spine: the shared SQLite store, not a separate JSONB/Supabase system.** ADR-0001 named sentient-trader's JSONB audit trail as a pattern to mine, but the project's existing decision (all 10 specs) is the shared SQLite state store as the system of record. Resolution: audit trail = a dedicated `audit_log` table in the same shared store, one row per stage-decision per trace_id (stage, decision, inputs digest, outputs digest, timestamp), queryable for the full per-trade history Verdict's audit trail and any future dashboard (OPEN-GAP-B) would read. No separate audit database. The JSONB *pattern* (rich structured decision snapshots, not just scalars) is worth mining for the row shape; the storage technology is SQLite, consistent with everything else.

- **Dead-man's-switch heartbeat.** Orchestrator emits a heartbeat (Telegram, reusing Verdict's already-provisioned trade channel — verdict-spec story 14) on a fixed interval; **silence itself is the alert signal** (external watchdog / cron checks last-heartbeat-age, not the Orchestrator polling itself). Matches CLAUDE.md's flagged MacBook-host risk (auto-update reboot, power/WiFi drop).

- **Crash recovery = stateless restart + reconciliation.** The Orchestrator itself holds no unrecoverable in-memory state across a tick — on restart it resumes the schedule; Execution's own crash-restart reconciliation (already specced) recovers in-flight orders. The Orchestrator doesn't need its own crash-recovery logic beyond "start the scheduler and let each stage's own persistence carry state."

> **Superseded 2026-08-07 (historical record, not corrected in place per CLAUDE.md's wayfinder-docs convention).** The "not a scanner" decision below was reversed by wayfinder map [#397](../../issues/397) and `docs/specs/universe-selector-spec.md`: the scanner exists as an out-of-session component, and the Orchestrator's active list comes from a provider at each session boundary. The deferral in the "Out of scope" section below is superseded on the same grounds.

- **Signal production = simple universe iteration, not a scanner (v1).** GAP-I asked who produces `Signal`. Resolution: v1 is NOT a screening/ranking engine — it's a fixed configurable universe list, iterated every tick. A smarter opportunity-scanner (rank/filter a larger universe down to the ones worth a full pipeline pass) is a valid v2 direction but is explicitly deferred — the vision's DoD #1 only requires "produces ideas for **configurable universe**," which a fixed list satisfies.

- **Multi-instrument concurrency: bounded parallelism, not fully sequential.** Ticks fan out across the universe with a concurrency cap (protects LLM rate limits on Analysts/Debate — CLAUDE.md's HARD STOP governs those, not Execution's broker calls). Debate Engine's own per-instrument latency budget (15s crypto/60s stocks) is unaffected; the cap is about how many instruments run their pipelines concurrently, not any single instrument's internal budget.

## Frontier

All frontier decisions resolved. Map complete.

## Cross-spec reconciliation required (flag for the all-specs verification pass)

1. **`Signal` producer now named.** Closes GAP-I (analysts-spec.md's flagged dependency): the Orchestrator's universe-iteration loop is the producer. Analysts spec's "Signal Production (out of scope, flagged dependency)" note should point here once this map/spec exists.
2. **RESOLVED (2026-07-14, GAP-J).** Trace ID becomes a cross-cutting field on every stage's input/output envelope. Not previously specced on any stage's `*Input`/`*Result` types. The follow-up light pass flagged here happened: `trace_id: string` added to the primary `*Input` type of all 6 pipeline stages + market-intelligence + execution (8 specs), added as a call parameter (not a struct field) to feedback-loop's `onTradeClose` and market-intelligence's `getContext`, and deliberately NOT added to market-data-service or cost-model-backtest (both are query/library dependencies injected into stages, not themselves sequenced in the Orchestrator's tick). See cross-spec-contracts.md GAP-J propagation log for the full per-spec breakdown.
3. **`audit_log` table added to the shared SQLite store schema** — alongside `bars`/`latest_mark` (Market Data Service), `OpenPosition`/`Fill`/`ClosedTrade` (Execution), `config_trials` (cost-model), weights/params/thresholds (Feedback Loop). No conflicts; additive.
4. **Verdict's Telegram/Discord trade channel is reused for the heartbeat**, not a separate channel — confirm with verdict-spec story 14 owner (same channel, different message type).

## Out of scope

- **Any single stage's internal logic** — the Orchestrator wires and schedules; it does not decide, debate, size, risk-check, or execute. Each stage owns its own domain logic per its spec.
- **The opportunity-scanner / instrument-ranking engine** — v1 Signal production is a fixed universe list (see decisions above); a smarter scanner is v2, out of scope here.
- **The dashboard/CLI** (OPEN-GAP-B) — the Orchestrator produces the audit_log data a dashboard would read, but building the dashboard itself is a separate, unspecced, deliberately-deferred concern.
- **Multi-host / distributed deployment** — single-process, single-host (MacBook) is the only target; no message broker, no service mesh.
- **The backtest harness's own replay logic** — the Orchestrator's tick loop is what the harness drives (via the injected simulated `Clock`); the harness itself (walk-forward/CPCV splitting, metrics) is cost-model-backtest-spec's domain.
