import { TRADING_DAYS_PER_YEAR } from '../../../pipeline/momentum/index.js';

export interface ReturnMoments {
  readonly count: number;
  readonly mean: number;
  readonly stdev: number;
  readonly skew: number;
  readonly excessKurtosis: number;
}

export function moments(returns: readonly number[]): ReturnMoments {
  const count = returns.length;
  if (count < 2) throw new Error(`moments: need >= 2 returns (got ${count})`);
  let sum = 0;
  for (const value of returns) sum += value;
  const mean = sum / count;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const value of returns) {
    const deviation = value - mean;
    m2 += deviation ** 2;
    m3 += deviation ** 3;
    m4 += deviation ** 4;
  }
  const variance = m2 / (count - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return { count, mean, stdev, skew: 0, excessKurtosis: 0 };
  const populationVariance = m2 / count;
  return {
    count,
    mean,
    stdev,
    skew: m3 / count / populationVariance ** 1.5,
    excessKurtosis: m4 / count / populationVariance ** 2 - 3,
  };
}

export function perPeriodSharpe(returns: readonly number[]): number {
  const { mean, stdev } = moments(returns);
  return stdev === 0 ? 0 : mean / stdev;
}

export function annualisedSharpe(returns: readonly number[]): number {
  return perPeriodSharpe(returns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

export function maxDrawdown(equity: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.max(worst, 1 - value / peak);
  }
  return worst;
}

export function compoundedAnnualReturn(equity: readonly number[]): number {
  const first = equity[0];
  const last = equity[equity.length - 1];
  if (first === undefined || last === undefined || !(first > 0)) return 0;
  const years = (equity.length - 1) / TRADING_DAYS_PER_YEAR;
  return years <= 0 ? 0 : (last / first) ** (1 / years) - 1;
}

export function annualisedVol(returns: readonly number[]): number {
  return moments(returns).stdev * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

export function calendarYearReturns(
  dates: readonly string[],
  equity: readonly number[],
): Map<number, number> {
  if (dates.length !== equity.length)
    throw new Error('calendarYearReturns: dates and equity differ in length');
  const byYear = new Map<number, number>();
  let yearStart = equity[0] as number;
  for (let index = 1; index < dates.length; index++) {
    const year = Number((dates[index] as string).slice(0, 4));
    const previousYear = Number((dates[index - 1] as string).slice(0, 4));
    if (year !== previousYear) yearStart = equity[index - 1] as number;
    byYear.set(year, (equity[index] as number) / yearStart - 1);
  }
  return byYear;
}
