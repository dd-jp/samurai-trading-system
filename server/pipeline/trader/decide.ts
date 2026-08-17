/**
 * Trader core decision — DebateResult -> OrderIntent bracket (tickets #73,
 * #74). See docs/specs/trader-spec.md (Module: Trader Core, Module: Position
 * Sizing, Module: Side Derivation, Module: Non-Convergence & Skip Policy,
 * Module: Position Awareness).
 *
 * Mechanical and deterministic: no LLM, no hidden state. The same code path
 * runs live and in replay; only the injected Clock and the data behind
 * MarketDataService differ.
 *
 * Cosine precedent retrieval (#75) is wired in here as of #432; before that
 * this module hardcoded the no-precedent default on every intent, which meant
 * a permanent 0.75x haircut on every position the system ever took.
 */
import {
  type Bar,
  computeIndicator,
  type IndicatorSpec,
  minimumBarsFor,
} from '../../providers/market-data-service/index.js';
import {
  type ExitReason,
  heldQuantitiesFor,
  type OpenPosition,
  type OrderIntent,
  totalHeldQuantity,
} from '../../shared/index.js';
// TYPE-only, and from the defining module rather than the debate-engine
// barrel, for the reason the deleted `floorToBar` import used to state: the
// barrel pulls the whole engine's module graph into the Trader path. A type
// import is erased at compile time, so this adds no runtime edge — and it is
// deliberately the ONLY thing this module now takes from the debate engine.
// The bar grid (`floorToBar`, `DEBATE_BAR_TIMEFRAME_MS`) used to be imported
// here as values so the Trader could re-derive the decision bar; it no longer
// is, because the Trader no longer derives it (#687).
import type { DebateResult } from '../debate-engine/types.js';
import { NO_PRECEDENT_MULTIPLIER, retrieveCosinePrecedent } from './cosine-precedent.js';
import { readSignalDecay } from './early-exit.js';
import { computeIdempotencyKey, intentSideFor } from './idempotency-key.js';
import { buildSetupVector } from './setup-vector.js';
import type { AssetClass, TraderConfig, TraderInput } from './types.js';

/** trader-spec.md Module: Side Derivation. `neutral` has no directional edge to act on. */
function sideFor(direction: 'bullish' | 'bearish'): 'buy' | 'sell' {
  return direction === 'bullish' ? 'buy' : 'sell';
}

/**
 * The exact `IndicatorSpec` Trader asks the Market Data Service for. Exported
 * so `atr-equivalence.test.ts` can pin THIS spec rather than a hand-rebuilt
 * copy of it — a duplicate would keep passing if the real one drifted, which
 * is the whole failure mode that test exists to catch. Module-internal: it is
 * deliberately not re-exported from `trader/index.js`.
 *
 * `params.period` is pinned explicitly rather than left to
 * `computeIndicator`'s `params.period ?? spec.lookback` fallback — with
 * `spec.lookback` being the BAR-WINDOW width (`atr_lookback + 1`, matching
 * `DEFAULT_VOLATILITY_INDICATOR`), that fallback would silently make this an
 * ATR(15), the exact off-by-one commit 0281a8c already had to fix once.
 */
export function atrIndicatorSpec(lookback: number, timeframe: string): IndicatorSpec {
  return {
    indicator: 'atr',
    params: { period: lookback },
    // Passed in rather than defaulted (#315). This spec describes the bars the
    // caller fetched with `config.atr_timeframe`, and a default here would let
    // the two drift — the spec claiming 1h while the ATR was computed on
    // something else, which reprices every stop without changing a test.
    timeframe,
    lookback: lookback + 1,
  };
}

/**
 * Average true range for the stop, computed by the Market Data Service's
 * indicator registry rather than by Trader (ticket #304 — #65 landed the
 * registry, which retired the private copy Trader carried while #65 was
 * open). Indicator maths lives in exactly one place now, so the
 * "N bars yield N-1 true ranges" seeding rule cannot be fixed in one
 * implementation and left wrong in the other.
 *
 * Returns null on any ATR that cannot size a stop. BOTH guards below are
 * load-bearing, and they cover different failures:
 *
 * - Too little history. Since #319 `computeIndicator` THROWS
 *   (`InsufficientBarsError`) rather than answering a short-window mean
 *   labelled ATR(`lookback`), so the length check is what keeps Trader on its
 *   existing skip path instead of letting that throw kill the tick. It asks
 *   `minimumBarsFor` — the module that owns the arity — rather than restating
 *   a number here, so the two cannot drift apart; a hardcoded `< 2` was the
 *   old check, and it let 3 bars through as an "ATR(14)" computed from two
 *   true ranges, which is a mispriced stop, not a rough one.
 *   Deliberately a pre-check and not a `try`/`catch`: catching would also have
 *   to be narrow enough to re-throw `computeIndicator`'s ascending-order
 *   error, which `production.ts` means to surface as a forfeited tick.
 * - Corrupt bar data (one non-numeric high/low) poisons a true range on an
 *   otherwise well-sized window and returns NaN. Nothing about the window's
 *   LENGTH catches that, so `Number.isFinite` is still the only thing standing
 *   between Trader and a NaN intent on a full-width window.
 *
 * NaN must not be allowed downstream at all: it passes straight through
 * `Math.max`, the `stopDistance <= 0` check and the min-notional check (every
 * comparison against NaN is false) and lands in an EMITTED OrderIntent with
 * NaN size, stop and target. Verified, not assumed — reverting
 * `Number.isFinite` reproduces exactly that intent in the "returns null when
 * the computed ATR is not finite" test.
 *
 * Bars are consumed in the order `getBars` returns them — ascending by
 * close_time, which is the documented contract of
 * `MarketDataService.getBars`, the interface Trader is actually injected, and
 * which `computeIndicator` now ENFORCES rather than merely documenting (it
 * throws on a misordered window). Trader used to re-sort defensively; that
 * check belongs at the one place every indicator computation passes through,
 * not in every consumer of it.
 */
function atrFor(
  bars: Bar[],
  lookback: number,
  timeframe: string,
): { atr: number; reason: null } | { atr: null; reason: TraderSkipReason } {
  const spec = atrIndicatorSpec(lookback, timeframe);

  // `lookback + 1` bars yield `lookback` true ranges — the arity lives in
  // `minimumBarsFor`, not in a literal here. Skipping the trade is the only
  // safe answer: a stop cannot be priced off an ATR that does not exist.
  //
  // The two failures are reported SEPARATELY (#475) because they mean opposite
  // things operationally: a short window is a warm-up or a data gap and is
  // expected early in a soak, while a non-finite ATR on a full window means
  // corrupt bar data and is never expected. Collapsing them to one null — as
  // this did — made the benign case and the alarming one indistinguishable in
  // `trader_log`.
  if (bars.length < minimumBarsFor(spec)) return { atr: null, reason: 'atr_insufficient_bars' };

  const atr = computeIndicator(bars, spec);
  return Number.isFinite(atr) ? { atr, reason: null } : { atr: null, reason: 'atr_not_finite' };
}

