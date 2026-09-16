/**
 * Technical analyst persona (ticket #70, restructured by #745) — see
 * docs/specs/analysts-spec.md "Module: Analyst Roles & Input Model": primary =
 * price/indicators (Market Data Service); context = last-N-candles + volume
 * (always). Mandatory, applies to both crypto and stocks (Technical never sits
 * out an asset class, unlike Fundamental).
 *
 * A stateless pure function of its `AnalystInput` — no module-level mutable
 * state, no wall-clock reads, no caching. Rolling features (SMA/RSI/MACD/ADX/
 * Donchian/squeeze) are computed by the Market Data Service, never here
 * (analysts-spec.md "analysts stay stateless ... never compute or cache them
 * myself"). The one exception is the participation read, which has no registry
 * kind to delegate to; see `PARTICIPATION_LOOKBACK`.
 *
 * Reasoning is a deterministic indicator rule, not an LLM call — and as of the
 * 2026-08-16 amendment to analysts-spec.md ("Where the LLM belongs") that is
 * the SPECIFIED end state rather than a waypoint. A model deciding whether RSI
 * 72 is overbought is arithmetic with a threshold wearing a nondeterministic,
 * per-call-billed coat; indicators feed the debate, the debate decides.
 * `analyst-prompt-cost.test.ts` asserts it rather than trusting it.
 *
 * # One vote per axis (#745)
 *
 * The analyst reads five axes — trend, momentum, volatility-as-gate,
 * participation, structure — and emits AT MOST ONE vote per axis. That rule is
 * the whole design: it is what stops two correlated oscillators (RSI and the
 * MACD histogram both being momentum) outvoting a single trend read, and it is
 * the rule that justified cutting #744's indicator batch from ten kinds to
 * five. Two indicators on one axis combine into one vote before the vote is
 * counted (`momentumVote`), never after.
 *
 * `confidence = |net| / availableAxes`, capped at `LOW_CONVICTION_CAP` when the
 * volatility gate says the tape is not trending (ADX below `ADX_TREND_FLOOR`)
 * or is coiled (`bb_kc_squeeze` below `SQUEEZE_ON_BELOW`).
 *
 * # Core vs enrichment
 *
 * This analyst is `role: 'mandatory'`: a throw here forfeits the whole
 * instrument for the tick as a `quorum_skip` (`AnalystOrchestrator.runAnalysts`
 * returns an empty view set, `SequentialTickRunner` short-circuits). At six
 * indicator reads with warm-ups from 15 bars (~70 minutes of 5m tape) to 112
 * (~9 hours, several sessions), that would be six independent ways to lose a
 * tick and a cold start that trades nothing until the LONGEST warm-up cleared.
 *
 * So the reads are split:
 *
 * - **CORE** — the trend pair (`SMA_SPEC` + the last close), `RSI_SPEC`,
 *   `ATR_PCT_SPEC`. Fail loud, exactly as before: no pre-check, no catch. A
 *   core kind short of bars still forfeits the instrument, because a technical
 *   view with no trend and no momentum read is not a degraded view, it is no
 *   view.
 * - **ENRICHMENT** — `MACD_SPEC`, `ADX_SPEC`, `DONCHIAN_SPEC`, `SQUEEZE_SPEC`
 *   and the participation read. Bar sufficiency is PRE-CHECKED against the
 *   already-fetched 5m window before the call is made; the call is additionally
 *   wrapped in a catch narrowed to `InsufficientBarsError` ALONE. An
 *   unavailable axis leaves the vote denominator entirely (it is NOT counted
 *   as a zero vote), renders an explicit line naming what the kind needed and
 *   what it had, and increments `technical_indicator_unavailable{kind}`.
 *
 * The catch is narrow on purpose and a broad one would be a defect, not a
 * simplification: `assertAscending` throws a deliberately-fatal bare `Error`
 * meaning "this feed is misordered", which must keep propagating and forfeit
 * the tick rather than be absorbed into a silent degrade. That is the whole
 * reason `InsufficientBarsError` is a typed class (see its doc comment in
 * `indicators.ts`) and `technical-axes.test.ts` pins the propagation.
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

/**
 * Issue #742: the technical read moves from 1h to 5m. At period 14, a 1h
 * SMA/RSI is a 2.3-session lookback on a position that must be flat by
 * close (ADR-0014) — a signal about a different holding period than the one
 * being traded. 1h is retained separately, below, as always-on CONTEXT
 * (`CONTEXT_TIMEFRAME`), not as an input to direction/confidence.
 *
 * Deliberately NOT moved in this change (per #742): `trader/decide.ts`'s
 * `atrIndicatorSpec` timeframe (`TraderConfig.atr_timeframe`) and
 * `production/defaults.ts`'s `DEFAULT_VOLATILITY_INDICATOR`. Those feed the
 * stop and halt paths; bundling them would make this signal-horizon
 * experiment inseparable from a risk-parameter change. #745 does not move them
 * either, for the same reason.
 */
