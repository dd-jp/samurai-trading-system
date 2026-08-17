# ADR-0004: Production Composition Root — wiring shape for paper trading

**Status:** Accepted
**Date:** 2026-07-28
**Owner:** David (Deepak)

## Context

`server/apps/orchestrator/index.ts`'s doc comment states plainly there is "no production composition root yet — binding the real stage instances needs `ingestFills`/reconciliation (#83, #86) and the Analysts fan-out (#71) that do not exist yet." All three are now closed. All 12 components (6 pipeline stages + Market Intelligence + Market Data Service + Execution + cost-model/backtest + Orchestrator) have code, tests, and closed implementation maps. The gap is end-to-end wiring, not a missing component.

Wayfinder map [#224](../../issues/224) charted six related open tickets to reconcile scope against before wiring: #201, #197, #161 (SQLite-backed stores), #74 (Trader position-aware branching), #207 (HITL approval authn), #208 (prompt-injection mitigation), #209 (orphaned-verdict crash recovery). Checking each against the tracker found five already closed and merged — only #74 remains open.

## Decision

1. **No persistence or safety gate blocks wiring.** #201/#197/#161 (SQLite-backed `AuditLog`/`CurrentTickStore`/`TuningStore`/`AdjustmentLog`/`ClosedTradeStore`/`DashboardQueryStore`) and #207/#208/#209 (HITL authn, prompt-injection mitigation, orphaned-verdict recovery) are all closed and merged. `server/apps/orchestrator/` no longer has in-memory store classes, only `Sqlite*` ones — the composition root wires the real stores and safety mechanisms because they're the only implementation in the codebase, not because of a separate policy call.

2. **Trader completeness gate: enter/hold-only ships first.** #74 (position-aware branching: scale-in/exit-flip/hold) is a fast-follow, not a blocker for the first paper run.

3. **Composition root = `server/apps/orchestrator/production.ts`.** A new file, exported from `server/apps/orchestrator/index.ts` alongside the existing exports. It:
   - imports the real stage entry points — `AnalystOrchestrator` (analysts), `runDebate` (debate-engine), `decide` (trader), `RiskManagerImpl.evaluate` (risk-manager), `VerdictImpl.decide` (verdict), `ExecutionImpl.execute` (execution) — and closes each over its own ancillary dependencies (Market Data Service, Market Intelligence, broker adapter, position/setup stores, approval channel, trading calendar) to produce the six `TickSteps` callables.
   - Two of the six need a thin adapter, not a direct bind, because their native signature doesn't match `TickSteps` 1:1: `AnalystOrchestrator.runAnalysts(trace_id, signal, clock)` returns an `AnalystRunResult` (`{ views, analyst_count, skipped }`), and the adapter narrows it to the bare `AnalystView[]` `TickSteps.analysts` expects; `runDebate(input: DebateInput, personas: DebatePersonas)` takes two arguments, and the adapter closes over the persona set (bull/bear/mediator, each backed by the LLM client) to present the one-argument `TickSteps.debate` shape. `trader`/`risk`/`verdict`/`execution` bind directly — their exported functions already match `TickSteps`'s shape once their own config/deps are closed over.
   - constructs `SqliteAuditLog`, `SqliteCurrentTickStore`, `OrphanVerdictScanner`, `UniverseScheduler`, and `Heartbeat` against the shared SQLite store.
   - wires Feedback Loop's `onTradeClose` and `runDailyCycle` at the same composition point, but **not** as `TickSteps` members — `onTradeClose` hooks off `ExecutionResult` (a fill), and `runDailyCycle` runs on its own daily schedule; neither is part of the per-instrument tick chain `SequentialTickRunner` drives.
   - exports `buildProductionTickRunner(): SequentialTickRunner`, plus whatever the entrypoint needs to start/stop the scheduler loop and heartbeat.

4. **First-run universe: narrow smoke-test, not the full ADR-0001 six.** `UniverseScheduler`'s `SchedulerConfig.universe` already accepts an arbitrary instrument list — narrowing the first run to 1-2 instruments (e.g. one crypto pair via Alpaca's crypto venue) is a config choice at composition time, not a code change. Widen to `DEFAULT_UNIVERSE` (SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD) only after the first tick completes cleanly.

5. **Definition of done — two-tier.**
   - **Wiring validated (this ADR's scope):** one successful automated tick end-to-end through all six stages against real Alpaca paper (+ the narrow smoke universe), correctly audit-logged.
   - **Paper trading achieved for live-money graduation purposes (separate, later gate, own ticket — not this ADR's scope):** a sustained **14-day** unattended run with no unhandled crashes or data loss.

## Consequences

- `docs/specs/orchestrator-spec.md` gains a "Module: Production Composition Root" section describing `production.ts`'s shape and a corresponding user-story block and testing decision.
- #74 stayed open and out of scope for the first paper run at the time of this decision; it has since shipped and closed (2026-08-06) as its own fast-follow, and `trader-spec.md`/`orchestrator-spec.md` now describe the fuller position-aware routing as delivered, not deferred.
- The stale doc comment in `server/apps/orchestrator/index.ts` (citing #83/#86/#71 as blockers) is corrected when `production.ts` is implemented, not by this ADR — this ADR is a docs-only decision record; the code change is a `/to-tickets` implementation ticket.
- Unblocks `/to-tickets` for the `production.ts` implementation ticket and the 14-day-soak follow-on ticket.

## Superseded documents

None — additive to [ADR-0001](0001-technical-foundation-hybrid.md) (technical foundation) and the closed [Orchestrator Implementation map (#60)](../../issues/60).