/**
 * `withinFlattenWindow`'s answer, plus anything it noticed getting there (#698).
 *
 * A pair rather than a bare boolean because the two callers need the boolean and
 * the DIAGNOSTIC needs to survive both of them: the entry path turns `within`
 * into a skip and the holding path turns it into an exit intent, so a diagnostic
 * carried on the skip alone would be dropped on exactly the flatten it describes.
 */
interface FlattenWindowVerdict {
  within: boolean;
  diagnostic: TraderDiagnostic | null;
}

/**
 * Is `now` inside the flat-by-close window for this asset class (#668)?
 *
 * The window is `[sessionEnd − flatten_before_close_ms, sessionEnd)`, resolved
 * through the INSTRUMENT'S OWN calendar rather than a wall-clock constant —
 * 16:00 ET for the Alpaca paper venue, 16:30 London for the live LSE leg, and
 * 12:30 on an LSE half-day. #656 measured only a two-hour overlap between those
 * two sessions, so a single shared constant would be wrong for one of them.
 *
 * **A `null` session end means "no close", and returns false.** That is crypto,
 * and it is not an oversight: what flat-by-close should mean for a leg whose
 * venue never shuts is an open thesis amendment (#667) that is David's to make.
 * #668 is explicit that a crypto flatten must not be implemented ahead of it.
 * The honest reading is that the risk the rule guards — a stop that cannot fill
 * because the market is closed — does not exist on a 24/7 venue with a live
 * bracket leg.
 *
 * **A past close is stated explicitly, and it changes nothing (#691).** The
 * `remaining < 0` branch below is documentation-as-code, NOT a behaviour
 * change: `remaining <= flatten_before_close_ms` was already true for every
 * negative `remaining`, so a past close has always meant "flatten". The branch
 * exists because that was reached by accident of a comparison rather than by
 * decision, and reviewers twice reasoned about it wrongly — including the first
 * cut of this very change.
 *
 * Flattening IS the right answer, which is why the branch only restates it.
 * `sessionEnd <= now` says the session has already ended, and the response to
 * "the market is shut and we are holding" is the same whether the calendar is
 * broken or merely surprising: be flat. On the entry path the same `true` means
 * "inside the window", so nothing new opens. A permanently-wrong calendar
 * therefore parks the book flat and stops trading — a halt, but a safe one.
 *
 * The two alternatives are both worse, and both were tried. Returning FALSE
 * would decline to flatten while the market is shut, which is the overnight
 * carry #668 exists to prevent. THROWING was this change's first cut, and
 * review killed it: this check is the FIRST branch of the held-position path,
 * so a throw takes the whole decision down on every tick — including the
 * direction-flip exit two branches below — stranding exposure the system could
 * then neither flatten nor exit.
 *
 * **Audibility is what #698 added, and it did not change any answer above.**
 * A calendar this broken should raise an alert, and `TraderInput` still carries
 * no logger to raise one from — so this reports the condition as DATA on the
 * returned verdict, and the adapter that already writes `trader_log` turns it
 * into an alert. Every `within` value below is exactly what it was before.
 */
function withinFlattenWindow(
  input: Pick<TraderInput, 'clock' | 'config' | 'sessionCalendars'>,
  assetClass: AssetClass,
): FlattenWindowVerdict {
  // Checked here rather than at construction because `TraderConfig` is a plain
  // interface with no validation seam — nothing between the config literal and
  // this comparison inspects the value. Written as `!(x > 0)` so `NaN` fails
  // too; `x <= 0` would let it through and make the window silently never open.
  //
  // Zero or negative disables flat-by-close ENTIRELY and quietly: the window
  // never opens, the Trader never flattens, and every position carries
  // overnight against ADR-0014 with nothing in `trader_log` marking it. A
  // safety rule that can be switched off by a plausible-looking config value
  // has to say so.
  //
  // This throw DOES take the direction-flip exit down with it — the same
  // stranding the docblock argues against for a past close. The asymmetry is
  // deliberate, and it turns on whether the condition is recoverable. A past
  // close is a live input that may be right, wrong, or transient, and there is
  // a safe answer available (be flat), so the Trader takes it and keeps
  // running. A non-positive window is a static misconfiguration that cannot
  // become valid at the next tick, and every answer it could produce is a lie
  // about whether ADR-0014 is being enforced — so halting the instrument IS the
  // correct outcome, not a side effect tolerated to keep the check cheap.
  //
  // In practice nothing should ever reach this: `assertTraderConfigSound` at
  // the composition root refuses the boot. This is the backstop for callers
  // that never pass through that seam, and there the halt is what you want.
  if (!(input.config.flatten_before_close_ms > 0)) {
    throw new Error(
      `flatten_before_close_ms must be > 0 (got ${input.config.flatten_before_close_ms}); ` +
        `a non-positive window disables flat-by-close, which ADR-0014 requires`,
    );
  }

  const calendar = input.sessionCalendars[assetClass];
  const now = input.clock.now();
  const sessionEnd = calendar.sessionEnd(now);

  if (sessionEnd === null) {
    // Null is the DOCUMENTED answer for crypto — a venue that never closes —
    // and a silent one for anything else, which is the whole #698 complaint:
    // an equity calendar that has quietly stopped resolving sessions returns
    // the identical `false` and never flattens, carrying overnight against
    // ADR-0014 with nothing marking it.
    return {
      within: false,
      diagnostic:
        assetClass === 'crypto'
          ? null
          : {
              kind: 'session_end_absent_on_non_crypto',
              asset_class: assetClass,
              detail:
                `${assetClass} calendar returned no session end at ${now.toISOString()}; ` +
                'flat-by-close cannot be enforced for this leg while that persists',
            },
    };
  }

  const remaining = sessionEnd.getTime() - now.getTime();

  // The session has already ended. Be flat — see the docblock for why this is
  // answered here rather than by throwing, which would take the direction-flip
  // exit down with it and strand the exposure.
  //
  // The answer is unchanged and correct; the DIAGNOSTIC is the new part, and it
  // is alarming on the FIRST occurrence. `sessionEnd` is resolved from
  // `now` immediately above, and a calendar's contract is to answer with the
  // close of the session containing or following that instant — both shipped
  // implementations enforce `close > instant` — so a conforming calendar cannot
  // reach this branch. Reaching it means the calendar is broken, overridden, or
  // has been handed a clock that runs ahead of it. Not "an ordinary tick just
  // after the bell", which an earlier version of this comment claimed and which
  // sent a reviewer looking for a grace threshold the alert must not have
  // (#710). The adapter's repeat throttle bounds the NOISE of a condition that
  // persists; it is not a confidence filter on the first one.
  if (remaining < 0) {
    return {
      within: true,
      diagnostic: {
        kind: 'session_end_in_past',
        asset_class: assetClass,
        detail:
          `${assetClass} calendar resolved a session end of ${sessionEnd.toISOString()}, ` +
          `which is ${Math.round(-remaining / 1_000)}s before now (${now.toISOString()}); ` +
          'the book is being parked flat as a result',
      },
    };
  }

  return { within: remaining <= input.config.flatten_before_close_ms, diagnostic: null };
}

