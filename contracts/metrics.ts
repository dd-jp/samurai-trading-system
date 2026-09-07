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
 * Every field is plain `number` in-process (`MetricsSuite`, below) — true for
 * the backtest tools and the Feedback Loop's own report, which never leave
 * the process and can carry `Number.POSITIVE_INFINITY` (a window with wins
 * and no losses) without incident. It does NOT hold for the wire:
 * `profit_factor` is the one field a routine day drives non-finite, and
 * `JSON.stringify` has no representation for `Infinity`/`NaN` — it emits
 * literal `null`, indistinguishable from "unknown" (#1270). `MetricsSuiteWire`
 * (`contracts/snapshot.ts`) is therefore NOT this interface verbatim: it
 * replaces `profit_factor` with `ProfitFactorWire`, the one field this file's
 * "plain number, JSON by construction" claim does not cover.
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
  /**
   * Gross wins / gross losses over the trades. `Number.POSITIVE_INFINITY`
   * when there are wins and no losses — an ordinary flawless window, not a
   * defect. Fine to carry as-is in-process; see `ProfitFactorWire` for how
   * this crosses the wire, where `Infinity` cannot survive `JSON.stringify`.
   */
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

/**
 * `profit_factor`'s wire shape (#1270) — a discriminated union, not a
 * nullable `number`. `MetricsSuite.profit_factor` is `Infinity` on any
 * window with wins and no losses (the best possible outcome, not an
 * absence), and `JSON.stringify` has no representation for a non-finite
 * number: it serializes `Infinity`/`NaN`/`-Infinity` as literal `null`,
 * which the client's `formatFixed` renders as the SAME em dash it renders
 * for "we have no idea" (`format.ts`'s `UNKNOWN`). A nullable field would
 * reproduce exactly that collapse one type-check later. A discriminated
 * union survives the boundary intact and forces every reader to handle
 * `no_losses` by name — `switch (pf.kind)` without a `default` is a compile
 * error on a new variant, not a silent fallthrough.
 *
 * `unreadable` exists so `ratio.value` is NEVER itself a non-finite number:
 * without it, an upstream defect that drove `profit_factor` to `NaN` or
 * `-Infinity` would still be wrapped as `{ kind: 'ratio', value: NaN }`, and
 * THAT number dies in `JSON.stringify` the same way the bare field used to —
 * the fix would only have moved the bug one field deeper. `toProfitFactorWire`
 * below is what keeps this invariant true; it is the only production
 * construction site (test fixtures build the literal shape directly, which
 * is fine — they are asserting against it, not deriving it from a domain
 * number).
 *
 * `wins === 0 && losses === 0` (no closed trades at all) is `profitFactor()`
 * returning `0` — an ordinary finite ratio, `{ kind: 'ratio', value: 0 }`.
 * That is a DELIBERATE choice, not an oversight: it keeps that case's
 * current on-wire meaning (a real 0, per `sqlite-query-store.ts`) and it
 * stays distinguishable from `no_losses` by `kind` alone, which is all
 * either acceptance criterion asks for.
 */
export type ProfitFactorWire =
  | { kind: 'ratio'; value: number }
  | { kind: 'no_losses' }
  | { kind: 'unreadable' };

/**
 * The only production construction site for a `ProfitFactorWire`. Every
 * producer of a `MetricsSuiteWire` (today just `buildSnapshot`) must route
 * the domain `profit_factor` number through this function rather than
 * re-deriving the three-way split, so a future second wire-builder cannot
 * drift from this one on which non-finite values mean what. (Test fixtures
 * construct the literal shape directly to assert against it — that is not a
 * second production path.)
 */
export function toProfitFactorWire(value: number): ProfitFactorWire {
  if (Number.isFinite(value)) return { kind: 'ratio', value };
  if (value === Number.POSITIVE_INFINITY) return { kind: 'no_losses' };
  return { kind: 'unreadable' };
}
