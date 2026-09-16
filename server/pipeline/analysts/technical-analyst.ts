/**
 * Technical analyst persona: stateless pure function of its `AnalystInput`, mandatory for both
 * asset classes. Five axes (trend, momentum, volatility-as-gate, participation, structure) each
 * emit AT MOST ONE vote, so correlated oscillators can't outvote a single trend read. CORE axes
 * (trend pair, RSI, ATR%) fail loud with no catch; ENRICHMENT axes are caught narrowly for
 * `InsufficientBarsError` alone, so an unavailable axis leaves the vote denominator rather than counting as zero.
 */

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

/** 5m, not 1h: at period 14 a 1h SMA/RSI is a 2.3-session lookback on a flat-by-close position (ADR-0014) */
const INDICATOR_TIMEFRAME = '5m';
/** 1h read retained as context only — never feeds direction/confidence */
const CONTEXT_TIMEFRAME = '1h';
const INDICATOR_LOOKBACK = 14;
const CONTEXT_CANDLE_LOOKBACK = 20;
/** 24h news/sentiment context window, matching the always-on context frame */
const MI_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one shared 5m warm-up every 5m spec relies on (one fetch, six store reads, not six
 * fetches). 260 covers `MACD_SPEC`'s 112-bar warm-up with 2x margin.
 */
export const WARMUP_5M = 260;

/** 5m bars in one regular US equity session: 6.5 hours / 5 minutes */
const BARS_PER_SESSION_5M = 78;

/**
 * SEPARATE, WIDER window `computeRvol` needs — can't reuse `WARMUP_5M` since RVOL needs the
 * prior `RVOL_SESSION_WINDOW` sessions plus the current one. Fetched sequenced after the shared
 * warm-up read, never `Promise.all`-ed with it: two concurrent fetches would race the store write.
 */
export const RVOL_5M_LOOKBACK = (RVOL_SESSION_WINDOW + 2) * BARS_PER_SESSION_5M;

/** `sma` reads the closes directly, so an SMA(14) is exactly 14 bars — the `params.period ?? lookback` fallback needs no `+ 1`. */
export const SMA_SPEC: IndicatorSpec = {
  indicator: 'sma',
  params: {},
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK,
};
/**
 * The arity floor: `params.period` pinned rather than left to the `?? lookback` fallback.
 * `rsi` consumes the first bar only to seed the previous close, so N bars yield N-1 changes.
 */
const RSI_FLOOR_SPEC: IndicatorSpec = {
  indicator: 'rsi',
  params: { period: INDICATOR_LOOKBACK },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK + 1,
};

/**
 * RSI(14) over a CONVERGED warm-up (57 bars), not the arity floor of 15: at the floor, Wilder
 * smoothing ran zero times and the simple-mean seed measured a median 4.6-point RSI shift and
 * flipped the overbought/oversold classification on 18% of bars
 */
export const RSI_SPEC: IndicatorSpec = {
  ...RSI_FLOOR_SPEC,
  lookback: recommendedWarmupFor(RSI_FLOOR_SPEC),
};

/** Puts a spec on its CONVERGED warm-up rather than its arity floor, applied once instead of restated per spec */
function onRecommendedWarmup(spec: IndicatorSpec): IndicatorSpec {
  return { ...spec, lookback: recommendedWarmupFor(spec) };
}

/**
 * ATR as a percentage of price — CORE, since the volatility gate renders on every view.
 * Deliberately NOT shared with `trader/decide.ts`'s specs: those price stops and trip the
 * volatility breaker, this one only renders a band into a prompt.
 */
export const ATR_PCT_SPEC: IndicatorSpec = onRecommendedWarmup({
  indicator: 'atr_pct',
  params: { period: INDICATOR_LOOKBACK },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK + 1,
});

/** MACD's conventional 12/26/9, unfitted — see `AXIS_WEIGHTS` on why nothing here is searched */
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

/**
 * MACD histogram — ENRICHMENT, and the widest spec in the file: converged
 * warm-up is 112 bars (~9 hours, more than one session), which is exactly why
 * it cannot be core — a fresh instrument would trade nothing for a session and a half
 */
