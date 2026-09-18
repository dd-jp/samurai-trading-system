
import {
  type Bar,
  type BarWindow,
  computeRvol,
  computeSessionVwap,
  type IndicatorSpec,
  InsufficientBarsError,
  minimumBarsFor,
  RVOL_SESSION_WINDOW,
  type RvolReading,
  recommendedWarmupFor,
} from '../../providers/market-data-service/index.js';
import { screeningInstrumentFor } from '../../providers/universe-pool/index.js';
import type { AnalystView, Direction } from '../debate-engine/index.js';
import type { Analyst, AnalystInput, AnalystTelemetry, AssetClass } from './types.js';

const INDICATOR_TIMEFRAME = '5m';
const CONTEXT_TIMEFRAME = '1h';
const INDICATOR_LOOKBACK = 14;
const CONTEXT_CANDLE_LOOKBACK = 20;
const MI_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const WARMUP_5M = 260;

const BARS_PER_SESSION_5M = 78;

export const RVOL_5M_LOOKBACK = (RVOL_SESSION_WINDOW + 2) * BARS_PER_SESSION_5M;

export const SMA_SPEC: IndicatorSpec = {
  indicator: 'sma',
  params: {},
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK,
};
const RSI_FLOOR_SPEC: IndicatorSpec = {
  indicator: 'rsi',
  params: { period: INDICATOR_LOOKBACK },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK + 1,
};

export const RSI_SPEC: IndicatorSpec = {
  ...RSI_FLOOR_SPEC,
  lookback: recommendedWarmupFor(RSI_FLOOR_SPEC),
};

function onRecommendedWarmup(spec: IndicatorSpec): IndicatorSpec {
  return { ...spec, lookback: recommendedWarmupFor(spec) };
}

export const ATR_PCT_SPEC: IndicatorSpec = onRecommendedWarmup({
  indicator: 'atr_pct',
  params: { period: INDICATOR_LOOKBACK },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK + 1,
});

const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

export const MACD_SPEC: IndicatorSpec = onRecommendedWarmup({
  indicator: 'macd_histogram',
  params: { fast: MACD_FAST, slow: MACD_SLOW, signal: MACD_SIGNAL },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: MACD_SLOW,
});

export const ADX_SPEC: IndicatorSpec = onRecommendedWarmup({
  indicator: 'adx',
  params: { period: INDICATOR_LOOKBACK },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: 2 * INDICATOR_LOOKBACK,
});

const DONCHIAN_PERIOD = 20;

export const DONCHIAN_SPEC: IndicatorSpec = {
  indicator: 'donchian_pos',
  params: { period: DONCHIAN_PERIOD },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: DONCHIAN_PERIOD,
};

const BB_PERIOD = 20;
const BB_MULT = 2;
const KC_PERIOD = 20;
const KC_MULT = 1.5;

export const SQUEEZE_SPEC: IndicatorSpec = onRecommendedWarmup({
  indicator: 'bb_kc_squeeze',
  params: { bb_period: BB_PERIOD, bb_mult: BB_MULT, kc_period: KC_PERIOD, kc_mult: KC_MULT },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: BB_PERIOD,
});

export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;

const ADX_TREND_FLOOR = 20;

const SQUEEZE_ON_BELOW = 1;

export const LOW_CONVICTION_CAP = 0.4;

export const PARTICIPATION_LOOKBACK = 20;

const PARTICIPATION_BULL_SHARE = 0.55;

const STRUCTURE_UPPER = 0.7;
const STRUCTURE_LOWER = 0.3;

export type TechnicalAxis = 'trend' | 'momentum' | 'volatility' | 'participation' | 'structure';

export const VOTING_AXES: readonly TechnicalAxis[] = [
  'trend',
  'momentum',
  'participation',
  'structure',
];

export const AXIS_WEIGHTS: Readonly<Record<TechnicalAxis, number>> = {
  trend: 1,
  momentum: 1,
  volatility: 1,
  participation: 1,
  structure: 1,
};

