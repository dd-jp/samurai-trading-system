import type {
  MarketData,
  SleeveDecision,
  SleeveOutput,
  SleeveSpec,
  SleeveUniverse,
  V2Bar,
} from '../../../../contracts/index.js';
import type { SleeveFactory } from '../backtest.js';
import {
  type BarsSource,
  calendarReferenceFor,
  sessionsBefore,
  windowCovered,
} from '../data/index.js';
import { baseRead } from './bar-quality.js';
import { liquidityCore, type PoolContext } from './universe.js';

export const MEAN_REVERSION_UNIVERSE_COUNT = 300;

export const MEAN_REVERSION_CANDIDATE_ID = 'mean-reversion';
export const MEAN_REVERSION_BENCHMARK_ID = 'mean-reversion-benchmark';

// Pinned: from/to feed the trial hash, so they must not drift if the store is re-primed. Alpaca SIP starts 2016-01-04, so every name skips on window_coverage until 2016-12-14, the first day with 240 prior SPY sessions (#1912)
export const MEAN_REVERSION_FROM = '2016-10-11';
export const MEAN_REVERSION_TO = '2025-09-24';

const SMA_WINDOW = 200;
const RSI_PERIOD = 2;
const RECOVERY_RSI = 65;
export const MEAN_REVERSION_ENTRY_THRESHOLDS: readonly number[] = [10, 15];
const ATR_WINDOW = 20;
const STOP_ATR_MULTIPLE = 5;
export const MEAN_REVERSION_TIME_STOP_TRADING_DAYS = 10;
// Large finite stand-in for "no limit" so SleeveSizing's fields stay plain numbers
const SENTINEL_LIMIT = 1_000_000;
const RISK_FRACTION = 0.005;
const ADV_SHARE_NON_BINDING = 1;
const ADV_WINDOW_BARS = 20;
const CAPITAL_SHARE = 0.7;
// Slack beyond the SMA and ATR windows lets the RSI(2) seed converge
const LOOKBACK_BARS = SMA_WINDOW + ATR_WINDOW + 20;

function meanReversionSpec(): SleeveSpec {
  return {
    capitalShare: CAPITAL_SHARE,
    minimumCapitalGbp: 0,
    capacityGbp: Number.POSITIVE_INFINITY,
    validation: 'backtest',
    macroGate: false,
    sizing: {
      riskFraction: RISK_FRACTION,
      stopAtrMultiple: STOP_ATR_MULTIPLE,
      targetAtrMultiple: SENTINEL_LIMIT,
      timeStopTradingDays: MEAN_REVERSION_TIME_STOP_TRADING_DAYS,
      advShare: ADV_SHARE_NON_BINDING,
      advWindowBars: ADV_WINDOW_BARS,
    },
    books: [{ variant: 'primary', instantiated: true }],
  };
}

function meanReversionBenchmarkSpec(): SleeveSpec {
  const spec = meanReversionSpec();
  return { ...spec, sizing: { ...spec.sizing, timeStopTradingDays: SENTINEL_LIMIT } };
}