const INDICATOR_TIMEFRAME = '5m';
/** 1h read retained as context only — never feeds direction/confidence */
const CONTEXT_TIMEFRAME = '1h';
const INDICATOR_LOOKBACK = 14;
const CONTEXT_CANDLE_LOOKBACK = 20;
/** 24h news/sentiment context window, matching the always-on context frame */
const MI_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one shared 5m warm-up every 5m spec below relies on. `run()` fetches this
 * window FIRST and awaits it, so the store holds >= this many 5m bars before
 * any spec is requested; each spec's own (smaller) lookback is then served by
 * `MarketDataServiceImpl`'s `cachedBars` route 1 (same instrument+timeframe,
 * already fetched this bar interval) instead of issuing its own source fetch —
 * ONE fetch and six store reads per tick, not six fetches.
 *
 * 260 covers the widest spec below (`MACD_SPEC`, 112 bars at 12/26/9) with
 * more than 2x margin. `technical-axes.test.ts` pins `WARMUP_5M >=` every
 * spec's lookback, because the collapse degrades SILENTLY when it does not
 * hold: `cachedBars` misses on `rows.length < window.lookback` and the tick
 * quietly starts paying six fetches.
 *
 * The 1m-fetch "large limit" warning documented in `alpaca-http-client.ts` does
 * not transfer here: that warning is about `DataSource.fetchBars`' own
 * pagination search widening past its buffer at large `limit`, and 260 5m bars
 * is well under a percent of any request budget mentioned there.
 */
export const WARMUP_5M = 260;

/** 5m bars in one regular US equity session: 6.5 hours / 5 minutes */
const BARS_PER_SESSION_5M = 78;

/**
 * The SEPARATE, WIDER 5m window `computeRvol` needs (#797), and why it cannot
 * reuse `WARMUP_5M`.
 *
 * RVOL's baseline is the same clock-time bucket across the prior
 * `RVOL_SESSION_WINDOW` (10) sessions, so it needs those ten sessions PLUS the
 * current one present in the bars it is handed. `WARMUP_5M` is 260 bars ≈ 3.3
 * sessions — feeding it to `computeRvol` would return `insufficient_sessions`
 * on every tick forever, which is a caller in name only. Twelve sessions
 * (`RVOL_SESSION_WINDOW + 2`) rather than the bare eleven, so ONE half-day or
 * holiday inside the window does not drop the count below ten priors and
 * degrade the line for a fortnight.
 *
 * **Cost, stated rather than hand-waved.** This is a second `getBars` call per
 * instrument per tick, sequenced AFTER the shared `WARMUP_5M` read (never
 * `Promise.all`-ed with it or with the core reads — two concurrent source
 * fetches for the same instrument+timeframe would race on the store write).
 * On a cold store it costs one extra HTTP fetch: `MarketDataServiceImpl`'s
 * `cachedBars` route 1 misses when the store cannot return `lookback` rows, so
 * a 936-row ask is not satisfied by the 260-row fetch that preceded it. Once
 * the store holds >= `RVOL_5M_LOOKBACK` bars for the instrument, route 1 hits
 * (same instrument+timeframe, already fetched this bar interval) and the
 * steady-state cost returns to ONE fetch per instrument per tick.
 *
 * Within the raw-fetch caps by construction, not by luck: 936 + the forming-bar
 * margin is far under `normalizing-data-source.ts`'s `MAX_RAW_LIMIT_ABSOLUTE`
 * (20,000), the absolute row cap #747 shipped for EXACTLY this request shape —
 * its doc comment names `computeRvol`'s "lookback in the hundreds" as the case
 * it exists to bound. `alpaca-http-client.ts`'s large-`limit` warning does not
 * bite either, but the reasoning is NOT inherited from `WARMUP_5M`'s ("well
 * under a percent"), because 936 is 3.6x that: at `BUFFER_MULTIPLIER` 8 the
 * widened search window is ~26 calendar days, ~18 equity sessions, ~1.4k raw
 * 5m rows — two `PAGE_SIZE` (1,000) pages, and comfortably inside
 * `RETRY_MAX_ROWS` (25,000).
 */
export const RVOL_5M_LOOKBACK = (RVOL_SESSION_WINDOW + 2) * BARS_PER_SESSION_5M;

/**
 * `sma` reads the closes directly, so an SMA(14) is exactly 14 bars: the
 * `params.period ?? lookback` fallback resolves to 14 and needs no `+ 1`.
 */
export const SMA_SPEC: IndicatorSpec = {
  indicator: 'sma',
  params: {},
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK,
};
/**
 * The ARITY floor this spec used to sit on: `INDICATOR_LOOKBACK + 1`, with
 * `params.period` pinned rather than left to the `?? lookback` fallback — the
 * same shape `trader/decide.ts`'s `atrIndicatorSpec` and `production.ts`'s
 * `DEFAULT_VOLATILITY_INDICATOR` carry, for the same reason. `rsi` consumes
 * the first bar only to seed the previous close, so N bars yield N-1 changes:
 * this used to ask for 14 bars and get an RSI averaged over 13 changes but
 * divided by 14 — presented in `key_points` as "RSI(14)". Issue #319 made that
 * throw instead of lying. Leaving `params` empty and bumping only `lookback`
 * would have silently made this an RSI(15), which is why the period is pinned.
 */