export const MACD_SPEC: IndicatorSpec = onRecommendedWarmup({
  indicator: 'macd_histogram',
  params: { fast: MACD_FAST, slow: MACD_SLOW, signal: MACD_SIGNAL },
  timeframe: INDICATOR_TIMEFRAME,
  // Placeholder: `macd_histogram`'s arity/warm-up are functions of fast/slow/signal alone; `onRecommendedWarmup` replaces this before any consumer sees it
  lookback: MACD_SLOW,
});

/** ADX(14) — ENRICHMENT, feeds the CONFIDENCE CAP rather than a vote: it answers "is there a trend to have an opinion about", not "which way" */
export const ADX_SPEC: IndicatorSpec = onRecommendedWarmup({
  indicator: 'adx',
  params: { period: INDICATOR_LOOKBACK },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: 2 * INDICATOR_LOOKBACK,
});

/** The Donchian window, in 5m bars — 20 bars is ~100 minutes, an intraday range */
const DONCHIAN_PERIOD = 20;

/** Donchian position — ENRICHMENT, and the STRUCTURE axis's only input */
export const DONCHIAN_SPEC: IndicatorSpec = {
  indicator: 'donchian_pos',
  params: { period: DONCHIAN_PERIOD },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: DONCHIAN_PERIOD,
};

/** Bollinger/Keltner conventional parameters, unfitted */
const BB_PERIOD = 20;
const BB_MULT = 2;
const KC_PERIOD = 20;
const KC_MULT = 1.5;

/** BB/KC squeeze ratio — ENRICHMENT, and the gate's second cap input */
export const SQUEEZE_SPEC: IndicatorSpec = onRecommendedWarmup({
  indicator: 'bb_kc_squeeze',
  params: { bb_period: BB_PERIOD, bb_mult: BB_MULT, kc_period: KC_PERIOD, kc_mult: KC_MULT },
  timeframe: INDICATOR_TIMEFRAME,
  // Placeholder, replaced below — same reason as `MACD_SPEC`'s
  lookback: BB_PERIOD,
});

/** RSI above this alongside a rising close is treated as overbought, not confirming bullish */
export const RSI_OVERBOUGHT = 70;
/** RSI below this alongside a falling close is treated as oversold, not confirming bearish */
export const RSI_OVERSOLD = 30;

/**
 * Wilder's own "no trend worth trading" line. Below it the gate caps
 * confidence; it does not flip a vote, because a weak trend says nothing about
 * direction.
 */
const ADX_TREND_FLOOR = 20;

/** `bb_kc_squeeze` below 1 means the Bollinger band narrowed inside the Keltner channel — a coil where a breakout can go either way, so it caps rather than votes */
const SQUEEZE_ON_BELOW = 1;

/** A DAMPER, not a veto: a gated tape can still clear the conviction floor if the mediator independently agrees */
export const LOW_CONVICTION_CAP = 0.4;

/** Matched to `DONCHIAN_PERIOD` so the two intraday-range axes describe the same stretch of tape */
export const PARTICIPATION_LOOKBACK = 20;

/**
 * Above this share of participating volume on up-bars, buyers are treated as
 * dominant; below `1 - PARTICIPATION_BULL_SHARE`, sellers are. The band is
 * deliberately wide around 50/50: a 51/49 split is noise, not participation.
 */
const PARTICIPATION_BULL_SHARE = 0.55;

/** Donchian position above this is the top of the range; below its mirror, the bottom */
const STRUCTURE_UPPER = 0.7;
const STRUCTURE_LOWER = 0.3;

/** The five axes. `volatility` is the GATE — it never votes; see `VOTING_AXES`. */
export type TechnicalAxis = 'trend' | 'momentum' | 'volatility' | 'participation' | 'structure';

/** `volatility` is deliberately absent: if it also voted, ADX/squeeze would move confidence twice — once through the numerator, again through the cap */
export const VOTING_AXES: readonly TechnicalAxis[] = [
  'trend',
  'momentum',
  'participation',
  'structure',
];

