import type {
  SleeveDecision,
  SleeveOutput,
  SleeveSpec,
  V2Bar,
} from '../../../../contracts/index.js';
import { averageTrueRange } from '../../../pipeline/momentum/index.js';
import type { SleeveFactory } from '../backtest.js';

// #1785 ruling (b): the 15 declared lines from the proposal (doc 70 §10.4's 22-line Saxo pool)
// Read directly here, bypassing selectLseUniverse/lseInstrumentsAbove: the LSE liquidity screen
// (#1774) is unset and the Saxo appropriateness gate would drop SGLN/SSLN, but ruling (e)/(l)
// says the backtest itself is unaffected by either — CUKS/CUS1/CPJ1 are declared and kept even
// though they size to 0 shares at this capital (near-never holdable either way)
export const CROSS_ASSET_TREND_TIDMS: readonly string[] = [
  'ISF',
  'VMID',
  'IUSA',
  'IEUX',
  'IJPN',
  'IEEM',
  'IGLT',
  'INXG',
  'SLXX',
  'VUTY',
  'SGLN',
  'SSLN',
  'CUKS',
  'CUS1',
  'CPJ1',
];

export const CROSS_ASSET_TREND_CANDIDATE_ID = 'cross-asset-trend';

// `to` is the day before the 12-month locked holdout (2025-09-25, Step 4b). `from` is VUTY's
// SMA(200) warmup date, the latest of the 15 lines, so trials and benchmark share one window
// Pinned as literals since `from`/`to` feed the trial hash (recordTrials) and must not drift if
// the store is re-primed. Window/MinBTL reconciliation against the proposal's own ~8.7y estimate:
// doc 66, 2026-09-28 entry
export const CROSS_ASSET_TREND_FROM = '2017-08-18';
export const CROSS_ASSET_TREND_TO = '2025-09-24';

const SMA_WINDOWS = { 100: 100, 200: 200 } as const;
export type CrossAssetTrendSmaWindow = keyof typeof SMA_WINDOWS;

const ATR_WINDOW = 20;
const STOP_ATR_MULTIPLE = 3;
// No target, no time stop (proposal §2): a large finite sentinel keeps SleeveSizing's fields
// plain numbers (required by contracts/v2.ts) without Infinity, which serialises to null in the
// trial hash and in nativeRearmPrices' JSON-round-tripped stop/target payload
const NO_TARGET_OR_TIME_STOP = 1_000_000;
const RISK_FRACTION = 0.0015;
// The proposal's sizing table (§2) has no ADV/volume constraint, only the risk fraction and the
// generic 10%-of-equity cap (MAX_POSITION_FRACTION_OF_EQUITY). advShare/advWindowBars are
// required fields regardless, so this is set generous enough to never bind ahead of those two
const ADV_SHARE_NON_BINDING = 1;
const ADV_WINDOW_BARS = 20;
// Ruling (f)/S1: this candidate's own backtest runs at the full 0.7 (debate's 0.3 complement)
// The split across whichever candidates pass (ruling f) is a separate, later step
const CAPITAL_SHARE = 0.7;

function crossAssetTrendSpec(): SleeveSpec {
  return {
    capitalShare: CAPITAL_SHARE,
    minimumCapitalGbp: 0,
    capacityGbp: Number.POSITIVE_INFINITY,
    validation: 'backtest',
    macroGate: false,
    sizing: {
      riskFraction: RISK_FRACTION,
      stopAtrMultiple: STOP_ATR_MULTIPLE,
      targetAtrMultiple: NO_TARGET_OR_TIME_STOP,
      timeStopTradingDays: NO_TARGET_OR_TIME_STOP,
      advShare: ADV_SHARE_NON_BINDING,
      advWindowBars: ADV_WINDOW_BARS,
    },
    books: [{ variant: 'primary', instantiated: true }],
  };
}

function shapeValid(bar: V2Bar): boolean {
  return (
    bar.open >= bar.low && bar.open <= bar.high && bar.close >= bar.low && bar.close <= bar.high
  );
}

function simpleMovingAverage(bars: readonly V2Bar[], window: number): number | undefined {
  if (bars.length < window) return undefined;
  let total = 0;
  for (const bar of bars.slice(-window)) total += bar.close;
  return total / window;
}

interface TrendRead {
  readonly price: number;
  readonly close: number;
  readonly sma: number | undefined;
  readonly atr: number | undefined;
}

