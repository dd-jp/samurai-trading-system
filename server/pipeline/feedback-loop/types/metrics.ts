/**
 * Measurement and the kill lines (#308): the metrics report, the thresholds
 * that constitute a breach, and the revalidation snapshot Stage 2 freezes.
 * Separate from `tuning.ts` because measuring and adjusting change for
 * different reasons.
 */

import type { Clock, TuningStore } from '../../../shared/index.js';
import type { MetricsSuite } from '../../../tools/backtest/index.js';
import type { AdjustmentLog, FeedbackConfig } from './tuning.js';

/**
 * Kill-line config for `computeMetrics` (#93) — feedback-loop-spec.md
 * ("Module: Metrics & Revalidation", story 13): "PBO > 0.05, OOS/paper Sharpe
 * < 0.5, DSR insignificant, live-vs-backtest divergence". Config, not
 * hardcoded, for the same reason `TunableDial`'s bounds are: the spec lists
 * "kill thresholds" alongside step caps and cadences as `FeedbackConfig`
 * fields the operator sets, not values this module bakes in.
 */
export interface KillThresholds {
  /** PBO's own reject line is 0.05 (validation-types.ts `PboVerdict`); this is FL's copy of it. */
  max_pbo: number;
  /** Below this, the mean out-of-sample/paper Sharpe across the walk-forward distribution breaches. */
  min_oos_sharpe: number;
  /** Below this Deflated Sharpe (a probability), the edge is statistically insignificant. */
  min_deflated_sharpe: number;
  /** Fractional drop of live Sharpe below the frozen backtest reference before it counts as divergence. */
  max_live_backtest_divergence: number;
}

/**
 * The validation library's periodic (weekly/monthly) walk-forward/DSR/PBO
 * OUTPUT, computed elsewhere (offline research / the eval executor, using
 * `generateSplits`/`deflatedSharpe`/`pbo` from cost-model-backtest) and handed
 * to `computeMetrics` to recompose and evaluate — never reimplemented here.
 * Absent outside the periodic cadence; the daily call has no revalidation to
 * recompose.
 */
export interface RevalidationSnapshot {
  walk_forward_sharpe_distribution: number[];
  deflated_sharpe: number;
  pbo: number;
}

/**
 * Fire-and-forget human alert on a kill-threshold breach (spec story 13, "the
 * trade channel"). Deliberately NOT `LoosenApprovalChannel`: a breach alert
 * expects no response — the kill/rework call is the human's to make later,
 * out of band — whereas a loosening is a request this module waits on.
 */
export interface BreachAlertChannel {
  postBreachAlert(alert: BreachAlert): void;
}

export interface BreachAlert {
  /** The breach identifiers also written to `MetricsReport.breaches`. */
  breaches: string[];
  reported_at: Date;
}

/**
 * Narrow seam `computeMetrics` (#93) actually consumes — the spec's
 * `FeedbackInput` minus the fields `runDailyCycle` alone needs (`trades`,
 * `debate_log`, `proposals`), same split rationale as `DailyCycleInput`.
 */
export interface MetricsInput {
  /** Wall-clock live, simulated T in replay — read only through this. */
  clock: Clock;
  /**
   * = the validation library's `MetricsSuite`, already computed by its
   * `computeMetrics` (cost-model-backtest/metrics.ts) over the day's returns
   * and trades. This module recomposes it into the report; it does not
   * derive it from raw returns itself (acceptance criterion #1).
   */
  daily: MetricsSuite;
  /** The frozen selected config's backtest Sharpe — the divergence check's baseline. */
  backtest_reference_sharpe: number;
  /** Present only on the weekly/monthly revalidation cadence. */
  revalidation?: RevalidationSnapshot;
  /** The three dials, read and written — auto-tighten writes here on breach. */
  tuning: TuningStore;
  /** Where every auto-tighten move is recorded, same log `runDailyCycle` appends to. */
  adjustments: AdjustmentLog;
  config: FeedbackConfig;
  alerts: BreachAlertChannel;
}

/** Shape frozen by feedback-loop-spec.md ("Key Interfaces"). */
export interface MetricsReport {
  /** = the library's `MetricsSuite`, recomposed — no reimplemented math (acceptance criterion #1). */
  daily: MetricsSuite;
  /** The library's DSR/PBO/walk-forward output, recomposed — present only on the periodic cadence. */
  revalidation?: RevalidationSnapshot;
  /** FL-only. e.g. 'pbo_over_max', 'oos_sharpe_under_min'. Never triggers a kill — alert + auto-tighten only. */
  breaches: string[];
  /**
   * Kill-lines this run could NOT evaluate, so that "did not breach" is never
   * mistaken for "was never checked" (#327).
   *
   * Two causes, both routine and both silent until now:
   *
   * - No `revalidation` snapshot — which is every non-revalidation day, by
   *   design. The three snapshot-gated lines (`pbo_over_max`,
   *   `oos_sharpe_under_min`, `dsr_insignificant`) simply do not run.
   * - `backtest_reference_sharpe <= 0` — `liveBacktestDivergence` returns `0`
   *   rather than manufacture a false breach off a broken reference (correct,
   *   and unchanged), which leaves `live_backtest_divergence_over_max` inert.
   *
   * An empty array is the only clean bill of health: it means all four lines
   * actually ran. A caller reading `breaches` alone cannot tell the
   * difference — which is precisely how a degrading paper run reports nothing.
   */
  not_evaluated: string[];
}

/**
 * Where a live run gets the `MetricsSuite` that `computeMetrics` evaluates
 * (#327).
 *
 * A supplied port, not a computation here. It stayed one for a while because
 * the validation library's `computeMetrics(returns, trades)` needs a
 * `ReturnSeries` — evenly spaced periodic equity returns — and nothing
 * persisted such a series: `account_state` (migration 0006) holds
 * `peak_equity`, a high-water scalar, and that migration's own comment recorded
 * `daily_open_equity` as an OPEN decision (GAP-8). Deriving returns from
 * realized `ClosedTrade` PnL instead would use the wrong denominator and be
 * unevenly spaced.
 *
 * **#345 closed that.** `daily_equity` (migration 0011) persists one immutable
 * equity observation per portfolio session — per UTC day, so exactly evenly
 * spaced — and `SqliteDailyEquityMetricsSource` (orchestrator/production)
 * derives a real `ReturnSeries` from it. See ADR-0006.
 *
 * The port survives that, rather than being replaced by a direct computation,
 * because a breach does not merely report: `autoTighten` WRITES every risk
 * threshold toward its extreme and appends to the `AdjustmentLog`. Deciding
 * whether the sample can carry that weight is a policy question — the
 * implementation refuses below a justified minimum observation count — and
 * keeping it behind a port is what lets the answer be "not this cycle" without
 * anything downstream having to understand why.
 *
 * So: returning `undefined` is a first-class answer meaning "no suite this
 * cycle", not an error. The orchestrator says so out loud rather than booking
 * it as a passing check. Backtest and Stage-2 harnesses supply their own
 * implementations, exactly as they do for `LoosenApprovalChannel`.
 */
export interface DailyMetricsSource {
  getDailyMetrics(): DailyMetricsSample | undefined;
}

export interface DailyMetricsSample {
  /** Already computed by the validation library — never derived here. */
  daily: MetricsSuite;
  /** Present only on the weekly/monthly revalidation cadence. */
  revalidation?: RevalidationSnapshot;
}