const RSI_FLOOR_SPEC: IndicatorSpec = {
  indicator: 'rsi',
  params: { period: INDICATOR_LOOKBACK },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK + 1,
};

/**
 * RSI(14) over a CONVERGED warm-up — `recommendedWarmupFor` = `4 x period + 1`
 * = 57 bars — rather than the `minimumBarsFor` floor of 15 (#722).
 *
 * At the floor, `changes.slice(period)` is empty, so `rsi`'s Wilder smoothing
 * loop ran ZERO times and the value the debate read was the simple-mean seed:
 * Cutler's RSI wearing Wilder's name. That is not an alternative convention,
 * it is a warm-up artefact — the number was a function of where the window
 * happened to start. Measured against a converged 200-bar warm-up on the same
 * bar it moved a median 4.6 RSI points, p90 12.0, and flipped the 70/30
 * overbought/oversold classification on 18% of bars
 * (`docs/reviews/indicator-characterisation-2026-08-16.md` F2). Adopting the
 * recommendation reprices every technical opinion in the system at once; that
 * is a knowing, accepted cost, decided on #722 rather than a side effect.
 *
 * Derived from `recommendedWarmupFor` rather than written as 57, so the spec
 * cannot drift away from the function that justifies it. `minimumBarsFor` is
 * still 15 and is deliberately unchanged: it is the fabrication floor, and a
 * cold instrument that holds only 20 bars still gets a (less-warm) RSI rather
 * than no view at all.
 *
 * Exported for the same reason `atrIndicatorSpec` is (#304): so the goldens and
 * `rsi-warmup.test.ts` pin THIS spec rather than a hand-rebuilt copy that would
 * keep passing if the real one drifted.
 */
export const RSI_SPEC: IndicatorSpec = {
  ...RSI_FLOOR_SPEC,
  lookback: recommendedWarmupFor(RSI_FLOOR_SPEC),
};

/**
 * Puts a spec on its CONVERGED warm-up rather than its arity floor — the #722
 * decision, applied once per spec instead of restated per spec.
 *
 * Derived from `recommendedWarmupFor` rather than written as a number so a spec
 * cannot drift away from the function that justifies it (the mistake #722 had
 * to correct in `rsi-warmup.test.ts`). For the multi-parameter kinds the
 * incoming `lookback` is ignored by the registry entirely; see their specs.
 */
function onRecommendedWarmup(spec: IndicatorSpec): IndicatorSpec {
  return { ...spec, lookback: recommendedWarmupFor(spec) };
}

/**
 * ATR as a percentage of price (#745) — CORE, because it is the volatility
 * gate's magnitude read and the gate renders on every view. Its arity is
 * `period + 1` = 15 bars, the same floor `RSI_SPEC` sits on, so making it core
 * costs the cold start nothing: an instrument warm enough for RSI is warm
 * enough for this.
 *
 * Sits on the converged warm-up for the same reason `RSI_SPEC` does — ATR is
 * Wilder-smoothed, so the floor would report the plain-mean seed.
 *
 * NOT the same spec as `trader/decide.ts`'s `atrIndicatorSpec` or
 * `DEFAULT_VOLATILITY_INDICATOR`, and deliberately not shared with them: those
 * price stops and trip the volatility breaker, this one renders a band into a
 * prompt. #745's scope discipline is explicit that the risk-path specs do not
 * move.
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
 * MACD histogram (#744/#745) — ENRICHMENT, and the widest spec in the file:
 * `minimumBarsFor` is `max(12, 26) + 9 - 1` = 34 bars and the converged warm-up
 * is 112 (~9 hours of 5m tape, i.e. more than one session). That width is
 * exactly why it cannot be core: making it so would mean a fresh instrument
 * traded nothing for a session and a half.
 */
export const MACD_SPEC: IndicatorSpec = onRecommendedWarmup({
  indicator: 'macd_histogram',
  params: { fast: MACD_FAST, slow: MACD_SLOW, signal: MACD_SIGNAL },
  timeframe: INDICATOR_TIMEFRAME,
  // Placeholder: `macd_histogram`'s arity and warm-up are functions of
  // fast/slow/signal ALONE (`indicators.ts` `requiredIntParam` — this kind
  // never falls back to `spec.lookback`), so `onRecommendedWarmup` replaces
  // this before any consumer sees it. Stated rather than left at 0, which
  // would read as a meaningful zero-length window
  lookback: MACD_SLOW,
});

/**
 * ADX(14) — ENRICHMENT, and it feeds the CONFIDENCE CAP rather than a vote.
 * That is the axis exception #744's cut list already names: DI+/DI- are not
 * exposed as kinds precisely because ADX here answers "is there a trend to
 * have an opinion about", not "which way".
 */
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
export const ADX_TREND_FLOOR = 20;

