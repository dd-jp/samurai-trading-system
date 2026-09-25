import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { coverageSatisfied, windowCoverage } from '../../../pipeline/momentum/index.js';

export const MAX_CARRY_FORWARD_DAYS = 5;

export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function monthEndIndices(calendar: readonly string[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < calendar.length - 1; index++) {
    if (monthOf(calendar[index] as string) !== monthOf(calendar[index + 1] as string)) {
      indices.push(index);
    }
  }
  return indices;
}

interface AlignedSeries {
  readonly series: BarSeries;
  readonly indexByCalendar: readonly (number | undefined)[];
  readonly dates: ReadonlySet<string>;
  readonly lastCalendarIndex: number;
}

export class AlignedMarket {
  readonly calendar: readonly string[];
  private readonly aligned = new Map<string, AlignedSeries>();

  constructor(reference: BarSeries, series: ReadonlyMap<string, BarSeries>) {
    if (reference.bars.length === 0) throw new Error('AlignedMarket: empty reference series');
    this.calendar = reference.bars.map((bar) => bar.date);
    const position = new Map(this.calendar.map((date, index) => [date, index]));
    for (const [symbol, one] of series) this.aligned.set(symbol, this.align(one, position));
  }

  symbols(): readonly string[] {
    return [...this.aligned.keys()].sort();
  }

  has(symbol: string): boolean {
    return this.aligned.has(symbol);
  }

  barAt(symbol: string, calendarIndex: number): DailyBar | undefined {
    const aligned = this.require(symbol);
    const barIndex = aligned.indexByCalendar[calendarIndex];
    return barIndex === undefined ? undefined : aligned.series.bars[barIndex];
  }

  bars(symbol: string): readonly DailyBar[] {
    return this.require(symbol).series.bars;
  }

  barIndexAt(symbol: string, calendarIndex: number): number | undefined {
    return this.require(symbol).indexByCalendar[calendarIndex];
  }

  closeAtOrBefore(symbol: string, calendarIndex: number): number | undefined {
    const bar = this.barAtOrBefore(symbol, calendarIndex);
    return bar?.close;
  }

  lastBarAtOrBefore(symbol: string, calendarIndex: number): DailyBar | undefined {
    return this.scanBack(symbol, calendarIndex, 0);
  }

  barAtOrBefore(symbol: string, calendarIndex: number): DailyBar | undefined {
    return this.scanBack(symbol, calendarIndex, calendarIndex - MAX_CARRY_FORWARD_DAYS);
  }

  private scanBack(symbol: string, calendarIndex: number, oldest: number): DailyBar | undefined {
    const aligned = this.require(symbol);
    const floor = Math.max(0, oldest);
    for (let index = calendarIndex; index >= floor; index--) {
      const barIndex = aligned.indexByCalendar[index];
      if (barIndex !== undefined) return aligned.series.bars[barIndex];
    }
    return undefined;
  }

  seriesEndedBefore(symbol: string, calendarIndex: number): boolean {
    return this.require(symbol).lastCalendarIndex < calendarIndex;
  }

  coverageOk(symbol: string, decisionIndex: number, lookbackDays: number): boolean {
    const aligned = this.aligned.get(symbol);
    if (aligned === undefined) return false;
    return coverageSatisfied(
      windowCoverage(this.calendar, aligned.dates, decisionIndex, lookbackDays),
    );
  }

  private require(symbol: string): AlignedSeries {
    const aligned = this.aligned.get(symbol);
    if (aligned === undefined) throw new Error(`AlignedMarket: unknown symbol ${symbol}`);
    return aligned;
  }

  private align(series: BarSeries, position: ReadonlyMap<string, number>): AlignedSeries {
    const indexByCalendar: (number | undefined)[] = Array.from(
      { length: this.calendar.length },
      () => undefined,
    );
    let lastCalendarIndex = -1;
    series.bars.forEach((bar, barIndex) => {
      const calendarIndex = position.get(bar.date);
      if (calendarIndex === undefined) return;
      indexByCalendar[calendarIndex] = barIndex;
      lastCalendarIndex = Math.max(lastCalendarIndex, calendarIndex);
    });
    return {
      series,
      indexByCalendar,
      dates: new Set(series.bars.map((bar) => bar.date)),
      lastCalendarIndex,
    };
  }
}