/** EQUAL and UNFITTED: a weight chosen by outcome is a fitted parameter, forbidden by ADR-0018 D4's selection-budget cap */
export const AXIS_WEIGHTS: Readonly<Record<TechnicalAxis, number>> = {
  trend: 1,
  momentum: 1,
  volatility: 1,
  participation: 1,
  structure: 1,
};

/** A single axis's vote. One per axis, never one per indicator. */
export type AxisVote = -1 | 0 | 1;

/** An axis that produced a vote, with the already-interpreted band behind it */
interface AxisReading {
  axis: TechnicalAxis;
  vote: AxisVote;
  /** The interpretation, computed HERE — never a legend shipped to the prompt */
  band: string;
  /** The rendered `key_points` line */
  line: string;
}

/** An axis that could not be read, with the arithmetic behind the refusal */
interface AxisUnavailable {
  axis: TechnicalAxis;
  /** `IndicatorKind`, or the derived feature name for the participation read */
  kind: string;
  required: number;
  received: number;
  line: string;
}

/** What `readAxes` produces — the structured points the prompt renders verbatim */
export interface AxisAssessment {
  readings: AxisReading[];
  /** Sum of `weight x vote` over the available voting axes */
  net: number;
  /** Sum of the weights of the available voting axes — the denominator */
  availableAxes: number;
  direction: Direction;
  confidence: number;
  /** Why the cap fired, empty when it did not */
  capReasons: string[];
}

/** Rounded so a rendered confidence is short and byte-identical across runs */
function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** TREND — the close/SMA pair, CORE. One vote from the pair, not one per member — counting separately is the correlated double-vote this design forbids. */
function trendVote(lastClose: number, sma: number): AxisVote {
  if (lastClose > sma) return 1;
  if (lastClose < sma) return -1;
  return 0;
}

/** MOMENTUM's RSI half. Extremes vote ZERO, not with the move — RSI 72 is a stretched tape, not "more bullish". */
function rsiVote(rsi: number): AxisVote {
  if (rsi >= RSI_OVERBOUGHT || rsi <= RSI_OVERSOLD) return 0;
  if (rsi > 50) return 1;
  if (rsi < 50) return -1;
  return 0;
}

/** MOMENTUM's MACD half: the histogram's sign is the whole reading */
function macdVote(histogram: number): AxisVote {
  if (histogram > 0) return 1;
  if (histogram < 0) return -1;
  return 0;
}

/**
 * THE one-vote-per-axis rule, in code: `sign(rsi + macd)` is 0 when they disagree, passes the
 * non-zero one through when the other is neutral. `macd === undefined` still votes on RSI alone.
 */
export function momentumVote(rsi: number, macd: number | undefined): AxisVote {
  const fromRsi = rsiVote(rsi);
  if (macd === undefined) return fromRsi;
  return Math.sign(fromRsi + macdVote(macd)) as AxisVote;
}

/** STRUCTURE: where the close sits in the Donchian range */
function structureVote(donchianPos: number): AxisVote {
  if (donchianPos > STRUCTURE_UPPER) return 1;
  if (donchianPos < STRUCTURE_LOWER) return -1;
  return 0;
}

/**
 * The share of participating volume (up-bars vs down-bars, doji excluded) that traded on
 * up-bars. `null` when nothing participated — never a fabricated 0.5 dressed as a measurement.
 * Deliberately does NOT share a definition with `computeRvol`: RVOL is unsigned magnitude
 * against a session baseline, this is a signed split of the volume that did participate.
 */
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

/**
 * Reads one ENRICHMENT indicator, or reports why it could not be read. Catches
 * `InsufficientBarsError` ALONE and rethrows anything else — a bare catch would swallow a
 * misordered-feed `Error` and turn a broken data feed into a quietly narrower debate.
 */
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

/**
 * Names the KIND that could not be read, and the axis it feeds — not "this
 * axis is gone", since an unreadable `macd_histogram` leaves momentum voting
 * on RSI alone. Only participation and structure actually leave the
 * denominator when unreadable.
 */
function unavailableLine(axis: string, kind: string, required: number, received: number): string {
  return `Unavailable: ${kind} (${axis} axis) needed ${required} bars, had ${received}`;
}