/**
 * `bb_kc_squeeze` is `bbWidth / kcWidth`: below 1 the Bollinger band has
 * narrowed INSIDE the Keltner channel, which is the classic coil. A coiled tape
 * is precisely when a directional read is least reliable and a breakout can go
 * either way, so it caps rather than votes.
 */
export const SQUEEZE_ON_BELOW = 1;

/**
 * The cap the gate applies. 0.40 is the issue's number, taken as given rather
 * than searched — see `AXIS_WEIGHTS`.
 *
 * **It is a DAMPER, not a veto (#870).** The cap binds on the ANALYST's
 * confidence, and `computeConvictionScore` then combines it with the
 * mediator's stance and the evidence average. On the all-absent desk —
 * sentiment and fundamental both `NO_DATA_MARKER`, the shape every recorded
 * soak debate ran on — conviction is `0.5 + 0.2c` in the capped confidence
 * `c`, so a capped 0.40 yields **0.58**, above the 0.55 floor. Measured by
 * `server/tools/measure-conviction-ceiling.ts` (#756) and pinned end to end in
 * `../trader/gated-tape-conviction.test.ts`.
 *
 * What the cap is worth, stated shape by shape rather than as one sentence,
 * because no single sentence covers all of them:
 *
 * - **All-absent desk:** a gated tape clears the floor **only** with an
 *   agreeing mediator (0.58); neutral gives 0.43 and opposing 0.28.
 * - **Hydrated-aligned desk:** the cap does not prevent entry at **any**
 *   mediator stance — two MI analysts at 0.95 carry the evidence average, and
 *   even an opposing mediator lands at 0.6533. That desk is not "technicals
 *   alone", so this is not a hole in the intent; it is the reason the intent
 *   could never have been enforced by capping a conviction either.
 * - **Everywhere:** `conviction_floor` is read twice in the Trader, once as
 *   the gate and once through `convictionMultiplier`, so the cap's real effect
 *   is on SIZE. `(0.58 − 0.55)/0.45 ≈ 6.7%` of ADR-0018 D5's deployment
 *   envelope is the **CEILING, not the value**: the cap only binds from raw
 *   confidence 0.40 up, and a weaker gated read deploys less. At `raw = 1/3`
 *   conviction is 0.5667 and the index bracket deploys about £12.96 of the
 *   £1,000 book; at `raw = 0.25` conviction is exactly the floor, the
 *   multiplier is 0 and `decide` skips at `below_min_notional`. Gated
 *   deployment therefore spans **0 → ~6.7%** — at most about a fifth of what
 *   the same axis votes deploy with ADX above the trend floor.
 *
 * **Two conditions those numbers hold under**, both carried from
 * `measure-conviction-ceiling.ts`: `routeDecision` skips at
 * `neutral_direction_while_flat` BEFORE the floor is ever consulted (265 of
 * 268 recorded skips in #625's data), so clearing the floor is necessary and
 * not sufficient; and `applyAnalystWeights` rescales the conviction the Trader
 * gates on by a factor that is exactly 1 only while every `analyst_weights`
 * row still sits at 1.0, which a feedback loop that has started moving weights
 * would change.
 *
 * **Lowering the value would enforce #745's intent — and is David's call, not
 * a defect fix.** On the absent desk the intent needs the CAP under 0.25, and
 * that is reachable: a 0.24 cap yields `0.5 + 0.2(0.24) = 0.548` and the
 * entry is refused. What it costs is directional strength: it would bind on
 * every non-zero point of the four-axis lattice (weights all 1, votes in
 * {-1, 0, 1}, `availableAxes` in {2, 3, 4}, so the non-zero values of
 * `|net| / availableAxes` are {0.25, 1/3, 0.5, 2/3, 0.75, 1}) and collapse
 * every non-zero read to one constant. 0.40 already collapses 4 of those 6
 * points, so this is a difference of degree, not of kind — and a sub-0.25 cap
 * would sit a hundredth under a `conviction_floor` that #756 item 1 still has
 * open and blocked on soak data. Barring a gated tape outright is a product
 * decision.
 *
 * **Resolved 2026-08-26 (#870): the value stays 0.40, mechanism unchanged.**
 * David's ruling — the mechanism is fine, #745's stated intent was overstated.
 * "A gated tape should not carry an entry on technicals alone" means alone —
 * no other analyst signal AND no mediator agreement — not "even with a
 * concurring mediator". The all-absent-desk 0.58 case above clears the floor
 * only because a mediator independently agreed; that is not the cap failing,
 * it is the cap doing exactly what a damper (not a veto) does. #745's
 * docstring is corrected by this note rather than by lowering the cap.
 */
export const LOW_CONVICTION_CAP = 0.4;

