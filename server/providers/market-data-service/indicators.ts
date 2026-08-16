/**
 * Deterministic technical-indicator computation (ticket #65).
 * See docs/specs/market-data-service-spec.md (Module: Indicators):
 * "a vetted TA computation with fixed rounding; no floating nondeterminism."
 * Computed here — never inside analysts — so analysts stay stateless.
 */
import { type Bar, INDICATOR_KINDS, type IndicatorKind, type IndicatorSpec } from './types.js';

/** Fixed rounding so repeated computations are byte-identical. */
const ROUNDING_PRECISION = 8;

function round(value: number): number {
  return Number(value.toFixed(ROUNDING_PRECISION));
}

function closes(bars: Bar[]): number[] {
  return bars.map((bar) => bar.close);
}

function sma(values: number[], period: number): number {
  const window = values.slice(-period);
  const sum = window.reduce((acc, value) => acc + value, 0);
  return sum / window.length;
}

function ema(values: number[], period: number): number {
  const seedWindow = values.slice(0, period);
  const smoothing = 2 / (period + 1);
  let emaValue = seedWindow.reduce((acc, value) => acc + value, 0) / seedWindow.length;

  for (const value of values.slice(period)) {
    emaValue = value * smoothing + emaValue * (1 - smoothing);
  }

  return emaValue;
}

/** Pairwise differences: [values[1]-values[0], values[2]-values[1], ...]. */
function diffs(values: number[]): number[] {
  const result: number[] = [];
  let previous: number | undefined;
  for (const value of values) {
    if (previous !== undefined) {
      result.push(value - previous);
    }
    previous = value;
  }
  return result;
}

function rsi(values: number[], period: number): number {
  const changes = diffs(values);
  const seedChanges = changes.slice(0, period);

  let avgGain =
    seedChanges.filter((change) => change > 0).reduce((acc, change) => acc + change, 0) / period;
  let avgLoss =
    seedChanges.filter((change) => change < 0).reduce((acc, change) => acc - change, 0) / period;

  for (const change of changes.slice(period)) {
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(bars: Bar[], period: number): number {
  const trueRanges: number[] = [];
  let previousClose: number | undefined;
  for (const current of bars) {
    if (previousClose !== undefined) {
      trueRanges.push(
        Math.max(
          current.high - current.low,
          Math.abs(current.high - previousClose),
          Math.abs(current.low - previousClose),
        ),
      );
    }
    previousClose = current.close;
  }

  const seedRanges = trueRanges.slice(0, period);
  let atrValue = seedRanges.reduce((acc, range) => acc + range, 0) / seedRanges.length;

  for (const range of trueRanges.slice(period)) {
    atrValue = (atrValue * (period - 1) + range) / period;
  }

  return atrValue;
}

/**
 * Ascending order is this module's precondition, so it is asserted here
 * rather than trusted — every production indicator computation funnels
 * through `computeIndicator` (`service.ts` `getIndicator`, `trader/decide.ts`,
 * `proxy-strategy.ts`, `replay-driver.ts`), and each one of them either
 * documents ascending bars or inherits the guarantee from
 * `MarketDataService.getBars`. A documented contract is not an enforced one:
 * a source that returned a descending or interleaved window would feed
 * reversed true-range legs into `atr` and silently reprice every stop derived
 * from it, with no error anywhere. Cost is one pass over ~15 bars, against an
 * indicator that already walks them.
 *
 * Throwing, not sorting: a misordered window means the data source is broken,
 * and quietly repairing it here would hide that from every other consumer of
 * the same feed. Contained by design — `production.ts`'s tick loop logs the
 * throw and forfeits one tick rather than the run, and the backtest lets it
 * propagate deliberately (`backtest.ts`). This is the posture `replay-driver`'s
 * `BarCursor` already takes on the same contract, for the same reason.
 *
 * Non-decreasing rather than strictly increasing: an inversion is the failure
 * mode that corrupts the maths; equal close_times do not reorder anything.
 */
function assertAscending(bars: Bar[]): void {
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1] as Bar;
    const current = bars[i] as Bar;
    if (current.close_time.getTime() < previous.close_time.getTime()) {
      throw new Error(
        `computeIndicator: bars must be ascending by close_time — ` +
          `${current.close_time.toISOString()} follows ${previous.close_time.toISOString()} ` +
          `at index ${i}. Computing over a misordered window would silently produce a wrong ` +
          'indicator value rather than fail.',
      );
    }
  }
}

