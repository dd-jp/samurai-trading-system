import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { coverageSatisfied, windowCoverage } from '../../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../../providers/bar-store/index.js';
import { addDays } from './macro-calendar.js';

export interface BarsSource {
  load(symbol: string): BarSeries | undefined;
}

export class ParquetBarsSource implements BarsSource {
  #series: ReadonlyMap<string, BarSeries> | undefined;

  constructor(
    private readonly root: string,
    private readonly venue: string,
  ) {}

  async prime(): Promise<void> {
    if (this.#series !== undefined) return;
    const store = await ParquetBarStore.open(this.root);
    try {
      const series = await store.readVenue(this.venue);
      if (series.size === 0) throw new Error(`bars: no ${this.venue} series under ${this.root}`);
      this.#series = series;
    } finally {
      store.close();
    }
  }

  load(symbol: string): BarSeries | undefined {
    if (this.#series === undefined) {
      throw new Error(`bars: ${this.venue} read before prime()`);
    }
    return this.#series.get(symbol);
  }
}

export function currentConstituents(csvText: string, tradingDate: string): readonly string[] {
  const lines = csvText.split('\n').filter((line) => line.trim().length > 0);
  if (lines.shift()?.trim() !== 'date,tickers') throw new Error('constituents: unexpected header');
  let chosen: string | undefined;
  for (const line of lines) {
    const comma = line.indexOf(',');
    const date = line.slice(0, comma);
    if (date <= tradingDate) chosen = line.slice(comma + 1).replaceAll('"', '');
  }
  if (chosen === undefined) throw new Error(`constituents: no row on or before ${tradingDate}`);
  return chosen
    .split(',')
    .map((ticker) => ticker.trim())
    .filter((ticker) => ticker.length > 0);
}

export function barsBefore(series: BarSeries, tradingDate: string): readonly DailyBar[] {
  return series.bars.filter((bar) => bar.date < tradingDate);
}

const MAX_BAR_AGE_CALENDAR_DAYS = 5;

export function isFresh(last: DailyBar | undefined, tradingDate: string): last is DailyBar {
  return last !== undefined && addDays(last.date, MAX_BAR_AGE_CALENDAR_DAYS) >= tradingDate;
}

export const CALENDAR_REFERENCE = 'SPY';

export function sessionsBefore(bars: BarsSource, tradingDate: string): readonly string[] {
  const reference = bars.load(CALENDAR_REFERENCE);
  const history = reference === undefined ? [] : barsBefore(reference, tradingDate);
  return isFresh(history.at(-1), tradingDate) ? history.map((bar) => bar.date) : [];
}

export function windowCovered(
  history: readonly DailyBar[],
  sessions: readonly string[],
  windowBars: number,
): boolean {
  if (sessions.length === 0 || history.length < windowBars) return false;
  const barDates = new Set(history.map((bar) => bar.date));
  const coverage = windowCoverage(sessions, barDates, sessions.length - 1, windowBars - 1);
  return coverageSatisfied(coverage);
}
