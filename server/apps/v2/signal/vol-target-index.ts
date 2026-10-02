import type {
  SleeveAction,
  SleeveDecision,
  SleeveOutput,
  SleeveSpec,
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

// The equity-index role of #1785 candidate 1's ruling (b). US-listed ETFs stay out until ADR §5 item 6
// confirms UK-resident access (S2)
export const VOL_TARGET_INDEX_TIDMS: readonly string[] = [
  'ISF',
  'VMID',
  'IUSA',
  'IEUX',
  'IJPN',
  'IEEM',
  'CUKS',
  'CUS1',
  'CPJ1',
];

export const VOL_TARGET_INDEX_CANDIDATE_ID = 'vol-target-index';
export const VOL_TARGET_INDEX_BENCHMARK_ID = 'vol-target-index-benchmark';

// Pinned: from/to feed the trial hash. `from` is the first 2006 LSE session, when ISF, IUSA, IJPN
// and IEEM all have Saxo history; IEUX (2011) and VMID (2014) join both arms as they warm, and
// `to` is the day before the 12-month locked holdout, as for candidates 1 and 2
export const VOL_TARGET_INDEX_FROM = '2006-01-03';
export const VOL_TARGET_INDEX_TO = '2025-09-24';

export const VOL_TARGET_INDEX_CEILINGS: readonly number[] = [0.2, 0.25];
export const VOL_TARGET_INDEX_VOL_WINDOW = 20;
const TRADING_DAYS_PER_YEAR = 252;
export const VOL_TARGET_INDEX_ATR_WINDOW = 20;
const STOP_ATR_MULTIPLE = 5;
const SENTINEL_LIMIT = 1_000_000;
const RISK_FRACTION = 0.0025;
const ADV_SHARE = 0.01;
const ADV_WINDOW_BARS = 20;
const CAPITAL_SHARE = 0.7;
export const VOL_TARGET_INDEX_LOOKBACK_BARS = 2 * VOL_TARGET_INDEX_VOL_WINDOW;

function volTargetIndexSpec(): SleeveSpec {
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
      timeStopTradingDays: SENTINEL_LIMIT,
      advShare: ADV_SHARE,
      advWindowBars: ADV_WINDOW_BARS,
    },
    books: [{ variant: 'primary', instantiated: true }],
  };
}

export function realisedVolatility(bars: readonly V2Bar[], window: number): number | undefined {
  if (bars.length < window + 1) return undefined;
  const closes = bars.slice(-(window + 1)).map((bar) => bar.close);
  if (closes.some((close) => !(close > 0))) return undefined;
  const returns = closes
    .slice(1)
    .map((close, index) => Math.log(close / (closes[index] as number)));
  const mean = returns.reduce((sum, value) => sum + value, 0) / window;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (window - 1);
  return Math.sqrt(variance * TRADING_DAYS_PER_YEAR);
}

interface VolRead {
  readonly price: number;
  readonly atr: number | undefined;
  readonly vol: number | undefined;
}

interface WarmRead extends VolRead {
  readonly atr: number;
  readonly vol: number;
}

type GatedRead =
  | { readonly warm: WarmRead }
  | { readonly skip: string; readonly read: VolRead | undefined };

function volRead(raw: readonly V2Bar[]): VolRead | undefined {
  const read = baseRead(raw, VOL_TARGET_INDEX_VOL_WINDOW, VOL_TARGET_INDEX_ATR_WINDOW);
  if (read === undefined) return undefined;
  return {
    price: read.price,
    atr: read.atr,
    vol: realisedVolatility(read.valid, VOL_TARGET_INDEX_VOL_WINDOW),
  };
}

// Freshness rides on windowCovered: sessionsBefore is empty on a stale calendar (postmortem §2)
function gatedRead(raw: readonly V2Bar[], sessions: readonly string[]): GatedRead {
  const read = volRead(raw);
  if (read === undefined) return { skip: 'bad_last_bar', read };
  if (!windowCovered(raw, sessions, VOL_TARGET_INDEX_LOOKBACK_BARS))
    return { skip: 'window_coverage', read };
  const { atr, vol } = read;
  if (atr === undefined || vol === undefined) return { skip: 'insufficient_history', read };
  return { warm: { ...read, atr, vol } };
}

function decision(
  sleeveId: string,
  instrument: string,
  read: VolRead | undefined,
  action: SleeveAction,
  reason: string,
  date: string,
  stopPrice?: number,
): SleeveDecision {
  const entering = action === 'enter_long';
  return {
    sleeve_id: sleeveId,
    instrument,
    venue: 'saxo',
    direction: entering ? 'bullish' : 'neutral',
    confidence: action === 'skip' ? 0 : 1,
    action,
    reason,
    price: read?.price ?? 0,
    atr: read?.atr,
    stop_price: stopPrice,
    inputs_hash: action === 'skip' ? '' : `${instrument}-${date}`,
    debate_id: undefined,
    payload: { realised_vol: read?.vol },
  };
}

function decisionFor(
  sleeveId: string,
  instrument: string,
  gated: GatedRead,
  date: string,
  holds: (vol: number) => boolean,
): SleeveDecision {
  if ('skip' in gated) return decision(sleeveId, instrument, gated.read, 'skip', gated.skip, date);
  const read = gated.warm;
  if (!holds(read.vol)) {
    return decision(sleeveId, instrument, read, 'exit', 'realised vol above ceiling', date);
  }
  const stopPrice = read.price - STOP_ATR_MULTIPLE * read.atr;
  if (stopPrice <= 0) {
    return decision(sleeveId, instrument, read, 'skip', 'non_positive_stop', date);
  }
  return decision(sleeveId, instrument, read, 'enter_long', 'vol rule holds', date, stopPrice);
}

function createSleeve(
  bars: BarsSource,
  sleeveId: string,
  holds: (vol: number) => boolean,
): SleeveFactory {
  return (market) => ({
    id: sleeveId,
    spec: volTargetIndexSpec(),
    universe: () => ({ instruments: VOL_TARGET_INDEX_TIDMS, refusals: [] }),
    decide(context): Promise<SleeveOutput> {
      const sessions = sessionsBefore(bars, context.tradingDate, calendarReferenceFor('saxo'));
      const decisions = VOL_TARGET_INDEX_TIDMS.map((instrument) => {
        const raw = market.barsBefore(
          instrument,
          context.tradingDate,
          VOL_TARGET_INDEX_LOOKBACK_BARS,
        );
        return decisionFor(
          sleeveId,
          instrument,
          gatedRead(raw, sessions),
          context.tradingDate,
          holds,
        );
      });
      return Promise.resolve({ decisions, refusals: [] });
    },
  });
}

export function volTargetIndexSleeveId(ceiling: number): string {
  return `vol-target-index-v${Math.round(ceiling * 100)}`;
}

export function createVolTargetIndexSleeve(bars: BarsSource, ceiling: number): SleeveFactory {
  return createSleeve(bars, volTargetIndexSleeveId(ceiling), (vol) => vol <= ceiling);
}

// Same lines, sizing, stop, warm-up and coverage gate with the ceiling ignored, so the two books
// differ only by the volatility rule. A stop-out re-enters at the next decision (candidate 1's ruling (d))
export function createVolTargetIndexBenchmarkSleeve(bars: BarsSource): SleeveFactory {
  return createSleeve(bars, VOL_TARGET_INDEX_BENCHMARK_ID, () => true);
}