/**
 * Raised when a window is too short for the period it is asked to compute
 * over (issue #319). Typed rather than a bare `Error` so "this window is too
 * short" stays distinguishable from "this feed is misordered"
 * (`assertAscending`) — the latter must keep propagating and forfeit the tick,
 * never be absorbed into a skip, and a bare `Error` would make a `catch`
 * unable to tell them apart. No production caller catches it today
 * (`trader/decide.ts` pre-checks `minimumBarsFor` instead, which is why it can
 * skip without a `catch` at all); the type is what keeps that option open and
 * what the tests assert on rather than a message regex.
 *
 * Carries the numbers a human needs rather than only a message, matching
 * `AlpacaDataUnderfetchError`'s shape (the client-level half of this same
 * failure family, #292): a caller that wants to degrade can read `received`
 * and `required` instead of re-parsing the text. Never retryable — repeating
 * the request cannot conjure bars that do not exist.
 */
export class InsufficientBarsError extends Error {
  /** `spec.indicator` — 'sma' | 'ema' | 'rsi' | 'atr'. */
  readonly indicator: string;
  /** The period actually asked for (`params.period ?? lookback`). */
  readonly period: number;
  /** Bars this indicator needs before it can produce a genuine `period`-length value. */
  readonly required: number;
  /** Bars the window actually held. */
  readonly received: number;

  constructor(details: { indicator: string; period: number; required: number; received: number }) {
    super(
      `computeIndicator: ${details.indicator}(${details.period}) needs ${details.required} ` +
        `bars but received ${details.received}. Computing it anyway would present a value ` +
        `derived from ${details.received} bars as a ${details.period}-period one — a ` +
        'fabricated indicator, not a degraded one, and every stop sized from it is mispriced.',
    );
    this.name = 'InsufficientBarsError';
    this.indicator = details.indicator;
    this.period = details.period;
    this.required = details.required;
    this.received = details.received;
  }
}

/**
 * `params.period` selects the indicator's own window inside the pinned
 * lookback; absent, the full lookback IS the period.
 *
 * A non-positive or non-integer period is rejected rather than tolerated:
 * `sma`'s `slice(-period)` at `period = 0` returns the WHOLE array (`-0 === 0`)
 * and would answer a full-window mean labelled a 0-period one; a `NaN` period
 * makes every length comparison below false; and a FRACTIONAL period seeds
 * over `slice`'s truncated count while `rsi`/`atr` divide by the untruncated
 * one. All three are the same silent fabrication this module now refuses.
 *
 * This throws on a path `atrFor` does NOT guard (it calls `minimumBarsFor`
 * outside any catch), so it is only safe because no period in this repo is
 * computed: `TraderConfig.atr_lookback` is the literal 14 in
 * `DEFAULT_TRADER_CONFIG`, spread unchanged by `paper-profile.ts`, and the
 * Feedback Loop's `strategy_params` dials are written to the tuning store
 * only — nothing feeds a tuned value back into an `IndicatorSpec`. If that
 * ever changes, a stepped dial is exactly how a fractional period would
 * arrive, and this check would turn a mispriced tick into a dead one; revisit
 * it then rather than assuming it stays free.
 */
/**
 * One definition per kind, replacing the two parallel `switch` statements that
 * `minimumBarsFor` and `computeIndicator` used to carry (#703 step B2).
 *
 * They were parallel in the literal sense: adding a kind meant editing both,
 * and adding it to only the second is a silent, specific bug rather than a
 * missing case. `minimumBarsFor`'s `default` threw `Unsupported indicator`,
 * so a kind present only in `computeIndicator` would have thrown from the
 * ARITY check with a message saying the indicator does not exist — while the
 * arithmetic for it sat right there. Worse in the other direction: a kind whose
 * arity was declared `period` when it consumes a predecessor computes over
 * `period - 1` deltas and divides by `period`, which is a fabrication that
 * returns a plausible number. This repo has paid for that exact mistake twice
 * (the ATR off-by-one at `decide.ts:47-53`, the RSI(13)-labelled-14 at
 * `technical-analyst.ts:40-49`).
 *
 * `Record<IndicatorKind, IndicatorDefinition>` makes both a compile error: the
 * union has no member without a row, and no row can omit its arity.
 */
