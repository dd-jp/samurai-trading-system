/**
 * The metrics suite — computed by the backtest validation library, written by
 * the Feedback Loop, and rendered by the dashboard's metrics panel.
 *
 * Moved here from `server/tools/backtest/validation-types.ts`. It was never
 * a backtest-only shape: `feedback-loop/types/metrics.ts` recomposes it into
 * its live report and `DashboardSnapshot.metrics` puts it on the wire, so a
 * folder named for an offline research harness owned a type on the operator's
 * live surface. The harness now imports it from here like everyone else.
 *
 * Every field is plain `number` — the whole suite is JSON by construction,
 * which is what qualifies it for this directory.
 */

/**
 * Reported together, never one number (spec: "Module: Validation Library",
 * user story 13). Every field is required: an optional field would let a
 * caller construct exactly the single-number report the suite exists to
 * prevent.
 *
 * = FL's `MetricsReport.daily` (cross-spec change #1) — FL recomposes this
 * flat suite into its nested report rather than re-implementing it, so live
 * metrics and backtest metrics match by construction.
 */
export interface MetricsSuite {
  /**
   * Annualized, respecting serial correlation (Lo 2002) — **not** a naive
   * ×√periodsPerYear, which overstates the Sharpe of positively
   * autocorrelated returns (i.e. exactly the trend-following shapes this
   * system produces).
   */
  sharpe: number;
  /** Downside-deviation denominator; same Lo-adjusted annualization. */
  sortino: number;
  /** Annualized return / max drawdown. */
  calmar: number;
  /** Worst peak-to-trough decline over the sample, as a positive fraction. */
  max_drawdown: number;
  /** Gross wins / gross losses over the trades. */
  profit_factor: number;
  /** (P_win × AvgWin) − (P_loss × AvgLoss), per trade, net of costs. */
  expectancy: number;
  /** Sample skew of the return series — a DSR input. */
  skew: number;
  /** Sample **excess** kurtosis (0 = normal) — a DSR input. */
  kurtosis: number;
  /**
   * The **non-annualized** Sharpe — mean/stdev of the raw periodic returns,
   * before `annualization_factor` is applied. `sharpe === per_period_sharpe ×
   * annualization_factor` by construction.
   *
   * Carried because `deflatedSharpe()` is defined against the per-period
   * statistic and cannot be handed `sharpe`: the Lo (2002) factor folds in
   * sample autocorrelation, so it is not a naive ×√periodsPerYear away and
   * cannot be inverted from the suite. Before this field existed, DSR was
   * structurally uncomputable on every run (#406, and P7 in
   * docs/research/14-backtest-pitfalls.md).
   *
   * It lives here, rather than behind a `sharpeDecomposition()` export, so it
   * cannot desync from the sample it describes — see `observations`.
   */
  per_period_sharpe: number;
  /** The Lo (2002) factor ξ(q) applied to reach `sharpe`. Always > 0. */
  annualization_factor: number;
  /**
   * Number of return observations in the sample — DSR's `sampleLen`.
   *
   * Computed inside `computeMetrics` on purpose: a caller assembling it
   * separately could hand `deflatedSharpe` a length from a different slice
   * than the Sharpe it deflates, which is exactly the silent mis-deflation the
   * statistic exists to prevent.
   */
  observations: number;
  /** Traded notional / average capital over the sample. */
  turnover: number;
  /** Fraction of the sample with a position open. */
  exposure: number;
}