/** Reports one unavailable axis: the `technical_indicator_unavailable{kind}` counter, then the rendered line. `AnalystInput.telemetry` is required, so this call is never guarded. */
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

/** The core reads every view is built on. A short window here still fails loud. */
interface CoreReads {
  lastClose: number;
  sma: number;
  rsi: number;
  atrPct: number;
}

/** The enrichment reads, each either a number or the arity that defeated it */
interface EnrichmentReads {
  macd: number | undefined;
  adx: number | undefined;
  squeeze: number | undefined;
  donchian: number | undefined;
  participation: number | null | undefined;
}

/** The `trend` axis reading — close vs. SMA */
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

/** The `momentum` axis reading — RSI, with MACD folded in when readable */
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

/** The `participation` axis reading — only built when `enrichment.participation` is readable */
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

/** The `structure` axis reading — only built when `enrichment.donchian` is readable */
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

/** The volatility-gate cap reasons — ADX below the trend floor, or BB/KC squeeze on */
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
  // `availableAxes` is never 0 (trend/momentum are core) but guarded anyway — a NaN confidence would reach a live sizing multiplier
  const raw = availableAxes === 0 ? 0 : Math.abs(net) / availableAxes;
  return round4(capReasons.length > 0 ? Math.min(raw, LOW_CONVICTION_CAP) : raw);
}

/**
 * `confidence = |net| / availableAxes`. An UNAVAILABLE axis leaves the denominator entirely
 * rather than counting as a zero vote — "unreadable" and "reads as balanced" are different claims.
 */
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

/** The gate's rendered line — magnitude (core) plus whichever cap inputs are readable */
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

/**
 * INFORMATIONAL ONLY, a recorded decision: RVOL feeds NO vote (absent from `VOTING_AXES`) —
 * adding one would be a design change to a live-money debate path, not a wiring change.
 * Volume on a leveraged ETP is market-maker/wrapper flow, not informed flow; the caveat is
 * dormant today (`screeningInstrumentFor` returns `null`) but renders once a wrapped instrument enters the universe.
 */
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

    // Awaited before the reads below: the shared 5m warm-up fetch every spec's own getIndicator call is then served from
    const technicalBars = await input.market_data.getBars(signal.asset, technicalWindow, asOf);

    const lastCandle = technicalBars.at(-1);
    if (!lastCandle) {
      throw new Error(
        `No ${INDICATOR_TIMEFRAME} bars for ${signal.asset} at or before ${asOf.toISOString()}`,
      );
    }

    // CORE. No pre-check, no catch: a short window here forfeits the instrument for the tick.
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

    // ENRICHMENT. Pre-checked, then narrowly caught.
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

    // Order matters only for the rendered line order, which follows the axis order the summary reports
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

    // Session-anchored VWAP, informational only: no vote, no cap, no change to `assessAxes`'s arithmetic
    // Reuses `technicalBars` rather than issuing its own fetch; a calendar that cannot answer is as fatal as a misordered bar feed
    const session = computeSessionVwap(technicalBars, input.calendar, asOf);
    const sessionLine =
      session.vwap === null
        ? `Session VWAP (${INDICATOR_TIMEFRAME}): no session to anchor to`
        : `Session VWAP (${INDICATOR_TIMEFRAME}): ${session.vwap} — price ${lastCandle.close} is ` +
          `${(session.distance_from_vwap as number) >= 0 ? '+' : ''}${session.distance_from_vwap} from it`;

    // RVOL, informational only — see `rvolLine`'s doc comment. A SEPARATE, WIDER window than `technicalBars` (see `RVOL_5M_LOOKBACK`),
    // awaited on its own since a concurrent fetch for the same instrument+timeframe would race on the store write
    const rvolBars = await input.market_data.getBars(
      signal.asset,
      { timeframe: INDICATOR_TIMEFRAME, lookback: RVOL_5M_LOOKBACK },
      asOf,
    );
    const rvol = computeRvol(rvolBars, input.calendar, asOf);
    const rvolText = rvolLine(signal.asset, rvol, screeningInstrumentFor(signal.asset));

    // No fallback numeric on purpose: reporting "avg volume 0" for an empty read would be a fabricated claim, not an approximation
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