export type AxisVote = -1 | 0 | 1;

interface AxisReading {
  axis: TechnicalAxis;
  vote: AxisVote;
  band: string;
  line: string;
}

interface AxisUnavailable {
  axis: TechnicalAxis;
  kind: string;
  required: number;
  received: number;
  line: string;
}

export interface AxisAssessment {
  readings: AxisReading[];
  net: number;
  availableAxes: number;
  direction: Direction;
  confidence: number;
  capReasons: string[];
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function trendVote(lastClose: number, sma: number): AxisVote {
  if (lastClose > sma) return 1;
  if (lastClose < sma) return -1;
  return 0;
}

function rsiVote(rsi: number): AxisVote {
  if (rsi >= RSI_OVERBOUGHT || rsi <= RSI_OVERSOLD) return 0;
  if (rsi > 50) return 1;
  if (rsi < 50) return -1;
  return 0;
}

function macdVote(histogram: number): AxisVote {
  if (histogram > 0) return 1;
  if (histogram < 0) return -1;
  return 0;
}

export function momentumVote(rsi: number, macd: number | undefined): AxisVote {
  const fromRsi = rsiVote(rsi);
  if (macd === undefined) return fromRsi;
  return Math.sign(fromRsi + macdVote(macd)) as AxisVote;
}

function structureVote(donchianPos: number): AxisVote {
  if (donchianPos > STRUCTURE_UPPER) return 1;
  if (donchianPos < STRUCTURE_LOWER) return -1;
  return 0;
}

function upVolumeShare(bars: Bar[]): number | null {
  let up = 0;
  let down = 0;
  for (const bar of bars) {
    if (bar.close > bar.open) up += bar.volume;
    else if (bar.close < bar.open) down += bar.volume;
  }
  const participating = up + down;
  if (participating === 0) return null;
  return up / participating;
}

function participationVote(share: number | null): AxisVote {
  if (share === null) return 0;
  if (share >= PARTICIPATION_BULL_SHARE) return 1;
  if (share <= 1 - PARTICIPATION_BULL_SHARE) return -1;
  return 0;
}

function directionOf(net: number): Direction {
  if (net > 0) return 'bullish';
  if (net < 0) return 'bearish';
  return 'neutral';
}

async function readEnrichment(
  input: AnalystInput,
  spec: IndicatorSpec,
  availableBars: number,
  asOf: Date,
): Promise<{ value: number } | { required: number; received: number }> {
  const required = minimumBarsFor(spec);
  if (availableBars < required) {
    return { required, received: availableBars };
  }
  try {
    const value = await input.market_data.getIndicator(input.signal.asset, spec, asOf);
    return { value: value.value };
  } catch (error) {
    if (error instanceof InsufficientBarsError) {
      return { required: error.required, received: error.received };
    }
    throw error;
  }
}

function unavailableLine(axis: string, kind: string, required: number, received: number): string {
  return `Unavailable: ${kind} (${axis} axis) needed ${required} bars, had ${received}`;
}

function recordUnavailable(
  input: AnalystInput,
  telemetry: AnalystTelemetry,
  axis: TechnicalAxis,
  kind: string,
  required: number,
  received: number,
): AxisUnavailable {
  telemetry.indicatorUnavailable({
    trace_id: input.trace_id,
    analyst_type: 'technical',
    instrument: input.signal.asset,
    axis,
    kind,
    required,
    received,
  });
  return {
    axis,
    kind,
    required,
    received,
    line: unavailableLine(axis, kind, required, received),
  };
}

interface CoreReads {
  lastClose: number;
  sma: number;
  rsi: number;
  atrPct: number;
}

interface EnrichmentReads {
  macd: number | undefined;
  adx: number | undefined;
  squeeze: number | undefined;
  donchian: number | undefined;
  participation: number | null | undefined;
}

function trendReading(core: CoreReads): AxisReading {
  const trend = trendVote(core.lastClose, core.sma);
  return {
    axis: 'trend',
    vote: trend,
    band: trend > 0 ? 'above' : trend < 0 ? 'below' : 'at',
    line:
      `Trend (${INDICATOR_TIMEFRAME}): ${directionOf(trend)} — close ${core.lastClose} ` +
      `${trend > 0 ? 'above' : trend < 0 ? 'below' : 'at'} SMA(${INDICATOR_LOOKBACK}) ${core.sma}`,
  };
}

function rsiBandFor(rsi: number): string {
  return rsi >= RSI_OVERBOUGHT
    ? 'overbought'
    : rsi <= RSI_OVERSOLD
      ? 'oversold'
      : rsi > 50
        ? 'above midline'
        : rsi < 50
          ? 'below midline'
          : 'at midline';
}

function macdPartFor(macd: number | undefined): string {
  return macd === undefined
    ? ''
    : `; MACD(${MACD_FAST},${MACD_SLOW},${MACD_SIGNAL}) histogram ${macd} ` +
        `${macd > 0 ? 'above' : macd < 0 ? 'below' : 'at'} signal`;
}

function momentumReading(core: CoreReads, macd: number | undefined): AxisReading {
  const momentum = momentumVote(core.rsi, macd);
  const rsiBand = rsiBandFor(core.rsi);
  const macdPart = macdPartFor(macd);
  return {
    axis: 'momentum',
    vote: momentum,
    band: rsiBand,
    line:
      `Momentum (${INDICATOR_TIMEFRAME}): ${directionOf(momentum)} — ` +
      `RSI(${INDICATOR_LOOKBACK}) ${core.rsi} ${rsiBand}${macdPart}`,
  };
}

function participationReading(share: number | null): AxisReading {
  const vote = participationVote(share);
  const band =
    share === null
      ? 'no participating volume'
      : vote > 0
        ? 'buyers'
        : vote < 0
          ? 'sellers'
          : 'balanced';
  return {
    axis: 'participation',
    vote,
    band,
    line:
      `Participation (${INDICATOR_TIMEFRAME}): ${directionOf(vote)} — ${band}` +
      (share === null
        ? ` over the last ${PARTICIPATION_LOOKBACK} bars`
        : `, ${round4(share * 100)}% of the last ${PARTICIPATION_LOOKBACK} bars' volume on up bars`),
  };
}

function structureReading(donchian: number): AxisReading {
  const vote = structureVote(donchian);
  const band = vote > 0 ? 'upper third of range' : vote < 0 ? 'lower third of range' : 'mid range';
  return {
    axis: 'structure',
    vote,
    band,
    line:
      `Structure (${INDICATOR_TIMEFRAME}): ${directionOf(vote)} — close in the ${band} ` +
      `of the ${DONCHIAN_PERIOD}-bar Donchian channel (position ${donchian})`,
  };
}

function capReasonsFor(enrichment: EnrichmentReads): string[] {
  const capReasons: string[] = [];
  if (enrichment.adx !== undefined && enrichment.adx < ADX_TREND_FLOOR) {
    capReasons.push(`ADX(${INDICATOR_LOOKBACK}) ${enrichment.adx} below ${ADX_TREND_FLOOR}`);
  }
  if (enrichment.squeeze !== undefined && enrichment.squeeze < SQUEEZE_ON_BELOW) {
    capReasons.push(`BB/KC ${enrichment.squeeze} below ${SQUEEZE_ON_BELOW} (squeeze on)`);
  }
  return capReasons;
}

function confidenceFor(net: number, availableAxes: number, capReasons: string[]): number {
  const raw = availableAxes === 0 ? 0 : Math.abs(net) / availableAxes;
  return round4(capReasons.length > 0 ? Math.min(raw, LOW_CONVICTION_CAP) : raw);
}

export function assessAxes(core: CoreReads, enrichment: EnrichmentReads): AxisAssessment {
  const readings: AxisReading[] = [];

  readings.push(trendReading(core));
  readings.push(momentumReading(core, enrichment.macd));

  if (enrichment.participation !== undefined) {
    readings.push(participationReading(enrichment.participation));
  }

  if (enrichment.donchian !== undefined) {
    readings.push(structureReading(enrichment.donchian));
  }

  const voting = readings.filter((reading) => VOTING_AXES.includes(reading.axis));
  const net = voting.reduce((sum, reading) => sum + AXIS_WEIGHTS[reading.axis] * reading.vote, 0);
  const availableAxes = voting.reduce((sum, reading) => sum + AXIS_WEIGHTS[reading.axis], 0);

  const capReasons = capReasonsFor(enrichment);
  const confidence = confidenceFor(net, availableAxes, capReasons);

  return {
    readings,
    net,
    availableAxes,
    direction: directionOf(net),
    confidence,
    capReasons,
  };
}

function gateLine(
  atrPct: number,
  adx: number | undefined,
  squeeze: number | undefined,
  capReasons: string[],
): string {
  const parts = [`ATR(${INDICATOR_LOOKBACK}) ${atrPct}% of price`];
  if (adx !== undefined) {
    parts.push(
      `ADX(${INDICATOR_LOOKBACK}) ${adx} ${adx < ADX_TREND_FLOOR ? 'below trend floor' : 'trending'}`,
    );
  }
  if (squeeze !== undefined) {
    parts.push(`BB/KC ${squeeze} ${squeeze < SQUEEZE_ON_BELOW ? 'squeeze on' : 'no squeeze'}`);
  }
  const verdict =
    capReasons.length > 0
      ? `confidence capped at ${LOW_CONVICTION_CAP} (${capReasons.join('; ')})`
      : 'no confidence cap';
  return `Volatility gate (${INDICATOR_TIMEFRAME}): ${parts.join(', ')} — ${verdict}`;
}

export function rvolLine(
  instrument: string,
  reading: RvolReading,
  screening: string | null,
): string {
  const body =
    reading.rvol === null
      ? `unavailable (${reading.degraded_reason}, ${reading.sessions_used}/${reading.sessions_target} sessions matched)`
      : `${round4(reading.rvol)}x the median same-clock-time bucket over ` +
        `${reading.sessions_used}/${reading.sessions_target} prior sessions`;
  const caveat =
    screening === null
      ? ''
      : `; measured on ${instrument}, a leveraged-ETP wrapper — market-maker flow, not informed ` +
        `flow. The informed instrument is ${screening}, not fetchable from this analyst's ` +
        `inputs (#797)`;
  return `RVOL (${INDICATOR_TIMEFRAME}): ${body} — informational, no vote${caveat}`;
}

export const technicalAnalyst: Analyst = {
  analyst_type: 'technical',
  role: 'mandatory',

  applies_to(_asset_class: AssetClass): boolean {
    return true;
  },

  async run(input: AnalystInput): Promise<AnalystView> {
    const { signal, clock } = input;
    const asOf = clock.now();
    const telemetry = input.telemetry;
    const technicalWindow: BarWindow = { timeframe: INDICATOR_TIMEFRAME, lookback: WARMUP_5M };
    const contextWindow: BarWindow = {
      timeframe: CONTEXT_TIMEFRAME,
      lookback: CONTEXT_CANDLE_LOOKBACK,
    };

    const technicalBars = await input.market_data.getBars(signal.asset, technicalWindow, asOf);

    const lastCandle = technicalBars.at(-1);
    if (!lastCandle) {
      throw new Error(
        `No ${INDICATOR_TIMEFRAME} bars for ${signal.asset} at or before ${asOf.toISOString()}`,
      );
    }

    const [candles, sma, rsi, atrPct, marketContext] = await Promise.all([
      input.market_data.getBars(signal.asset, contextWindow, asOf),
      input.market_data.getIndicator(signal.asset, SMA_SPEC, asOf),
      input.market_data.getIndicator(signal.asset, RSI_SPEC, asOf),
      input.market_data.getIndicator(signal.asset, ATR_PCT_SPEC, asOf),
      input.market_intelligence.getContext(
        signal.asset_class,
        MI_CONTEXT_WINDOW_MS,
        input.trace_id,
        input.bar,
      ),
    ]);

    const available = technicalBars.length;
    const [macdRead, adxRead, squeezeRead, donchianRead] = await Promise.all([
      readEnrichment(input, MACD_SPEC, available, asOf),
      readEnrichment(input, ADX_SPEC, available, asOf),
      readEnrichment(input, SQUEEZE_SPEC, available, asOf),
      readEnrichment(input, DONCHIAN_SPEC, available, asOf),
    ]);

    const unavailable: AxisUnavailable[] = [];
    const readValue = (
      read: { value: number } | { required: number; received: number },
      axis: TechnicalAxis,
      kind: string,
    ): number | undefined => {
      if ('value' in read) return read.value;
      unavailable.push(
        recordUnavailable(input, telemetry, axis, kind, read.required, read.received),
      );
      return undefined;
    };

    const macd = readValue(macdRead, 'momentum', 'macd_histogram');
    const participationBars = technicalBars.slice(-PARTICIPATION_LOOKBACK);
    let participation: number | null | undefined;
    if (participationBars.length < PARTICIPATION_LOOKBACK) {
      unavailable.push(
        recordUnavailable(
          input,
          telemetry,
          'participation',
          'volume_participation',
          PARTICIPATION_LOOKBACK,
          participationBars.length,
        ),
      );
    } else {
      participation = upVolumeShare(participationBars);
    }
    const donchian = readValue(donchianRead, 'structure', 'donchian_pos');
    const adx = readValue(adxRead, 'volatility', 'adx');
    const squeeze = readValue(squeezeRead, 'volatility', 'bb_kc_squeeze');

    const assessment = assessAxes(
      { lastClose: lastCandle.close, sma: sma.value, rsi: rsi.value, atrPct: atrPct.value },
      { macd, adx, squeeze, donchian, participation },
    );

    const session = computeSessionVwap(technicalBars, input.calendar, asOf);
    const sessionLine =
      session.vwap === null
        ? `Session VWAP (${INDICATOR_TIMEFRAME}): no session to anchor to`
        : `Session VWAP (${INDICATOR_TIMEFRAME}): ${session.vwap} — price ${lastCandle.close} is ` +
          `${(session.distance_from_vwap as number) >= 0 ? '+' : ''}${session.distance_from_vwap} from it`;

    const rvolBars = await input.market_data.getBars(
      signal.asset,
      { timeframe: INDICATOR_TIMEFRAME, lookback: RVOL_5M_LOOKBACK },
      asOf,
    );
    const rvol = computeRvol(rvolBars, input.calendar, asOf);
    const rvolText = rvolLine(signal.asset, rvol, screeningInstrumentFor(signal.asset));

    const contextLine =
      candles.length === 0
        ? `Context (${CONTEXT_TIMEFRAME}): unavailable`
        : `Context (${CONTEXT_TIMEFRAME}): ${candles.length} candles, avg volume ${candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length}`;

    const voteSummary = assessment.readings
      .filter((reading) => VOTING_AXES.includes(reading.axis))
      .map((reading) => `${reading.axis} ${reading.vote > 0 ? '+1' : reading.vote}`)
      .join(', ');

    return {
      trace_id: input.trace_id,
      analyst_id: 'technical',
      analyst_type: 'technical',
      direction: assessment.direction,
      confidence: assessment.confidence,
      key_points: [
        ...assessment.readings.map((reading) => reading.line),
        gateLine(atrPct.value, adx, squeeze, assessment.capReasons),
        ...unavailable.map((entry) => entry.line),
        `Axis votes: ${voteSummary} — net ${assessment.net} over ${assessment.availableAxes} ` +
          `available axes, confidence ${assessment.confidence}`,
        sessionLine,
        rvolText,
        contextLine,
        `MI context: ${marketContext.news.length} news, ${marketContext.social.length} social, ${marketContext.intel.length} intel items in window`,
      ],
      timestamp: asOf,
    };
  },
};
