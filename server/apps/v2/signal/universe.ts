import type { MarketData, Venue } from '../../../../contracts/index.js';
import type { DailyBar } from '../../../shared/index.js';
import {
  type BarsSource,
  barsBefore,
  calendarReferenceFor,
  isFresh,
  quotePerGbp,
  sessionsBefore,
  windowCovered,
} from '../data/index.js';
import {
  G18_SMALL_CAP_FLOORS,
  isSet,
  LSE_RESERVED_SLOTS,
  MOVERS_MIN_DOLLAR_VOLUME_USD,
  UnsetParameterError,
} from './parameters.js';

const LIQUIDITY_CORE_COUNT = 10;
const MOVERS_COUNT = 10;
const DOLLAR_VOLUME_WINDOW_DAYS = 20;
export const UNIVERSE_CAP = LIQUIDITY_CORE_COUNT + MOVERS_COUNT;

export interface PoolContext {
  readonly bars: BarsSource;
  readonly tradingDate: string;
  readonly venueFor: (symbol: string) => Venue;
  readonly market: Pick<MarketData, 'gbpUsdAtYearStart'>;
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

export function coveredHistory(
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

interface PoolReader {
  covered(symbol: string, windowBars: number): readonly DailyBar[];
  usdPerNative(symbol: string): number;
}

// Ranking and the movers floor compare in USD through the cycle's own quotePerGbp, so a
// US name converts by exactly 1 and its selection is independent of the GBPUSD rate
function readerFor(pool: PoolContext): PoolReader {
  const sessionsByVenue = new Map<Venue, readonly string[]>();
  const usdPerNativeByVenue = new Map<Venue, number>();
  const gbpUsd = () => pool.market.gbpUsdAtYearStart(Number(pool.tradingDate.slice(0, 4)));
  return {
    covered(symbol, windowBars) {
      const venue = pool.venueFor(symbol);
      let sessions = sessionsByVenue.get(venue);
      if (sessions === undefined) {
        sessions = sessionsBefore(pool.bars, pool.tradingDate, calendarReferenceFor(venue));
        sessionsByVenue.set(venue, sessions);
      }
      return coveredHistory(pool.bars, symbol, pool.tradingDate, sessions, windowBars);
    },
    usdPerNative(symbol) {
      const venue = pool.venueFor(symbol);
      let rate = usdPerNativeByVenue.get(venue);
      if (rate === undefined) {
        rate = gbpUsd() / quotePerGbp(pool.market, venue, pool.tradingDate);
        usdPerNativeByVenue.set(venue, rate);
      }
      return rate;
    },
  };
}

export function liquidityCore(
  symbols: readonly string[],
  pool: PoolContext,
  count: number = LIQUIDITY_CORE_COUNT,
): readonly string[] {
  const reader = readerFor(pool);
  const scored: Array<[string, number]> = [];
  for (const symbol of symbols) {
    const adv = averageDollarVolume(
      reader.covered(symbol, DOLLAR_VOLUME_WINDOW_DAYS),
      DOLLAR_VOLUME_WINDOW_DAYS,
    );
    if (adv !== undefined) scored.push([symbol, adv * reader.usdPerNative(symbol)]);
  }
  return scored
    .sort(([a, advA], [b, advB]) => advB - advA || a.localeCompare(b))
    .slice(0, count)
    .map(([symbol]) => symbol);
}

export interface MoverCandidate {
  readonly symbol: string;
  readonly dayReturn: number;
  readonly dollarVolumeUsd: number;
}

export function selectMovers(
  candidates: readonly MoverCandidate[],
  count: number = MOVERS_COUNT,
): readonly string[] {
  return candidates
    .filter((candidate) => candidate.dollarVolumeUsd >= MOVERS_MIN_DOLLAR_VOLUME_USD)
    .sort(
      (a, b) => Math.abs(b.dayReturn) - Math.abs(a.dayReturn) || a.symbol.localeCompare(b.symbol),
    )
    .slice(0, count)
    .map((candidate) => candidate.symbol);
}

function moverCandidates(symbols: readonly string[], pool: PoolContext): MoverCandidate[] {
  const reader = readerFor(pool);
  const candidates: MoverCandidate[] = [];
  for (const symbol of symbols) {
    const [previous, last] = reader.covered(symbol, 2).slice(-2);
    if (previous === undefined || last === undefined) continue;
    candidates.push({
      symbol,
      dayReturn: last.close / previous.close - 1,
      dollarVolumeUsd: last.rawClose * last.volume * reader.usdPerNative(symbol),
    });
  }
  return candidates;
}

export function selectUniverse(
  pooled: readonly string[],
  pool: PoolContext,
  reservedLseSlots: number = LSE_RESERVED_SLOTS,
): UniverseSelection {
  const refusals: UnsetParameterError[] = [];
  if (!isSet(G18_SMALL_CAP_FLOORS)) {
    refusals.push(new UnsetParameterError(G18_SMALL_CAP_FLOORS.name, G18_SMALL_CAP_FLOORS.ticket));
  }
  const reserved = liquidityCore(
    pooled.filter((symbol) => pool.venueFor(symbol) === 'saxo'),
    pool,
    Math.min(reservedLseSlots, LIQUIDITY_CORE_COUNT),
  );
  const shared = liquidityCore(
    pooled.filter((symbol) => !reserved.includes(symbol)),
    pool,
    LIQUIDITY_CORE_COUNT - reserved.length,
  );
  const liquidity = [...reserved, ...shared];
  const remaining = pooled.filter((symbol) => !liquidity.includes(symbol));
  const movers = selectMovers(moverCandidates(remaining, pool));
  return { liquidity, movers, refusals };
}
