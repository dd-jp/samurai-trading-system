import type { DailyBar } from '../../../pipeline/momentum/index.js';
import {
  addDays,
  type BarsSource,
  barsBefore,
  sessionsBefore,
  windowCovered,
} from '../data/index.js';
import {
  G18_SMALL_CAP_FLOORS,
  isSet,
  MOVERS_MIN_DOLLAR_VOLUME_USD,
  UnsetParameterError,
} from './parameters.js';

const LIQUIDITY_CORE_COUNT = 10;
const MOVERS_COUNT = 10;
const DOLLAR_VOLUME_WINDOW_DAYS = 20;

const MAX_BAR_AGE_CALENDAR_DAYS = 5;

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

function coveredHistory(
  bars: BarsSource,
  symbol: string,
  tradingDate: string,
  sessions: readonly string[],
  windowBars: number,
): readonly DailyBar[] {
  const series = bars.load(symbol);
  const history = series === undefined ? [] : barsBefore(series, tradingDate);
  const covered =
    isFresh(history.at(-1), tradingDate) && windowCovered(history, sessions, windowBars);
  return covered ? history : [];
}

export function liquidityCore(
  symbols: readonly string[],
  bars: BarsSource,
  tradingDate: string,
  count: number = LIQUIDITY_CORE_COUNT,
): readonly string[] {
  const scored: Array<[string, number]> = [];
  const sessions = sessionsBefore(bars, tradingDate);
  for (const symbol of symbols) {
    const history = coveredHistory(bars, symbol, tradingDate, sessions, DOLLAR_VOLUME_WINDOW_DAYS);
    const adv = averageDollarVolume(history, DOLLAR_VOLUME_WINDOW_DAYS);
    if (adv !== undefined) scored.push([symbol, adv]);
  }
  return scored
    .sort(([a, advA], [b, advB]) => advB - advA || a.localeCompare(b))
    .slice(0, count)
    .map(([symbol]) => symbol);
}

export interface MoverCandidate {
  readonly symbol: string;
  readonly dayReturn: number;
  readonly dollarVolume: number;
}

export function selectMovers(
  candidates: readonly MoverCandidate[],
  count: number = MOVERS_COUNT,
): readonly string[] {
  return candidates
    .filter((candidate) => candidate.dollarVolume >= MOVERS_MIN_DOLLAR_VOLUME_USD)
    .sort(
      (a, b) => Math.abs(b.dayReturn) - Math.abs(a.dayReturn) || a.symbol.localeCompare(b.symbol),
    )
    .slice(0, count)
    .map((candidate) => candidate.symbol);
}

function moverCandidates(
  symbols: readonly string[],
  bars: BarsSource,
  tradingDate: string,
): MoverCandidate[] {
  const candidates: MoverCandidate[] = [];
  const sessions = sessionsBefore(bars, tradingDate);
  for (const symbol of symbols) {
    const [previous, last] = coveredHistory(bars, symbol, tradingDate, sessions, 2).slice(-2);
    if (previous === undefined || last === undefined) continue;
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
  const remaining = constituents.filter((symbol) => !liquidity.includes(symbol));
  const movers = selectMovers(moverCandidates(remaining, bars, tradingDate));
  return { liquidity, movers, refusals };
}
