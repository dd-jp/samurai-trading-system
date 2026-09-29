import type {
  MarketData,
  SleeveDecision,
  SleeveOutput,
  SleeveSpec,
  SleeveUniverse,
  V2Bar,
} from '../../../../contracts/index.js';
import type { SleeveFactory } from '../backtest.js';
import type { BarsSource } from '../data/index.js';
import { baseRead } from './bar-quality.js';
import { liquidityCore, type PoolContext } from './universe.js';

// #1785 ruling (g): point-in-time top-300 by 20-day $ volume, reusing liquidityCore as-is
export const MEAN_REVERSION_UNIVERSE_COUNT = 300;

export const MEAN_REVERSION_CANDIDATE_ID = 'mean-reversion';
export const MEAN_REVERSION_BENCHMARK_ID = 'mean-reversion-benchmark';

// Ruling (d)/(a): Alpaca SIP from 2016-01-04 + SMA(200) warmup, ~200 trading sessions later —
// pinned as a literal since from/to feed the trial hash and must not drift if the store is
// re-primed (same rule as candidate 1's VUTY pin, cross-asset-trend.ts)
export const MEAN_REVERSION_FROM = '2016-10-11';
export const MEAN_REVERSION_TO = '2025-09-24';

const SMA_WINDOW = 200;
const RSI_PERIOD = 2;
const RECOVERY_RSI = 65;
export const MEAN_REVERSION_ENTRY_THRESHOLDS: readonly number[] = [10, 15];
const ATR_WINDOW = 20;
const STOP_ATR_MULTIPLE = 5;
// Ruling (e): 10 trading sessions, flatten at next open. #1515's embargo (folds.ts) is sized to
// the same number — shared here rather than each pinning its own copy of "10"
export const MEAN_REVERSION_TIME_STOP_TRADING_DAYS = 10;
// No fixed profit target (the RSI recovery signal is the exit) and, for the benchmark only, no
// time stop (ruling f): a large sentinel keeps SleeveSizing's fields plain numbers without
// Infinity (same rationale as cross-asset-trend.ts's NO_TARGET_OR_TIME_STOP), reused for both
// fields since both mean "no limit" at the same magnitude
const SENTINEL_LIMIT = 1_000_000;
const RISK_FRACTION = 0.005;
const ADV_SHARE_NON_BINDING = 1;
const ADV_WINDOW_BARS = 20;
// Ruling (f)/S1: this candidate's own backtest runs at the full 0.7, same convention as candidate 1
const CAPITAL_SHARE = 0.7;
// SMA(200) + ATR(20)'s own trailing window + slack for the RSI(2) seed to converge, all fed
// from the same daily fetch (mirrors cross-asset-trend.ts's smaWindow + 10, wider here because
// this candidate also needs the ATR window past the SMA's own tail)
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

// Ignores the time stop (ruling f): a sentinel far past any real hold keeps the benchmark's
// position open until its own stop, not a schedule unrelated to a pure-hold thesis
function meanReversionBenchmarkSpec(): SleeveSpec {
  const spec = meanReversionSpec();
  return { ...spec, sizing: { ...spec.sizing, timeStopTradingDays: SENTINEL_LIMIT } };
}

// Wilder smoothing over the whole supplied window, not just the trailing `period` — the seed
// seen by the recursive average is the window's OWN start, not the series' inception, but at
// period 2 the smoothing converges within a handful of bars, and LOOKBACK_BARS supplies far more
// warmup than that before the value this function returns is ever read (#1785: distinct from the
// debate panel's RSI(14) indicator engine — no import from it, this is its own small function)
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
  read: MeanReversionRead,
  date: string,
): SleeveDecision {
  const atr = read.atr as number;
  return {
    sleeve_id: sleeveId,
    instrument,
    venue: 'alpaca',
    direction: 'bullish',
    confidence: 1,
    action: 'enter_long',
    reason: 'close above SMA200, RSI(2) dip',
    price: read.price,
    atr,
    stop_price: read.price - STOP_ATR_MULTIPLE * atr,
    inputs_hash: `${instrument}-${date}`,
    debate_id: undefined,
    payload: { rsi2: read.rsi, sma200: read.sma },
  };
}

function exitDecision(
  sleeveId: string,
  instrument: string,
  read: MeanReversionRead,
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
  read: MeanReversionRead | undefined,
  date: string,
  entryThreshold: number,
): RankedDecision {
  if (read === undefined) {
    return {
      decision: baseDecision(sleeveId, instrument, undefined, 'bad_last_bar'),
      sortKey: Infinity,
    };
  }
  if (read.sma === undefined || read.atr === undefined || read.rsi === undefined) {
    return {
      decision: baseDecision(sleeveId, instrument, read, 'insufficient_history'),
      sortKey: Infinity,
    };
  }
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

// Ruling (g): decide() only sees the point-in-time top-300 (from universe()) — an instrument
// held from an earlier day that has since dropped out of that ranking simply gets no decision
// here, so it is never signal-exited on membership change; only its resting stop or the (already
// spec-declared) time stop can close it (exitHeldPosition/timeStop in cycle.ts act on the
// position, not on whether the sleeve returned a decision for it today)
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
      const ranked = instruments.map((instrument) => {
        const raw = market.barsBefore(instrument, context.tradingDate, LOOKBACK_BARS);
        const read = meanReversionRead(raw);
        return meanReversionDecisionFor(
          sleeveId,
          instrument,
          read,
          context.tradingDate,
          entryThreshold,
        );
      });
      // Ruling (g): sorted RSI(2) ascending (most oversold first) before the cash gate funds
      // them in cycle.ts:entries() — a stable sort, so ties (every bad_last_bar/insufficient_
      // history skip shares sortKey Infinity) keep the liquidityCore ADV order they arrived in
      ranked.sort((a, b) => a.sortKey - b.sortKey);
      return Promise.resolve({ decisions: ranked.map((entry) => entry.decision), refusals: [] });
    },
  });
}

function benchmarkDecisionFor(
  sleeveId: string,
  instrument: string,
  read: MeanReversionRead | undefined,
  date: string,
): SleeveDecision {
  if (read === undefined) return baseDecision(sleeveId, instrument, undefined, 'bad_last_bar');
  if (read.atr === undefined)
    return baseDecision(sleeveId, instrument, read, 'insufficient_history');
  return enterDecision(sleeveId, instrument, read, date);
}

// Ruling (f): risk-matched buy-and-hold over the same universe/sizing/stop/costs, funded in the
// same ADV-rank order as the strategy (liquidityCore's own order, kept as-is — no RSI sort, the
// benchmark ignores the mean-reversion signal entirely), ignoring the time stop (the sentinel in
// meanReversionBenchmarkSpec) and holding a top-300 dropout to its own stop (same mechanism as
// the strategy sleeve above: no decision for it, cycle.ts exits only on a real stop or signal)
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
      const decisions = instruments.map((instrument) => {
        const raw = market.barsBefore(instrument, context.tradingDate, LOOKBACK_BARS);
        const read = meanReversionRead(raw);
        return benchmarkDecisionFor(
          MEAN_REVERSION_BENCHMARK_ID,
          instrument,
          read,
          context.tradingDate,
        );
      });
      return Promise.resolve({ decisions, refusals: [] });
    },
  });
}