/**
 * The decision's BAR COORDINATE — the input `computeIdempotencyKey` needs to
 * be stable across every tick that shares a bar (#616), and the coordinate the
 * `debate_id` on the very same intent is hashed over (#687).
 *
 * ## It is INHERITED, never derived
 *
 * This function does not compute anything and takes no clock. It reads the bar
 * the Debate stage already floored and carried forward on `DebateResult`
 * (`bar_timestamp`). That is the whole of #687's fix, and the signature is the
 * enforcement: there is no `asOf` to floor, `decide.ts` imports neither
 * `floorToBar` nor `DEBATE_BAR_TIMEFRAME_MS`, and re-deriving the coordinate
 * would take a new import a reviewer can see.
 *
 * ## Two earlier shapes, and why each failed
 *
 * It was first `mark.observed_at`. In backtest that is a real bar coordinate
 * (`deriveBacktestMark` derives it from the bar); **in paper and live it is the
 * venue's latest-quote wire timestamp at millisecond resolution** — Alpaca's
 * `quote.t`, and the same shape in the ccxt and IBKR sources. The mark cache
 * cannot bridge ticks (`markTtlMs` defaults to 5s against a 15-minute tick), so
 * the key changed on every pass and every key-based dedup layer was inert in
 * production at once: local `findByKey`, the `open_positions` primary key
 * backstop, and the broker `client_order_id`. The backtest path kept the
 * invariant looking held, which is why no test caught it (#616).
 *
 * #616 then floored `clock.now()` here. That is stable within a bar, but it is
 * a SECOND clock read: it agreed with the debate's only while both landed in
 * the same bar. A debate that straddles an hour boundary — LLM round-trips,
 * retries, a latency-budget timeout — was logged at bar N and keyed at bar N+1,
 * and bar N+1's own genuine decision then computed the key the straddling
 * intent had already taken and was suppressed as a duplicate (#687).
 *
 * ## What is consequently NOT decided here any more
 *
 * The GRID. A finer grid would collapse several decision bars onto one key, so
 * `findByKey` and the broker `client_order_id` would suppress legitimate
 * orders. The grid now has exactly one statement in the system — `floorToBar`'s
 * `DEBATE_BAR_TIMEFRAME_MS`, applied once in `buildDebateStep` — instead of two
 * that had to be kept saying the same thing. It was never `config.atr_timeframe`
 * and still is not: that is the window the ATR is measured over, a
 * volatility-estimation choice, independently tunable, and keying the
 * order-dedup coordinate on a risk-tuning knob was never the intent.
 *
 * ## What this does NOT fix
 *
 * The straddling intent is still DECIDED late: after the fix its
 * `decision_timestamp` is bar N while the wall clock is in N+1, so Verdict's
 * staleness gate sees an age above one bar and may no-go it. That is the
 * fail-safe direction — refusing a late intent beats corrupting the next bar's
 * key — and it is also, usefully, the marker that tells a straddle apart from
 * an ordinary tick in `trader_log`: `decision_timestamp` no longer floors onto
 * the bar containing `created_at`.
 */
function decisionBarFor(debate: DebateResult): Date {
  return debate.bar_timestamp;
}

/**
 * Threshold-gated linear conviction scaling: 0 at the conviction floor,
 * rising to 1 at conviction 1.0 (trader-spec.md Module: Position Sizing).
 *
 * Anchoring the ramp at 0 rather than at some minimum keeps the floor
 * continuous — conviction a hair above the floor takes a hair of risk,
 * instead of jumping from no-trade to a materially sized position. Sizes
 * that round down to dust near the floor are caught by the min-viable-size
 * skip, which is exactly what the spec asks that skip to do.
 */
function convictionMultiplier(conviction: number, floor: number): number {
  const span = 1 - floor;
  if (span <= 0) return 1;
  return Math.min(1, (conviction - floor) / span);
}

function maxRiskFor(assetClass: AssetClass, config: TraderConfig): number {
  return config.max_risk_per_trade * config.asset_class_risk_multiplier[assetClass];
}

/**
 * Builds a full entry or scale_in bracket, or a NAMED skip (#475). Skips when:
 * conviction is below the floor, ATR cannot be computed, a priced input is not
 * finite, or the resulting position is below the minimum viable notional.
 * Shared by both intent types (trader-spec.md Module: Position Awareness —
 * scale_in sizes exactly like an entry; Risk enforces the exposure cap
 * downstream).
 */
