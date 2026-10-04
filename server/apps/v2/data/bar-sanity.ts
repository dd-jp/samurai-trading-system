import { SUSPECT_MIN_RATIO } from '../../../providers/bar-store/index.js';
import type { DailyBar } from '../../../shared/index.js';
import { coverageSatisfied, windowCoverage } from '../../../shared/index.js';
import type { BarsSource } from './bars.js';

export const ADJUSTED_JUMP_MIN_RATIO = SUSPECT_MIN_RATIO;

export type SanityFlag = 'coverage' | 'gap' | 'zero_volume' | 'adjusted_jump';

export interface AdjustedJump {
  readonly date: string;
  readonly ratio: number;
}

export interface SeriesSanity {
  readonly symbol: string;
  readonly flags: readonly SanityFlag[];
  readonly coverageRatio: number;
  readonly missingSessions: readonly string[];
  readonly zeroVolumeDays: readonly string[];
  readonly adjustedJumps: readonly AdjustedJump[];
}

export interface DataSanityReport {
  readonly from: string;
  readonly to: string;
  readonly seriesChecked: number;
  readonly flagged: readonly SeriesSanity[];
}

function assertWindow(sessions: readonly string[]): void {
  if (sessions.length < 2) throw new Error('data sanity: the window needs at least two sessions');
}

function spanCoverage(sessions: readonly string[], bars: readonly DailyBar[]) {
  const last = sessions.length - 1;
  const firstDate = bars[0]?.date ?? sessions[last];
  const start = Math.min(
    sessions.findIndex((session) => session >= (firstDate as string)),
    last - 1,
  );
  const barDates = new Set(bars.map((bar) => bar.date));
  return windowCoverage(sessions, barDates, last, last - start);
}

function interiorGaps(sessions: readonly string[], bars: readonly DailyBar[]): string[] {
  const first = bars[0]?.date;
  const last = bars.at(-1)?.date;
  if (first === undefined || last === undefined) return [];
  const barDates = new Set(bars.map((bar) => bar.date));
  return sessions.filter((date) => date > first && date < last && !barDates.has(date));
}

function adjustedJumps(bars: readonly DailyBar[]): AdjustedJump[] {
  return bars.slice(1).flatMap((bar, index) => {
    const previous = (bars[index] as DailyBar).close;
    const ratio = Math.max(bar.close / previous, previous / bar.close);
    return ratio > ADJUSTED_JUMP_MIN_RATIO ? [{ date: bar.date, ratio }] : [];
  });
}

function flagsOf(
  covered: boolean,
  checks: Pick<SeriesSanity, 'missingSessions' | 'zeroVolumeDays' | 'adjustedJumps'>,
): SanityFlag[] {
  const raised: [SanityFlag, boolean][] = [
    ['coverage', !covered],
    ['gap', checks.missingSessions.length > 0],
    ['zero_volume', checks.zeroVolumeDays.length > 0],
    ['adjusted_jump', checks.adjustedJumps.length > 0],
  ];
  return raised.filter(([, on]) => on).map(([flag]) => flag);
}

export function seriesSanity(
  symbol: string,
  history: readonly DailyBar[],
  sessions: readonly string[],
): SeriesSanity {
  assertWindow(sessions);
  const first = sessions[0] as string;
  const last = sessions.at(-1) as string;
  const bars = history.filter((bar) => bar.date >= first && bar.date <= last);
  const coverage = spanCoverage(sessions, bars);
  const checks = {
    missingSessions: interiorGaps(sessions, bars),
    zeroVolumeDays: bars.filter((bar) => bar.volume === 0).map((bar) => bar.date),
    adjustedJumps: adjustedJumps(bars),
  };
  return {
    symbol,
    flags: flagsOf(coverageSatisfied(coverage), checks),
    coverageRatio: coverage.ratio,
    ...checks,
  };
}

export function dataSanity(
  bars: BarsSource,
  symbols: readonly string[],
  sessions: readonly string[],
): DataSanityReport {
  assertWindow(sessions);
  const unique = [...new Set(symbols)].sort();
  const flagged = unique
    .map((symbol) => seriesSanity(symbol, bars.load(symbol)?.bars ?? [], sessions))
    .filter((sanity) => sanity.flags.length > 0);
  return {
    from: sessions[0] as string,
    to: sessions.at(-1) as string,
    seriesChecked: unique.length,
    flagged,
  };
}