interface IndicatorDefinition {
  /**
   * Bars consumed purely to seed a predecessor, on top of `period`.
   *
   * `1` for `rsi` (the prior close, to form the first change) and `atr` (the
   * previous close, for the true range's two gap legs). `0` for `sma`/`ema`,
   * which read the closes directly. This IS the "N bars yield N-1 deltas" rule,
   * stated once as data instead of twice as control flow.
   */
  readonly seedBars: 0 | 1;
  /**
   * Does the value depend on history BEYOND its window — i.e. does a longer
   * warm-up change the answer for the same final bar?
   *
   * Drives `recommendedWarmupFor` and nothing else. `sma` is false: its value
   * is `slice(-period)` and is warm-up-blind. `ema`, `rsi` and `atr` are true:
   * each seeds over the first `period` and folds the remainder, so the seed's
   * influence decays but never vanishes.
   */
  readonly recursive: boolean;
  /** Takes the full window; each kind slices what it needs. Rounding is the caller's. */
  readonly compute: (bars: Bar[], period: number) => number;
}

const INDICATORS: Record<IndicatorKind, IndicatorDefinition> = {
  sma: { seedBars: 0, recursive: false, compute: (bars, period) => sma(closes(bars), period) },
  ema: { seedBars: 0, recursive: true, compute: (bars, period) => ema(closes(bars), period) },
  rsi: { seedBars: 1, recursive: true, compute: (bars, period) => rsi(closes(bars), period) },
  atr: { seedBars: 1, recursive: true, compute: (bars, period) => atr(bars, period) },
};

/**
 * Looked up rather than indexed, and it still throws.
 *
 * `IndicatorSpec.indicator` is typed `IndicatorKind`, so this is unreachable
 * for a well-typed caller — and there is no unvalidated path today either:
 * the orchestrator contains no `JSON.parse` at all, so
 * `ProductionConfig.volatilityIndicator` is written in TypeScript rather than
 * loaded, and the golden fixture — the one place an unknown kind can arrive —
 * is checked at its own parse boundary.
 *
 * So this is a BACKSTOP with no current caller, and is stated as one rather
 * than justified by a config file that does not exist. It stays because a
 * cast (`as IndicatorKind`) silences the compiler at any call site, and
 * unchecked the failure reads `.compute is not a function` — naming neither
 * the spec nor the kind.
 */
function definitionFor(indicator: IndicatorKind): IndicatorDefinition {
  const definition = INDICATORS[indicator];
  if (definition === undefined) {
    throw new Error(
      `Unsupported indicator: ${indicator}. Known kinds: ${INDICATOR_KINDS.join(', ')}.`,
    );
  }
  return definition;
}

function periodOf(spec: IndicatorSpec): number {
  const period = spec.params.period ?? spec.lookback;
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(
      `computeIndicator: ${spec.indicator} period must be a positive integer, got ${period}. ` +
        'A zero, negative or non-integer period yields a value computed over an unrelated ' +
        'window rather than an error.',
    );
  }
  return period;
}

/**
 * How many bars `spec` needs before it can produce a genuine `period`-length
 * value. Exported so a caller that must DEGRADE rather than fail — today only
 * `trader/decide.ts`'s `atrFor`, which returns null so `buildBracket` skips
 * the trade — can ask the arity question up front instead of catching the
 * throw. Catch-based control flow there would also have to be narrow enough
 * not to swallow `assertAscending`'s error, which `production.ts` deliberately
 * lets surface as a forfeited tick.
 *
 * The `+ 1` on `rsi`/`atr` is the same "N bars yield N-1 deltas" rule
 * `atrIndicatorSpec` and `DEFAULT_VOLATILITY_INDICATOR` already encode: both
 * consume the first bar only to seed a predecessor (`previousClose` for the
 * true range; the prior close for the RSI change). `sma`/`ema` read the closes
 * directly, so they need exactly `period`.
 */
export function minimumBarsFor(spec: IndicatorSpec): number {
  const definition = definitionFor(spec.indicator);
  return periodOf(spec) + definition.seedBars;
}