async function buildBracket(
  input: TraderInput,
  intentType: 'entry' | 'scale_in',
  diagnostics: TraderDiagnostic[],
): Promise<TraderOutcome> {
  const { clock, config, debate, equity, instrument, marketData, setupStore } = input;

  // Every caller must have already excluded 'neutral' — sideFor has no
  // direction to derive a side from. Checked here, not just assumed, so the
  // invariant is enforced rather than merely documented.
  if (debate.direction === 'neutral') {
    throw new Error('buildBracket: debate.direction must not be neutral');
  }
  if (debate.confidence < config.conviction_floor) return skip('below_conviction_floor');

  const asOf = clock.now();
  const [mark, bars] = await Promise.all([
    marketData.getMark(instrument, asOf),
    marketData.getBars(
      instrument,
      // lookback + 1 bars yield `lookback` true ranges: each needs its
      // predecessor's close. The `+ 1` is also what keeps the ATR a plain
      // mean of those ranges: `computeIndicator`'s `atr` seeds on the first
      // `period` ranges and Wilder-smooths the rest, so a window wider than
      // this engages that smoothing and moves every stop in the system.
      //
      // Two tests pin the two halves, and neither pins the other's:
      // `atr-equivalence.test.ts` pins the ALGORITHMIC boundary (plain mean
      // at or below `period` ranges, smoothing beyond it); `decide.test.ts`
      // ("fetches exactly atr_lookback + 1 bars ...") pins THIS window, so
      // widening the fetch — or dropping `atr_timeframe` — fails a test
      // rather than silently repricing every stop.
      //
      // A separate fetch-width margin is applied underneath in fetchBars; see #362.
      { timeframe: config.atr_timeframe, lookback: config.atr_lookback + 1 },
      asOf,
    ),
  ]);

  // FLAT BY CLOSE, the opening half (#668). The router's holding branch closes
  // what is open inside the window; this stops the same window from opening
  // something new for the next tick to immediately close again.
  //
  // Not a nicety: on the live leg the round trip is the whole edge. ADR-0018
  // measures a 3x index ETP at 0.18% against a 2.00% take-profit, so a position
  // opened minutes before the close pays that cost for an exposure with no time
  // left to earn it, and the neutral bracket it was sized under assumes a full
  // session to resolve in.
  //
  // Checked AFTER the mark rather than alongside the position branch because
  // the asset class is the MARK's to report — and it is the asset class that
  // picks the calendar, since the crypto and equity legs run different venues
  // inside one process.
  const flattenWindow = withinFlattenWindow(input, mark.asset_class);
  if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);
  if (flattenWindow.within) {
    return skip('session_closing');
  }

  // Bars are still fetched here rather than read through
  // `marketData.getIndicator`, and #315 changed WHY.
  //
  // The old reason is gone: `IndicatorSpec` now carries a timeframe and
  // `getIndicator` builds its window from it, so routing through the serving
  // layer would no longer silently pin ATR to 1h.
  //
  // The remaining reason is what a SHORT window should do, and it is narrower
  // than it first looks. `computeIndicator` throws `InsufficientBarsError`
  // below `minimumBarsFor(spec)` and `getIndicator` propagates it, so routing
  // through the serving layer would NOT silently reprice stops off an
  // under-seeded ATR — it would fail loudly (PR #461 review corrected an
  // earlier version of this comment that claimed otherwise).
  //
  // What differs is the disposition. `atrFor` catches the shortfall itself and
  // returns null, which `decide()` turns into "skip this instrument this
  // tick" — the right answer during a warm-up or a data gap, since a stop
  // cannot be priced off an ATR that does not exist. Repointing would turn
  // that routine skip into a thrown tick. Cheap to fix (catch
  // `InsufficientBarsError` at the call site and return null), but it is a
  // behaviour decision about the Trader rather than a mechanical swap, so it
  // is the remaining step of #315 rather than a line in this one.
  const atrResult = atrFor(bars, config.atr_lookback, config.atr_timeframe);
  if (atrResult.atr === null) {
    // Only the non-finite half is a diagnostic (#698). `atr_insufficient_bars`
    // is a warm-up or a data gap — expected early in a soak, per `atrFor`'s own
    // comment — and alerting it would fire on day 1 for every instrument, which
    // is how an operator learns to mute the channel (ADR-0008 §1's lesson).
    // A non-finite ATR on a FULL window is corrupt bar data and never expected.
    if (atrResult.reason === 'atr_not_finite') {
      diagnostics.push({
        kind: 'atr_not_finite',
        asset_class: mark.asset_class,
        detail:
          `ATR over ${config.atr_lookback} ${config.atr_timeframe} bars for ${instrument} ` +
          'was not finite on a full window — the bar data is corrupt, not merely short',
      });
    }
    return skip(atrResult.reason);
  }
  const atr = atrResult.atr;

  // The same NaN argument `atrFor` documents, applied to the OTHER priced
  // input. `atrFor` guards the bars; nothing guarded the quote. Alpaca's
  // latest-quote body is cast, not validated (`alpaca-http-client.ts`, `as
  // CryptoLatestQuoteResponse`), so a null `ap`/`bp` on the wire arrives here
  // as a NaN `mark.price` — and NaN then walks through every guard below,
  // because every comparison against it is false. Checked at the inlet rather
  // than only at `size` so the skip names the input that was bad.
  const entry = mark.price;
  if (!Number.isFinite(entry)) return skip('mark_not_finite');

  const volFloor = config.vol_floor_fraction * entry;
  const effectiveVol = Math.max(atr, volFloor);
  const stopDistance = config.atr_k * effectiveVol;
  if (stopDistance <= 0) return skip('stop_distance_not_positive');

  const convictionMult = convictionMultiplier(debate.confidence, config.conviction_floor);
  const baseRiskFraction = maxRiskFor(mark.asset_class, config) * convictionMult;
  const nonConvergedHaircut = debate.converged ? 1 : config.non_converged_haircut;

  // The setup this decision represents, embedded once and used twice: to find
  // precedent now, and — if this intent survives the skip guards below — as
  // the row the Feedback Loop labels with its realized R on close.
  const setupVector = buildSetupVector(debate, { entry, atr, stopDistance, bars });
  const precedent = retrieveCosinePrecedent(setupVector, setupStore, asOf);

  // Multiplicative stacking — penalties compound honestly (trader-spec.md
  // Module: Non-Convergence & Skip Policy).
  const riskFraction = baseRiskFraction * nonConvergedHaircut * precedent.cosine_multiplier;
  const size = (equity * riskFraction) / stopDistance;

  // Backstop covering every numeric inlet at once, including `equity`, which
  // comes from an account read this module does not validate. The per-input
  // checks above say WHICH input was bad; this one guarantees that no future
  // inlet can reach an emitted intent unchecked. Must precede the min-notional
  // line: `NaN < min_viable_notional` is false, so that check passes NaN.
  if (!Number.isFinite(size)) return skip('size_not_finite');

  if (size * entry < config.min_viable_notional) return skip('below_min_notional');

  // Written only once every skip guard has passed, so a decision the Trader
  // itself declined leaves no row.
  //
  // What this does NOT promise: that every row written here becomes a labelled
  // trade. Risk can trim to a reject, Verdict can say no-go, and the broker can
  // refuse the order — each leaves a setup no `labelSetup` ever arrives for.
  // Those rows are inert rather than harmful (`findNeighbors` returns only
  // closed-outcome setups, so an unlabelled row can never influence sizing),
  // and the alternative is worse: the vector is only computable here, at the
  // point the decision is made, so deferring the write to the fill would mean
  // carrying the embedding through three stages that have no use for it.
  //
  // The write is first-write-wins in the store, which is what makes a
  // re-decided bar — replay, or a crash-restart on the same bar — safe rather
  // than fatal.
  setupStore.writeSetup(debate.debate_id, setupVector, asOf);

  const side = sideFor(debate.direction);
  const direction = side === 'buy' ? 1 : -1;

  const decisionBar = decisionBarFor(debate);

  return emit(
    {
      idempotency_key: computeIdempotencyKey(instrument, decisionBar, intentSideFor(intentType)),
      instrument,
      asset_class: mark.asset_class,
      side,
      intent_type: intentType,
      size,
      entry,
      stop: entry - direction * stopDistance,
      target: entry + direction * config.reward_risk_multiple * stopDistance,
      time_in_force: config.time_in_force[mark.asset_class],
      decision_timestamp: decisionBar,
      metadata: {
        debate_id: debate.debate_id,
        conviction: debate.confidence,
        converged: debate.converged,
        sizing: {
          base_risk_fraction: baseRiskFraction,
          conviction_multiplier: convictionMult,
          // How much the floor widened the stop. A non-positive ATR (perfectly
          // flat history) leaves the ratio undefined and the floor as sole
          // determinant; recorded as 1.
          vol_floor_factor: atr > 0 ? effectiveVol / atr : 1,
          non_converged_haircut: nonConvergedHaircut,
          cosine_multiplier: precedent.cosine_multiplier,
        },
        cosine_precedent: {
          neighbor_count: precedent.neighbor_count,
          weighted_mean_r: precedent.weighted_mean_r,
          no_precedent: precedent.no_precedent,
        },
      },
    },
    atr,
  );
}

