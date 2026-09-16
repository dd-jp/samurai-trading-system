/**
 * Trader core decision — DebateResult -> OrderIntent bracket. Mechanical and
 * deterministic: no LLM, no hidden state. Same code path live and in replay;
 * only the injected Clock and MarketDataService's data differ.
 */
import {
  type Bar,
  computeIndicator,
  type IndicatorSpec,
  minimumBarsFor,
  recommendedWarmupFor,
} from '../../providers/market-data-service/index.js';
import {
  describeThrown,
  describeThrownSafely,
  type ExitReason,
  heldQuantitiesFor,
  type OpenPosition,
  type OrderIntent,
  totalHeldQuantity,
} from '../../shared/index.js';
// Type-only import (erased at compile time), so this doesn't pull the whole
// debate-engine module graph into the Trader. Do not import `floorToBar` or
// `DEBATE_BAR_TIMEFRAME_MS` to re-derive the bar — take it from `DebateResult` (#687).
import type { DebateResult } from '../debate-engine/index.js';
// #1089: the one typed dependency this otherwise risk-manager-free module
// takes, only for `instanceof` discrimination — see `buildBracket`'s use of
// it to tell a whole-book valuation refusal apart from any other rejection.
import { BookValuationError } from '../risk-manager/index.js';
import { priceBracket, sideFor, sizeBracket, type TradeDirection } from './build-bracket.js';
import { NO_PRECEDENT_MULTIPLIER, retrieveCosinePrecedent } from './cosine-precedent.js';
import { readSignalDecay } from './early-exit.js';
import {
  computeFlattenIdempotencyKey,
  computeIdempotencyKey,
  intentSideFor,
} from './idempotency-key.js';
import { buildSetupVector } from './setup-vector.js';
import { resolveSubclassBracket } from './subclass-bracket.js';
import type {
  AssetClass,
  TraderDiagnosticKind,
  TraderInput,
  TraderReasonDetail,
  TraderSkipReason,
} from './types.js';

/**
 * The lot to attribute a position-level decision to when several are open on
 * the same instrument — most recently OPENED wins. Exported (#1128) so
 * `direct-bind.ts` shares this selection instead of a copy that could drift.
 */
export function mostRecentOpenLot(positions: readonly OpenPosition[]): OpenPosition {
  return positions.reduce((latest, lot) => (lot.opened_at > latest.opened_at ? lot : latest));
}

/**
 * The exact `IndicatorSpec` Trader asks the Market Data Service for. Exported
 * so `atr-equivalence.test.ts` can pin this spec instead of a hand-rebuilt
 * copy that could drift. Not re-exported from `trader/index.js`.
 *
 * `params.period` is pinned explicitly rather than left to
 * `computeIndicator`'s `?? spec.lookback` fallback, which would silently
 * off-by-one the ATR since `spec.lookback` is the bar-window width, not the
 * period. `lookback` here is the CONVERGED warm-up (#757), derived via
 * `recommendedWarmupFor(atrIndicatorSpec(...))` at the `buildBracket` call
 * site so the spec's declared width and the actual fetch width can't drift
 * apart the way #722 had to fix for `WARM_START_WINDOWS`.
 */
export function atrIndicatorSpec(lookback: number, timeframe: string): IndicatorSpec {
  const floor: IndicatorSpec = {
    indicator: 'atr',
    params: { period: lookback },
    // Passed in rather than defaulted (#315) — a default here could let the
    // spec's timeframe drift from the bars the caller actually fetched.
    timeframe,
    lookback: lookback + 1,
  };
  return { ...floor, lookback: recommendedWarmupFor(floor) };
}

/**
 * Average true range for the stop, computed by the Market Data Service's
 * indicator registry, not by Trader (#304) — indicator maths lives in one
 * place so the "N bars yield N-1 true ranges" rule can't be fixed in one
 * implementation and left wrong in another.
 *
 * Returns null on any ATR that cannot size a stop. Two independent guards:
 * too little history (a pre-check against `minimumBarsFor`, not a
 * `try`/`catch`, since `computeIndicator` throws `InsufficientBarsError` and
 * a catch would also have to re-throw its ascending-order error unmodified),
 * and corrupt bar data producing a NaN true range that the length check
 * can't see. NaN must never reach an emitted `OrderIntent` — every downstream
 * comparison against NaN is false, so it would pass every guard silently.
 */
function atrFor(
  bars: Bar[],
  lookback: number,
  timeframe: string,
):
  | { atr: number; reason: null; reason_detail: null }
  | { atr: null; reason: TraderSkipReason; reason_detail: TraderReasonDetail | null } {
  const spec = atrIndicatorSpec(lookback, timeframe);

  // Arity lives in `minimumBarsFor`, not a literal here. The two failure
  // reasons are reported SEPARATELY (#475): a short window is an expected
  // warm-up/data gap, while a non-finite ATR on a full window means corrupt
  // bar data — collapsing them made the two indistinguishable in `trader_log`.
  const minimumBars = minimumBarsFor(spec);
  if (bars.length < minimumBars) {
    return {
      atr: null,
      reason: 'atr_insufficient_bars',
      reason_detail: { compared_value: bars.length, threshold: minimumBars },
    };
  }

  const atr = computeIndicator(bars, spec);
  return Number.isFinite(atr)
    ? { atr, reason: null, reason_detail: null }
    : { atr: null, reason: 'atr_not_finite', reason_detail: null };
}

/**
 * `withinFlattenWindow`'s answer, plus anything it noticed getting there (#698).
 *
 * A pair rather than a bare boolean because the two callers need the boolean and
 * the DIAGNOSTIC needs to survive both of them: the entry path turns `within`
 * into a skip and the holding path turns it into an exit intent, so a diagnostic
 * carried on the skip alone would be dropped on exactly the flatten it describes.
 */
/**
 * `enforcing_close` is WHICH session close the tick is enforcing (#1389) —
 * `sessionEnd` before the bell, the close just gone inside the grace, and the
 * same instant either side of it.
 *
 * It rides on the verdict rather than being re-derived at the builder because
 * it is the flatten's IDEMPOTENCY COORDINATE
 * (`computeFlattenIdempotencyKey`), and re-deriving it there would mean a
 * second calendar read against a second `clock.now()`: a tick that crossed the
 * bell between the two reads would key its flatten to a different close than
 * the one it decided against, which is the exact failure this coordinate
 * exists to remove.
 *
 * A DISCRIMINATED union, so "the window is open but I have no close to key on"
 * is not a state a caller has to handle — or, worse, one it can paper over
 * with a fallback coordinate.
 */
