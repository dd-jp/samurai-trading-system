import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { assertSortedUniqueDates } from '../../../pipeline/momentum/index.js';

const BAR_HEADER = 'date,open,high,low,close,volume,raw_close';

export function parseBarsCsv(symbol: string, text: string): BarSeries {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const header = lines.shift();
  if (header?.trim() !== BAR_HEADER) {
    throw new Error(`bars ${symbol}: unexpected header ${JSON.stringify(header)}`);
  }
  const bars: DailyBar[] = lines.map((line) => {
    const [date, open, high, low, close, volume, rawClose] = line.split(',').map((v) => v.trim());
    const bar = {
      date: date ?? '',
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      rawClose: Number(rawClose),
    };
    if (!(bar.close > 0) || !(bar.rawClose > 0) || !Number.isFinite(bar.volume)) {
      throw new Error(`bars ${symbol}: bad row ${line}`);
    }
    return bar;
  });
  const series = { symbol, bars };
  assertSortedUniqueDates(series);
  return series;
}

export interface BarsSource {
  load(symbol: string): BarSeries | undefined;
}

export class CsvBarsSource implements BarsSource {
  readonly #cache = new Map<string, BarSeries | undefined>();

  constructor(private readonly directory: string) {}

  load(symbol: string): BarSeries | undefined {
    if (this.#cache.has(symbol)) return this.#cache.get(symbol);
    const path = join(this.directory, `${symbol}.csv`);
    const series = existsSync(path) ? parseBarsCsv(symbol, readFileSync(path, 'utf8')) : undefined;
    this.#cache.set(symbol, series);
    return series;
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
