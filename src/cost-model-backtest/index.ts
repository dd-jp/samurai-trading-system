/**
 * Cost Model / Backtest Harness — see docs/specs/cost-model-backtest-spec.md, epic #58.
 * Implemented ticket-by-ticket starting with #87.
 *
 * Ticket #88 adds the replay harness — `BacktestHarness` (Seam 2), the
 * no-lookahead auditor and the survivorship-free universe check — plus the
 * stepped `SimulatedClock` (exported from src/shared/clock.ts, beside the
 * `Clock` every stage already injects).
 *
 * The harness drives the Orchestrator's `Scheduler` + `TickRunner` (#94)
 * rather than containing a pipeline of its own, so replay and live share one
 * code path by construction. Those implementations do not exist yet — nor does
 * `DebateEngine.run` (epic #40) — so the harness is unit-tested against fakes
 * and the spec's end-to-end fixed-window replay is deferred to those tickets.
 *
 * `BacktestReport` is declared in its #88-fillable subset only: the `metrics`
 * / walk-forward / capacity-ceiling fields belong to the validation library
 * and arrive with the ticket that can honestly populate them, per the staged
 * style of `types.ts` (#87) and `execution/types.ts` (#82).
 *
 * Ticket #89 adds the **validation library** — the `MetricsSuite`, the
 * walk-forward/CPCV split generator, DSR/PBO/MinBTL, and the `config_trials`
 * log (`validation-types.ts`, `metrics.ts`, `splits.ts`, `overfitting.ts`,
 * `config-trial-log.ts`). It ships callable but **not yet wired into
 * `BacktestReport`**: populating `metrics`/`walk_forward` needs a return and
 * trade series, and `TickOutcome` (orchestrator/types.ts) carries only the
 * trace, final stage, verdict and an optional `ExecutionResult` — there are no
 * fill records to derive returns from until Execution's persisted `Fill`s are
 * wired. Reporting a metrics suite computed from nothing would be exactly the
 * flattering lie this component exists to prevent, so the report keeps its #88
 * subset and the wiring lands with the ticket that can fill it honestly.
 * `capacity_ceiling` likewise stays with `CostModel.capacityCeiling` (#87).
 *
 * Ticket #90 adds the **mined eval executor** (`eval-types.ts`,
 * `trade-derivation.ts`, `eval-executor.ts`) — pybroker's walk-forward/CPCV
 * split + eval-metric executor shape, in TypeScript per ADR-0001's
 * "mine for patterns, no hard dependency" posture. It is the join #89 could
 * not make: `ReplayTradeSource` reads the `ClosedTrade`s Execution now emits
 * (#83), `trade-derivation.ts` turns them into the `TradeSeries`/`ReturnSeries`
 * the validation library takes, and the executor cuts the splits and scores
 * each test slice. It computes no metric and generates no split of its own —
 * `CostModel.fill` stays the single fill authority and `computeMetrics` the
 * single metric implementation, which is what makes live == backtest.
 *
 * `BacktestReport.metrics` / `walk_forward` still stand empty. Scoring a
 * replay needs the deployed capital and the bar cadence (`EvalOptions`), and
 * `BacktestConfig` carries neither; adding them is a contract change #90 was
 * not asked to make, so the caller runs the executor over the report's window
 * rather than the harness inventing the inputs. `capacity_ceiling` remains
 * with `CostModel.capacityCeiling` (#87).
 *
 * CPCV *generation* works (#89); CPCV *scoring* deliberately throws — see
 * `testRangeOf` in eval-executor.ts for why a disjoint test side cannot be
 * given an honest exposure denominator without changing `TradeSeries`.
 *
 * Ticket #196 adds the real `SqliteConfigTrialLog`, over the shared store's
 * `config_trials` table (#193). `InMemoryConfigTrialLog` stays exported
 * alongside it — a fixture double, per `SqliteSetupStore`/`FixtureSetupStore`
 * precedent — since no composition root wires either yet (`eval-executor.ts`
 * does not call `recordTrial`; see the #89/#90 notes above on why
 * `BacktestReport.metrics` isn't wired into a caller that could).
 *
 * Ticket #242 (Stage 2 Validation Execution, wayfinder map #154, see
 * docs/specs/stage2-validation-execution-spec.md) adds `proxy-strategy.ts` —
 * the deterministic dual-SMA/ATR rule standing in for the live LLM debate
 * pipeline during Stage 2. It is a pure signal function only; the replay
 * driver that steps it through history (#243) is a separate, not-yet-built
 * ticket.
 *
 * Ticket #241 adds `stage2-historical-store.ts` — `Stage2HistoricalStore`,
 * a research-only scratch-SQLite store (never the shared store's `bars`
 * table) that ingests Polygon/Massive daily aggregates and implements both
 * `ReplayTimeline` and `InstrumentRegistry` for the replay driver (#243) to
 * consume. `PolygonClient` is interface-only, matching this codebase's
 * existing Alpaca/ccxt/IBKR client precedent — a real HTTP client is ops
 * wiring, not this ticket's scope.
 *
 * Ticket #243 adds `replay-driver.ts` — `ReplayDriver`, which steps the proxy
 * strategy (#242) through the ingested bars (#241), prices every entry and
 * exit through `CostModel.fill`, and produces `ReplayTradeSource`/
 * `ReplayTimeline` for `EvalExecutorImpl` to score. It is a backtest-only
 * path: no `BrokerAdapter`, Trader, Risk or Verdict call anywhere in it, and
 * `eval-executor.ts`/`eval-types.ts`/`types.ts` are unchanged by it.
 *
 * Ticket #244 adds `trial-execution.ts` — `buildTrialGrid` (the 12-config
 * cross-product) and `runTrialGrid`, which drives every config through the
 * replay driver (#243) and `EvalExecutorImpl` (#90) and logs each in
 * `ConfigTrialLog` (#89) exactly once by `config_hash`. Stock and crypto
 * universes are scored as separate `EvalReport`s (`periodsPerYear` 252 vs
 * 365), so the trial count stays 12 (what #245's Verdict deflates DSR/PBO/
 * MinBTL by) even though the report count is `12 x asset classes present`.
 * `ConfigTrialLog.recordTrial`, `EvalExecutorImpl.evaluate` and
 * `generateSplits` are all used unchanged, per the spec's "existing seams"
 * note — this ticket is orchestration, not a new implementation of any of
 * them.
 *
 * Ticket #245 adds `stage2-verdict.ts` — `renderStage2Verdict`, which checks
 * `TrialGridResult[]` (#244) against the spec's kill line via `overfitting.ts`
 * (#89) unchanged. As of this ticket no real trial data exists (no Polygon
 * ingestion has ever run — see docs/research/06-stage2-overfitting-verdict.md),
 * so `renderStage2Verdict` reports MinBTL for real (window/N only) and typed
 * `NotComputableReason`s for PBO (the spec's 5-fold walk-forward split is not
 * the even-count symmetric CSCV partition `pbo()` requires) and DSR
 * (`MetricsSuite.sharpe` is Lo-adjusted annualized, not the raw per-period
 * Sharpe `deflatedSharpe()` needs) rather than fabricating numbers.
 */

