/**
 * Cost Model / Backtest Harness — see docs/specs/cost-model-backtest-spec.md, epic #58.
 * Implemented ticket-by-ticket starting with #87.
 *
 * Ticket #88 built the replay harness — `BacktestHarness`, driving the
 * Orchestrator's `Scheduler` + `TickRunner` bar-by-bar via a stepped
 * `SimulatedClock` — as the spec's intended "replay and live share one code
 * path" seam, built precisely because pybroker's synchronous `exec_fn`
 * cannot host the LLM debate and the harness had to (`cost-model-backtest-
 * spec.md:227`). #1156 deleted it under `docs/coding-standards.md`'s
 * "speculative implementations live in git history" rule: no composition
 * root ever constructed it (only its own test and `eval-executor.test.ts`'s
 * cross-check did), and no open issue depends on wiring it — Stage 2 runs
 * the separate proxy-strategy path below (#242-#245) instead, which was
 * never derived from this harness's absence. The no-lookahead auditor
 * (`lookahead.ts`) and survivorship-free check (`universe.ts`) it also
 * introduced stayed: both are live via `replay-driver.ts`.
 *
 * `BacktestReport` is declared in its #88-fillable subset only: the `metrics`
 * / walk-forward / capacity-ceiling fields belong to the validation library
 * and arrive with the ticket that can honestly populate them, per the staged
 * style of `types.ts` (#87) and `execution/types.ts` (#82). `trial-execution.ts`
 * (#244) is `BacktestReport`'s one real writer.
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
 * CPCV *generation* works (#89); CPCV *scoring* deliberately throws — see
 * `testRangeOf` in eval-executor.ts for why a disjoint test side cannot be
 * given an honest exposure denominator without changing `TradeSeries`.
 *
 * Ticket #196 added a real `SqliteConfigTrialLog`, over the shared store's
 * `config_trials` table (#193). #1156 deleted it: no composition root ever
 * constructed it, wiring it into `run-stage2.ts` would have made
 * `distinctTrialCount()` a cumulative `SELECT COUNT(*)` across every run
 * ever taken against the shared store rather than the current process's
 * grid — silently moving a number `renderStage2Verdict`'s MinBTL check
 * deflates by — and no code ever called `getTrial` outside the deleted
 * class's own test. `InMemoryConfigTrialLog` is `ConfigTrialLog`'s one
 * implementation now; `trial-execution.ts` (#244) is its one real caller.
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
 * ingestion has ever run — see docs/research/archive/2026-07-29-stage2-overfitting-verdict.md),
 * so `renderStage2Verdict` reports MinBTL for real (window/N only) and typed
 * `NotComputableReason`s for PBO (the spec's 5-fold walk-forward split is not
 * the even-count symmetric CSCV partition `pbo()` requires) and DSR
 * (`MetricsSuite.sharpe` is Lo-adjusted annualized, not the raw per-period
 * Sharpe `deflatedSharpe()` needs) rather than fabricating numbers.
 *
 * Ticket #266 adds `http-polygon-client.ts` — `HttpPolygonClient`, the real
 * `PolygonClient` implementation `Stage2HistoricalStore` was built to accept
 * (#241 deliberately left it interface-only, ops/setup out of scope). It
 * follows `.next_url` pagination and maps this repo's `<BASE>-USD` crypto
 * symbols to Polygon's `X:<BASE>USD` ticker format, per
 * docs/research/32-vendor-api-reference.md (#263). This ticket
 * also adds `scripts/run-stage2.ts`, the one-shot runner wiring ingestion ->
 * `TrialGridAssetClass`es -> `runTrialGrid` -> `renderStage2Verdict` into a
 * runnable path — glue, not new design. Neither piece was exercised against
 * live Polygon traffic in this environment (no network access); both are
 * covered by tests against a mocked HTTP client / fake `PolygonClient`
 * instead. A real 5-year ingestion and the resulting written verdict remain
 * a follow-up manual/ops step (#245's still-open AC2/4/5).
 */

export { InMemoryConfigTrialLog } from './config-trial-log.js';
export type { RunCostAttribution } from './cost-attribution.js';
export {
  attributeRunCosts,
  GrossOfCostsTradeSource,
} from './cost-attribution.js';
export { CostModelImpl, SAXO_COMMISSION_RATE } from './cost-model.js';
export { EvalExecutorImpl } from './eval-executor.js';
// `maxAlpacaPagesFor` is deliberately NOT re-exported for the same reason
// `isCryptoSymbol` is not: it has no consumer outside its module
// `isCryptoSymbol` is deliberately NOT re-exported: nothing outside this
// module consumes it, and `docs/coding-standards.md` rules that a barrel entry
// with no external consumer is dead surface. It stays exported from its own
// file for its unit test, which is an in-module import
export { FreeStackAggregatesClient } from './free-stack-aggregates-client.js';
export { HttpPolygonClient } from './http-polygon-client.js';
export { HttpTiingoClient } from './http-tiingo-client.js';
export { computeMetrics } from './metrics.js';
export { minbtl } from './overfitting.js';
export type { ReplayRunResult } from './replay-driver.js';
export { ReplayDriver } from './replay-driver.js';
export { SqliteStage2SelectionStore } from './sqlite-stage2-selection-store.js';
export type {
  PolygonAggregate,
  PolygonClient,
} from './stage2-historical-store.js';
export { DEFAULT_STAGE2_TIMEFRAME, Stage2HistoricalStore } from './stage2-historical-store.js';
export { type Stage2Selection, selectionsFrom } from './stage2-selection.js';
export type { Stage2Verdict } from './stage2-verdict.js';
export { killLineChecks, renderStage2Verdict } from './stage2-verdict.js';
export type {
  TrialGridAssetClass,
  TrialGridResult,
} from './trial-execution.js';
export {
  CRYPTO_PERIODS_PER_YEAR,
  periodsPerYearFor,
  runTrialGrid,
  STOCK_PERIODS_PER_YEAR,
} from './trial-execution.js';
export type {
  CostBreakdown,
  CostConfig,
  CostModel,
  CostVenue,
  FillRequest,
  MarketState,
} from './types.js';
export type { DateRange } from './universe.js';
export type {
  MetricsSuite,
  ReturnSeries,
  TradeSeries,
} from './validation-types.js';
