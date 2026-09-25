import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { assertSortedUniqueDates } from '../../../pipeline/momentum/index.js';
import type { FxRate } from './fx.js';

export const SPLICE_MIN_OVERLAP_SESSIONS = 60;
export const SPLICE_MAX_MEAN_ABS_RETURN_DIFF_BPS = 1;

export interface OverlapStats {
  readonly sessions: number;
  readonly meanAbsReturnDiffBps: number;
  readonly meanReturnDiffBps: number;
  readonly returnCorrelation: number;
  readonly cumulativeReturnDiffBps: number;
}

export interface SpliceResult {
  readonly bars: DailyBar[];
  readonly spliceDate: string;
  readonly siblingBarsUsed: number;
  readonly overlap: OverlapStats;
  readonly withinTolerance: boolean;
}

export function convertUsdBarsToGbp(
  bars: readonly DailyBar[],
  rates: readonly FxRate[],
): DailyBar[] {
  const sorted = [...rates].sort((a, b) => a.date.localeCompare(b.date));
  let cursor = 0;
  return bars.map((bar) => {
    while (cursor + 1 < sorted.length && (sorted[cursor + 1] as FxRate).date <= bar.date) cursor++;
    const fix = sorted[cursor];
    if (fix === undefined || fix.date > bar.date) {
      throw new Error(`convertUsdBarsToGbp: no BoE fix on or before ${bar.date}`);
    }
    const gbpPerUsd = 1 / fix.usdPerGbp;
    const close = bar.close * gbpPerUsd;
    return {
      date: bar.date,
      open: bar.open * gbpPerUsd,
      high: bar.high * gbpPerUsd,
      low: bar.low * gbpPerUsd,
      close,
      volume: bar.volume,
      rawClose: close,
    };
  });
}

export function overlapStats(
  primary: readonly DailyBar[],
  sibling: readonly DailyBar[],
): OverlapStats {
  const siblingClose = new Map(sibling.map((bar) => [bar.date, bar.close]));
  const pairs: { a: number; b: number }[] = [];
  let previous: { date: string; a: number; b: number } | undefined;
  for (const bar of primary) {
    const other = siblingClose.get(bar.date);
    if (other === undefined) continue;
    const current = { date: bar.date, a: bar.close, b: other };
    if (previous !== undefined) {
      pairs.push({ a: current.a / previous.a - 1, b: current.b / previous.b - 1 });
    }
    previous = current;
  }
  const sessions = pairs.length;
  if (sessions === 0) {
    return {
      sessions: 0,
      meanAbsReturnDiffBps: Number.NaN,
      meanReturnDiffBps: Number.NaN,
      returnCorrelation: Number.NaN,
      cumulativeReturnDiffBps: Number.NaN,
    };
  }
  let sumAbs = 0;
  let sum = 0;
  let cumulativeA = 1;
  let cumulativeB = 1;
  for (const pair of pairs) {
    sumAbs += Math.abs(pair.a - pair.b);
    sum += pair.a - pair.b;
    cumulativeA *= 1 + pair.a;
    cumulativeB *= 1 + pair.b;
  }
  return {
    sessions,
    meanAbsReturnDiffBps: (sumAbs / sessions) * 10_000,
    meanReturnDiffBps: (sum / sessions) * 10_000,
    returnCorrelation: correlation(
      pairs.map((pair) => pair.a),
      pairs.map((pair) => pair.b),
    ),
    cumulativeReturnDiffBps: (cumulativeA - cumulativeB) * 10_000,
  };
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < n; index++) {
    const da = (a[index] as number) - meanA;
    const db = (b[index] as number) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  return varA === 0 || varB === 0 ? Number.NaN : cov / Math.sqrt(varA * varB);
}

export function spliceSibling(primary: BarSeries, siblingGbp: readonly DailyBar[]): SpliceResult {
  const first = primary.bars[0];
  if (first === undefined) throw new Error(`spliceSibling: ${primary.symbol} has no bars`);
  const overlap = overlapStats(primary.bars, siblingGbp);
  const older = siblingGbp.filter((bar) => bar.date < first.date);
  const series = { symbol: primary.symbol, bars: [...older, ...primary.bars] };
  assertSortedUniqueDates(series);
  return {
    bars: series.bars,
    spliceDate: first.date,
    siblingBarsUsed: older.length,
    overlap,
    withinTolerance:
      overlap.sessions >= SPLICE_MIN_OVERLAP_SESSIONS &&
      overlap.meanAbsReturnDiffBps <= SPLICE_MAX_MEAN_ABS_RETURN_DIFF_BPS,
  };
}