export type { BacktestDeps } from './backtest.js';
export { BacktestHarness } from './backtest.js';
export type { ConfigTrialLog } from './config-trial-log.js';
export { InMemoryConfigTrialLog } from './config-trial-log.js';
export { CostModelImpl } from './cost-model.js';
export type { EvalExecutorDeps } from './eval-executor.js';
export { EvalExecutorImpl } from './eval-executor.js';
export type {
  EvalExecutor,
  EvalOptions,
  EvalReport,
  ReplayTradeSource,
  SplitEval,
} from './eval-types.js';
export type { LookaheadViolation } from './lookahead.js';
export { LookaheadAuditor, LookaheadViolationError } from './lookahead.js';
export { computeMetrics } from './metrics.js';
export { deflatedSharpe, minbtl, minbtlGuard, pbo } from './overfitting.js';
export type { ProxySignal, ProxyStrategyConfig } from './proxy-strategy.js';
export { proxySignal } from './proxy-strategy.js';
export type {
  ReplayBarSource,
  ReplayDriverDeps,
  ReplayInstrument,
  ReplayRunResult,
} from './replay-driver.js';
export { ReplayDriver } from './replay-driver.js';
export type { SplitOptions } from './splits.js';
export { generateSplits } from './splits.js';
export { SqliteConfigTrialLog } from './sqlite-config-trial-log.js';
export type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
export { Stage2HistoricalStore } from './stage2-historical-store.js';
export type {
  ConfigKillLineCheck,
  NotComputableReason,
  PboOutcome,
  Stage2Verdict,
} from './stage2-verdict.js';
export { KILL_LINE, killLineChecks, renderStage2Verdict } from './stage2-verdict.js';
export type { SeriesOptions } from './trade-derivation.js';
export { assertCostModelPriced, toReturnSeries, toTradeSeries } from './trade-derivation.js';
export type {
  ReplayRunner,
  TrialGridAssetClass,
  TrialGridEntry,
  TrialGridResult,
  TrialGridRunDeps,
} from './trial-execution.js';
export {
  buildTrialGrid,
  CRYPTO_PERIODS_PER_YEAR,
  runTrialGrid,
  STOCK_PERIODS_PER_YEAR,
} from './trial-execution.js';
export type {
  AssetClassCostConfig,
  Backtest,
  BacktestConfig,
  BacktestReport,
  CostBreakdown,
  CostConfig,
  CostModel,
  CostModelResult,
  FillRequest,
  MarketState,
  ReplayTimeline,
} from './types.js';
export type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';
export { assertSurvivorshipFree, SurvivorshipViolationError } from './universe.js';
export type {
  MetricsSuite,
  MinBtlVerdict,
  PboVerdict,
  ReturnSeries,
  Split,
  Trade,
  TradeSeries,
} from './validation-types.js';