// #1838: a shape-invalid last bar is never priced off (fail-closed, the candleFeatures idiom);
// shape-invalid bars inside the trailing window are filtered out of the SMA/ATR inputs rather
// than treated as zero-return days
function trendRead(rawHistory: readonly V2Bar[], smaWindow: number): TrendRead | undefined {
  const last = rawHistory.at(-1);
  if (last === undefined || !shapeValid(last)) return undefined;
  const valid = rawHistory.filter(shapeValid);
  const atr = averageTrueRange(valid, valid.length - 1, ATR_WINDOW);
  return {
    price: last.rawClose,
    close: last.close,
    sma: simpleMovingAverage(valid, smaWindow),
    atr: atr === undefined ? undefined : (atr * last.rawClose) / last.close,
  };
}

function baseDecision(
  sleeveId: string,
  instrument: string,
  read: TrendRead | undefined,
  reason: string,
): SleeveDecision {
  return {
    sleeve_id: sleeveId,
    instrument,
    venue: 'saxo',
    direction: 'neutral',
    confidence: 0,
    action: 'skip',
    reason,
    price: read?.price ?? 0,
    atr: read?.atr,
    stop_price: undefined,
    inputs_hash: '',
    debate_id: undefined,
    payload: {},
  };
}

function enterDecision(
  sleeveId: string,
  instrument: string,
  read: TrendRead,
  date: string,
): SleeveDecision {
  const atr = read.atr as number;
  return {
    sleeve_id: sleeveId,
    instrument,
    venue: 'saxo',
    direction: 'bullish',
    confidence: 1,
    action: 'enter_long',
    reason: 'close above SMA',
    price: read.price,
    atr,
    stop_price: read.price - STOP_ATR_MULTIPLE * atr,
    inputs_hash: `${instrument}-${date}`,
    debate_id: undefined,
    payload: {},
  };
}

function exitDecision(
  sleeveId: string,
  instrument: string,
  read: TrendRead,
  date: string,
): SleeveDecision {
  return {
    sleeve_id: sleeveId,
    instrument,
    venue: 'saxo',
    direction: 'neutral',
    confidence: 1,
    action: 'exit',
    reason: 'close below SMA',
    price: read.price,
    atr: read.atr,
    stop_price: undefined,
    inputs_hash: `${instrument}-${date}`,
    debate_id: undefined,
    payload: {},
  };
}

function decisionFor(
  sleeveId: string,
  instrument: string,
  read: TrendRead | undefined,
  date: string,
  signalOn: (read: TrendRead) => boolean,
): SleeveDecision {
  if (read === undefined) return baseDecision(sleeveId, instrument, undefined, 'bad_last_bar');
  if (read.sma === undefined || read.atr === undefined) {
    return baseDecision(sleeveId, instrument, read, 'insufficient_history');
  }
  return signalOn(read)
    ? enterDecision(sleeveId, instrument, read, date)
    : exitDecision(sleeveId, instrument, read, date);
}

function createSleeve(
  sleeveId: string,
  smaWindow: number,
  signalOn: (read: TrendRead) => boolean,
): SleeveFactory {
  const lookbackBars = smaWindow + 10;
  return (market) => ({
    id: sleeveId,
    spec: crossAssetTrendSpec(),
    universe: () => ({ instruments: CROSS_ASSET_TREND_TIDMS, refusals: [] }),
    decide(context): Promise<SleeveOutput> {
      const decisions = CROSS_ASSET_TREND_TIDMS.map((instrument) => {
        const raw = market.barsBefore(instrument, context.tradingDate, lookbackBars);
        const read = trendRead(raw, smaWindow);
        return decisionFor(sleeveId, instrument, read, context.tradingDate, signalOn);
      });
      return Promise.resolve({ decisions, refusals: [] });
    },
  });
}

export function crossAssetTrendSleeveId(window: CrossAssetTrendSmaWindow): string {
  return `cross-asset-trend-sma${window}`;
}

export const CROSS_ASSET_TREND_BENCHMARK_ID = 'cross-asset-trend-benchmark';

export function createCrossAssetTrendSleeve(window: CrossAssetTrendSmaWindow): SleeveFactory {
  return createSleeve(
    crossAssetTrendSleeveId(window),
    SMA_WINDOWS[window],
    (read) => read.close > (read.sma as number),
  );
}

// Ruling (d): a re-entering always-long version of the SAME sleeve (lines, sizing, stop, costs,
// budget), signal ignored — isolates whether the trend signal adds value over holding the book
// Re-enters because entries() re-issues enter_long for every held line daily; submitEntry no-ops
// while held, so a stop-out is the only way back to flat before the next cycle re-enters. Its own
// SMA(20) is unused by signalOn — only its definedness (ATR's own warmup) gates the first entry
export function createCrossAssetTrendBenchmarkSleeve(): SleeveFactory {
  return createSleeve(CROSS_ASSET_TREND_BENCHMARK_ID, ATR_WINDOW, () => true);
}