/**
 * Flattens every held lot for `instrument` to zero (trader-spec.md Module:
 * Position Awareness — "opposite direction → exit"). A reversal is this
 * exit followed by a fresh `entry` on a later, flat cycle, never a single
 * zero-crossing bracket — so this intent carries no new risk and its
 * stop/target are degenerate (equal to entry): #83 owns the flatten
 * lifecycle and does not consult them.
 */
async function buildExitIntent(
  input: TraderInput,
  positions: OpenPosition[],
  exitReason: ExitReason,
): Promise<TraderOutcome> {
  const { debate } = input;
  return buildFlattenExit(
    input,
    positions,
    decisionBarFor(debate),
    {
      debate_id: debate.debate_id,
      conviction: debate.confidence,
      converged: debate.converged,
    },
    exitReason,
  );
}

/**
 * What an exit intent's metadata attributes the flatten TO.
 *
 * On the decision path this is the current bar's debate — unchanged behaviour.
 * On the tick path (#743) there is no debate by construction, so the exit
 * check attributes to the debate that OPENED the most recent lot, read off
 * `OpenPosition` — which is the more literal answer to "which decision is this
 * exit a consequence of", and requires consulting nothing the analysts or the
 * Debate Engine produced this bar.
 */
interface ExitAttribution {
  debate_id: string;
  conviction: number;
  converged: boolean;
}

/**
 * The debate-free core of the flatten (#743): everything an exit needs is a
 * mark, the held quantities and a bar coordinate for the idempotency key.
 * `attribution` is metadata only — nothing here branches on it, which is what
 * keeps the exit path safe to run without a debate (orchestrator-spec.md,
 * "The tick/decision split", constraint 4).
 */
async function buildFlattenExit(
  input: Pick<TraderInput, 'clock' | 'config' | 'exitFillSizes' | 'instrument' | 'marketData'>,
  positions: OpenPosition[],
  decisionBar: Date,
  attribution: ExitAttribution,
  exitReason: ExitReason,
): Promise<TraderOutcome> {
  const { clock, config, exitFillSizes, instrument, marketData } = input;

  const existingSide = positions[0]?.side;
  if (existingSide === undefined) {
    throw new Error('buildFlattenExit: positions must be non-empty');
  }
  const closingSide = existingSide === 'buy' ? 'sell' : 'buy';
  // Only filled exposure needs flattening — a lot still `pending`/
  // `submitted` has nothing on the books yet, so an all-pending instrument
  // has no fill to close and there is nothing to emit.
  //
  // #568: and only what the VENUE still holds. `filled_size` alone is the
  // ENTRY quantity, which no exit fill reduces, so a partially-flattened lot
  // (which stays open) would size this exit to the original quantity while
  // the venue holds only the residual. `heldQuantitiesFor` subtracts what is
  // already closed — the same derivation `executeExit` re-runs before it
  // submits, and it refuses on exact inequality, so a difference between the
  // two stops the exit rather than mis-sizing it.
  const held = await heldQuantitiesFor(positions, exitFillSizes);

  // Fail closed, per lot, BEFORE summing — the same check `executeExit` makes,
  // for the same reason. A lot recording more closed than it ever opened is
  // the store contradicting itself, and netting that negative against a
  // positive sibling yields a total that reads as an ordinary "nothing to
  // flatten". Folded into `exit_no_filled_size` it would be invisible twice
  // over: the sibling's REAL residual would never be exited, and
  // `executeExit`'s loud refusal would never run, because no order is emitted
  // for it to refuse. Its own reason, so a soak can tell it from a flat lot.
  if (held.some((lot) => lot.held < 0)) return skip('exit_held_quantity_diverged');

  const totalSize = totalHeldQuantity(held);
  if (totalSize <= 0) return skip('exit_no_filled_size');

  const asOf = clock.now();
  const mark = await marketData.getMark(instrument, asOf);

  return emit(
    {
      // #748: the early exit takes its OWN key discriminator, so a release and
      // a later mandatory flatten in the same bar cannot hash to one key and
      // have the flatten deduped away. See `IntentSide`.
      idempotency_key: computeIdempotencyKey(
        instrument,
        decisionBar,
        exitReason === 'signal_decay' ? 'early_close' : 'close',
      ),
      instrument,
      asset_class: mark.asset_class,
      side: closingSide,
      intent_type: 'exit',
      size: totalSize,
      entry: mark.price,
      stop: mark.price,
      target: mark.price,
      time_in_force: config.time_in_force[mark.asset_class],
      decision_timestamp: decisionBar,
      metadata: {
        debate_id: attribution.debate_id,
        exit_reason: exitReason,
        conviction: attribution.conviction,
        converged: attribution.converged,
        sizing: {
          base_risk_fraction: 0,
          conviction_multiplier: 0,
          vol_floor_factor: 1,
          non_converged_haircut: 1,
          // An exit sizes to the held quantity, not to risk, so no precedent is
          // retrieved and no setup is written: the flatten is the consequence of
          // an earlier setup, not a new one to find neighbors for. The field is
          // non-optional (cross-spec-contracts.md registry #1), so it carries
          // the no-precedent default — which is also the honest reading.
          cosine_multiplier: NO_PRECEDENT_MULTIPLIER,
        },
        cosine_precedent: {
          neighbor_count: 0,
          weighted_mean_r: null,
          no_precedent: true,
        },
      },
    },
    null,
  );
}

