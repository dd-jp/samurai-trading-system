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
// TYPE-only, and from the defining module rather than the debate-engine
// barrel, for the reason the deleted `floorToBar` import used to state: the
// barrel pulls the whole engine's module graph into the Trader path. A type
// import is erased at compile time, so this adds no runtime edge — and it is
// deliberately the ONLY thing this module now takes from the debate engine.
// The bar grid (`floorToBar`, `DEBATE_BAR_TIMEFRAME_MS`) used to be imported
// here as values so the Trader could re-derive the decision bar; it no longer
// is, because the Trader no longer derives it (#687).
import type { DebateResult } from '../debate-engine/types.js';
// #1089: the ONE typed dependency this otherwise risk-manager-free module
// takes, and only for `instanceof` discrimination (coding-standards.md
// "Typed errors only where a caller branches" — the same posture
// `DuplicatePositionError` models). `TraderInput.equity` stays an opaque
// thunk everywhere else in this file; the single call site that inspects
// what it threw needs to tell a genuine whole-book valuation refusal apart
// from any OTHER rejection the thunk's implementation might raise (e.g.
// `sizingEquity`'s #569 non-finite-ceiling guard) — see `buildBracket`.
// `BookValuationError` (#1089), not `StaleMarkError` alone: `readMarks`
// (portfolio-view.ts) throws it bare on either a stale mark or a failed/
// omitted mark read, and the base type is what catches both.
import { BookValuationError } from '../risk-manager/index.js';
import { NO_PRECEDENT_MULTIPLIER, retrieveCosinePrecedent } from './cosine-precedent.js';
import { readSignalDecay } from './early-exit.js';
import { computeIdempotencyKey, intentSideFor } from './idempotency-key.js';
import { buildSetupVector } from './setup-vector.js';
import { resolveSubclassBracket, riskFractionFor } from './subclass-bracket.js';
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
 * `spec.lookback` being the BAR-WINDOW width (see below, matching
 * `DEFAULT_VOLATILITY_INDICATOR`), that fallback would silently make this an
 * ATR(`lookback`+1-ish), the exact off-by-one commit 0281a8c already had to
 * fix once.
 *
 * `lookback` sits on the CONVERGED warm-up (`recommendedWarmupFor` =
 * `4 x lookback + 1`), not the `lookback + 1` arity floor (#757,
 * `docs/reviews/indicator-characterisation-2026-08-16.md` F1 — the same
 * warm-up gap #722 fixed for `RSI_SPEC`). This field is metadata only for
 * `computeIndicator` (which reads `bars.length` and `params.period`, not
 * `spec.lookback`) — the value that actually matters is the bar window
 * `atrFor`'s caller fetches, which is derived from this same function via
 * `recommendedWarmupFor(atrIndicatorSpec(...))` at the call site in
 * `buildBracket`. Keeping both derived from one function is what stops the
 * spec's declared width and the actual fetch width from drifting apart the
 * way #722 had to fix for `WARM_START_WINDOWS`.
 */
export function atrIndicatorSpec(lookback: number, timeframe: string): IndicatorSpec {
  const floor: IndicatorSpec = {
    indicator: 'atr',
    params: { period: lookback },
    // Passed in rather than defaulted (#315). This spec describes the bars the
    // caller fetched with `config.atr_timeframe`, and a default here would let
    // the two drift — the spec claiming 1h while the ATR was computed on
    // something else, which reprices every stop without changing a test.
    timeframe,
    lookback: lookback + 1,
  };
  return { ...floor, lookback: recommendedWarmupFor(floor) };
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
):
  | { atr: number; reason: null; reason_detail: null }
  | { atr: null; reason: TraderSkipReason; reason_detail: TraderReasonDetail | null } {
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
  //
  // `minimumBarsFor(spec)` is a configured threshold (#1109) — it derives from
  // `config.atr_lookback` via `atrIndicatorSpec` — so `bars.length` against it
  // is the fourth numeric-gate site, alongside the three `TraderReasonDetail`
  // already covers. Without it "2 bars short" and "13 bars short" are the same
  // row, and the warm-up case this reason exists to distinguish (see #475's
  // comment above) is exactly the one a near-miss vs. a decisive shortfall
  // would tell apart.
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
 * The straddling intent is still DECIDED late: `decision_timestamp` is bar N
 * while the wall clock is in N+1. `decision_timestamp` no longer floors onto
 * the bar containing `created_at`, so it stays a usable marker in
 * `trader_log` that tells a straddle apart from an ordinary tick.
 *
 * It stopped being a fail-safe as of #1190, undisclosed there and stated
 * here: Verdict's staleness gate used to read `decision_timestamp` and so
 * caught a straddling intent as stale (bar N read against wall-clock N+1) —
 * "refusing a late intent beats corrupting the next bar's key". #1190 moved
 * that gate to `OrderIntent.decided_at`, `clock.now()` read fresh at the
 * point this function's caller builds the intent, regardless of which bar
 * the debate that produced it started in. A straddling intent now reads
 * exactly as fresh as an ordinary one and passes the gate. Whether a
 * straddle-specific bound should be added back is open — tracked as an open
 * question on #1190, not decided here.
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
  const { clock, config, debate, instrument, marketData, setupStore } = input;
  // #753: absent means the live arm — the arm that existed before the control
  // did — never "unknown".
  const arm = input.arm ?? 'live';

  // Every caller must have already excluded 'neutral' — sideFor has no
  // direction to derive a side from. Checked here, not just assumed, so the
  // invariant is enforced rather than merely documented.
  if (debate.direction === 'neutral') {
    throw new Error('buildBracket: debate.direction must not be neutral');
  }

  // THE SIZING READ (#847), resolved HERE — the first thing this function does
  // once it knows it is sizing, and the ONLY place in the module that touches
  // it. Two properties, both load-bearing:
  //
  //  1. Reaching sizing at all requires a whole-book valuation to have
  //     succeeded. On the LIVE arm the thunk's rejection propagates unchanged
  //     — that throw aborts the tick exactly as the eager read did before
  //     #847, and it is NOT converted into a `skip_reason` there. A read
  //     failure is a fault and must stay audible in `tick-loop.ts`'s
  //     `error`-level catch (#507).
  //
  //     #1089: `arm === 'control'` converts ONE specific shape of that
  //     rejection — a genuine whole-book valuation refusal, any
  //     `BookValuationError` (a stale mark OR a failed/omitted mark read) or
  //     an `AggregateError` whose members are ALL `BookValuationError` — into
  //     `control_arm_valuation_refused` instead of rethrowing. See that skip
  //     reason's own doc for why the control arm needs this and the live arm
  //     must not get it. Narrowed by TYPE, not just by arm: `input.equity()`
  //     is an opaque thunk that can reject for an unrelated reason
  //     (`sizingEquity`'s #569 non-finite-ceiling guard, a fail-open refusal
  //     that must stay a fault on EITHER arm), and only these two shapes
  //     identify "the book could not be valued" as opposed to "sizing itself
  //     refused". The `AggregateError` check inspects `.errors`, not just the
  //     wrapper type: `readMarks`'s own wrap (portfolio-view.ts) is always
  //     all-`BookValuationError`, but `input.equity()` is opaque and a future
  //     non-valuation `AggregateError` (e.g. a batched sub-read inside
  //     `sizingEquity`) must not be silently downgraded to a skip.
  //  2. Nothing that does NOT size pays for it or fails on it. `routeDecision`
  //     evaluates flat-by-close before it can ever get here, so a dark mark
  //     elsewhere in the book no longer suppresses this pass's flatten.
  //
  // Awaited at the TOP rather than at the use site so a future edit cannot
  // reach the `size` computation on some path that skipped the read.
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
      // `undefined` here on purpose — see `TraderDiagnostic.asset_class`.
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
  // mandatory (see `readExitPrice`'s docstring for the full posture).
  // Stamped onto `decided_at` below (#1190) — Verdict's gate 1 measures signal
  // age from THIS read, not from `DebateLog.created_at` (the debate's own
  // completion instant): `DebateResult` does not expose `created_at`, so
  // reading it here would need a contract change gate 1 does not otherwise
  // need, and `asOf` already bounds the same latency budget
  // (`LATENCY_BUDGET_MS.stocks`, 60s) that separates debate completion from
  // this call. Read BEFORE `getMark`/`getBars`/the precedent lookup below, so
  // a slow data fetch still counts toward the age Verdict measures — it is
  // not a cheap timestamp taken after the expensive work is already done.
  const asOf = clock.now();
  const [mark, bars] = await Promise.all([
    marketData.getMark(instrument, asOf),
    marketData.getBars(
      instrument,
      // CONVERGED width (#757): `recommendedWarmupFor` = `4 x atr_lookback + 1`.
      // Until #757 this fetched exactly `atr_lookback + 1` bars — one true
      // range past the seed, so `computeIndicator`'s Wilder smoothing loop ran
      // ZERO times and the value was a plain mean wearing Wilder's name (the
      // same warm-up gap #722 fixed for `RSI_SPEC`). Measured before adopting:
      // median relative shift 3.0%, p90 6.9%, near-zero signed bias, against a
      // declared median<=15%/p90<=30% gate — see
      // `docs/reviews/indicator-characterisation-2026-08-16.md` F1.
      //
      // Two tests pin the two halves, and neither pins the other's:
      // `atr-equivalence.test.ts` pins the ALGORITHMIC boundary (plain mean at
      // or below `period` ranges, smoothing beyond it) at the historical
      // `atr_lookback + 1` width, which is no longer the production fetch
      // width; `decide.test.ts` ("fetches exactly the converged ATR width")
      // pins THIS window, so narrowing the fetch back to the floor — or
      // dropping `atr_timeframe` — fails a test rather than silently
      // reintroducing the seed.
      //
      // Derived from `atrIndicatorSpec` rather than restated, so the fetch and
      // the spec that documents it cannot drift apart the way #722's
      // `WARM_START_WINDOWS` had to be fixed separately from `RSI_SPEC`.
      //
      // A separate fetch-width margin is applied underneath in fetchBars; see #362.
      {
        timeframe: config.atr_timeframe,
        lookback: recommendedWarmupFor(atrIndicatorSpec(config.atr_lookback, config.atr_timeframe)),
      },
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
    return skip(atrResult.reason, atrResult.reason_detail);
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

  // ADR-0018 D3/D5 (#739). `bracket === null` is "no universe row declares a
  // subclass", which is `DEFAULT_UNIVERSE`, `SMOKE_TEST_UNIVERSE` and every
  // backtest fixture — none of them a leveraged ETP ADR-0018 prices — and those
  // keep the pre-ADR-0018 ATR geometry below. An armed map with this instrument
  // missing THROWS rather than falling back (see `resolveSubclassBracket`);
  // sizing an unclassified name on the other subclass's numbers is the silent
  // error the ADR's sizing amendment exists to prevent.
  const bracket = resolveSubclassBracket(instrument, config.subclass_of, config.subclass_brackets);

  const volFloor = config.vol_floor_fraction * entry;
  const effectiveVol = Math.max(atr, volFloor);
  // Under the frozen bracket the stop is a percentage of ENTRY and ATR does not
  // enter it at all — that is the withdrawal of the ATR-floating geometry
  // (trader-spec.md "Sizing math"), not a re-parameterisation of it.
  const stopDistance = bracket === null ? config.atr_k * effectiveVol : bracket.stop_pct * entry;
  if (stopDistance <= 0) return skip('stop_distance_not_positive');
  const targetDistance =
    bracket === null ? config.reward_risk_multiple * stopDistance : bracket.take_profit_pct * entry;

  const convictionMult = convictionMultiplier(debate.confidence, config.conviction_floor);
  // `riskFractionFor` is D5's deployment converted through D3's frozen stop and
  // net of #897's headroom reserve, so that `size x entry` lands on
  // `deployment_fraction x (1 - headroom_reserve_fraction) x equity` — the
  // assertion that discriminates it from both of the ADR's recorded error
  // modes. The first tranche therefore lands BELOW the Risk Manager's
  // `per_subclass_deployment_cap` (unchanged at 35%/25%), which is what leaves
  // a later `scale_in` — sized by this same line, then trimmed by that cap to
  // the remaining headroom — admissible rather than rejected at zero. The
  // asset-class multiplier is superseded on this path (trader-spec.md: the
  // surviving dial is `risk_fraction` keyed on subclass) and cannot express
  // ADR-0018's split, because both ETP subclasses are the same asset class.
  const maxRiskFraction =
    bracket === null ? maxRiskFor(mark.asset_class, config) : riskFractionFor(bracket);
  const baseRiskFraction = maxRiskFraction * convictionMult;
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

  // #941: the venue's quantity grid, applied to the ENTRY only. `Math.floor`
  // rather than rounding to nearest, and the direction of the rounding is the
  // whole point — rounding up would submit more than D5's envelope sized and
  // more than every cap the Risk Manager is about to approve against, turning
  // a venue accommodation into an unrecorded amendment of ADR-0018 D5. Erring
  // small is the ADR's own declared preference. `size` is always positive here
  // (the direction lives in `side`, not the sign), so a plain floor is a floor
  // toward zero exposure on both sides.
  //
  // Sited AFTER the finite check so `Math.floor(NaN)` cannot reach the
  // guards below, and BEFORE `min_viable_notional` so the notional test reads
  // the quantity that will actually be submitted rather than the unquantised
  // one — a 0.8-share intent is dust the venue would refuse, and it must not
  // pass a notional check on the strength of a fraction we cannot send.
  //
  // Exits are NOT quantised here or anywhere: `buildFlattenExit` sizes from
  // `heldQuantitiesFor`, i.e. from what actually filled, and rounding that
  // could stranded a remainder or zero a flatten outright. Under this flag
  // every entry fills whole, so held quantities are whole and no exit needs
  // it; if that ever stops being true the residual must still go out verbatim.
  const submittableSize = config.whole_share_sizing ? Math.floor(size) : size;

  // Its own reason rather than folding into `below_min_notional`, because the
  // two say different things to a soak: `below_min_notional` means the
  // strategy sized dust, this means the strategy sized a real position and the
  // venue's quantity grid ate it. A run in which this fires steadily is a run
  // whose deployment fraction cannot buy one share of the names it is trading
  // — a sizing/universe mismatch, not a quiet market. It also cannot be left
  // to the notional check below: 0.8 shares of a $300 name is $240 of intended
  // notional, which passes a $10 dust floor comfortably and would then be
  // submitted as a zero quantity.
  //
  // `size > 0` is what keeps the two distinguishable in the direction that
  // matters. A gate that damped conviction to nothing produces size EXACTLY
  // zero, and that is the strategy declining to deploy, not the venue's grid
  // eating a real position — it belongs in `below_min_notional` where it has
  // always been reported, and #870's ceiling test asserts precisely that.
  if (submittableSize <= 0 && size > 0) return skip('rounds_to_zero_shares');

  if (submittableSize * entry < config.min_viable_notional) {
    return skip('below_min_notional', {
      compared_value: submittableSize * entry,
      threshold: config.min_viable_notional,
    });
  }

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
      // #753: `arm` is a hash input, not merely a recorded label. The control
      // arm runs the same names on the same bars, so on every bar the two arms
      // agree they would otherwise produce ONE key and Execution's `findByKey`
      // gate would dedupe the second away — silently, and exactly on the
      // agreeing subset the comparison is most sensitive to. `'live'` hashes
      // identically to the pre-#753 payload; see `computeIdempotencyKey`.
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
      size: submittableSize,
      entry,
      stop: entry - direction * stopDistance,
      target: entry + direction * targetDistance,
      time_in_force: config.time_in_force[mark.asset_class],
      decision_timestamp: decisionBar,
      decided_at: asOf,
      metadata: {
        debate_id: debate.debate_id,
        // #753. Recorded on every intent (never omitted for the live arm), so
        // `trader_log` / `risk_log` rows say which arm decided without anyone
        // having to infer it from a `debate_id` prefix.
        arm,
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
          // Spread rather than field-by-field so a bracket field added to
          // config cannot be silently dropped from the audit record.
          ...(bracket === null ? {} : { frozen_bracket: { ...bracket } }),
          // Spread-or-absent for the same `exactOptionalPropertyTypes` reason
          // the bracket above is, and absent when the floor changed nothing so
          // that its PRESENCE means "this intent under-deploys D5" rather than
          // merely "the flag is on".
          ...(submittableSize === size ? {} : { unquantised_size: size }),
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
    // propagate exactly as they did before #826.
    if (exitReason !== 'flatten' || lotAssetClass === undefined) throw error;

    const reason = describeThrownSafely(error);
    try {
      input.onUnpricedFlatten?.({ instrument, reason });
    } catch {
      // The flatten is already decided; a page that could abort it would
      // reinstate the very suppression this function removes. The composition
      // root logs before it posts (`reportExitValuationDegraded`), so the
      // durable record does not depend on this call surviving.
    }
    return { price: 0, asset_class: lotAssetClass, unpriced: true };
  }
}

/**
 * The debate-free core of the flatten (#743): everything an exit needs is a
 * mark, the held quantities and a bar coordinate for the idempotency key.
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
  exitReason: ExitReason,
): Promise<TraderOutcome> {
  // No `marketData` here since #826: the mark read moved into `readExitPrice`,
  // which owns both the healthy answer and the unpriced degradation.
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

  // Stamped onto `decided_at` below (#1190) — same `clock.now()` read as
  // `buildBracket`'s, see that call's comment for why this and not
  // `DebateLog.created_at`. This exit's own gate 1 read is exempted for
  // `exit_reason: 'flatten'` (`mandatory_flatten`, see verdict/index.ts), so
  // this timestamp only feeds `trader_log`/observability here, not a gate.
  const asOf = clock.now();
  const priced = await readExitPrice(input, positions, exitReason, asOf);

  return emit(
    {
      // #748: the early exit takes its OWN key discriminator, so a release and
      // a later mandatory flatten in the same bar cannot hash to one key and
      // have the flatten deduped away. See `IntentSide`.
      idempotency_key: computeIdempotencyKey(
        instrument,
        decisionBar,
        exitReason === 'signal_decay' ? 'early_close' : 'close',
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
      // sized to the held quantity without reading a price at all.
      entry: priced.price,
      stop: priced.price,
      target: priced.price,
      time_in_force: config.time_in_force[priced.asset_class],
      decision_timestamp: decisionBar,
      decided_at: asOf,
      metadata: {
        debate_id: attribution.debate_id,
        // #753 — see the entry intent's own `arm` note.
        arm,
        exit_reason: exitReason,
        // Spread rather than a plain `unpriced_exit: priced.unpriced` field:
        // `exactOptionalPropertyTypes` is on, and the flag is true-or-absent so
        // that `=== true` is the only test a reader can write (#826).
        ...(priced.unpriced ? { unpriced_exit: true as const } : {}),
        // #894: the mandatory-flatten marker Verdict's gate-1 exemption reads.
        // Derived from `exitReason` HERE, at the one place an exit intent is
        // constructed, so the two discretionary exits cannot acquire it and no
        // second call site has to be kept in step. Same spread form and the
        // same true-or-absent shape as `unpriced_exit`, for the same
        // `exactOptionalPropertyTypes` reason.
        ...(exitReason === 'flatten' ? { mandatory_flatten: true as const } : {}),
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
  | 'size_not_finite'
  // #941: the entry sized to less than one whole share on a venue that only
  // accepts whole shares (`whole_share_sizing`). Not a data-quality failure
  // and not dust — see the guard's own comment in `decide`.
  | 'rounds_to_zero_shares'
  // #1089, `arm === 'control'` ONLY: a whole-book valuation refusal
  // (`BookValuationError`/`AggregateError`) from `equity()` that the live arm
  // would instead let propagate into `#507`'s retry. See `buildBracket`'s
  // read of `input.equity()` for the full reasoning.
  | 'control_arm_valuation_refused';

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
 * this reason (see `TraderDiagnosticKind`) — the class this reviewer's
 * concern actually describes ("a class meant to signal corrupt inputs") is
 * `TraderDiagnostic`, not `TraderDecisionClass`.
 *
 * `null` on any outcome that is not a skip: an emitted order has nothing to
 * classify.
 */
export type TraderDecisionClass = 'declined_on_signal' | 'could_not_decide' | 'input_unusable';

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
 * comment in `buildBracket` says it "belongs in `below_min_notional` where it
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
  early_exit_signal_unavailable: 'input_unusable',
  no_position_side: 'input_unusable',
  atr_insufficient_bars: 'input_unusable', // benign warm-up, not corruption — see the class doc above
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
 */
function debateWasDegraded(debate: DebateResult): boolean {
  return debate.timed_out !== undefined || debate.rate_limited !== undefined;
}

/**
 * `declined_on_signal` reasons whose baseline is NOT actually a read of the
 * debate, and so must sit out `classifyDecision`'s degraded-debate override.
 *
 * `session_closing` is the one member: `withinFlattenWindow` decides off the
 * clock and the session calendar, and would fire identically against a fully
 * converged debate. Second-pass review of #1109's fix found the override
 * flipping it to `could_not_decide` on a merely degraded debate, pointing an
 * operator at an upstream failure that is not there. A future reason added
 * here needs the same argument — "this baseline never reads `debate` at
 * all" — not just a baseline of `declined_on_signal`.
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

/**
 * The compared value and the threshold it missed, for a skip reason that IS
 * a numeric gate (#1109). Present only on the four sites that compare a
 * value to a configured threshold — `below_conviction_floor`,
 * `below_min_notional`, `scale_in_conviction_delta_not_met`,
 * `atr_insufficient_bars` — so a near-miss (0.549 against a 0.55 floor) is
 * distinguishable from a decisive one (0.1 against 0.55) without re-deriving
 * either number from a raw log line.
 *
 * Not attempted for `session_closing`: its comparison lives inside
 * `withinFlattenWindow`'s own remaining-time arithmetic, and widening that
 * verdict's shape to export a millisecond figure would touch the flat-by-close
 * ordering the function's own comment calls load-bearing, for a diagnostic
 * this ticket does not require. Not attempted for `rounds_to_zero_shares`
 * either: its comparison is against the literal `1` (`submittableSize <= 0`),
 * not a configured threshold — see the reason's own siting comment in
 * `buildBracket`.
 */
export interface TraderReasonDetail {
  compared_value: number;
  threshold: number;
}

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
  | 'atr_not_finite'
  /**
   * #1089, `arm === 'control'` ONLY: paired with the `control_arm_valuation_
   * refused` skip reason, for exactly the reason `atr_not_finite` is listed
   * here despite already having one — a durable `trader_log` row is not an
   * alert. Raised from `buildBracket`'s equity read, before the mark read
   * that would otherwise supply `asset_class` — see `TraderDiagnostic.
   * asset_class` for why this is the one kind that can carry `undefined`.
   */
  | 'control_arm_valuation_refused';

/** One detected degradation, with enough context for an operator to act. */
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

/** A decision that produced an order. */
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
  // the trade #698 itself argues against.
  const diagnostics: TraderDiagnostic[] = [];
  const outcome = await routeDecision(input, diagnostics);

  // #1109: classified once here, not at each `skip()` call site — see
  // `TraderOutcome.decision_class`.
  const decision_class =
    outcome.skip_reason === null ? null : classifyDecision(outcome.skip_reason, input.debate);

  // Merged here rather than at each producing site so the skip helper stays a
  // one-liner and no future skip site can forget the field.
  return {
    ...outcome,
    decision_class,
    diagnostics: diagnostics.length === 0 ? outcome.diagnostics : diagnostics,
  };
}

/**
 * `decideWithReason`'s routing on current position state (trader-spec.md
 * Module: Position Awareness, tickets #73/#74), with #698's diagnostic
 * accumulator threaded through.
 */
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
    return skip('scale_in_conviction_delta_not_met', {
      compared_value: debate.confidence - mostRecentLot.conviction,
      threshold: config.scale_in_conviction_delta,
    });
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
  // #826: the tick path is where the mandatory flatten is actually decided
  // (`routeExitCheck`'s first branch), so the unpriced-flatten escalation has
  // to reach THIS entry point — omitting it here would leave the degradation
  // audible only on the once-a-bar decision path.
  | 'onUnpricedFlatten'
  // #753: which arm's book this exit closes. Both arms share this ONE exit
  // entry point — that sharing is the acceptance criterion "both arms share
  // the same exit rule and the same stop, asserted, not configured twice" —
  // so the arm cannot be a property of a second implementation; it has to be
  // an input to the single one.
  | 'arm'
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
