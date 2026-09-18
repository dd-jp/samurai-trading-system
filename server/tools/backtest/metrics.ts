import type { MetricsSuite, ReturnSeries, TradeSeries } from './validation-types.js';

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

  return variance === 0 ? 0 : covariance / variance;
}

function downsideDeviation(r: readonly number[]): number {
  let sum = 0;
  for (const value of r) {
    if (value < 0) {
      sum += value ** 2;
    }
  }
  return Math.sqrt(sum / r.length);
}

function annualizedReturn(r: readonly number[], periodsPerYear: number): number {
  let equity = 1;
  for (const value of r) {
    equity *= 1 + value;
  }

  if (equity <= 0) {
    return -1;
  }

  return equity ** (periodsPerYear / r.length) - 1;
}

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

function skew(r: readonly number[]): number {
  const m2 = centralMoment(r, 2);
  return m2 === 0 ? 0 : centralMoment(r, 3) / m2 ** 1.5;
}

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