/**
 * How many 5m bars the participation read spans. 20 bars is ~100 minutes,
 * matched to `DONCHIAN_PERIOD` so the two intraday-range axes describe the same
 * stretch of tape.
 *
 * Participation is the one axis with NO registry kind behind it: #744 added
 * five kinds and none of them reads volume. It is therefore computed here, from
 * the 5m bars this analyst has already fetched — stateless, pure, and with
 * direct precedent in the 1h context line, which has averaged volume in this
 * file since #70. A `volume_ratio` (or signed-volume) indicator kind belongs in
 * the registry beside the other five; that is a registry change and out of
 * #745's scope, noted rather than smuggled in.
 */
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

/**
 * The axes that produce a vote, and therefore the axes that can appear in
 * `availableAxes`.
 *
 * `volatility` is deliberately absent. The issue names it "volatility-as-GATE"
 * and separately specifies the 0.40 cap on ADX/squeeze: if the gate also voted,
 * ADX and the squeeze would move confidence twice — once through the numerator
 * and again through the cap — and a flat, coiled tape could end up with a
 * HIGHER `|net| / availableAxes` than a trending one purely by widening the
 * denominator. So the gate modulates and never votes, and `availableAxes` tops
 * out at four.
 */
export const VOTING_AXES: readonly TechnicalAxis[] = [
  'trend',
  'momentum',
  'participation',
  'structure',
];

/**
 * Per-axis weights, EQUAL and UNFITTED.
 *
 * Equal because ADR-0018 D4 caps the selection budget and a weight chosen by
 * outcome is a fitted parameter — the same reasoning that keeps
 * `recommendedWarmupFor`'s `4 x period + 1` a conventional figure rather than a
 * searched one. Every threshold in this file (70/30, 20, 1, 0.40, 0.55, 0.7)
 * is conventional or given by the issue for the same reason.
 *
 * This does NOT disable the Feedback Loop. Its bounded post-trade adjustment of
 * per-ANALYST weights inside hard floors and ceilings is its specified job and
 * is untouched here — `CONTEXT.md` already excludes that tuning from the edge
 * claim. What is forbidden is STARTING from fitted weights.
 *
 * Present as a constant rather than implied by the arithmetic so "equal and
 * unfitted" is an artifact a test can assert on and a later change has to
 * edit deliberately.
 */
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
export interface AxisReading {
  axis: TechnicalAxis;
  vote: AxisVote;
  /** The interpretation, computed HERE — never a legend shipped to the prompt */
  band: string;
  /** The rendered `key_points` line */
  line: string;
}

