import type { Venue } from '../../../../contracts/index.js';
import { ParquetBarStore } from '../../../providers/bar-store/index.js';
import type { BarSeries, DailyBar } from '../../../shared/index.js';
import { coverageSatisfied, windowCoverage } from '../../../shared/index.js';
import { addDays } from './macro-calendar.js';
import { quoteCurrencyOf } from './venues.js';

export interface BarsSource {
  load(symbol: string): BarSeries | undefined;
  noteWindow?(symbol: string, bars: number): void;
}

export interface ParquetBarsSourceOptions {
  // an optional venue primes to an empty series set rather than throwing when
  // its store directory is missing or empty (e.g. saxo in a fixture that only
  // seeds alpaca)
  readonly optional?: boolean;
}

export class ParquetBarsSource implements BarsSource {
  #series: ReadonlyMap<string, BarSeries> | undefined;

  constructor(
    private readonly root: string,
    private readonly venue: string,
    private readonly options: ParquetBarsSourceOptions = {},
  ) {}

  async prime(): Promise<void> {
    if (this.#series !== undefined) return;
    const store = await ParquetBarStore.open(this.root);
    try {
      const series = await store.readVenue(this.venue);
      if (series.size === 0 && this.options.optional !== true) {
        throw new Error(
          `bars: no ${this.venue} series under ${this.root} (npm run bars:snapshot restores the last committed store)`,
        );
      }
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

// A symbol held by more than one venue (TSCO is Tesco on the LSE and Tractor
// Supply in the US) has no venue-free identity, so it is served from neither
export class MultiVenueBarsSource implements BarsSource {
  readonly #reported = new Set<string>();

  constructor(
    private readonly sources: readonly BarsSource[],
    private readonly onClash: (symbol: string) => void = () => {},
  ) {}

  load(symbol: string): BarSeries | undefined {
    const held = this.sources
      .map((source) => source.load(symbol))
      .filter((series) => series !== undefined);
    if (held.length > 1 && !this.#reported.has(symbol)) {
      this.#reported.add(symbol);
      this.onClash(symbol);
    }
    return held.length === 1 ? held[0] : undefined;
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

export const MAX_BAR_AGE_CALENDAR_DAYS = 5;

export function isFresh(last: DailyBar | undefined, tradingDate: string): last is DailyBar {
  return last !== undefined && addDays(last.date, MAX_BAR_AGE_CALENDAR_DAYS) >= tradingDate;
}

export const CALENDAR_REFERENCE = 'SPY';
export const LSE_CALENDAR_REFERENCE = 'ISF';

// LSE and US trading calendars diverge on each venue's own bank holidays (UK early
// May/spring/summer bank holidays, Boxing Day; US Presidents' Day, Juneteenth, etc)
// windowCovered's 95% ratio makes an SPY-keyed calendar fail almost every LSE name
// over a 200-session window, so each venue reads sessions off its own reference line
export function calendarReferenceFor(venue: Venue): string {
  return quoteCurrencyOf(venue) === 'GBP' ? LSE_CALENDAR_REFERENCE : CALENDAR_REFERENCE;
}

export function sessionsBefore(
  bars: BarsSource,
  tradingDate: string,
  referenceSymbol: string = CALENDAR_REFERENCE,
): readonly string[] {
  const reference = bars.load(referenceSymbol);
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