/**
 * Routes on current position state (trader-spec.md Module: Position
 * Awareness, tickets #73/#74):
 * - No lot for `instrument` → directional entry, or skip if neutral/below
 *   the conviction floor.
 * - Holding, debate neutral or non-converged → hold (`null`). Too little
 *   trust in the signal to act, regardless of which way it points.
 *   Stop-tightening on this path is out of scope for #74.
 * - Holding, same direction as debate → hold, unless conviction rose
 *   materially since the most recently opened lot, then bounded `scale_in`.
 * - Holding, opposite direction → `exit` (flatten). A same-cycle reversal
 *   fires as a fresh `entry` once flat, next cycle.
 */
/**
 * Every distinct way the Trader can decline to trade (#475).
 *
 * A CLOSED UNION rather than free text, so the set is greppable, countable
 * across a soak, and impossible to typo into a new category that looks like a
 * new phenomenon. Adding a skip path means adding a member here, which is the
 * point: the compiler asks the question the old bare `null` let us skip.
 *
 * Ordered roughly by how often they should fire in a healthy run. The last
 * four are data-quality failures — if any of them appears in soak logs at all,
 * the market data feed is the thing to look at, not the strategy.
 */
export type TraderSkipReason =
  | 'neutral_direction_while_flat'
  | 'below_conviction_floor'
  // #668: inside the flat-by-close window, so no new exposure is opened. A
  // distinct reason rather than a silent skip because "nothing traded after
  // 16:25" and "nothing traded because the market was quiet" are the same row
  // otherwise, and only one of them is the system working as designed.
  | 'session_closing'
  | 'below_min_notional'
  | 'holding_neutral_or_non_converged'
  | 'scale_in_conviction_delta_not_met'
  | 'exit_no_filled_size'
  // #568: a lot whose recorded exit fills exceed what it ever opened. NOT a
  // quiet variant of `exit_no_filled_size` — that one means "nothing to
  // close", this one means "the store's own record of this instrument
  // disagrees with itself", and the exit it suppresses may be one a sibling
  // lot genuinely needs. If this ever appears in a soak log, the fill record
  // is the thing to look at, and an instrument is stuck un-exitable until it
  // is.
  | 'exit_held_quantity_diverged'
  // #743, tick path only: no lot is open for this instrument, so the exit
  // check has nothing to evaluate. By far the commonest tick-path outcome and
  // entirely healthy — it is the exit-cadence sibling of a quiet decision.
  | 'no_open_position'
  // #748, tick path only: a lot is held, the flat-by-close window has not
  // opened, and the momentum axis still supports the held side. The healthy
  // holding outcome and by far the commonest one on an instrument that holds
  // something — holding through the session is what a position is for.
  //
  // **This REPLACES #743's `flatten_not_due`**, which is deliberately gone
  // rather than kept alongside. Once the early exit runs on every non-flatten
  // tick, "the flatten is not due" is no longer a decision the Trader reaches:
  // it is a branch it passes THROUGH on the way to the decay read. Keeping the
  // old member would have left a value nothing can emit — the no-caller shape
  // this codebase keeps shipping — and, worse, would have made a working hold
  // and a decay read that never ran the same row.
  | 'signal_still_supports_position'
  // #748, tick path only: a lot is held, the flatten is not due, and the
  // momentum read could not be taken at all — an instrument too cold for the
  // MACD warm-up, typically in the first session after it enters the universe.
  //
  // Its OWN reason, not folded into `signal_still_supports_position`, and the
  // distinction is the point: one says the signal was read and still supports
  // the position, the other says nothing was read. A soak in which this appears
  // steadily is a soak whose early exit is not running, and under one shared
  // reason that is indistinguishable from a healthy hold.
  | 'early_exit_signal_unavailable'
  | 'no_position_side'
  | 'atr_insufficient_bars'
  | 'atr_not_finite'
  | 'mark_not_finite'
  | 'stop_distance_not_positive'
  | 'size_not_finite';

/**
 * A condition the Trader DETECTED but did not treat as fatal (#698).
 *
 * Distinct from `TraderSkipReason` on purpose, and the distinction is the whole
 * point of this type. A skip reason says why THIS tick produced no order, and
 * every value it can take is a decision the Trader made correctly. A diagnostic
 * says the Trader is running in a DEGRADED state that it papered over — it kept
 * going, it returned a defensible answer, and something is nonetheless wrong
 * upstream of it.
 *
 * That difference is why these do not simply become new skip reasons. Two of the
 * three below occur on paths that still produce an intent (a flatten exit is an
 * emit, not a skip), so there is no skip row to hang them on; and the third
 * (`atr_not_finite`) already HAS a skip reason and is listed here anyway,
 * because a durable `trader_log` row is not an alert and nobody is reading the
 * table at 3am during an unattended soak (#238).
 *
 * Returned as data rather than logged from inside `decide`, deliberately.
 * trader-spec.md's contract is "fully deterministic given its inputs + the
 * clock-scoped market data", and admitting a logger to `TraderInput` would make
 * the decision path side-effecting to buy a diagnostic. #698 itself weighs both
 * options and calls this one "probably right"; the adapter that already writes
 * `trader_log` is the natural place for the effect.
 */
export type TraderDiagnosticKind =
  /**
   * The calendar reports a session close at or before `now`. Flattening is the
   * correct response and `withinFlattenWindow` gives it (see its docblock), but
   * a calendar stuck in this state parks the book flat FOREVER and stops
   * trading — and at a 15-minute cadence that is indistinguishable from a quiet
   * market, which is the failure #625 actually produced (96 debates, 0 trades).
   */
  | 'session_end_in_past'
  /**
   * `sessionEnd` returned null for a class that is not crypto. Null means "this
   * venue never closes", which is the documented and intended answer for crypto
   * and a broken calendar for anything else — and the two are the same `false`
   * today, so an equity leg whose calendar has quietly stopped resolving
   * sessions never flattens and carries overnight against ADR-0014.
   */
  | 'session_end_absent_on_non_crypto'
  /**
   * ATR came back non-finite on a FULL window — corrupt bar data, which
   * `atrFor` calls "never expected". Its sibling `atr_insufficient_bars` is
   * deliberately NOT here: that one is a warm-up or a data gap, is expected
   * early in a soak, and alerting it would fire on day 1 for every instrument.
   */
  | 'atr_not_finite';

