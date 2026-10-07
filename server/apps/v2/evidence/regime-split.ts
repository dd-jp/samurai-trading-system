import { annualisedSharpe } from './momentum/stats.js';

export interface RegimePeriod {
  readonly period: string;
  readonly from: string;
  readonly to: string;
}

const MIN_SHARPE_SESSIONS = 2;

export interface RegimeDay {
  readonly date: string;
  readonly strategy: number;
  readonly benchmark: number;
}

export interface RegimeComparison {
  readonly sessions: number;
  readonly strategySharpeHaircut: number | null;
  readonly benchmarkSharpe: number | null;
  readonly excess: number | null;
}

export interface RegimePeriodRow extends RegimePeriod {
  readonly inPeriod: RegimeComparison;
  readonly withoutPeriod: RegimeComparison;
  readonly beatsBenchmarkWithoutPeriod: boolean;
}

export interface RegimeSplit {
  readonly periods: readonly RegimePeriodRow[];
  readonly beatsBenchmarkWithAnyPeriodRemoved: boolean;
}

export function regimePeriods(from: string, to: string): RegimePeriod[] {
  const years: RegimePeriod[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    years.push({ period: String(year), from: `${year}-01-01`, to: `${year}-12-31` });
  }
  // David, 2026-10-05 on #1747: S&P 500 peak to trough, the same dates for the LSE candidates
  return [
    ...years,
    { period: '2020-crash', from: '2020-02-19', to: '2020-03-23' },
    { period: '2022-drawdown', from: '2022-01-03', to: '2022-10-12' },
  ];
}

function compare(days: readonly RegimeDay[], haircutMultiplier: number): RegimeComparison {
  if (days.length < MIN_SHARPE_SESSIONS) {
    return {
      sessions: days.length,
      strategySharpeHaircut: null,
      benchmarkSharpe: null,
      excess: null,
    };
  }
  const strategy = annualisedSharpe(days.map((day) => day.strategy)) * haircutMultiplier;
  const benchmark = annualisedSharpe(days.map((day) => day.benchmark));
  return {
    sessions: days.length,
    strategySharpeHaircut: strategy,
    benchmarkSharpe: benchmark,
    excess: strategy - benchmark,
  };
}

function periodRow(
  days: readonly RegimeDay[],
  period: RegimePeriod,
  haircutMultiplier: number,
): RegimePeriodRow {
  const inside = (day: RegimeDay) => day.date >= period.from && day.date <= period.to;
  const withoutPeriod = compare(
    days.filter((day) => !inside(day)),
    haircutMultiplier,
  );
  return {
    ...period,
    inPeriod: compare(days.filter(inside), haircutMultiplier),
    withoutPeriod,
    // Fail-closed: a remainder too short for a Sharpe leaves the one period carrying the result
    beatsBenchmarkWithoutPeriod: (withoutPeriod.excess ?? 0) > 0,
  };
}

export function regimeSplit(
  days: readonly RegimeDay[],
  periods: readonly RegimePeriod[],
  haircutMultiplier: number,
): RegimeSplit {
  const rows = periods.map((period) => periodRow(days, period, haircutMultiplier));
  return {
    periods: rows,
    beatsBenchmarkWithAnyPeriodRemoved: rows.every((row) => row.beatsBenchmarkWithoutPeriod),
  };
}