type FlattenWindowVerdict =
  | { within: true; enforcing_close: Date; diagnostic: TraderDiagnostic | null }
  | { within: false; enforcing_close: null; diagnostic: TraderDiagnostic | null };

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
 * **THE WINDOW IS NO LONGER FORWARD-ONLY (#1389), and that is the whole of
 * this function's second branch.**
 *
 * `TradingCalendar.sessionEnd` is contractually forward — every conforming
 * implementation returns a close STRICTLY after the instant it is handed
 * (`trading-calendar.ts`'s port doc). So one instant past the bell it named
 * TOMORROW's close, `remaining` jumped to ~17.5 hours, `within` went false,
 * and a held lot fell straight through to the holding branches with no flatten
 * intent produced at all. Not refused by a gate — never built. On 2026-09-08
 * seven control lots carried overnight exactly this way: one tick's Trader
 * arrivals ran 19:58:27 to 20:02:02, and every lot reached after 20:00:00Z hit
 * a shut window.
 *
 * The window is now `[sessionEnd − flatten_before_close_ms, priorClose +
 * flatten_after_close_ms]`, resolved through the SAME calendar in two reads
 * that name the same instant across the boundary: `sessionEnd(now)` while the
 * session is still open, and `sessionStart(now)` — "the most recent close AT OR
 * BEFORE `now`", not the open — once it is not. At `now = close − 1ms` the
 * first names today's close; at `now = close` and after, the second does. There
 * is no instant at which the coordinate jumps, which is what lets the flatten's
 * idempotency key dedupe across the bell (`computeFlattenIdempotencyKey`).
 *
 * `sessionStart` throws after `MAX_SESSION_SEARCH_DAYS` exactly as `sessionEnd`
 * does, and is called only on the branch where `sessionEnd` already answered —
 * same caller, same calendar, same existing exposure. It adds no failure mode
 * the first read did not already carry.
 *
 * **A past close is no longer a diagnostic (#1389 deletes `session_end_in_past`).**
 * It used to be reported as an alarming condition on the reasoning that a
 * conforming calendar could not produce one. That reasoning was correct and is
 * now obsolete: past the bell this function DELIBERATELY works against a close
 * that has already happened, so a diagnostic for it would fire every session on
 * every held instrument. The answer it produced — flatten — is unchanged, and
 * still reached: a broken calendar reporting a close already gone still lands
 * `remaining <= flatten_before_close_ms` on the first branch and still parks the
 * book flat. Only the alert is gone, because it would now be noise.
 *
 * **Audibility is what #698 added, and it did not change any answer above.**
 * A calendar that has stopped resolving sessions should raise an alert, and
 * `TraderInput` still carries no logger to raise one from — so this reports the
 * condition as DATA on the returned verdict, and the adapter that already
 * writes `trader_log` turns it into an alert.
 */
function withinFlattenWindow(
  input: Pick<TraderInput, 'clock' | 'config' | 'sessionCalendars'>,
  assetClass: AssetClass,
): FlattenWindowVerdict {
  // Checked here rather than at construction because `TraderConfig` is a plain
  // interface with no validation seam — nothing between the config literal and
  // this comparison inspects the value. Written as `!(x > 0)` so `NaN` fails
  // too; `x <= 0` would let it through and make the window silently never open
  //
  // Zero or negative disables flat-by-close ENTIRELY and quietly: the window
  // never opens, the Trader never flattens, and every position carries
  // overnight against ADR-0014 with nothing in `trader_log` marking it. A
  // safety rule that can be switched off by a plausible-looking config value
  // has to say so
  //
  // This throw DOES take the direction-flip exit down with it — the same
  // stranding the docblock argues against for a past close. The asymmetry is
  // deliberate, and it turns on whether the condition is recoverable. A past
  // close is a live input that may be right, wrong, or transient, and there is
  // a safe answer available (be flat), so the Trader takes it and keeps
  // running. A non-positive window is a static misconfiguration that cannot
  // become valid at the next tick, and every answer it could produce is a lie
  // about whether ADR-0014 is being enforced — so halting the instrument IS the
  // correct outcome, not a side effect tolerated to keep the check cheap
  //
  // In practice nothing should ever reach this: `assertTraderConfigSound` at
  // the composition root refuses the boot. This is the backstop for callers
  // that never pass through that seam, and there the halt is what you want
  if (!(input.config.flatten_before_close_ms > 0)) {
    throw new Error(
      `flatten_before_close_ms must be > 0 (got ${input.config.flatten_before_close_ms}); ` +
        `a non-positive window disables flat-by-close, which ADR-0014 requires`,
    );
  }
  // #1389, and the same backstop argument one line up: a non-positive grace is
  // a static misconfiguration that restores the forward-only window this
  // ticket removed, and cannot become valid at the next tick
  if (!(input.config.flatten_after_close_ms > 0)) {
    throw new Error(
      `flatten_after_close_ms must be > 0 (got ${input.config.flatten_after_close_ms}); ` +
        'a non-positive grace restores the forward-only flatten window #1389 removed',
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
    // ADR-0014 with nothing marking it
    return {
      within: false,
      enforcing_close: null,
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

  // Still before the bell (or a calendar reporting a close already gone, which
  // this comparison has always swept up and still does — see the docblock)
  if (remaining <= input.config.flatten_before_close_ms) {
    return { within: true, enforcing_close: sessionEnd, diagnostic: null };
  }

  // Past the bell. `sessionStart` is "the most recent regular or early close
  // AT OR BEFORE `now`" — the close just gone, which is the one this tick is
  // still enforcing, NOT the session's open. The `>= 0` bound is that contract
  // restated rather than trusted: a calendar answering with a FUTURE close
  // would otherwise produce a negative elapsed that clears the upper bound and
  // silently widen the grace to the whole session
  const priorClose = calendar.sessionStart(now);
  const elapsed = now.getTime() - priorClose.getTime();
  if (elapsed >= 0 && elapsed <= input.config.flatten_after_close_ms) {
    return { within: true, enforcing_close: priorClose, diagnostic: null };
  }

  return { within: false, enforcing_close: null, diagnostic: null };
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
 * ## Never derive it from a mark or a clock read
 *
 * `mark.observed_at` is not a bar coordinate in paper/live: it is the venue's
 * latest-quote wire timestamp at millisecond resolution (Alpaca's `quote.t`,
 * same shape in ccxt/IBKR), so it changes on every tick and silently defeats
 * every key-based dedup layer at once — local `findByKey`, the
 * `open_positions` primary key backstop, the broker `client_order_id` — while
 * backtest (where `deriveBacktestMark` derives it from the bar) keeps the
 * invariant looking held, so no test catches it (#616). A fresh `clock.now()`
 * read is stable within a bar but is a SECOND clock: it agrees with the
 * debate's own bar only while both land in the same one, and a debate that
 * straddles an hour boundary (LLM round-trips, retries, a latency-budget
 * timeout) gets keyed one bar later than it was decided, colliding with that
 * next bar's own genuine decision (#687).
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
 * The straddling intent is still DECIDED late: `decision_timestamp` is bar N
 * while the wall clock is in N+1. `decision_timestamp` no longer floors onto
 * the bar containing `created_at`, so it stays a usable marker in
 * `trader_log` that tells a straddle apart from an ordinary tick.
 *
 * `decision_timestamp` is NOT a staleness gate: Verdict's staleness check
 * reads `OrderIntent.decided_at` (`clock.now()`, read fresh at the point this
 * function's caller builds the intent), so a straddling intent passes that
 * gate exactly as an ordinary one would (#1190). Whether a straddle-specific
 * bound belongs there is open, tracked on #1190 — not decided here.
 */
function decisionBarFor(debate: DebateResult): Date {
  return debate.bar_timestamp;
}

/**
 * Builds a full entry or scale_in bracket, or a NAMED skip (#475). Skips when:
 * conviction is below the floor, ATR cannot be computed, a priced input is not
 * finite, or the resulting position is below the minimum viable notional.
 * Shared by both intent types (trader-spec.md Module: Position Awareness —
 * scale_in sizes exactly like an entry; Risk enforces the exposure cap
 * downstream). The reads live here; the arithmetic is `build-bracket.ts`.
 *
 * `direction` is the router's already-narrowed `debate.direction`: the type
 * is what keeps a neutral debate out, so nothing here re-checks it.
 */
async function buildBracket(
  input: TraderInput,
  direction: TradeDirection,
  intentType: 'entry' | 'scale_in',
  diagnostics: TraderDiagnostic[],
): Promise<TraderOutcome> {
  const { clock, config, debate, instrument, marketData, setupStore } = input;
  // #753: absent means the live arm — the arm that existed before the control
  // did — never "unknown"
  const arm = input.arm ?? 'live';

  // THE SIZING READ (#847), resolved HERE — the first thing this function does
  // once it knows it is sizing, and the ONLY place in the module that touches
  // it. Two properties, both load-bearing:
  //
  //  1. Reaching sizing at all requires a whole-book valuation to have
  //     succeeded. On the LIVE arm the thunk's rejection propagates unchanged
  //     — that throw aborts the tick exactly as the eager read did before
  //     #847, and it is NOT converted into a `skip_reason` there. A read
  //     failure is a fault and must stay audible in `tick-loop.ts`'s
  //     `error`-level catch (#507)
  //
  //     #1089: `arm === 'control'` converts ONE specific shape of that
  //     rejection — a genuine whole-book valuation refusal, any
  //     `BookValuationError` (a stale mark OR a failed/omitted mark read) or
  //     an `AggregateError` whose members are ALL `BookValuationError` — into
  //     `control_arm_valuation_refused` instead of rethrowing. See that skip
  //     reason's own doc for why the control arm needs this and the live arm
  //     must not get it. Narrowed by TYPE, not just by arm: `input.equity()`
  //     is an opaque thunk that can reject for an unrelated reason
  //     (an account-state read failing, say — a fault that must stay a fault
  //     on EITHER arm), and only these two shapes
  //     identify "the book could not be valued" as opposed to "sizing itself
  //     refused". The `AggregateError` check inspects `.errors`, not just the
  //     wrapper type: `readMarks`'s own wrap (portfolio-view.ts) is always
  //     all-`BookValuationError`, but `input.equity()` is opaque and a future
  //     non-valuation `AggregateError` (e.g. a batched sub-read inside
  //     `sizingEquity`) must not be silently downgraded to a skip
  //  2. Nothing that does NOT size pays for it or fails on it. `routeDecision`
  //     evaluates flat-by-close before it can ever get here, so a dark mark
  //     elsewhere in the book no longer suppresses this pass's flatten
  //
  // Awaited at the TOP rather than at the use site so a future edit cannot
  // reach the `size` computation on some path that skipped the read
  let equity: number;
  try {
    equity = await input.equity();
  } catch (error) {
    const isValuationRefusal =
      error instanceof BookValuationError ||
      (error instanceof AggregateError &&
        error.errors.length > 0 &&
        error.errors.every((member: unknown) => member instanceof BookValuationError));
    if (arm === 'control' && isValuationRefusal) {
      // #1089: paired with the skip so `escalateTraderDiagnostics` (the
      // pre-existing #698 mechanism — a `trader_log` write plus a REAL alert
      // transport when one is configured) makes this audible above `warn`,
      // rather than a bespoke log line with no consumer. `asset_class` is
      // `undefined` here on purpose — see `TraderDiagnostic.asset_class`
      diagnostics.push({
        kind: 'control_arm_valuation_refused',
        asset_class: undefined,
        detail:
          `${instrument}: the control arm could not value the book (${describeThrown(error)}) ` +
          'and skipped this pass instead of crashing it.',
      });
      return skip('control_arm_valuation_refused');
    }
    throw error;
  }

  if (debate.confidence < config.conviction_floor) {
    return skip('below_conviction_floor', {
      compared_value: debate.confidence,
      threshold: config.conviction_floor,
    });
  }

  // `marketData.getMark` here is the mark read #900 pins for BOTH callers of
  // this function — an entry AND a scale_in (`intentType`, above): it is
  // load-bearing (it prices `entry`/`stop`/`target` and its `asset_class`
  // picks the flatten calendar a few lines down), it has no failover — only
  // `getBars` does, via `FailoverDataSource` — and there is no mode flag or
  // catch around it. A stalled vendor throws here and takes the whole
  // `Promise.all` (and this function, and the tick) down with it, on
  // purpose: opening or adding to a position without a live price is worse
  // than deferring to the next tick, unlike the ONE exit ADR-0014 makes
  // mandatory (see `readExitPrice`'s docstring for the full posture)
  // Stamped onto `decided_at` below (#1190) — Verdict's gate 1 measures signal
  // age from THIS read, not from `DebateLog.created_at` (the debate's own
  // completion instant): `DebateResult` does not expose `created_at`, so
  // reading it here would need a contract change gate 1 does not otherwise
  // need, and `asOf` already bounds the same latency budget
  // (`LATENCY_BUDGET_MS.stocks`, 60s) that separates debate completion from
  // this call. Read BEFORE `getMark`/`getBars`/the precedent lookup below, so
  // a slow data fetch still counts toward the age Verdict measures — it is
  // not a cheap timestamp taken after the expensive work is already done
  const asOf = clock.now();
  const [mark, bars] = await Promise.all([
    marketData.getMark(instrument, asOf),
    marketData.getBars(
      instrument,
      // CONVERGED width (#757): `recommendedWarmupFor` = `4 x atr_lookback + 1`
      // Fetching only `atr_lookback + 1` bars — one true range past the seed —
      // leaves `computeIndicator`'s Wilder smoothing loop running ZERO times,
      // so the value becomes a plain mean wearing Wilder's name (the same
      // warm-up gap #722 fixed for `RSI_SPEC`). Measured before adopting the
      // wider window: median relative shift 3.0%, p90 6.9%, near-zero signed
      // bias, against a declared median<=15%/p90<=30% gate — see
      // `docs/reviews/indicator-characterisation-2026-08-16.md` F1
      //
      // Two tests pin the two halves, and neither pins the other's:
      // `atr-equivalence.test.ts` pins the ALGORITHMIC boundary (plain mean at
      // or below `period` ranges, smoothing beyond it) at the historical
      // `atr_lookback + 1` width, which is no longer the production fetch
      // width; `decide.test.ts` ("fetches exactly the converged ATR width")
      // pins THIS window, so narrowing the fetch back to the floor — or
      // dropping `atr_timeframe` — fails a test rather than silently
      // reintroducing the seed
      //
      // Derived from `atrIndicatorSpec` rather than restated, so the fetch and
      // the spec that documents it cannot drift apart the way #722's
      // `WARM_START_WINDOWS` had to be fixed separately from `RSI_SPEC`
      //
      // A separate fetch-width margin is applied underneath in fetchBars; see #362
      {
        timeframe: config.atr_timeframe,
        lookback: recommendedWarmupFor(atrIndicatorSpec(config.atr_lookback, config.atr_timeframe)),
      },
      asOf,
    ),
  ]);

  // FLAT BY CLOSE, the opening half (#668). The router's holding branch closes
  // what is open inside the window; this stops the same window from opening
  // something new for the next tick to immediately close again
  //
  // Not a nicety: on the live leg the round trip is the whole edge. ADR-0018
  // measures a 3x index ETP at 0.18% against a 2.00% take-profit, so a position
  // opened minutes before the close pays that cost for an exposure with no time
  // left to earn it, and the neutral bracket it was sized under assumes a full
  // session to resolve in
  //
  // Checked AFTER the mark rather than alongside the position branch because
  // the asset class is the MARK's to report — and it is the asset class that
  // picks the calendar, since the crypto and equity legs run different venues
  // inside one process
  const flattenWindow = withinFlattenWindow(input, mark.asset_class);
  if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);
  if (flattenWindow.within) {
    return skip('session_closing');
  }

  // Bars are still fetched here rather than read through
  // `marketData.getIndicator`. `computeIndicator` throws
  // `InsufficientBarsError` below `minimumBarsFor(spec)` and `getIndicator`
  // propagates it, so routing through the serving layer would fail loudly on
  // a short window rather than silently repricing stops off an under-seeded
  // ATR
  //
  // What differs is the disposition. `atrFor` catches the shortfall itself and
  // returns null, which `decide()` turns into "skip this instrument this
  // tick" — the right answer during a warm-up or a data gap, since a stop
  // cannot be priced off an ATR that does not exist. Repointing would turn
  // that routine skip into a thrown tick. Cheap to fix (catch
  // `InsufficientBarsError` at the call site and return null), but it is a
  // behaviour decision about the Trader rather than a mechanical swap, so it
  // is the remaining step of #315 rather than a line in this one
  const atrResult = atrFor(bars, config.atr_lookback, config.atr_timeframe);
  if (atrResult.atr === null) {
    // Only the non-finite half is a diagnostic (#698). `atr_insufficient_bars`
    // is a warm-up or a data gap — expected early in a soak, per `atrFor`'s own
    // comment — and alerting it would fire on day 1 for every instrument, which
    // is how an operator learns to mute the channel (ADR-0008 §1's lesson)
    // A non-finite ATR on a FULL window is corrupt bar data and never expected
    if (atrResult.reason === 'atr_not_finite') {
      diagnostics.push({
        kind: 'atr_not_finite',
        asset_class: mark.asset_class,
        detail:
          `ATR over ${config.atr_lookback} ${config.atr_timeframe} bars for ${instrument} ` +
          'was not finite on a full window — the bar data is corrupt, not merely short',
      });
    }
    return skip(atrResult.reason, atrResult.reason_detail);
  }
  const atr = atrResult.atr;

  // The same NaN argument `atrFor` documents, applied to the OTHER priced
  // input. `atrFor` guards the bars; nothing guarded the quote. Alpaca's
  // latest-quote body is cast, not validated (`alpaca-http-client.ts`, `as
  // CryptoLatestQuoteResponse`), so a null `ap`/`bp` on the wire arrives here
  // as a NaN `mark.price` — and NaN then walks through every guard below,
  // because every comparison against it is false. Checked at the inlet rather
  // than only at `size` so the skip names the input that was bad
  const entry = mark.price;
  if (!Number.isFinite(entry)) return skip('mark_not_finite');

  // ADR-0018 D3/D5 (#739). `bracket === null` is "no universe row declares a
  // subclass", which is `DEFAULT_UNIVERSE`, `SMOKE_TEST_UNIVERSE` and every
  // backtest fixture — none of them a leveraged ETP ADR-0018 prices — and those
  // keep the pre-ADR-0018 ATR geometry below. An armed map with this instrument
  // missing THROWS rather than falling back (see `resolveSubclassBracket`);
  // sizing an unclassified name on the other subclass's numbers is the silent
  // error the ADR's sizing amendment exists to prevent
  const bracket = resolveSubclassBracket(instrument, config.subclass_of, config.subclass_brackets);

  const priced = priceBracket({ direction, entry, atr, bracket, config });
  if (priced.priced === null) return skip(priced.skip.reason, priced.skip.reason_detail);
  const { side, stop, target, stop_distance: stopDistance } = priced.priced;

  // The setup this decision represents, embedded once and used twice: to find
  // precedent now, and — if this intent survives the skip guards below — as
  // the row the Feedback Loop labels with its realized R on close
  const setupVector = buildSetupVector(debate, { entry, atr, stopDistance, bars });
  const precedent = retrieveCosinePrecedent(setupVector, setupStore, asOf);

  const sized = sizeBracket({
    priced: priced.priced,
    entry,
    equity,
    conviction: debate.confidence,
    converged: debate.converged,
    cosine_multiplier: precedent.cosine_multiplier,
    bracket,
    asset_class: mark.asset_class,
    config,
  });
  if (sized.sized === null) return skip(sized.skip.reason, sized.skip.reason_detail);

  // Written only once every skip guard has passed, so a decision the Trader
  // itself declined leaves no row
  //
  // What this does NOT promise: that every row written here becomes a labelled
  // trade. Risk can trim to a reject, Verdict can say no-go, and the broker can
  // refuse the order — each leaves a setup no `labelSetup` ever arrives for
  // Those rows are inert rather than harmful (`findNeighbors` returns only
  // closed-outcome setups, so an unlabelled row can never influence sizing),
  // and the alternative is worse: the vector is only computable here, at the
  // point the decision is made, so deferring the write to the fill would mean
  // carrying the embedding through three stages that have no use for it
  //
  // The write is first-write-wins in the store, which is what makes a
  // re-decided bar — replay, or a crash-restart on the same bar — safe rather
  // than fatal
  setupStore.writeSetup(debate.debate_id, setupVector, asOf);

  const decisionBar = decisionBarFor(debate);

  return emit(
    {
      // #753: `arm` is a hash input, not merely a recorded label. The control
      // arm runs the same names on the same bars, so on every bar the two arms
      // agree they would otherwise produce ONE key and Execution's `findByKey`
      // gate would dedupe the second away — silently, and exactly on the
      // agreeing subset the comparison is most sensitive to. `'live'` hashes
      // identically to the pre-#753 payload; see `computeIdempotencyKey`
      idempotency_key: computeIdempotencyKey(
        instrument,
        decisionBar,
        intentSideFor(intentType),
        arm,
      ),
      instrument,
      asset_class: mark.asset_class,
      side,
      intent_type: intentType,
      size: sized.sized.size,
      entry,
      stop,
      target,
      time_in_force: config.time_in_force[mark.asset_class],
      decision_timestamp: decisionBar,
      decided_at: asOf,
      metadata: {
        debate_id: debate.debate_id,
        // #753. Recorded on every intent (never omitted for the live arm), so
        // `trader_log` / `risk_log` rows say which arm decided without anyone
        // having to infer it from a `debate_id` prefix
        arm,
        conviction: debate.confidence,
        converged: debate.converged,
        sizing: sized.sized.sizing,
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
  exitKind: ExitKind,
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
    exitKind,
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
 * What the exit prices its (degenerate) bracket at — and #826's decision:
 * **a MANDATORY flatten never depends on a live mark.**
 *
 * ## The failure
 *
 * `FailoverDataSource` (providers/market-data-service) fails bars over to a
 * second vendor and deliberately does NOT fail marks over: the fallback
 * vendors serve delayed historical aggregates, and pricing an open position
 * off a delayed, differently-conventioned feed is worse than a loud failure.
 * That decision stands and is not reopened here. Its CONSEQUENCE is what #826
 * is about: `getMark` still throws for the whole length of an Alpaca stall,
 * and this read is on the flatten's path — so under ADR-0014's flat-by-close
 * invariant a vendor outage in the last hour of a session was not a pause, it
 * was a missed exit. The throw propagates to `tick-loop.ts`'s `error` catch,
 * the tick moves on, and a leveraged ETP (ADR-0016) carries overnight.
 *
 * ## Hold versus flatten — the ticket's actual question
 *
 * **Flatten.** Scoped to the ONE exit the horizon makes mandatory
 * (`exit_reason: 'flatten'`); every other exit keeps failing loudly, and so
 * does every entry.
 *
 * The argument is that the mark is not load-bearing for this order. An exit
 * sizes to the HELD QUANTITY, never to a price (`heldQuantitiesFor`, above),
 * and `executeExit` submits a MARKET flatten — `submitFlatten` takes
 * (instrument, side, size, key) and reads no price at all. The mark's only
 * jobs here are to stamp `asset_class` and to fill `entry`/`stop`/`target`,
 * which are degenerate on an exit by construction (all three equal) and which
 * #83's flatten lifecycle does not consult. `asset_class` is carried on the
 * open lot, which is the better source anyway: it is what the position was
 * actually opened as.
 *
 * So the choice is between a flatten that goes out with three unread price
 * fields and no flatten at all. ADR-0014 settles that.
 *
 * ## Why only `'flatten'`
 *
 * `signal_decay` and `direction_flip` are DISCRETIONARY exits — the system
 * choosing to close, not the session forcing it. Nothing is lost by deferring
 * one to the next tick, and a market-data feed that cannot answer is a real
 * reason to do less. `'flatten'` is the only exit whose deferral is itself the
 * harm, so it is the only one that degrades; the other two keep propagating
 * the throw exactly as before.
 *
 * ## The trigger is ANY throw, not a feed stall
 *
 * The degradation keys on `getMark` throwing, and nothing narrower: a symbol
 * mapping that resolves to no instrument, a `marketData` wired to a source that
 * does not serve this venue, and a stalled feed are one case here. That is
 * correct rather than merely tolerable, because the flatten's size comes from
 * our own position store and its price fields are never read — an exit is
 * sized to the held quantity, so a misconfiguration cannot make a degraded
 * flatten close the wrong amount, only an unpriced one.
 *
 * ## The control plane is a different service
 *
 * Alpaca serves both marks and orders here, so a fair question is whether a
 * flatten can even be submitted during an Alpaca outage. It can: the data API
 * stalling does not imply the trading API is down, and they are separate hosts
 * (`AlpacaHttpDataClient` vs the execution adapter). If the trading API is
 * also down the flatten fails at the adapter — loudly, with a durable
 * `flatten_submissions` row and #86's reconciliation behind it — which is the
 * correct outcome and strictly better than never having tried.
 *
 * ## Backtest and replay
 *
 * Not gated on a mode flag, because this seam has none and inventing one would
 * add a knob a caller can set wrongly. A missing fixture mark in replay still
 * fails loudly one stage down: `SimulatedBrokerAdapter` prices its own fills
 * through `marketData.getMark`, so an unpriced exit cannot fill quietly there
 * — it raises the same read failure at the adapter instead.
 *
 * ## Why this is the settled posture (#900)
 *
 * #900 asked whether the remainder — quotes/marks never failed over, so
 * `signal_decay`, `direction_flip`, every entry, and every scale_in still
 * throw during a vendor outage — is an open gap or an accepted design. It is
 * the latter, recorded here rather than reopened: `FailoverDataSource`
 * fails BARS over to a second vendor and deliberately does not fail
 * marks/quotes over (see above), and there is no equivalent for a mark today
 * to fail over TO even if the policy changed — #895 records that no LSE mark
 * vendor is chosen at all yet, so building failover for a data class with no
 * live source would be premature. A vendor outage therefore leaves the book
 * able to take exactly one action: the clock-driven mandatory flatten, which
 * degrades because deferring it IS the harm (ADR-0014). Every other
 * decision — an entry, a scale_in, or either discretionary exit — is the
 * system CHOOSING to act rather than the session forcing it, so failing
 * closed and deferring to the next tick is the correct posture, not an
 * oversight this function forgot to handle. `decide.test.ts`'s "#826 — THE
 * MARK SOURCE STALLS" suite pins this for all four decision kinds — entry,
 * scale_in, signal_decay, direction_flip — and `live-money-gates.ts` carries
 * the operator-facing citation.
 */
async function readExitPrice(
  input: Pick<TraderInput, 'instrument' | 'marketData' | 'onUnpricedFlatten'>,
  positions: OpenPosition[],
  exitReason: ExitReason,
  asOf: Date,
): Promise<{ price: number; asset_class: AssetClass; unpriced: boolean }> {
  const { instrument, marketData } = input;
  try {
    const mark = await marketData.getMark(instrument, asOf);
    return { price: mark.price, asset_class: mark.asset_class, unpriced: false };
  } catch (error) {
    const lotAssetClass = positions[0]?.asset_class;
    // A discretionary exit, or a lot that cannot even say what asset class it
    // is (nothing constructs one, but an array index is not proof) — both
    // propagate exactly as they did before #826
    if (exitReason !== 'flatten' || lotAssetClass === undefined) throw error;

    const reason = describeThrownSafely(error);
    try {
      input.onUnpricedFlatten?.({ instrument, reason });
    } catch {
      // The flatten is already decided; a page that could abort it would
      // reinstate the very suppression this function removes. The composition
      // root logs before it posts (`reportExitValuationDegraded`), so the
      // durable record does not depend on this call surviving
    }
    return { price: 0, asset_class: lotAssetClass, unpriced: true };
  }
}

/**
 * WHICH exit is being built, and — for the mandatory flatten alone — the
 * session close it is enforcing (#1389).
 *
 * A discriminated union rather than a bare `ExitReason` plus an optional date,
 * because the session close is the flatten's IDEMPOTENCY COORDINATE and a
 * flatten built without one would silently fall back to some other coordinate.
 * Spelled this way, the compiler refuses a `'flatten'` that does not carry a
 * close, and refuses to let the two discretionary exits acquire one they must
 * not use.
 */
type ExitKind =
  | { reason: 'flatten'; session_close: Date }
  | { reason: 'signal_decay' }
  | { reason: 'direction_flip' };

/**
 * Has this arm already SENT a flatten for this instrument that has not
 * resolved yet (#1389)?
 *
 * ## Why the idempotency key is not enough on its own
 *
 * The key dedups one COORDINATE. It was never a per-instrument in-flight
 * guard, and every design #1389's re-analysis discarded failed at exactly that
 * gap. Between `submitFlatten` and the fill sweep, `getExitFillSizes` still
 * reports nothing closed, so any second flatten that reaches the builder sizes
 * itself off the FULL `filled_size` and sells the whole lot again — into a
 * short, on a 3x leveraged ETP. `executeExit`'s size guard compares the same
 * two stale numbers and agrees.
 *
 * The key stops the same obligation being re-sent under the same coordinate.
 * This stops a DIFFERENT coordinate — a partially-filled first flatten, a lot
 * whose key changed across a config edit, a retry that advanced its key — from
 * arriving while the first one is still open at the venue. Two guards, two
 * failure modes; neither subsumes the other.
 *
 * ## Why a RETURN and never a fall-through
 *
 * On the tick path the branch below this one is the decay release, and it
 * sizes off the same stale held quantities. Falling through would produce the
 * identical over-sell wearing a different `exit_reason`, which is worse than
 * the bug it replaces because the row would not even say "flatten".
 *
 * ## What this blocks that it should not
 *
 * A wedged fill poll leaves rows unresolved forever and makes the instrument
 * un-flattenable until it is unwedged. Blocking is still the safe direction —
 * the held quantities really are unknown until the sweep lands — and the
 * carried-lot alert is what bounds it. That bound is documented, not coded;
 * see ADR-0014's 2026-09-10 amendment.
 */
async function flattenAlreadyInFlight(
  input: Pick<TraderInput, 'instrument' | 'unresolvedFlattens'>,
): Promise<boolean> {
  const unresolved = await input.unresolvedFlattens();
  return unresolved.some((submission) => submission.instrument === input.instrument);
}

/**
 * The debate-free core of the flatten (#743): everything an exit needs is a
 * mark, the held quantities and a coordinate for the idempotency key.
 * `attribution` is metadata only — nothing here branches on it, which is what
 * keeps the exit path safe to run without a debate (orchestrator-spec.md,
 * "The tick/decision split", constraint 4).
 */
async function buildFlattenExit(
  input: Pick<
    TraderInput,
    'arm' | 'clock' | 'config' | 'exitFillSizes' | 'instrument' | 'marketData' | 'onUnpricedFlatten'
  >,
  positions: OpenPosition[],
  decisionBar: Date,
  attribution: ExitAttribution,
  exitKind: ExitKind,
): Promise<TraderOutcome> {
  const exitReason: ExitReason = exitKind.reason;
  // No `marketData` here since #826: the mark read moved into `readExitPrice`,
  // which owns both the healthy answer and the unpriced degradation
  const { clock, config, exitFillSizes, instrument } = input;
  // #753 — see `buildBracket`'s note. Absent means the live arm.
  const arm = input.arm ?? 'live';

  const existingSide = positions[0]?.side;
  if (existingSide === undefined) {
    throw new Error('buildFlattenExit: positions must be non-empty');
  }
  const closingSide = existingSide === 'buy' ? 'sell' : 'buy';
  // Only filled exposure needs flattening — a lot still `pending`/
  // `submitted` has nothing on the books yet, so an all-pending instrument
  // has no fill to close and there is nothing to emit
  //
  // #568: and only what the VENUE still holds. `filled_size` alone is the
  // ENTRY quantity, which no exit fill reduces, so a partially-flattened lot
  // (which stays open) would size this exit to the original quantity while
  // the venue holds only the residual. `heldQuantitiesFor` subtracts what is
  // already closed — the same derivation `executeExit` re-runs before it
  // submits, and it refuses on exact inequality, so a difference between the
  // two stops the exit rather than mis-sizing it
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

  // Stamped onto `decided_at` below (#1190) — same `clock.now()` read as
  // `buildBracket`'s, see that call's comment for why this and not
  // `DebateLog.created_at`. This exit's own gate 1 read is exempted for
  // `exit_reason: 'flatten'` (`mandatory_flatten`, see verdict/index.ts), so
  // this timestamp only feeds `trader_log`/observability here, not a gate
  const asOf = clock.now();
  const priced = await readExitPrice(input, positions, exitReason, asOf);

  return emit(
    {
      // #1389: the MANDATORY flatten is keyed on the session close it enforces,
      // not on a bar — so the same obligation, evaluated on either side of the
      // bell, produces one key and gate 3 dedups across the boundary. See
      // `computeFlattenIdempotencyKey`
      //
      // #748: the two DISCRETIONARY exits keep the bar coordinate, and the
      // early exit keeps its own `'early_close'` discriminator, so a release
      // and a later mandatory flatten in the same bar cannot hash to one key
      // and have the flatten deduped away. See `IntentSide`.
      idempotency_key:
        exitKind.reason === 'flatten'
          ? computeFlattenIdempotencyKey(instrument, exitKind.session_close, arm)
          : computeIdempotencyKey(
              instrument,
              decisionBar,
              exitKind.reason === 'signal_decay' ? 'early_close' : 'close',
              arm,
            ),
      instrument,
      asset_class: priced.asset_class,
      side: closingSide,
      intent_type: 'exit',
      size: totalSize,
      // All three are the mark, or all three are ZERO when there was no mark
      // to read (#826). Degenerate either way: #83 owns the flatten lifecycle
      // and consults none of them, and `executeExit` submits a market flatten
      // sized to the held quantity without reading a price at all
      entry: priced.price,
      stop: priced.price,
      target: priced.price,
      time_in_force: config.time_in_force[priced.asset_class],
      decision_timestamp: decisionBar,
      decided_at: asOf,
      metadata: {
        debate_id: attribution.debate_id,
        // #753 — see the entry intent's own `arm` note
        arm,
        exit_reason: exitReason,
        // Spread rather than a plain `unpriced_exit: priced.unpriced` field:
        // `exactOptionalPropertyTypes` is on, and the flag is true-or-absent so
        // that `=== true` is the only test a reader can write (#826)
        ...(priced.unpriced ? { unpriced_exit: true as const } : {}),
        // #894: the mandatory-flatten marker Verdict's gate-1 exemption reads
        // Derived from `exitReason` HERE, at the one place an exit intent is
        // constructed, so the two discretionary exits cannot acquire it and no
        // second call site has to be kept in step. Same spread form and the
        // same true-or-absent shape as `unpriced_exit`, for the same
        // `exactOptionalPropertyTypes` reason
        ...(exitReason === 'flatten' ? { mandatory_flatten: true as const } : {}),
        // #1497: the per-lot breakdown behind `totalSize` — see this field's
        // doc on `OrderIntentMetadata` for why `executeExit` needs it to catch
        // a compensating swap the total-only guard cannot see
        lot_held_quantities: held,
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
          // the no-precedent default — which is also the honest reading
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
 * WHY a `TraderSkipReason` fired, at the granularity an operator's next
 * action needs (#1109).
 *
 * `skip_reason` alone answers "the Trader declined" without saying whether
 * the refusal is the system working or the system starving — and those two
 * demand opposite responses. #1080 found 41 of 44 live debates in the
 * 2026-09-04 session timed out (32 with zero completed rounds); every one of
 * them still resolved to `direction: 'neutral'`, so the Trader's own
 * `neutral_direction_while_flat` / `holding_neutral_or_non_converged` rows
 * were byte-identical whether the debate genuinely read neutral or never
 * finished reading anything.
 *
 * - `declined_on_signal` — the debate (or the position/sizing state) was
 *   read and the read said no. Nothing upstream needs attention.
 * - `could_not_decide` — the debate itself produced nothing usable
 *   (`timed_out` or `rate_limited`); the Trader's `neutral`-shaped refusal is
 *   a correct response to a bad input, not a reading of the market.
 * - `input_unusable` — the Trader's OWN priced inputs (a mark, an ATR, a
 *   fill record) could not be used this tick — missing, not yet available,
 *   or non-finite. Distinct from `could_not_decide` because the debate
 *   itself was fine; the problem is downstream of it.
 *
 * `input_unusable` is not uniformly alarming. `atr_insufficient_bars` is a
 * warm-up/data-gap case — expected early in a soak or when an instrument is
 * new to the universe (#475) — not evidence of corrupt data, and it sits
 * here rather than in `could_not_decide` on purpose: `could_not_decide` has
 * no static baseline anywhere in `SKIP_REASON_CLASS` (below) — it exists
 * ONLY as `classifyDecision`'s degraded-debate override — and #1109's
 * acceptance criterion pins its count to #1080's 41 debate timeouts. Giving
 * `atr_insufficient_bars` a baseline of `could_not_decide` would fold every
 * routine warm-up tick into that count and make it stop meaning "the debate
 * starved."
 *
 * So the class alone is not the operator's within-bucket severity signal for
 * `input_unusable` — two things downstream of it are. `reason_detail` is one:
 * `atr_insufficient_bars` is the ONLY `input_unusable` reason that carries a
 * non-null one (bars compared against the configured minimum), so a query
 * can isolate it from its genuinely-corrupt siblings without pattern-matching
 * `skip_reason` strings. `TraderDiagnostic` is the other: it already excludes
 * `atr_insufficient_bars` from the alarming `atr_not_finite` kind for exactly
 * this reason (see `TraderDiagnosticKind`).
 *
 * `null` on any outcome that is not a skip: an emitted order has nothing to
 * classify.
 */
type TraderDecisionClass = 'declined_on_signal' | 'could_not_decide' | 'input_unusable';

/**
 * The BASELINE classification for every `TraderSkipReason`, before
 * `classifyDecision`'s degraded-debate override. A `Record` over the full
 * union rather than a function with a default case, so a twentieth skip
 * reason is a compile error here until someone decides which bucket it
 * belongs to, the same guarantee `TraderSkipReason` itself gives `skip()`'s
 * call sites.
 *
 * `neutral_direction_while_flat` and `holding_neutral_or_non_converged` sit
 * here too, at their baseline `declined_on_signal` — they read `debate`
 * exactly the way every other `declined_on_signal` reason can end up doing
 * (see `classifyDecision`), so there is nothing left that is special about
 * them once the override lives in one place.
 *
 * `rounds_to_zero_shares` sits with `below_min_notional`, not with the
 * data-quality reasons below it in `TraderSkipReason`'s ordering — its own
 * comment in `sizeBracket` says it "belongs in `below_min_notional` where it
 * has always been reported": both are the strategy correctly declining to
 * deploy a real, well-formed size, not a corrupt input.
 */
const SKIP_REASON_CLASS: Record<TraderSkipReason, TraderDecisionClass> = {
  below_conviction_floor: 'declined_on_signal',
  session_closing: 'declined_on_signal',
  below_min_notional: 'declined_on_signal',
  scale_in_conviction_delta_not_met: 'declined_on_signal',
  rounds_to_zero_shares: 'declined_on_signal',
  no_open_position: 'declined_on_signal',
  signal_still_supports_position: 'declined_on_signal',
  neutral_direction_while_flat: 'declined_on_signal',
  holding_neutral_or_non_converged: 'declined_on_signal',
  exit_no_filled_size: 'input_unusable',
  exit_held_quantity_diverged: 'input_unusable',
  // The system working, not starving: the close IS in flight. `input_unusable`
  // would fold it in with the fill-record failures above and make a healthy
  // dedup look like corrupt data
  flatten_in_flight: 'declined_on_signal',
  early_exit_signal_unavailable: 'input_unusable',
  no_position_side: 'input_unusable',
  // benign warm-up, not corruption — see the class doc above
  atr_insufficient_bars: 'input_unusable',
  atr_not_finite: 'input_unusable',
  mark_not_finite: 'input_unusable',
  stop_distance_not_positive: 'input_unusable',
  size_not_finite: 'input_unusable',
  control_arm_valuation_refused: 'input_unusable',
};

/**
 * `debate.timed_out`/`.rate_limited` mirror the discriminator
 * `debateDecisionWord` (orchestrator, #1080) uses at the Debate seam — this
 * is the Trader-side read of the same two fields, not a re-derivation of a
 * third state. Deliberately does NOT split `timed_out` by
 * `rounds_completed`: #1080's `timed_out_partial` distinction lives at the
 * Debate stage, and a partial debate is no more decided than a zero-round one
 * from the Trader's seat — both handed it a `direction` it should not trust.
 *
 * `!debate.read` is checked alongside them (#1393): `timed_out` and
 * `rate_limited` name the two read failures this contract knows about today,
 * but a future fallback that hands back a neutral result for neither reason
 * would set both to `undefined` and, without this check, read here as a
 * genuine decline. No producer sets `read: false` yet, so this arm is dead
 * today and exists to keep it that way once one does.
 */
function debateWasDegraded(debate: DebateResult): boolean {
  return !debate.read || debate.timed_out !== undefined || debate.rate_limited !== undefined;
}

/**
 * `declined_on_signal` reasons whose baseline is NOT actually a read of the
 * debate, and so must sit out `classifyDecision`'s degraded-debate override.
 *
 * `session_closing` is the one member: `withinFlattenWindow` decides off the
 * clock and the session calendar, and would fire identically against a fully
 * converged debate, so the override must not flip it to `could_not_decide`
 * on a merely degraded one — that would point an operator at an upstream
 * failure that is not there. A future reason added here needs the same
 * argument — "this baseline never reads `debate` at all" — not just a
 * baseline of `declined_on_signal`.
 */
const DECLINED_ON_SIGNAL_NOT_DEBATE_DERIVED: ReadonlySet<TraderSkipReason> = new Set([
  'session_closing',
]);

/**
 * `skip_reason` plus the debate that produced it, resolved to the class an
 * operator's response turns on.
 *
 * A degraded debate is not confined to producing
 * `neutral_direction_while_flat`/`holding_neutral_or_non_converged`. On a flat
 * instrument, `routeDecision` only special-cases `direction === 'neutral'`
 * before routing to `buildBracket` — and a timed-out debate with
 * `rounds_completed > 0` can hand back `partial.direction` as `long`/`short`
 * (`latency-budget.ts`), which reaches `buildBracket` with no `converged`
 * check on that path at all. Every `buildBracket` skip downstream of that —
 * `below_conviction_floor` among them — is then a read of a debate that never
 * finished, not a genuine decline. So the override is keyed on the
 * BASELINE CLASS, not the specific reason: MOST reasons whose baseline is
 * `declined_on_signal` are read off the debate, and a degraded debate makes
 * that read untrustworthy regardless of which `declined_on_signal` reason it
 * produced — except the ones in `DECLINED_ON_SIGNAL_NOT_DEBATE_DERIVED`
 * above, whose baseline reads something else entirely. `input_unusable`
 * reasons are a different fault (the Trader's own priced inputs, downstream
 * of the debate) and are never overridden by the debate's health.
 */
function classifyDecision(
  skip_reason: TraderSkipReason,
  debate: DebateResult,
): TraderDecisionClass {
  const baseClass = SKIP_REASON_CLASS[skip_reason];
  const isDebateDerivedDecline =
    baseClass === 'declined_on_signal' && !DECLINED_ON_SIGNAL_NOT_DEBATE_DERIVED.has(skip_reason);
  return isDebateDerivedDecline && debateWasDegraded(debate) ? 'could_not_decide' : baseClass;
}

/** One detected degradation, with enough context for an operator to act */
export interface TraderDiagnostic {
  kind: TraderDiagnosticKind;
  /**
   * Which leg — the calendar and the venue both follow the instrument's
   * class. `undefined` for exactly `control_arm_valuation_refused`: it fires
   * from the equity read at the top of `buildBracket`, before the mark read a
   * few lines later ever resolves an `asset_class` on the entry branch —
   * there is no class in scope yet to carry, and this diagnostic must not
   * wait for one (that would put the sizing read behind the mark read,
   * changing the live arm's fault-handling order for no live-arm benefit).
   */
  asset_class: AssetClass | undefined;
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
   * WHY `skip_reason` fired, at the operator-response granularity #1109
   * exists to give — see `TraderDecisionClass`. Set by `decideWithReason`
   * from `skip_reason` and `input.debate` after routing, not by `skip()`
   * itself: classification needs the debate that produced the reason, and
   * threading it through every skip site would break the one-line-per-site
   * property `skip()` protects. `null` exactly when `skip_reason` is `null`.
   */
  decision_class: TraderDecisionClass | null;
  /**
   * The compared value and the threshold, for a skip reason that is a
   * numeric gate (#1109) — see `TraderReasonDetail`. `null` for every skip
   * that is not one of the four threshold sites, and always `null` when an
   * order was produced.
   */
  reason_detail: TraderReasonDetail | null;
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
 * A declined decision. Narrow helper so every skip site stays one line each —
 * and so a newly added one cannot forget a field.
 *
 * Diagnostics are deliberately NOT a parameter here (#698): they are collected
 * in `decideWithReason`'s accumulator and merged onto whatever this returns, so
 * that the one-line-per-skip-site property this helper exists to protect
 * survives a second cross-cutting field. `decision_class` is likewise not a
 * parameter (#1109) — it is filled in by `decideWithReason`, which is the one
 * place that has both `skip_reason` and the debate that produced it.
 * `reason_detail` IS a parameter: unlike the other two, it is known only at
 * the call site that compared the value to its threshold.
 */
function skip(
  reason: TraderSkipReason,
  reason_detail: TraderReasonDetail | null = null,
): TraderOutcome {
  return {
    intent: null,
    skip_reason: reason,
    decision_class: null,
    reason_detail,
    atr: null,
    diagnostics: [],
  };
}

/** A decision that produced an order */
function emit(intent: OrderIntent, atr: number | null): TraderOutcome {
  return {
    intent,
    skip_reason: null,
    decision_class: null,
    reason_detail: null,
    atr,
    diagnostics: [],
  };
}

export async function decide(input: TraderInput): Promise<OrderIntent | null> {
  return (await decideWithReason(input)).intent;
}

/**
 * `decide`, but saying WHY when it declines (#475).
 *
 * The Trader has nineteen distinct ways to produce no order, and until this
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
  // the trade #698 itself argues against
  const diagnostics: TraderDiagnostic[] = [];
  const outcome = await routeDecision(input, diagnostics);

  // #1109: classified once here, not at each `skip()` call site — see
  // `TraderOutcome.decision_class`
  const decision_class =
    outcome.skip_reason === null ? null : classifyDecision(outcome.skip_reason, input.debate);

  // Merged here rather than at each producing site so the skip helper stays a
  // one-liner and no future skip site can forget the field
  return {
    ...outcome,
    decision_class,
    diagnostics: diagnostics.length === 0 ? outcome.diagnostics : diagnostics,
  };
}

/**
 * `decideWithReason`'s routing on current position state (trader-spec.md
 * Module: Position Awareness, tickets #73/#74), with #698's diagnostic
 * accumulator threaded through
 */
async function routeDecision(
  input: TraderInput,
  diagnostics: TraderDiagnostic[],
): Promise<TraderOutcome> {
  const { config, debate, instrument, positionState } = input;

  const positions = (await positionState()).filter((lot) => lot.instrument === instrument);

  if (positions.length === 0) {
    if (debate.direction === 'neutral') return skip('neutral_direction_while_flat');
    return buildBracket(input, debate.direction, 'entry', diagnostics);
  }

  // All lots for one instrument are the same side by construction (v1
  // per-lot design: scale_in only adds same-direction, exit flattens before
  // a fresh entry) — no defensive mixed-side reconciliation
  const existingSide = positions[0]?.side;
  if (existingSide === undefined) return skip('no_position_side');

  // FLAT BY CLOSE (#668, ADR-0014) — ahead of EVERY other holding branch, and
  // the ordering is the load-bearing part
  //
  // Below this point the router can decline to act for reasons that are all
  // perfectly good reasons to hold a position through a quiet afternoon and
  // are none of them a reason to hold one overnight: a neutral debate, a
  // non-converged one, a scale-in delta not met. Put the close check after any
  // of them and the commonest branch in the whole system — `debate.direction
  // === 'neutral'`, 92 of 94 debates in the soak — silently suppresses the
  // flatten and carries the book overnight. That is the exact failure the rule
  // exists to prevent, so it is decided first
  //
  // ADR-0007/ADR-0013 removed the human from the trade path, so this must fire
  // unattended INCLUDING on the days it closes into a loss
  const positionAssetClass = positions[0]?.asset_class;
  if (positionAssetClass !== undefined) {
    const flattenWindow = withinFlattenWindow(input, positionAssetClass);
    // Pushed BEFORE the branch, so the diagnostic survives whichever way it
    // goes: a stale close produces an exit intent, and an equity calendar that
    // has stopped resolving sessions produces `false` and no exit at all — the
    // second being precisely the silent case #698 was filed for
    if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);
    if (flattenWindow.within) {
      // #1389's second guard, and it sits HERE rather than inside
      // `buildFlattenExit` on purpose: that builder also serves the two
      // discretionary exits, and a guard at its top would silently swallow a
      // direction-flip or a decay release whenever a flatten happened to be in
      // flight — refusing exits the in-flight flatten is not the close for
      if (await flattenAlreadyInFlight(input)) return skip('flatten_in_flight');
      return buildExitIntent(input, positions, {
        reason: 'flatten',
        session_close: flattenWindow.enforcing_close,
      });
    }
  }

  if (debate.direction === 'neutral' || !debate.converged) {
    return skip('holding_neutral_or_non_converged');
  }

  const desiredSide = sideFor(debate.direction);
  if (desiredSide !== existingSide) {
    return buildExitIntent(input, positions, { reason: 'direction_flip' });
  }

  const mostRecentLot = mostRecentOpenLot(positions);
  if (debate.confidence - mostRecentLot.conviction < config.scale_in_conviction_delta) {
    return skip('scale_in_conviction_delta_not_met', {
      compared_value: debate.confidence - mostRecentLot.conviction,
      threshold: config.scale_in_conviction_delta,
    });
  }

  return buildBracket(input, debate.direction, 'scale_in', diagnostics);
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
  // #1389: the tick path is where the mandatory flatten is decided, so the
  // in-flight guard has to reach THIS entry point — omitting it here would
  // leave the second flatten unguarded on precisely the path that produces
  // nearly all of them
  | 'unresolvedFlattens'
  // #826: the tick path is where the mandatory flatten is actually decided
  // (`routeExitCheck`'s first branch), so the unpriced-flatten escalation has
  // to reach THIS entry point — omitting it here would leave the degradation
  // audible only on the once-a-bar decision path
  | 'onUnpricedFlatten'
  // #753: which arm's book this exit closes. Both arms share this ONE exit
  // entry point — that sharing is the acceptance criterion "both arms share
  // the same exit rule and the same stop, asserted, not configured twice" —
  // so the arm cannot be a property of a second implementation; it has to be
  // an input to the single one
  | 'arm'
> & {
  /** The pass's debate-bar coordinate, floored once by the tick runner */
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
  const decision_class =
    outcome.skip_reason === null ? null : classifyExitCheckSkip(outcome.skip_reason);
  return {
    ...outcome,
    decision_class,
    diagnostics: diagnostics.length === 0 ? outcome.diagnostics : diagnostics,
  };
}

/**
 * `classifyDecision`'s counterpart for the tick-path exit entry point
 * (#1109). `ExitCheckInput` carries no `DebateResult` by construction, so
 * `routeExitCheck` (and the `buildExitIntent` helper it shares with
 * `routeDecision`) can only produce a skip that reads position/mark/fill
 * state — never `neutral_direction_while_flat` or
 * `holding_neutral_or_non_converged`, the two `SKIP_REASON_CLASS` entries
 * `classifyDecision` overrides using a debate this entry point does not have.
 *
 * A plain `SKIP_REASON_CLASS` lookup, not a branch on those two reasons:
 * this runs on the exit-cadence / flat-by-close path (~30 calls/bar/
 * instrument, the mandatory flatten among them), where nothing may throw.
 * `SKIP_REASON_CLASS` being a `Record` over the FULL `TraderSkipReason`
 * union already gives the same compile-time guarantee a runtime assertion
 * would — a twentieth reason added there without a class here is a compile
 * error — without a runtime path that can take the flatten down with it.
 */
function classifyExitCheckSkip(skip_reason: TraderSkipReason): TraderDecisionClass {
  return SKIP_REASON_CLASS[skip_reason];
}

/** `checkExitsWithReason`'s routing, with the #698 diagnostic accumulator threaded through */
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
  // and at a 2-minute tick THIS is now the path that reports it most often
  if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);

  const mostRecentLot = mostRecentOpenLot(positions);
  const attribution = {
    debate_id: mostRecentLot.debate_id,
    conviction: mostRecentLot.conviction,
    converged: mostRecentLot.converged,
  };

  // FLAT BY CLOSE FIRST, AND THE ORDER IS THE SAFETY ARGUMENT (#748)
  //
  // The flatten is evaluated on a tick and NOWHERE ELSE — there is no
  // session-end job (orchestrator-spec.md, tick/decision split, constraint 1) —
  // so anything placed ahead of it can cost the book an overnight carry. Put
  // the decay read first and a cold instrument's `InsufficientBarsError`, a
  // store outage, or any future throw inside it takes out the flatten with it
  // Below this line, nothing the early exit does can reach the flatten: it has
  // already returned
  if (flattenWindow.within) {
    // #1389. RETURNS rather than falling through — see `flattenAlreadyInFlight`
    // for why continuing to the decay read below would be the same over-sell by
    // another name
    if (await flattenAlreadyInFlight(input)) return skip('flatten_in_flight');
    return buildFlattenExit(input, positions, input.bar, attribution, {
      reason: 'flatten',
      session_close: flattenWindow.enforcing_close,
    });
  }

  // The indicator-based early exit (#748). Reached only when the flatten is not
  // due, and it consults ONLY indicators — no `AnalystView`, no `DebateResult`,
  // no model call. `ExitCheckInput` has no field any of those could arrive
  // through, which is orchestrator-spec.md constraint 4 enforced by the type,
  // and this change adds none
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
  // no argument to it that could produce anything else
  return buildFlattenExit(input, positions, input.bar, attribution, { reason: 'signal_decay' });
}