/** One detected degradation, with enough context for an operator to act. */
export interface TraderDiagnostic {
  kind: TraderDiagnosticKind;
  /** Which leg — the calendar and the venue both follow the instrument's class. */
  asset_class: AssetClass;
  /** Human-readable specifics (the resolved close, how stale it is). Never raw vendor payloads. */
  detail: string;
}

/**
 * What `decideWithReason` returns: an intent, or the reason there isn't one.
 *
 * Exactly one side is populated. Not modelled as a discriminated union on a
 * `kind` field because the two consumers both want `intent` directly — the
 * production caller writes it to `trader_log` alongside the reason, and
 * `decide` projects it — and a tag would make both read through a narrowing
 * they do not otherwise need.
 */
export interface TraderOutcome {
  intent: OrderIntent | null;
  skip_reason: TraderSkipReason | null;
  /**
   * The ATR this decision priced its stop from (#475).
   *
   * Surfaced because `trader_log.atr` has had a column since migration 0016 and
   * was written as a hardcoded `null` — the value existed, inside
   * `buildBracket`, and simply never left it. It is the input that explains a
   * stop distance, so without it a soak cannot tell a wide stop from a volatile
   * instrument.
   *
   * Null on an exit (no stop is priced, so no ATR is computed) and on any skip
   * that happened before or at the ATR step. Carried here rather than added to
   * `OrderIntentMetadata` because it is a diagnostic about the DECISION, not a
   * term of the order — nothing downstream of the Trader sizes from it.
   */
  atr: number | null;
  /**
   * Degraded-but-continuing conditions detected while deciding (#698). Empty on
   * a healthy decision, which is the overwhelmingly common case.
   *
   * Orthogonal to `intent`/`skip_reason` rather than a third alternative: a
   * diagnostic can accompany EITHER side. The flatten path is exactly why —
   * a stale `sessionEnd` produces a diagnostic and an exit intent on the same
   * pass, so a field that only rode along with skips would miss the case that
   * motivated the ticket.
   */
  diagnostics: readonly TraderDiagnostic[];
}

/**
 * A declined decision. Narrow helper so the twelve skip sites stay one line
 * each — and so adding a fourteenth cannot forget a field.
 *
 * Diagnostics are deliberately NOT a parameter here (#698): they are collected
 * in `decideWithReason`'s accumulator and merged onto whatever this returns, so
 * that the one-line-per-skip-site property this helper exists to protect
 * survives a second cross-cutting field.
 */
function skip(reason: TraderSkipReason): TraderOutcome {
  return { intent: null, skip_reason: reason, atr: null, diagnostics: [] };
}

/** A decision that produced an order. */
function emit(intent: OrderIntent, atr: number | null): TraderOutcome {
  return { intent, skip_reason: null, atr, diagnostics: [] };
}

export async function decide(input: TraderInput): Promise<OrderIntent | null> {
  return (await decideWithReason(input)).intent;
}

/**
 * `decide`, but saying WHY when it declines (#475).
 *
 * The Trader has thirteen distinct ways to produce no order, and until this
 * existed `trader_log.skip_reason` recorded the same string —
 * `'decide() returned no intent'` — for every one of them. #328's resolution
 * called the skip row "the highest-value row of the lot", and the whole point
 * of it is answering why nothing traded; one constant answers nothing. During
 * an unattended soak (#238) that is the difference between "the conviction
 * floor is too high" and "the market data feed is returning NaN marks", which
 * are the same row today.
 *
 * A SEPARATE ENTRY POINT rather than a changed return type, because `decide`'s
 * `OrderIntent | null` contract is exercised by a large existing test suite and
 * one production caller. Widening the contract everywhere would have churned
 * every one of those assertions for a diagnostic gain, and churned tests are
 * tests nobody re-reads. `decide` is now a one-line wrapper over this, so the
 * two cannot drift: there is one implementation, and the old signature is a
 * projection of it.
 */
export async function decideWithReason(input: TraderInput): Promise<TraderOutcome> {
  // #698's collector. A LOCAL array threaded into the routing below, not an
  // injected sink: nothing escapes this call, so `decide` stays deterministic
  // in the sense trader-spec.md means it (same inputs, same output) while still
  // reporting what it noticed. An injected logger would have bought the same
  // diagnostic at the cost of making the decision path side-effecting, which is
  // the trade #698 itself argues against.
  const diagnostics: TraderDiagnostic[] = [];
  const outcome = await routeDecision(input, diagnostics);

  // Merged here rather than at each producing site so the skip helper stays a
  // one-liner and no future skip site can forget the field.
  return diagnostics.length === 0 ? outcome : { ...outcome, diagnostics };
}

/** `decideWithReason`'s routing, with #698's diagnostic accumulator threaded through. */
async function routeDecision(
  input: TraderInput,
  diagnostics: TraderDiagnostic[],
): Promise<TraderOutcome> {
  const { config, debate, instrument, positionState } = input;

  const positions = (await positionState()).filter((lot) => lot.instrument === instrument);

  if (positions.length === 0) {
    if (debate.direction === 'neutral') return skip('neutral_direction_while_flat');
    return buildBracket(input, 'entry', diagnostics);
  }

  // All lots for one instrument are the same side by construction (v1
  // per-lot design: scale_in only adds same-direction, exit flattens before
  // a fresh entry) — no defensive mixed-side reconciliation.
  const existingSide = positions[0]?.side;
  if (existingSide === undefined) return skip('no_position_side');

  // FLAT BY CLOSE (#668, ADR-0014) — ahead of EVERY other holding branch, and
  // the ordering is the load-bearing part.
  //
  // Below this point the router can decline to act for reasons that are all
  // perfectly good reasons to hold a position through a quiet afternoon and
  // are none of them a reason to hold one overnight: a neutral debate, a
  // non-converged one, a scale-in delta not met. Put the close check after any
  // of them and the commonest branch in the whole system — `debate.direction
  // === 'neutral'`, 92 of 94 debates in the soak — silently suppresses the
  // flatten and carries the book overnight. That is the exact failure the rule
  // exists to prevent, so it is decided first.
  //
  // ADR-0007/ADR-0013 removed the human from the trade path, so this must fire
  // unattended INCLUDING on the days it closes into a loss.
  const positionAssetClass = positions[0]?.asset_class;
  if (positionAssetClass !== undefined) {
    const flattenWindow = withinFlattenWindow(input, positionAssetClass);
    // Pushed BEFORE the branch, so the diagnostic survives whichever way it
    // goes: a stale close produces an exit intent, and an equity calendar that
    // has stopped resolving sessions produces `false` and no exit at all — the
    // second being precisely the silent case #698 was filed for.
    if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);
    if (flattenWindow.within) return buildExitIntent(input, positions, 'flatten');
  }

  if (debate.direction === 'neutral' || !debate.converged) {
    return skip('holding_neutral_or_non_converged');
  }

  const desiredSide = sideFor(debate.direction);
  if (desiredSide !== existingSide) {
    return buildExitIntent(input, positions, 'direction_flip');
  }

  const mostRecentLot = positions.reduce((latest, lot) =>
    lot.opened_at > latest.opened_at ? lot : latest,
  );
  if (debate.confidence - mostRecentLot.conviction < config.scale_in_conviction_delta) {
    return skip('scale_in_conviction_delta_not_met');
  }

  return buildBracket(input, 'scale_in', diagnostics);
}