// Seeded at the window's own start; at period 2 it converges well inside LOOKBACK_BARS
export function relativeStrengthIndex(bars: readonly V2Bar[], period: number): number | undefined {
  if (bars.length < period + 1) return undefined;
  let avgGain = 0;
  let avgLoss = 0;
  for (let index = 1; index <= period; index++) {
    const change = (bars[index] as V2Bar).close - (bars[index - 1] as V2Bar).close;
    avgGain += Math.max(change, 0);
    avgLoss += Math.max(-change, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let index = period + 1; index < bars.length; index++) {
    const change = (bars[index] as V2Bar).close - (bars[index - 1] as V2Bar).close;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

interface MeanReversionRead {
  readonly price: number;
  readonly close: number;
  readonly sma: number | undefined;
  readonly rsi: number | undefined;
  readonly atr: number | undefined;
}

function meanReversionRead(rawHistory: readonly V2Bar[]): MeanReversionRead | undefined {
  const read = baseRead(rawHistory, SMA_WINDOW, ATR_WINDOW);
  if (read === undefined) return undefined;
  const { valid, ...rest } = read;
  return { ...rest, rsi: relativeStrengthIndex(valid, RSI_PERIOD) };
}

interface WarmRead extends MeanReversionRead {
  readonly sma: number;
  readonly rsi: number;
  readonly atr: number;
}

type GatedRead =
  | { readonly warm: WarmRead }
  | { readonly skip: string; readonly read: MeanReversionRead | undefined };

// Freshness rides on windowCovered: sessionsBefore is empty on a stale calendar, and coverage
// needs a bar on the calendar's last session (postmortem section 2, #1912)
function gatedRead(raw: readonly V2Bar[], sessions: readonly string[]): GatedRead {
  const read = meanReversionRead(raw);
  if (read === undefined) return { skip: 'bad_last_bar', read };
  if (!windowCovered(raw, sessions, LOOKBACK_BARS)) return { skip: 'window_coverage', read };
  const { sma, rsi, atr } = read;
  if (sma === undefined || rsi === undefined || atr === undefined) {
    return { skip: 'insufficient_history', read };
  }
  return { warm: { ...read, sma, rsi, atr } };
}

function gatedReads(
  bars: BarsSource,
  market: MarketData,
  instruments: readonly string[],
  tradingDate: string,
): ReadonlyArray<readonly [string, GatedRead]> {
  const sessions = sessionsBefore(bars, tradingDate, calendarReferenceFor('alpaca'));
  return instruments.map((instrument) => [
    instrument,
    gatedRead(market.barsBefore(instrument, tradingDate, LOOKBACK_BARS), sessions),
  ]);
}

function baseDecision(
  sleeveId: string,
  instrument: string,
  read: MeanReversionRead | undefined,
  reason: string,
): SleeveDecision {
  return {
    sleeve_id: sleeveId,
    instrument,
    venue: 'alpaca',
    direction: 'neutral',
    confidence: 0,
    action: 'skip',
    reason,
    price: read?.price ?? 0,
    atr: read?.atr,
    stop_price: undefined,
    inputs_hash: '',
    debate_id: undefined,
    payload: { rsi2: read?.rsi, sma200: read?.sma },
  };
}

function enterDecision(
  sleeveId: string,
  instrument: string,
  read: WarmRead,
  date: string,
): SleeveDecision {
  const stopPrice = read.price - STOP_ATR_MULTIPLE * read.atr;
  if (stopPrice <= 0) return baseDecision(sleeveId, instrument, read, 'non_positive_stop');
  return {
    sleeve_id: sleeveId,
    instrument,
    venue: 'alpaca',
    direction: 'bullish',
    confidence: 1,
    action: 'enter_long',
    reason: 'close above SMA200, RSI(2) dip',
    price: read.price,
    atr: read.atr,
    stop_price: stopPrice,
    inputs_hash: `${instrument}-${date}`,
    debate_id: undefined,
    payload: { rsi2: read.rsi, sma200: read.sma },
  };
}

function exitDecision(
  sleeveId: string,
  instrument: string,
  read: WarmRead,
  date: string,
): SleeveDecision {
  return {
    sleeve_id: sleeveId,
    instrument,
    venue: 'alpaca',
    direction: 'neutral',
    confidence: 1,
    action: 'exit',
    reason: 'RSI(2) recovered above 65',
    price: read.price,
    atr: read.atr,
    stop_price: undefined,
    inputs_hash: `${instrument}-${date}`,
    debate_id: undefined,
    payload: { rsi2: read.rsi, sma200: read.sma },
  };
}

interface RankedDecision {
  readonly decision: SleeveDecision;
  readonly sortKey: number;
}

function meanReversionDecisionFor(
  sleeveId: string,
  instrument: string,
  gated: GatedRead,
  date: string,
  entryThreshold: number,
): RankedDecision {
  if ('skip' in gated) {
    return {
      decision: baseDecision(sleeveId, instrument, gated.read, gated.skip),
      sortKey: Infinity,
    };
  }
  const read = gated.warm;
  if (read.close > read.sma && read.rsi < entryThreshold) {
    return { decision: enterDecision(sleeveId, instrument, read, date), sortKey: read.rsi };
  }
  if (read.rsi > RECOVERY_RSI) {
    return { decision: exitDecision(sleeveId, instrument, read, date), sortKey: read.rsi };
  }
  return { decision: baseDecision(sleeveId, instrument, read, 'no_signal'), sortKey: read.rsi };
}

function meanReversionUniverse(
  bars: BarsSource,
  market: Pick<MarketData, 'gbpUsdAtYearStart'>,
  constituentsFor: (tradingDate: string) => readonly string[],
  tradingDate: string,
): SleeveUniverse {
  const pool: PoolContext = { bars, tradingDate, venueFor: () => 'alpaca', market };
  const instruments = liquidityCore(
    constituentsFor(tradingDate),
    pool,
    MEAN_REVERSION_UNIVERSE_COUNT,
  );
  return { instruments, refusals: [] };
}

export function meanReversionSleeveId(entryThreshold: number): string {
  return `mean-reversion-rsi${entryThreshold}`;
}

// A held instrument that leaves the top-300 gets no decision, so only its stop or the time stop closes it
export function createMeanReversionSleeve(
  bars: BarsSource,
  constituentsFor: (tradingDate: string) => readonly string[],
  entryThreshold: number,
): SleeveFactory {
  const sleeveId = meanReversionSleeveId(entryThreshold);
  return (market) => ({
    id: sleeveId,
    spec: meanReversionSpec(),
    universe: (context) =>
      meanReversionUniverse(bars, market, constituentsFor, context.tradingDate),
    decide(context, instruments): Promise<SleeveOutput> {
      const ranked = gatedReads(bars, market, instruments, context.tradingDate).map(
        ([instrument, gated]) =>
          meanReversionDecisionFor(
            sleeveId,
            instrument,
            gated,
            context.tradingDate,
            entryThreshold,
          ),
      );
      // Stable: every gated skip shares sortKey Infinity and keeps liquidityCore's ADV order
      ranked.sort((a, b) => a.sortKey - b.sortKey);
      return Promise.resolve({ decisions: ranked.map((entry) => entry.decision), refusals: [] });
    },
  });
}

function benchmarkDecisionFor(
  sleeveId: string,
  instrument: string,
  gated: GatedRead,
  date: string,
): SleeveDecision {
  if ('skip' in gated) return baseDecision(sleeveId, instrument, gated.read, gated.skip);
  return enterDecision(sleeveId, instrument, gated.warm, date);
}

export function createMeanReversionBenchmarkSleeve(
  bars: BarsSource,
  constituentsFor: (tradingDate: string) => readonly string[],
): SleeveFactory {
  return (market) => ({
    id: MEAN_REVERSION_BENCHMARK_ID,
    spec: meanReversionBenchmarkSpec(),
    universe: (context) =>
      meanReversionUniverse(bars, market, constituentsFor, context.tradingDate),
    decide(context, instruments): Promise<SleeveOutput> {
      const decisions = gatedReads(bars, market, instruments, context.tradingDate).map(
        ([instrument, gated]) =>
          benchmarkDecisionFor(MEAN_REVERSION_BENCHMARK_ID, instrument, gated, context.tradingDate),
      );
      return Promise.resolve({ decisions, refusals: [] });
    },
  });
}
