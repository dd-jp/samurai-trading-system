/**
 * MetricsSuite computation (ticket #89). See
 * docs/specs/cost-model-backtest-spec.md ("Module: Validation Library").
 *
 * **Reported together, never one number.** `computeMetrics` is the only export:
 * there is deliberately no `computeSharpe(...)` for a caller to reach for. The
 * suite exists because a single number invites the cherry-pick the whole
 * overfitting defence is built to stop, so the shape enforces it.
 *
 * **Implemented in TypeScript, not pybroker.** The spec names pybroker as the
 * eval executor, but ADR-0001 resolves the reuse posture as "mine the three
 * repos for patterns, no hard dependency ... Python repos remain pattern
 * references only, read during implementation, not imported" and fixes
 * TypeScript as the core language. #88 set the same precedent for the harness.
 * The repos are not on disk in this worktree, so the formulas below come from
 * their primary sources (cited per-function) rather than from pybroker's
 * `src/eval.py`. <!-- cite-exempt: foreign — pybroker's own tree, mined not depended on; never expected to exist here -->
 */

import type { MetricsSuite, ReturnSeries, TradeSeries } from './validation-types.js';

/**
 * Compute the full suite. Throws rather than returning a degenerate number:
 * every ratio below is undefined on a zero-dispersion or empty sample, and a
 * silently-zero Sharpe next to a real drawdown is precisely the kind of
 * flattering lie this component exists to prevent.
 */
export function computeMetrics(returns: ReturnSeries, trades: TradeSeries): MetricsSuite {
  assertUsableSeries(returns);

  const { returns: r, periodsPerYear } = returns;

  const mean = average(r);
  const stdev = sampleStdev(r);

  if (stdev === 0) {
    throw new Error(
      'computeMetrics: return series has zero variance — Sharpe/Sortino are undefined on it.',
    );
  }

  const annualization = loAnnualizationFactor(r, periodsPerYear);
  const downside = downsideDeviation(r);
  const max_drawdown = maxDrawdown(r);

  // The DSR inputs (#406). `per_period_sharpe` is the statistic
  // `deflatedSharpe()` is defined against; `sharpe` below is it times
  // `annualization`, so the two can never disagree about the same sample
  const per_period_sharpe = mean / stdev;

  return {
    sharpe: per_period_sharpe * annualization,
    sortino: downside === 0 ? Number.POSITIVE_INFINITY : (mean / downside) * annualization,
    calmar:
      max_drawdown === 0
        ? Number.POSITIVE_INFINITY
        : annualizedReturn(r, periodsPerYear) / max_drawdown,
    max_drawdown,
    profit_factor: profitFactor(trades),
    expectancy: expectancy(trades),
    skew: skew(r),
    kurtosis: excessKurtosis(r),
    turnover: turnover(trades),
    exposure: exposure(trades),
    per_period_sharpe,
    annualization_factor: annualization,
    observations: r.length,
  };
}

/**
 * Lo (2002), "The Statistics of Sharpe Ratios", eq. (9-10): the correct
 * factor for scaling a per-period Sharpe to a q-period one is
 *
 *   ξ(q) = q / sqrt( q + 2·Σ_{k=1..q-1} (q−k)·ρ_k )
 *
 * **not** the naive √q, which is only the ρ_k = 0 special case (substitute and
 * see). The distinction is load-bearing rather than academic: positively
 * autocorrelated returns — the shape a trend-following system produces — have
 * a q-period variance *larger* than q times the per-period variance, so √q
 * overstates their annualized Sharpe. The spec calls this out by name.
 *
 * The autocovariances use the biased (÷n) estimator on purpose. Together with
 * the (q−k) Bartlett weights that makes the denominator a variance-of-a-sum
 * estimate, which is non-negative by construction — the (÷(n−k)) estimator can
 * produce a negative radicand on noisy samples.
 */
function loAnnualizationFactor(r: readonly number[], periodsPerYear: number): number {
  const maxLag = Math.min(periodsPerYear - 1, r.length - 1);

  let weighted = 0;
  for (let k = 1; k <= maxLag; k++) {
    weighted += (periodsPerYear - k) * autocorrelation(r, k);
  }

  const varianceOfSum = periodsPerYear + 2 * weighted;

  if (varianceOfSum <= 0) {
    throw new Error(
      `computeMetrics: Lo (2002) annualization is undefined — the estimated ${periodsPerYear}-period ` +
        `variance ratio is ${varianceOfSum.toFixed(4)} (must be > 0). The sample is too short or too ` +
        'strongly mean-reverting to annualize honestly.',
    );
  }

  return periodsPerYear / Math.sqrt(varianceOfSum);
}

/** ρ_k, via the biased autocovariance estimator — see loAnnualizationFactor */
function autocorrelation(r: readonly number[], lag: number): number {
  const mean = average(r);
  const deviations = r.map((value) => value - mean);

  let covariance = 0;
  for (let t = 0; t < deviations.length - lag; t++) {
    const leading = deviations[t];
    const lagged = deviations[t + lag];
    if (leading === undefined || lagged === undefined) {
      continue;
    }
    covariance += leading * lagged;
  }

  let variance = 0;
  for (const deviation of deviations) {
    variance += deviation ** 2;
  }

  // Standard biased autocorrelation: numerator has n−lag terms,
  // denominator has n terms. The 1/n cancels out of the ratio.
  return variance === 0 ? 0 : covariance / variance;
}

/**
 * Downside deviation about a zero target: only returns below the target
 * contribute, but the sum is divided by the full n (Sortino's convention) so
 * a strategy is not rewarded for having few, deep losses
 */