/** An axis that could not be read, with the arithmetic behind the refusal */
export interface AxisUnavailable {
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

/**
 * TREND — the close/SMA pair, CORE.
 *
 * One vote from the pair, not one per member: "close" and "SMA(14)" are two
 * readings of one axis, and counting them separately is exactly the correlated
 * double-vote this design forbids.
 */
export function trendVote(lastClose: number, sma: number): AxisVote {
  if (lastClose > sma) return 1;
  if (lastClose < sma) return -1;
  return 0;
}

/**
 * MOMENTUM's RSI half. Extremes vote ZERO, not with the move: RSI 72 is not
 * "more bullish", it is a stretched tape, which is the reading the previous
 * `directionFrom` already took (`rsi < RSI_OVERBOUGHT` gated the bullish
 * branch) and #745 keeps.
 */
export function rsiVote(rsi: number): AxisVote {
  if (rsi >= RSI_OVERBOUGHT || rsi <= RSI_OVERSOLD) return 0;
  if (rsi > 50) return 1;
  if (rsi < 50) return -1;
  return 0;
}

/** MOMENTUM's MACD half: the histogram's sign is the whole reading */
export function macdVote(histogram: number): AxisVote {
  if (histogram > 0) return 1;
  if (histogram < 0) return -1;
  return 0;
}

/**
 * THE one-vote-per-axis rule, in code. RSI and the MACD histogram are both
 * momentum oscillators and are strongly correlated; two agreeing bullish
 * oscillators must produce ONE bullish vote, not two, or momentum quietly
 * outweighs trend and structure combined.
 *
 * Agreement is required for a non-zero vote: `sign(rsi + macd)` is 0 when they
 * disagree (+1 and -1), and passes the non-zero one through when the other is
 * neutral. Disagreeing oscillators are genuinely no signal on this axis — that
 * is information, and it is different from the axis being unavailable, which is
 * why it stays IN the denominator as a zero vote.
 *
 * `macd === undefined` is the enrichment-unavailable case: momentum still
 * votes, on RSI alone. Momentum is a CORE axis (RSI is core), so it is never
 * dropped from the denominator.
 */
export function momentumVote(rsi: number, macd: number | undefined): AxisVote {
  const fromRsi = rsiVote(rsi);
  if (macd === undefined) return fromRsi;
  return Math.sign(fromRsi + macdVote(macd)) as AxisVote;
}

/** STRUCTURE: where the close sits in the Donchian range */
export function structureVote(donchianPos: number): AxisVote {
  if (donchianPos > STRUCTURE_UPPER) return 1;
  if (donchianPos < STRUCTURE_LOWER) return -1;
  return 0;
}

/**
 * PARTICIPATION: the share of the window's PARTICIPATING volume (up-bars and
 * down-bars, doji excluded) that traded on up-bars.
 *
 * `null` when nothing participated — every bar in the window a doji, or zero
 * volume throughout. That is the halted/auction-flat shape #725 already handled
 * in `rsi`, and it is answered the same way: no fabricated 0.5 dressed as a
 * measurement, an explicit "no reading" the caller renders as a zero vote.
 *
 * #790 — kept as an in-analyst derivation, NOT migrated into
 * `market-data-service`'s `INDICATOR_KINDS` registry. Considered and rejected:
 * a `compute: (bars, spec) => number` registry kind is a TOTAL function — it
 * cannot return the `null` above, only a number. Folding the halted/flat case
 * into the registry's usual degenerate-denominator convention (RSI 50,
 * `donchian_pos` 0.5) would make `assessAxes` render "balanced" for a window
 * that never traded, which is exactly the fabrication class `null` exists to
 * avoid — and this string reaches the debate prompt (`analyst-prompt-cost.test.ts`),
 * so it isn't cosmetic. A registry kind plus an analyst-side pre-check that
 * re-derives "did anything participate" before trusting the registry's answer
 * was also considered; it would just duplicate this loop's own arithmetic to
 * decide whether to call it, buying golden-fixture coverage at the cost of a
 * second implementation of the same walk. Not worth it for a function this
 * shape and this small — recording the decision per #790's own escape hatch
 * rather than shipping a golden fixture that exists only to re-prove
 * `up === down === 0`.
 *
 * The 3x-ETP volume caveat (`market-data-service/types.ts`'s doc comment on
 * `INDICATOR_KINDS`, echoed in `rvol.ts`) applies here exactly as it does to
 * `computeSessionVwap` above: `participationBars` is sliced from
 * `technicalBars`, itself fetched for `signal.asset` — the leveraged ETP on
 * the live equity leg, not its liquid US underlying. This function's volume
 * reads are therefore market-maker/wrapper flow, not informed flow, same as
 * every other volume-derived read in this file. NOT enforced (no routing to
 * an underlying happens here) for the same reason `rvol.ts` documents its own
 * gap rather than papering over it: routing needs a screening/underlying
 * instrument identity (#749) this codebase does not have yet. Recorded, not
 * silently absent.
 *
 * Reconciled with #747's `computeRvol`, deliberately NOT sharing a
 * definition: RVOL is unsigned magnitude — today's volume in a clock-time
 * bucket over the MEDIAN of the same bucket across the last 10 sessions,
 * answering "is more volume trading right now than usually does" — and it
 * needs a `TradingCalendar` to find that bucket, which is exactly why it
 * can't be a pure `(bars, spec)` registry kind either (`rvol.ts`'s own doc
 * comment). `upVolumeShare` is signed direction — of the volume that DID
 * participate this window, what fraction traded on up-bars, answering "when
 * volume showed up, which side was it on." Different questions, different
 * inputs (a calendar vs. none), complementary rather than duplicate; no
 * shared definition was used, and none should be.
 */
export function upVolumeShare(bars: Bar[]): number | null {
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

export function participationVote(share: number | null): AxisVote {
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
 * Reads one ENRICHMENT indicator, or reports why it could not be read.
 *
 * Two guards, on purpose:
 *
 * 1. A PRE-CHECK against the already-fetched 5m window, so the ordinary
 *    cold-start case costs no throw at all and the numbers in the rendered
 *    unavailability line (`required`/`received`) are the real ones.
 * 2. A catch narrowed to `InsufficientBarsError` ALONE, for the case the
 *    pre-check cannot see — the service's own window, filtered by `asOf`, is
 *    the authority on how many bars actually reach `computeIndicator`.
 *
 * The catch is `instanceof InsufficientBarsError` and RETHROWS anything else.
 * A bare `catch` here would swallow `assertAscending`'s deliberately-fatal
 * "this feed is misordered" `Error` and turn a broken data feed into a quietly
 * narrower debate — the failure this whole typed-error split exists to prevent.
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
 * Names the KIND that could not be read, and the axis it feeds — not "this axis
 * is gone", because for two of the five that would be false. An unreadable
 * `macd_histogram` leaves momentum voting on RSI alone, and `adx`/
 * `bb_kc_squeeze` feed a gate that never votes at all. Only participation and
 * structure actually leave the denominator when their kind is unreadable, and
 * the `Axis votes: ... over N available axes` line is what reports that.
 */
function unavailableLine(axis: string, kind: string, required: number, received: number): string {
  return `Unavailable: ${kind} (${axis} axis) needed ${required} bars, had ${received}`;
}

/**
 * Reports one unavailable axis: the counter, then the rendered line.
 *
 * The counter is `technical_indicator_unavailable{kind}` and is emitted through
 * `AnalystTelemetry`, which the production composition root wires to the
 * logger (`production.ts`). `AnalystInput.telemetry` is REQUIRED (#790, a
 * no-op default when there is no real sink) so this call is never guarded —
 * `production.test.ts` still asserts the COMPOSITION ROOT wires the LOGGING
 * sink specifically, not merely that some sink was supplied.
 */
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

/** The `momentum` axis reading — RSI, with MACD folded in when readable */
function momentumReading(core: CoreReads, macd: number | undefined): AxisReading {
  const momentum = momentumVote(core.rsi, macd);
  const rsiBand =
    core.rsi >= RSI_OVERBOUGHT
      ? 'overbought'
      : core.rsi <= RSI_OVERSOLD
        ? 'oversold'
        : core.rsi > 50
          ? 'above midline'
          : core.rsi < 50
            ? 'below midline'
            : 'at midline';
  const macdPart =
    macd === undefined
      ? ''
      : `; MACD(${MACD_FAST},${MACD_SLOW},${MACD_SIGNAL}) histogram ${macd} ` +
        `${macd > 0 ? 'above' : macd < 0 ? 'below' : 'at'} signal`;
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
  const band =
    vote > 0 ? 'upper third of range' : vote < 0 ? 'lower third of range' : 'mid range';
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
  // `availableAxes` is never 0: trend and momentum are core, so both are always
  // present by the time this runs. Guarded anyway rather than divided blindly —
  // a NaN confidence would reach a live sizing multiplier
  const raw = availableAxes === 0 ? 0 : Math.abs(net) / availableAxes;
  return round4(capReasons.length > 0 ? Math.min(raw, LOW_CONVICTION_CAP) : raw);
}

/**
 * Turns the reads into votes, a direction and a confidence — the whole decision
 * rule, as a pure function so the tests can drive it directly instead of
 * through a market-data double.
 *
 * `confidence = |net| / availableAxes`. An UNAVAILABLE axis leaves the
 * denominator entirely; it is never counted as a zero vote, because those two
 * are different claims: "participation says nothing" is evidence of balance,
 * "participation is unreadable" is an absence of evidence, and averaging the
 * second into the first silently dilutes every real vote. A cold instrument
 * with only trend and momentum readable and both bullish therefore reports
 * confidence 1.0 on 2 axes, not 0.5 on 4.
 *
 * The shrink has ONE mechanism and this function is all of it: an axis with no
 * readable input never gets a `readings` entry, so it is absent from the
 * numerator and the denominator alike. It deliberately takes no list of
 * unavailable axes — a second input that the arithmetic did not consult would
 * read as the thing enforcing the shrink while enforcing nothing. The caller
 * owns the unavailability lines and the counters; this owns the arithmetic.
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
 * The RVOL `key_points` line (#797) — INFORMATIONAL ONLY, and that is the
 * recorded decision, not an omission.
 *
 * ## Option 1 of the three #797 put up, and why
 *
 * #797 offered (1) an informational line, (2) a new axis or a second reading
 * on the participation axis, (3) reconciling RVOL with the participation axis.
 * This is **option 1**. RVOL feeds NO vote: it is absent from `TechnicalAxis`,
 * absent from `VOTING_AXES`, and never reaches `assessAxes` — it is rendered
 * from the returned view alone, so `direction`, `net`, `availableAxes` and
 * `confidence` are byte-identical with and without it
 * (`technical-rvol.test.ts` asserts exactly that).
 *
 * Option 2 was NOT taken, and deliberately: #745's rule is ONE VOTE PER AXIS,
 * and that rule is what justified cutting #744's indicator batch from ten
 * kinds to five. Adding a vote — a sixth axis, or a second reading folded into
 * participation — is a design change to a live-money debate path, not a wiring
 * change. It would need the rule reconciled explicitly rather than quietly
 * widened, and that is the owner's call. Same reason `computeSessionVwap`
 * (#746) is informational above.
 *
 * Option 3 is ADOPTED, not overturned — and it is already written down at
 * `upVolumeShare`'s doc comment above ("Reconciled with #747's `computeRvol`,
 * deliberately NOT sharing a definition"). RVOL is unsigned magnitude against
 * a baseline; `upVolumeShare` is a signed directional split of the volume that
 * did participate. Different questions, different inputs (a calendar vs.
 * none). That judgement stands; this call site consumes it rather than
 * re-deciding it, and shares its volume-caveat posture below.
 *
 * ## The volume caveat (#744), enforced rather than merely documented
 *
 * On a 3x leveraged ETP, volume is market-maker and wrapper flow, not informed
 * flow — so RVOL there measures the wrapper, not the tape, which is close to
 * meaningless for what RVOL is supposed to measure. #749 has since landed
 * `screening_instrument` (the liquid US underlying) as a named identity, so
 * the question "is this instrument a wrapper" is now ANSWERABLE here, and
 * `screeningInstrumentFor` answers it.
 *
 * What is NOT possible from this analyst's inputs is FETCHING the underlying's
 * bars, and that limit is structural rather than an oversight:
 * `AssetClassRoutingDataSource#routeFor` throws a bare `Error` for any
 * instrument absent from `assetClassOf`, which `production/defaults.ts` builds
 * from `ProductionConfig.universe` alone — and #749's pool is deliberately not
 * wired into any running profile's universe (that is #751's job, gated on
 * #800). So `market_data.getBars(screening_instrument, ...)` would throw
 * inside a `role: 'mandatory'` analyst and forfeit the whole tick as a
 * `quorum_skip`. THAT is the recorded deviation, and it is recorded HERE, at
 * the call site, per #797's own acceptance criterion.
 *
 * The deviation is bounded and self-announcing rather than silent:
 *
 * - Today's configured universes hold only liquid US instruments (SPY, QQQ,
 *   AAPL, TSLA), for which the traded instrument IS the informed instrument
 *   and no caveat is owed. `screeningInstrumentFor` returns `null` and the
 *   line carries no caveat, because there is nothing to caveat.
 * - The moment #751 wires ETP lines into a universe, `screeningInstrumentFor`
 *   returns a real underlying and this line RENDERS the caveat into the debate
 *   prompt itself, naming the wrapper, the informed instrument, and this
 *   ticket. Nobody has to remember to revisit it; the prompt says so.
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

    // Awaited BEFORE the reads below, on purpose (#742): this is the shared 5m
    // warm-up fetch. Every 5m spec's own getIndicator call is then served from
    // the store instead of triggering its own DataSource.fetchBars — and, as of
    // #745, it is ALSO the window the enrichment pre-checks count against, so
    // the availability decision and the data are the same read
    const technicalBars = await input.market_data.getBars(signal.asset, technicalWindow, asOf);

    const lastCandle = technicalBars.at(-1);
    if (!lastCandle) {
      throw new Error(
        `No ${INDICATOR_TIMEFRAME} bars for ${signal.asset} at or before ${asOf.toISOString()}`,
      );
    }

    // CORE. No pre-check, no catch: a short window here forfeits the instrument
    // for the tick, exactly as it did before #745
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

    // Order matters only for the rendered line order, which follows the axis
    // order the summary reports
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

    // #746 — session-anchored VWAP, informational only: no vote, no cap, no
    // change to `assessAxes`'s arithmetic. Reuses `technicalBars` (the same
    // shared 5m warm-up window every core/enrichment read above is served
    // from) rather than issuing its own fetch. `input.calendar` is resolved
    // by the orchestrator per `signal.asset_class`
    // (`AnalystOrchestratorDeps.sessionCalendars`); not caught here, on
    // purpose — a calendar that cannot answer at all (`TradingCalendar`'s
    // documented throw) is exactly as fatal to this mandatory analyst as a
    // misordered bar feed, and containment is the same tick-loop backstop
    // `computeIndicator`'s own doc comment traces
    //
    // Computed on `signal.asset` — the traded instrument, which on the live
    // equity leg is the leveraged ETP, not its liquid US underlying. #744's
    // volume caveat applies here exactly as it would to a registry indicator
    // kind: this instrument's volume is market-maker/wrapper flow, not
    // informed flow. Routing this at the underlying instead would need a
    // screening/underlying-instrument identity this codebase does not have —
    // see `session-features.ts`'s doc comment for why that gap is recorded
    // rather than papered over
    const session = computeSessionVwap(technicalBars, input.calendar, asOf);
    const sessionLine =
      session.vwap === null
        ? `Session VWAP (${INDICATOR_TIMEFRAME}): no session to anchor to`
        : `Session VWAP (${INDICATOR_TIMEFRAME}): ${session.vwap} — price ${lastCandle.close} is ` +
          `${(session.distance_from_vwap as number) >= 0 ? '+' : ''}${session.distance_from_vwap} from it`;

    // #797 — RVOL, informational only: no vote, no cap, no change to
    // `assessAxes`'s arithmetic. See `rvolLine`'s doc comment for the recorded
    // decision (option 1 of three), the one-vote-per-axis reasoning, and the
    // recorded volume-caveat deviation
    //
    // A SEPARATE, WIDER window than `technicalBars` — see `RVOL_5M_LOOKBACK`
    // for why 260 bars cannot serve it and for the per-tick fetch cost. Awaited
    // on its own rather than joined into either `Promise.all` above: both of
    // those already read this instrument+timeframe, and two concurrent source
    // fetches for one (instrument, timeframe) race on the store write
    const rvolBars = await input.market_data.getBars(
      signal.asset,
      { timeframe: INDICATOR_TIMEFRAME, lookback: RVOL_5M_LOOKBACK },
      asOf,
    );
    const rvol = computeRvol(rvolBars, input.calendar, asOf);
    const rvolText = rvolLine(signal.asset, rvol, screeningInstrumentFor(signal.asset));

    // No fallback numeric here on purpose: an empty context read has no
    // volume to average, and reporting "avg volume 0" would be a fabricated
    // claim about the tape, not an approximation (the same fabrication class
    // #319 made computeIndicator throw on rather than silently answer)
    // `direction`/`confidence` never depend on this string, so an absent 1h
    // context degrades the prose only, never the decision
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