/**
 * The Trader's EXIT-ONLY entry point (#743) — what the tick path runs.
 *
 * A `Pick` of `TraderInput`, not a new bag of dependencies: everything here is
 * the same seam the decision path already injects, minus `debate` (there is
 * none on a tick pass, by construction — that absence is the "exits must not
 * read analyst output" constraint stated in the type), minus the sizing
 * inputs (`equity`, `setupStore`) an exit never uses, plus the `bar` the
 * runner floored once for this pass — the coordinate the exit's idempotency
 * key dedupes on, inherited rather than re-derived here for the same reason
 * `decisionBarFor` inherits the debate's (#616/#687).
 */
export type ExitCheckInput = Pick<
  TraderInput,
  | 'trace_id'
  | 'instrument'
  | 'clock'
  | 'config'
  | 'marketData'
  | 'sessionCalendars'
  | 'positionState'
  | 'exitFillSizes'
> & {
  /** The pass's debate-bar coordinate, floored once by the tick runner. */
  bar: Date;
};

/**
 * Evaluates the position-facing exits for one instrument, in this order:
 *
 * 1. Is a lot held at all?
 * 2. Is the flat-by-close window (#668, ADR-0014) open for its venue? If so,
 *    the same flatten intent the decision path would build — held quantities,
 *    degenerate stop/target, `'close'`-side idempotency key on `input.bar`.
 * 3. Has the held side's signal DECAYED (#748)? If so, the same builder emits
 *    the same shape of exit, distinguished by `metadata.exit_reason:
 *    'signal_decay'` and by an `'early_close'` idempotency-key discriminator.
 *
 * **The order is a safety property, not a style choice.** The flatten is
 * evaluated on a tick and nowhere else, so it is decided before anything that
 * can throw or decline. See the comment at the branch itself.
 *
 * What it deliberately does NOT evaluate: entries, scale-ins, and the
 * direction-flip exit — all of those are answers to "what does the debate
 * say", which is a decision-path question and runs once per debate bar. This
 * function consults no `AnalystView` and no `DebateResult` and makes no model
 * call; its exit attribution comes off the most recent open lot and its decay
 * read comes off the indicator registry.
 *
 * Mirrors `decideWithReason`'s shape (an outcome plus collected diagnostics)
 * so the adapter that writes `trader_log` and escalates diagnostics treats
 * both entry points identically.
 */
export async function checkExitsWithReason(input: ExitCheckInput): Promise<TraderOutcome> {
  const diagnostics: TraderDiagnostic[] = [];
  const outcome = await routeExitCheck(input, diagnostics);
  return diagnostics.length === 0 ? outcome : { ...outcome, diagnostics };
}

/** `checkExitsWithReason`'s routing, with the #698 diagnostic accumulator threaded through. */
async function routeExitCheck(
  input: ExitCheckInput,
  diagnostics: TraderDiagnostic[],
): Promise<TraderOutcome> {
  const { instrument, positionState } = input;

  const positions = (await positionState()).filter((lot) => lot.instrument === instrument);
  if (positions.length === 0) return skip('no_open_position');

  const existingSide = positions[0]?.side;
  if (existingSide === undefined) return skip('no_position_side');

  const positionAssetClass = positions[0]?.asset_class;
  if (positionAssetClass === undefined) return skip('no_position_side');

  const flattenWindow = withinFlattenWindow(input, positionAssetClass);
  // Pushed BEFORE the branch, exactly as `routeDecision` does: the diagnostic
  // must survive both a flatten (an emit) and a calendar that has quietly
  // stopped resolving sessions (a skip) — the second is #698's silent case,
  // and at a 2-minute tick THIS is now the path that reports it most often.
  if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);

  const mostRecentLot = positions.reduce((latest, lot) =>
    lot.opened_at > latest.opened_at ? lot : latest,
  );
  const attribution = {
    debate_id: mostRecentLot.debate_id,
    conviction: mostRecentLot.conviction,
    converged: mostRecentLot.converged,
  };

  // FLAT BY CLOSE FIRST, AND THE ORDER IS THE SAFETY ARGUMENT (#748).
  //
  // The flatten is evaluated on a tick and NOWHERE ELSE — there is no
  // session-end job (orchestrator-spec.md, tick/decision split, constraint 1) —
  // so anything placed ahead of it can cost the book an overnight carry. Put
  // the decay read first and a cold instrument's `InsufficientBarsError`, a
  // store outage, or any future throw inside it takes out the flatten with it.
  // Below this line, nothing the early exit does can reach the flatten: it has
  // already returned.
  if (flattenWindow.within) {
    return buildFlattenExit(input, positions, input.bar, attribution, 'flatten');
  }

  // The indicator-based early exit (#748). Reached only when the flatten is not
  // due, and it consults ONLY indicators — no `AnalystView`, no `DebateResult`,
  // no model call. `ExitCheckInput` has no field any of those could arrive
  // through, which is orchestrator-spec.md constraint 4 enforced by the type,
  // and this change adds none.
  const decay = await readSignalDecay({
    instrument,
    side: existingSide,
    marketData: input.marketData,
    asOf: input.clock.now(),
    config: input.config.early_exit,
  });
  if (decay.verdict === 'signal_unavailable') return skip('early_exit_signal_unavailable');
  if (decay.verdict === 'holds') return skip('signal_still_supports_position');

  // A release, built by the SAME builder the flatten uses — so "can only reduce
  // or close, never open or increase" holds by construction rather than by a
  // second code path agreeing to behave. `buildFlattenExit` sizes to the held
  // quantity, takes the closing side, and emits `intent_type: 'exit'`; there is
  // no argument to it that could produce anything else.
  return buildFlattenExit(input, positions, input.bar, attribution, 'signal_decay');
}