/**
 * A warm-up long enough that one more bar no longer moves the value — the
 * WIDTH question, kept strictly separate from `minimumBarsFor`'s ARITY one.
 *
 * B1 measured what the difference costs. All three live specs (`RSI_SPEC`,
 * `atrIndicatorSpec(14)`, `DEFAULT_VOLATILITY_INDICATOR`) sit at exactly
 * `minimumBarsFor`, so `changes.slice(period)` is empty and the smoothing loop
 * runs ZERO times: what the debate reads as "RSI(14)" is the simple-mean seed,
 * Cutler's RSI rather than Wilder's. Against a converged warm-up on the same
 * bar that is a median 4.6 RSI points, p90 12.0, and it flips the 70/30
 * overbought/oversold classification on 18% of bars —
 * `docs/reviews/indicator-characterisation-2026-08-16.md` F1/F2.
 *
 * **`minimumBarsFor` is deliberately NOT raised to this.** It is the
 * fabrication floor: below it every kind here answers with a window it did not
 * have, which is why #319 made it throw. `trader/decide.ts:126` pre-checks
 * against it precisely to decide whether a genuine value is obtainable at all.
 * Raising it would turn "this number would be better with more history" into
 * "this instrument cannot trade", forfeiting cold-start ticks over a warm-up
 * preference. The two questions have different answers and different
 * consequences, so they get different functions.
 *
 * `4 x period + 1` is ~98% convergence for a Wilder smoother (each step retains
 * `(period - 1) / period`, so `0.929^56 ~ 0.016` of the seed survives at
 * period 14) and is the conventional figure rather than a fitted one — nothing
 * here is permitted to search it, since ADR-0018 D4 caps the selection budget
 * and a warm-up chosen by outcome is a fitted parameter.
 *
 * Windowed kinds get `minimumBarsFor` back unchanged. That is not a shortcut:
 * `sma` reads `slice(-period)` and its value is warm-up-BLIND, pinned by
 * `rsi-warmup.test.ts` at 14 bars of history against 400.
 *
 * Adopting this for a live spec is a separate, deliberate decision — it
 * reprices every technical opinion in the system at once — and belongs to the
 * wayfinder map, not to this function existing.
 */
export function recommendedWarmupFor(spec: IndicatorSpec): number {
  const definition = definitionFor(spec.indicator);
  const period = periodOf(spec);

  return definition.recursive ? 4 * period + 1 : period + definition.seedBars;
}

/**
 * Computes `spec.indicator` deterministically over `bars` — a close-time-
 * filtered, ascending-by-close_time window whose length is the pinned
 * `spec.lookback`. `params.period` selects the indicator's own window
 * within that lookback (defaults to the full lookback for sma/ema/rsi).
 *
 * Throws if `bars` is not ascending (`assertAscending`), or if the window
 * holds fewer than `minimumBarsFor(spec)` bars (`InsufficientBarsError`).
 *
 * THROWING, not returning a degraded value, is the failure mode (issue #319).
 * Every unguarded short-window answer here is a FABRICATION rather than an
 * approximation — `atr` divides by `seedRanges.length`, so 3 bars at
 * `period: 14` answers a 2-range mean presented as ATR(14); `sma` means
 * whatever `slice(-period)` found; `rsi` divides by `period` regardless of how
 * many changes it actually saw. There is no caller that can use such a number
 * safely, and the two consumers that must not simply die already convert a
 * throw into their own explicit degraded state: `atrFor` skips the trade
 * (via `minimumBarsFor`, before the call), and
 * `MarketDataVolatilityReadingProvider` fails CLOSED, aggregating a rejected
 * `getIndicator` as `FAILURE_READING` (`Infinity`) so the volatility breaker
 * trips conservatively instead of going inert. Returning `null` here would
 * instead push a new nullable through every consumer, and the ones that forgot
 * to handle it would land back at a `NaN` sizing a live stop.
 *
 * Containment was checked, not assumed, because this path fires far more often
 * than `assertAscending` ever did (a cold instrument, a fresh DB after
 * restart, a venue gap). No throw from here escapes one instrument's pass:
 * the technical analyst's SMA/RSI reject inside
 * `AnalystOrchestrator.runAnalysts`'s per-persona `catch`, which records the
 * reason and — technical being `mandatory` — returns an empty view set, so
 * `SequentialTickRunner` short-circuits that instrument at `analysts` with a
 * logged `quorum_skip`; `simulated-adapter`'s `buildMarketState` surfaces as
 * an `error` execution result; and `production.ts`'s tick loop is the
 * backstop that costs one tick rather than the run. Note `runTickPlan` has no
 * per-instrument catch of its own, so that backstop is the only one below the
 * process — which is why every consumer above converts rather than propagates.
 *
 * The length guard is checked AFTER the ordering guard on purpose: a
 * misordered window means a broken FEED, which is the more actionable
 * diagnosis, so it must not be masked by a length complaint when a window
 * happens to be both.
 */
export function computeIndicator(bars: Bar[], spec: IndicatorSpec): number {
  assertAscending(bars);
  const period = periodOf(spec);

  const required = minimumBarsFor(spec);
  if (bars.length < required) {
    throw new InsufficientBarsError({
      indicator: spec.indicator,
      period,
      required,
      received: bars.length,
    });
  }

  return round(definitionFor(spec.indicator).compute(bars, period));
}
