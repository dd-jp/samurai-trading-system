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

interface SeriesSpan {
  readonly first: string;
  readonly last: string;
}

function seriesSpan(
  sessions: readonly string[],
  history: readonly DailyBar[],
  bars: readonly DailyBar[],
): SeriesSpan | undefined {
  const firstBar = bars[0];
  const lastBar = bars.at(-1);
  if (firstBar === undefined || lastBar === undefined) return undefined;
  const windowFirst = sessions[0] as string;
  const windowLast = sessions.at(-1) as string;
  return {
    first: (history[0] as DailyBar).date < windowFirst ? windowFirst : firstBar.date,
    last: (history.at(-1) as DailyBar).date > windowLast ? windowLast : lastBar.date,
  };
}

function spanCoverage(
  sessions: readonly string[],
  barDates: ReadonlySet<string>,
  span: SeriesSpan | undefined,
) {
  const last = sessions.length - 1;
  const firstDate = span?.first ?? (sessions[last] as string);
  const start = Math.min(
    sessions.findIndex((session) => session >= firstDate),
    last - 1,
  );
  return windowCoverage(sessions, barDates, last, last - start);
}

function interiorGaps(
  sessions: readonly string[],
  barDates: ReadonlySet<string>,
  span: SeriesSpan | undefined,
): string[] {
  if (span === undefined) return [];
  return sessions.filter((date) => date >= span.first && date <= span.last && !barDates.has(date));
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
  const barDates = new Set(bars.map((bar) => bar.date));
  const span = seriesSpan(sessions, history, bars);
  const coverage = spanCoverage(sessions, barDates, span);
  const checks = {
    missingSessions: interiorGaps(sessions, barDates, span),
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

function lastTradeableIndex(
  sessions: readonly string[],
  symbolsOn: (session: string) => readonly string[],
): Map<string, number> {
  const until = new Map<string, number>();
  sessions.forEach((session, index) => {
    for (const symbol of symbolsOn(session)) until.set(symbol, index);
  });
  return until;
}

export function dataSanity(
  bars: BarsSource,
  symbolsOn: (session: string) => readonly string[],
  sessions: readonly string[],
): DataSanityReport {
  assertWindow(sessions);
  const until = lastTradeableIndex(sessions, symbolsOn);
  const flagged = [...until.keys()]
    .sort()
    .map((symbol) =>
      seriesSanity(
        symbol,
        bars.load(symbol)?.bars ?? [],
        sessions.slice(0, Math.max((until.get(symbol) as number) + 1, 2)),
      ),
    )
    .filter((sanity) => sanity.flags.length > 0);
  return {
    from: sessions[0] as string,
    to: sessions.at(-1) as string,
    seriesChecked: until.size,
    flagged,
  };
}
