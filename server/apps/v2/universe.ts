import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import { assertSortedUniqueDates } from '../../pipeline/momentum/index.js';
import { addDays } from './macro-calendar.js';
import {
  G4_MOVERS_SELECTION_RULE,
  G18_SMALL_CAP_FLOORS,
  isSet,
  type MoverCandidate,
  requireSet,
  UnsetParameterError,
} from './parameters.js';

const LIQUIDITY_CORE_COUNT = 10;
const MOVERS_COUNT = 10;
const DOLLAR_VOLUME_WINDOW_DAYS = 20;

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

const MAX_BAR_AGE_CALENDAR_DAYS = 5;

export function barsBefore(series: BarSeries, tradingDate: string): readonly DailyBar[] {
  return series.bars.filter((bar) => bar.date < tradingDate);
}

function isFresh(last: DailyBar | undefined, tradingDate: string): last is DailyBar {
  return last !== undefined && addDays(last.date, MAX_BAR_AGE_CALENDAR_DAYS) >= tradingDate;
}

export function averageDollarVolume(bars: readonly DailyBar[], window: number): number | undefined {
  if (bars.length < window) return undefined;
  const tail = bars.slice(-window);
  let total = 0;
  for (const bar of tail) total += bar.rawClose * bar.volume;
  return total / window;
}

export interface UniverseSelection {
  readonly liquidity: readonly string[];
  readonly movers: readonly string[];
  readonly refusals: readonly UnsetParameterError[];
}

export function liquidityCore(
  symbols: readonly string[],
  bars: BarsSource,
  tradingDate: string,
  count: number = LIQUIDITY_CORE_COUNT,
): readonly string[] {
  const scored: Array<[string, number]> = [];
  for (const symbol of symbols) {
    const series = bars.load(symbol);
    if (series === undefined) continue;
    const history = barsBefore(series, tradingDate);
    if (!isFresh(history.at(-1), tradingDate)) continue;
    const adv = averageDollarVolume(history, DOLLAR_VOLUME_WINDOW_DAYS);
    if (adv !== undefined) scored.push([symbol, adv]);
  }
  return scored
    .sort(([a, advA], [b, advB]) => advB - advA || a.localeCompare(b))
    .slice(0, count)
    .map(([symbol]) => symbol);
}

function moverCandidates(
  symbols: readonly string[],
  bars: BarsSource,
  tradingDate: string,
): MoverCandidate[] {
  const candidates: MoverCandidate[] = [];
  for (const symbol of symbols) {
    const history = bars.load(symbol);
    const window = history === undefined ? [] : barsBefore(history, tradingDate).slice(-2);
    const [previous, last] = window;
    if (previous === undefined || !isFresh(last, tradingDate)) continue;
    candidates.push({
      symbol,
      dayReturn: last.close / previous.close - 1,
      dollarVolume: last.rawClose * last.volume,
    });
  }
  return candidates;
}

export function selectUniverse(
  constituents: readonly string[],
  bars: BarsSource,
  tradingDate: string,
): UniverseSelection {
  const refusals: UnsetParameterError[] = [];
  if (!isSet(G18_SMALL_CAP_FLOORS)) {
    refusals.push(new UnsetParameterError(G18_SMALL_CAP_FLOORS.name, G18_SMALL_CAP_FLOORS.ticket));
  }
  const liquidity = liquidityCore(constituents, bars, tradingDate);
  let movers: readonly string[] = [];
  try {
    const rule = requireSet(G4_MOVERS_SELECTION_RULE);
    const remaining = constituents.filter((symbol) => !liquidity.includes(symbol));
    movers = rule(moverCandidates(remaining, bars, tradingDate), MOVERS_COUNT);
  } catch (error) {
    if (!(error instanceof UnsetParameterError)) throw error;
    refusals.push(error);
  }
  return { liquidity, movers, refusals };
}
