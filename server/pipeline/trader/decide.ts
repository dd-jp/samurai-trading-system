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
 * `withinFlattenWindow`'s answer, plus anything it noticed getting there
 * (#698). A pair, not a bare boolean: both the entry-skip and holding-exit
 * callers need the diagnostic, so carrying it on only one path would drop it.
 *
 * `enforcing_close` is WHICH session close the tick is enforcing (#1389),
 * carried on the verdict rather than re-derived at the builder — re-deriving
 * would mean a second calendar read against a second `clock.now()`, letting a
 * tick that crosses the bell between reads key its flatten to the wrong close.
 */
type FlattenWindowVerdict =
  | { within: true; enforcing_close: Date; diagnostic: TraderDiagnostic | null }
  | { within: false; enforcing_close: null; diagnostic: TraderDiagnostic | null };

/**
 * Is `now` inside the flat-by-close window for this asset class (#668)? The
 * window is `[sessionEnd − flatten_before_close_ms, priorClose +
 * flatten_after_close_ms]`, resolved through the instrument's own calendar
 * (16:00 ET Alpaca, 16:30 London LSE, 12:30 on an LSE half-day — #656 found
 * only a two-hour overlap, ruling out one shared constant).
 *
 * A `null` session end (crypto, a venue that never shuts) returns false —
 * #668 is explicit a crypto flatten must not be implemented ahead of #667.
 *
 * The window is no longer forward-only (#1389): `TradingCalendar.sessionEnd`
 * is contractually forward-only, so one instant past the bell it names
 * TOMORROW's close and a held lot fell through with no flatten built at all
 * (measured 2026-09-08, seven control lots carried overnight). The second
 * branch below covers the grace period just past the bell via
 * `sessionStart(now)` — the close just gone — so the enforced coordinate
 * never jumps across the boundary, which is what lets
 * `computeFlattenIdempotencyKey` dedupe across it.
 *
 * A past close is no longer a diagnostic (#1389 deletes
 * `session_end_in_past`) — past the bell this function deliberately works
 * against a close that already happened, so alerting on it would fire every
 * session. #698 added audibility for a calendar that stops resolving
 * sessions entirely, reported as data on the verdict since `TraderInput`
 * carries no logger.
 */
function withinFlattenWindow(
  input: Pick<TraderInput, 'clock' | 'config' | 'sessionCalendars'>,
  assetClass: AssetClass,
): FlattenWindowVerdict {
  // `!(x > 0)` rather than `x <= 0` so NaN also fails closed. A non-positive
  // window is a static misconfiguration, not a recoverable condition like a
  // past close — it cannot become valid next tick and every answer it could
  // produce would misrepresent ADR-0014 enforcement, so this halts the
  // instrument rather than silently disabling flat-by-close. Backstop only:
  // `assertTraderConfigSound` refuses the boot on this at the composition root.
  if (!(input.config.flatten_before_close_ms > 0)) {
    throw new Error(
      `flatten_before_close_ms must be > 0 (got ${input.config.flatten_before_close_ms}); ` +
        `a non-positive window disables flat-by-close, which ADR-0014 requires`,
    );
  }
  // #1389: same backstop argument — a non-positive grace restores the
  // forward-only window this ticket removed.
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
    // Documented answer for crypto; for anything else it's #698's complaint —
    // a stopped-resolving equity calendar returns the same `false` silently.
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

  // Still before the bell (or a calendar reporting a close already gone).
  if (remaining <= input.config.flatten_before_close_ms) {
    return { within: true, enforcing_close: sessionEnd, diagnostic: null };
  }

  // Past the bell. `sessionStart` is the close just gone, not the session's
  // open. `elapsed >= 0` guards against a calendar answering with a FUTURE
  // close, which would otherwise silently widen the grace to the whole session.
  const priorClose = calendar.sessionStart(now);
  const elapsed = now.getTime() - priorClose.getTime();
  if (elapsed >= 0 && elapsed <= input.config.flatten_after_close_ms) {
    return { within: true, enforcing_close: priorClose, diagnostic: null };
  }

  return { within: false, enforcing_close: null, diagnostic: null };
}

/**
 * The decision's bar coordinate, which `computeIdempotencyKey` needs stable
 * across every tick sharing a bar (#616), and which `debate_id` is hashed
 * over (#687). Inherited from `DebateResult.bar_timestamp`, never re-derived
 * — this function takes no clock and imports neither `floorToBar` nor
 * `DEBATE_BAR_TIMEFRAME_MS`, so a re-derivation would need a new import a
 * reviewer can see.
 *
 * Never derive it from a mark (`mark.observed_at` is a venue quote
 * timestamp that changes every tick, silently defeating every key-based
 * dedup layer — #616) or from `clock.now()` (a second clock that only
 * agrees with the debate's bar until a debate straddles an hour boundary,
 * colliding with the next bar's own decision — #687).
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
  // #753: absent means the live arm, never "unknown".
  const arm = input.arm ?? 'live';

  // The sizing read (#847), resolved here, the only place in the module that
  // touches it. On the live arm a rejection propagates unchanged, aborting
  // the tick (#507's catch). #1089: on the control arm, a genuine whole-book
  // valuation refusal (`BookValuationError`, or an `AggregateError` whose
  // members all are) converts to `control_arm_valuation_refused` instead of
  // rethrowing — narrowed by type, not just arm, since `input.equity()` is an
  // opaque thunk that can reject for unrelated reasons that must stay a
  // fault on either arm. Awaited at the top so a future edit can't reach
  // `size` on a path that skipped the read.
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
      // #1089: paired with the skip so `escalateTraderDiagnostics` (#698)
      // makes this audible. `asset_class` is `undefined` on purpose — see
      // `TraderDiagnostic.asset_class`.
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

  // `getMark` here is the read #900 pins for both entry and scale_in — it
  // prices entry/stop/target and its `asset_class` picks the flatten
  // calendar below, has no failover (unlike `getBars`), and a stalled vendor
  // takes the tick down on purpose: opening without a live price is worse
  // than deferring to the next tick.
  // `asOf` is stamped onto `decided_at` below (#1190) and read BEFORE the
  // fetches so a slow read still counts toward the age Verdict's gate 1
  // measures.
  const asOf = clock.now();
  const [mark, bars] = await Promise.all([
    marketData.getMark(instrument, asOf),
    marketData.getBars(
      instrument,
      // Converged width (#757): fetching only `atr_lookback + 1` bars would
      // leave `computeIndicator`'s Wilder smoothing running zero times,
      // making it a plain mean (the warm-up gap #722 fixed for `RSI_SPEC`).
      // Derived from `atrIndicatorSpec`, not restated, so fetch and spec
      // can't drift apart. Margin applied underneath in fetchBars; see #362.
      {
        timeframe: config.atr_timeframe,
        lookback: recommendedWarmupFor(atrIndicatorSpec(config.atr_lookback, config.atr_timeframe)),
      },
      asOf,
    ),
  ]);

  // Flat by close, the opening half (#668): stops this window from opening a
  // position the router's holding branch would immediately close next tick.
  // Checked after the mark since the asset class is the mark's to report, and
  // it picks the calendar (crypto/equity run different venues in one process).
  const flattenWindow = withinFlattenWindow(input, mark.asset_class);
  if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);
  if (flattenWindow.within) {
    return skip('session_closing');
  }

  // Bars are fetched directly rather than through `marketData.getIndicator`,
  // which propagates `InsufficientBarsError` — `atrFor` instead catches the
  // shortfall and returns null, turning it into a routine skip rather than a
  // thrown tick. Repointing this is the remaining step of #315, not a
  // mechanical swap.
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

  // Embedded once, used twice: precedent lookup now, and — if this intent
  // survives the skip guards — the row the Feedback Loop labels on close.
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

  // Written only once every skip guard has passed. Not every row becomes a
  // labelled trade — Risk/Verdict/the broker can still refuse downstream —
  // but those rows are inert (`findNeighbors` only returns closed-outcome
  // setups). First-write-wins, so a re-decided bar (replay, crash-restart) is
  // safe rather than fatal.
  setupStore.writeSetup(debate.debate_id, setupVector, asOf);

  const decisionBar = decisionBarFor(debate);

  return emit(
    {
      // #753: `arm` is a hash input, not just a label — without it, the live
      // and control arms agreeing on a bar would collide to one key and
      // Execution's `findByKey` would silently dedupe the second away.
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
        // #753: recorded on every intent, including the live arm, so
        // `trader_log`/`risk_log` rows say which arm decided.
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
 * What an exit intent's metadata attributes the flatten TO. On the decision
 * path this is the current bar's debate; on the tick path (#743), where
 * there is no debate, it's the debate that opened the most recent lot.
 */
interface ExitAttribution {
  debate_id: string;
  conviction: number;
  converged: boolean;
}

/**
 * What the exit prices its (degenerate) bracket at — #826: a MANDATORY
 * flatten never depends on a live mark. `getMark` never fails over
 * (`FailoverDataSource` only fails bars), so a vendor stall on the flatten
 * path used to turn ADR-0014's forced exit into a missed one and a leveraged
 * ETP (ADR-0016) carried overnight.
 *
 * Only `exit_reason: 'flatten'` degrades to an unpriced (size=0-read) market
 * flatten on any `getMark` throw — an exit sizes to held quantity, never
 * price (`submitFlatten` reads no price), so the mark here only stamps
 * `asset_class`/fills degenerate entry-stop-target fields nothing consults.
 * `signal_decay` and `direction_flip` are discretionary and keep failing
 * loudly, since deferring them costs nothing. A degraded flatten still fails
 * loudly one stage down in replay (`SimulatedBrokerAdapter` re-reads the mark
 * to price the fill), and can still submit live even if the data API is
 * stalled, since it's a separate host from the trading API.
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
    // A discretionary exit, or a lot with no asset class, propagates as before #826.
    if (exitReason !== 'flatten' || lotAssetClass === undefined) throw error;

    const reason = describeThrownSafely(error);
    try {
      input.onUnpricedFlatten?.({ instrument, reason });
    } catch {
      // The flatten is already decided; a throwing page must not abort it.
    }
    return { price: 0, asset_class: lotAssetClass, unpriced: true };
  }
}

/**
 * Which exit is being built, and — for the mandatory flatten alone — the
 * session close it enforces (#1389). Discriminated union, not a bare
 * `ExitReason` plus optional date, so the compiler refuses a `'flatten'`
 * with no close and refuses a discretionary exit that acquires one.
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
  // No `marketData` here since #826 — the mark read moved into `readExitPrice`.
  const { clock, config, exitFillSizes, instrument } = input;
  // #753 — see `buildBracket`'s note. Absent means the live arm.
  const arm = input.arm ?? 'live';

  const existingSide = positions[0]?.side;
  if (existingSide === undefined) {
    throw new Error('buildFlattenExit: positions must be non-empty');
  }
  const closingSide = existingSide === 'buy' ? 'sell' : 'buy';
  // #568: sized to what the VENUE still holds, not `filled_size` (the entry
  // quantity, unreduced by exit fills) — `heldQuantitiesFor` subtracts what's
  // already closed, the same derivation `executeExit` re-checks before submit.
  const held = await heldQuantitiesFor(positions, exitFillSizes);

  // Fail closed, per lot, BEFORE summing — a lot recording more closed than
  // it ever opened would otherwise net against a sibling's positive residual
  // and read as an ordinary "nothing to flatten", silently skipping both.
  if (held.some((lot) => lot.held < 0)) return skip('exit_held_quantity_diverged');

  const totalSize = totalHeldQuantity(held);
  if (totalSize <= 0) return skip('exit_no_filled_size');

  // Stamped onto `decided_at` below (#1190); exempted from gate 1 for
  // `exit_reason: 'flatten'`, so this only feeds `trader_log` here.
  const asOf = clock.now();
  const priced = await readExitPrice(input, positions, exitReason, asOf);

  return emit(
    {
      // #1389: the mandatory flatten keys on the session close it enforces,
      // not a bar, so both sides of the bell dedup to one key. #748: the two
      // discretionary exits keep the bar coordinate (with their own
      // `'early_close'` discriminator) so they can't collide with a flatten
      // in the same bar. See `computeFlattenIdempotencyKey`, `IntentSide`.
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
      // All three are the mark, or all three are ZERO with no mark to read
      // (#826) — degenerate either way; #83's flatten lifecycle reads none.
      entry: priced.price,
      stop: priced.price,
      target: priced.price,
      time_in_force: config.time_in_force[priced.asset_class],
      decision_timestamp: decisionBar,
      decided_at: asOf,
      metadata: {
        debate_id: attribution.debate_id,
        arm,
        exit_reason: exitReason,
        // True-or-absent (`exactOptionalPropertyTypes`), so `=== true` is the
        // only test a reader can write (#826).
        ...(priced.unpriced ? { unpriced_exit: true as const } : {}),
        // #894: Verdict's gate-1 exemption marker, derived here so the two
        // discretionary exits can't acquire it.
        ...(exitReason === 'flatten' ? { mandatory_flatten: true as const } : {}),
        // #1497: per-lot breakdown behind `totalSize` — lets `executeExit`
        // catch a compensating swap the total-only guard can't see.
        lot_held_quantities: held,
        conviction: attribution.conviction,
        converged: attribution.converged,
        sizing: {
          base_risk_fraction: 0,
          conviction_multiplier: 0,
          vol_floor_factor: 1,
          non_converged_haircut: 1,
          // An exit sizes to held quantity, not risk, so no precedent is
          // retrieved; this non-optional field carries the no-precedent default.
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
 * Why a `TraderSkipReason` fired, at the granularity an operator's next
 * action needs (#1109) — `skip_reason` alone can't say whether the refusal
 * is the system working or starving (#1080 found 41/44 timed-out debates
 * all resolving to the same `neutral_direction_while_flat` rows a genuine
 * neutral read would produce).
 *
 * - `declined_on_signal` — the debate (or position/sizing state) was read
 *   and said no.
 * - `could_not_decide` — the debate produced nothing usable (`timed_out` or
 *   `rate_limited`).
 * - `input_unusable` — the Trader's own priced inputs (mark, ATR, fill
 *   record) couldn't be used this tick, independent of debate health.
 *
 * `atr_insufficient_bars` stays `input_unusable` rather than
 * `could_not_decide` even though it's a benign warm-up case — folding it in
 * would pollute #1109's timeout-count acceptance criterion. Its non-null
 * `reason_detail` and its exclusion from `TraderDiagnosticKind`'s
 * `atr_not_finite` let a query isolate it from genuinely corrupt siblings.
 *
 * `null` on any outcome that is not a skip.
 */
type TraderDecisionClass = 'declined_on_signal' | 'could_not_decide' | 'input_unusable';

/**
 * The baseline classification for every `TraderSkipReason`, before
 * `classifyDecision`'s degraded-debate override. A `Record` over the full
 * union, not a function with a default case, so a new skip reason is a
 * compile error here until classified.
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
  // The system working, not starving — the close IS in flight.
  flatten_in_flight: 'declined_on_signal',
  early_exit_signal_unavailable: 'input_unusable',
  no_position_side: 'input_unusable',
  // Benign warm-up, not corruption — see the class doc above.
  atr_insufficient_bars: 'input_unusable',
  atr_not_finite: 'input_unusable',
  mark_not_finite: 'input_unusable',
  stop_distance_not_positive: 'input_unusable',
  size_not_finite: 'input_unusable',
  control_arm_valuation_refused: 'input_unusable',
};

/**
 * Mirrors `debateDecisionWord`'s two fields, not a re-derivation. Does NOT
 * split `timed_out` by `rounds_completed` — a partial debate is no more
 * decided than a zero-round one from the Trader's seat. `!debate.read` is
 * checked too (#1393): no producer sets it false yet, but a future neutral
 * fallback with neither flag set must not read as a genuine decline.
 */
function debateWasDegraded(debate: DebateResult): boolean {
  return !debate.read || debate.timed_out !== undefined || debate.rate_limited !== undefined;
}

/**
 * `declined_on_signal` reasons that don't actually read the debate, so must
 * sit out `classifyDecision`'s degraded-debate override. `session_closing`
 * decides off the clock/calendar and would fire identically on a fully
 * converged debate — flipping it to `could_not_decide` would point an
 * operator at a failure that isn't there.
 */
const DECLINED_ON_SIGNAL_NOT_DEBATE_DERIVED: ReadonlySet<TraderSkipReason> = new Set([
  'session_closing',
]);

/**
 * `skip_reason` plus the debate that produced it, resolved to the class an
 * operator's response turns on. A timed-out debate with `rounds_completed >
 * 0` can still hand back a `long`/`short` `partial.direction` with no
 * `converged` check, so every `declined_on_signal` reason (except
 * `DECLINED_ON_SIGNAL_NOT_DEBATE_DERIVED`) is overridden on a degraded
 * debate, keyed on baseline class rather than the specific reason.
 * `input_unusable` reasons are a different fault and are never overridden.
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
   * `undefined` for exactly `control_arm_valuation_refused`: it fires from
   * the equity read at the top of `buildBracket`, before an `asset_class`
   * has resolved on the entry branch.
   */
  asset_class: AssetClass | undefined;
  /** Human-readable specifics (the resolved close, how stale it is). Never raw vendor payloads. */
  detail: string;
}

/**
 * What `decideWithReason` returns: an intent, or the reason there isn't one.
 * Exactly one side is populated. Not a discriminated union on `kind` since
 * both consumers want `intent` directly without narrowing.
 */
export interface TraderOutcome {
  intent: OrderIntent | null;
  skip_reason: TraderSkipReason | null;
  /**
   * Why `skip_reason` fired (#1109, see `TraderDecisionClass`). Set by
   * `decideWithReason` after routing, not by `skip()` — classification needs
   * the debate too. `null` exactly when `skip_reason` is `null`.
   */
  decision_class: TraderDecisionClass | null;
  /** The compared value and threshold for a numeric-gate skip (#1109). */
  reason_detail: TraderReasonDetail | null;
  /**
   * The ATR this decision priced its stop from (#475). Null on an exit or
   * any skip before the ATR step. Carried here, not on `OrderIntentMetadata`
   * — it's a diagnostic about the decision, not a term of the order.
   */
  atr: number | null;
  /**
   * Degraded-but-continuing conditions detected while deciding (#698).
   * Orthogonal to `intent`/`skip_reason`, not a third alternative — a stale
   * `sessionEnd` can produce a diagnostic alongside an emitted exit intent.
   */
  diagnostics: readonly TraderDiagnostic[];
}

/**
 * A declined decision. Narrow helper so every skip site stays one line.
 * Diagnostics and `decision_class` are NOT parameters — both are merged in
 * by `decideWithReason`, which has the accumulator and the debate.
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
 * `decide`, but saying WHY when it declines (#475) — until this,
 * `trader_log.skip_reason` recorded the same string for all nineteen skip
 * reasons. A separate entry point, not a changed return type, since
 * `decide`'s `OrderIntent | null` contract has a large existing test suite;
 * `decide` is now a one-line wrapper over this.
 */
export async function decideWithReason(input: TraderInput): Promise<TraderOutcome> {
  // #698's collector — local, not an injected sink, so `decide` stays
  // deterministic while still reporting what it noticed.
  const diagnostics: TraderDiagnostic[] = [];
  const outcome = await routeDecision(input, diagnostics);

  // #1109: classified once here, not at each `skip()` call site.
  const decision_class =
    outcome.skip_reason === null ? null : classifyDecision(outcome.skip_reason, input.debate);

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

  // Flat by close (#668, ADR-0014) — ahead of EVERY other holding branch. Put
  // after a neutral/non-converged/scale-in-delta decline and the commonest
  // branch in the system (`direction === 'neutral'`, 92/94 debates in the
  // soak) would silently suppress the flatten and carry the book overnight —
  // ADR-0007/0013 removed the human from the path, so this must fire
  // unattended including into a loss.
  const positionAssetClass = positions[0]?.asset_class;
  if (positionAssetClass !== undefined) {
    const flattenWindow = withinFlattenWindow(input, positionAssetClass);
    // Pushed before the branch so the diagnostic survives either outcome.
    if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);
    if (flattenWindow.within) {
      // #1389: sits here, not inside `buildFlattenExit`, which also serves
      // the two discretionary exits — a guard at its top would swallow a
      // direction-flip or decay release whenever a flatten is in flight.
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