function downsideDeviation(r: readonly number[]): number {
  let sum = 0;
  for (const value of r) {
    if (value < 0) {
      sum += value ** 2;
    }
  }
  return Math.sqrt(sum / r.length);
}

/** Geometric, so the compounding a real account experiences is respected */
function annualizedReturn(r: readonly number[], periodsPerYear: number): number {
  let equity = 1;
  for (const value of r) {
    equity *= 1 + value;
  }

  // A wipeout has no real annualized return; -100% is the honest report
  if (equity <= 0) {
    return -1;
  }

  return equity ** (periodsPerYear / r.length) - 1;
}

/** Worst peak-to-trough decline of the compounded equity curve, as a positive fraction */
function maxDrawdown(r: readonly number[]): number {
  let equity = 1;
  let peak = 1;
  let worst = 0;

  for (const value of r) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    worst = Math.max(worst, (peak - equity) / peak);
  }

  return worst;
}

/**
 * Gross wins / gross losses. `Infinity` on a lossless sample is deliberate:
 * the ratio genuinely is unbounded there, and substituting a finite stand-in
 * would invent an edge the sample does not show. A caller reading `Infinity`
 * next to a 3-trade sample can see the metric for what it is.
 */
function profitFactor(trades: TradeSeries): number {
  let wins = 0;
  let losses = 0;

  for (const trade of trades.trades) {
    if (trade.pnl >= 0) {
      wins += trade.pnl;
    } else {
      losses += -trade.pnl;
    }
  }

  if (losses === 0) {
    return wins === 0 ? 0 : Number.POSITIVE_INFINITY;
  }

  return wins / losses;
}

/** (P_win × AvgWin) − (P_loss × AvgLoss), per trade. Net of costs — see `Trade.pnl`. */
function expectancy(trades: TradeSeries): number {
  const all = trades.trades;
  if (all.length === 0) {
    return 0;
  }

  const wins = all.filter((trade) => trade.pnl >= 0);
  const losses = all.filter((trade) => trade.pnl < 0);

  const pWin = wins.length / all.length;
  const pLoss = losses.length / all.length;
  const avgWin = wins.length === 0 ? 0 : average(wins.map((trade) => trade.pnl));
  const avgLoss = losses.length === 0 ? 0 : average(losses.map((trade) => -trade.pnl));

  return pWin * avgWin - pLoss * avgLoss;
}

function turnover(trades: TradeSeries): number {
  if (trades.averageCapital <= 0) {
    throw new Error(
      `computeMetrics: trades.averageCapital must be > 0 (got ${trades.averageCapital}) — it is the turnover denominator.`,
    );
  }

  let notional = 0;
  for (const trade of trades.trades) {
    notional += trade.notional;
  }

  return notional / trades.averageCapital;
}

/**
 * Fraction of the window with *any* position open. Overlapping trades are
 * merged rather than summed: two instruments held at once is one period of
 * market exposure, and summing them would report exposure > 1 for a portfolio
 * that was simply diversified.
 */
function exposure(trades: TradeSeries): number {
  const windowMs = trades.window.end.getTime() - trades.window.start.getTime();

  if (windowMs <= 0) {
    throw new Error(
      'computeMetrics: trades.window must have end > start — it is the exposure denominator.',
    );
  }

  const intervals = trades.trades
    .map((trade) => ({ start: trade.opened_at.getTime(), end: trade.closed_at.getTime() }))
    .sort((a, b) => a.start - b.start);

  let held = 0;
  let openFrom: number | undefined;
  let openTo = 0;

  for (const interval of intervals) {
    if (openFrom === undefined) {
      openFrom = interval.start;
      openTo = interval.end;
      continue;
    }

    if (interval.start <= openTo) {
      openTo = Math.max(openTo, interval.end);
    } else {
      held += openTo - openFrom;
      openFrom = interval.start;
      openTo = interval.end;
    }
  }

  if (openFrom !== undefined) {
    held += openTo - openFrom;
  }

  return held / windowMs;
}

/** Sample skew, g1 = m3 / m2^1.5 — the moment estimator the DSR is defined against */
function skew(r: readonly number[]): number {
  const m2 = centralMoment(r, 2);
  return m2 === 0 ? 0 : centralMoment(r, 3) / m2 ** 1.5;
}

/** **Excess** kurtosis: m4 / m2² − 3, so a normal sample reports 0 */
function excessKurtosis(r: readonly number[]): number {
  const m2 = centralMoment(r, 2);
  return m2 === 0 ? 0 : centralMoment(r, 4) / m2 ** 2 - 3;
}

function centralMoment(r: readonly number[], order: number): number {
  const mean = average(r);
  let sum = 0;
  for (const value of r) {
    sum += (value - mean) ** order;
  }
  return sum / r.length;
}

function average(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function sampleStdev(values: readonly number[]): number {
  const mean = average(values);
  let sum = 0;
  for (const value of values) {
    sum += (value - mean) ** 2;
  }
  return Math.sqrt(sum / (values.length - 1));
}

function assertUsableSeries(returns: ReturnSeries): void {
  if (returns.returns.length < 2) {
    throw new Error(
      `computeMetrics: need at least 2 return observations to estimate dispersion (got ${returns.returns.length}).`,
    );
  }

  if (returns.periodsPerYear <= 0) {
    throw new Error(
      `computeMetrics: periodsPerYear must be > 0 (got ${returns.periodsPerYear}) — it is the annualization base.`,
    );
  }
}
