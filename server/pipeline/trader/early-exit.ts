/**
 * The indicator-based early exit (#748) — the third clause of the exit model
 * `docs/specs/trader-spec.md` records, restored. The spec's exit model is a
 * single frozen bracket per subclass AND an indicator-based early exit — #708
 * measured the tranche ladder this comment used to cite and killed it (ladder
 * 4.52 pp vs single bracket 4.19 pp over 897 OOS sessions, paired t = -0.20,
 * under the cost model most generous to the ladder). This clause is unaffected
 * by that: it is orthogonal to how the price legs are shaped.
 *
 * ## What it is for
 *
 * At an intraday, flat-by-close horizon a position whose thesis has evaporated
 * but whose price has reached neither bracket is dead money holding risk into a
 * close that is unconditional. A price-only exit cannot release it; this can.
 *
 * ## Where the read comes from, and why it is NOT the analyst's
 *
 * `trader-spec.md`'s third constraint on this exit is explicit: **"It must not
 * require analyst output. … an early exit that reads `views` or `debate` would
 * either force the expensive path back into every tick or read a stale view
 * without knowing it is stale."** That sentence rules out both obvious designs:
 * recomputing the analyst read on the tick path (which would undo #743's whole
 * point — 30 analyst runs per debate bar), and comparing against a persisted
 * snapshot of the bar's axis votes (a recorded analyst output, read at an age
 * the exit cannot see).
 *
 * So this module computes a **narrow, named subset of indicators itself**: the
 * MOMENTUM axis, and nothing else. It does so through the `MarketDataService`
 * handle `ExitCheckInput` already carries, so **no field was added to
 * `ExitCheckInput`** — orchestrator-spec.md's constraint 4 ("exits must not
 * read analyst output") stays enforced by the type, because there is still no
 * field an `AnalystView` or a `DebateResult` could arrive through.
 *
 * The vote functions ARE the analyst's (`momentumVote`, and the `RSI_SPEC` /
 * `MACD_SPEC` they read). That is deliberate and is not a constraint-4
 * violation: they are pure functions of two indicator numbers, exported
 * constants and arithmetic — not output the analyst produced. Decay is only
 * meaningful measured in the same semantics the entry was read in, and a
 * second, privately-tuned momentum rule here would be a different signal
 * wearing the same name.
 *
 * ## Cost, stated rather than assumed
 *
 * **Two `getIndicator` calls per tick per instrument that holds a lot**, and
 * zero on a flat instrument (the caller returns `no_open_position` before
 * reaching here). Each resolves to one `MarketDataStore` read plus an
 * in-process compute; the upstream HTTP fetch is bounded by
 * `MarketDataServiceImpl.getBars`' per-bar-interval fetch cache (#391), so at
 * τ = 2 min against 5m bars the network cost is at most one bar fetch per 5
 * minutes per instrument, unchanged from what the decision path already pays.
 * The indicator cache keys on `asOf` and so does not hit across ticks; the bar
 * cache is the one that matters and it does.
 *
 * That "one fetch" is conditional on ORDER, and the order below is load-bearing.
 * `cachedBars` refuses a hit when `rows.length < window.lookback` — it checks
 * depth BEFORE it checks the per-interval fetch record, and that record is keyed
 * on `(instrument, timeframe)` with no lookback in the key. `MACD_SPEC` wants
 * 112 bars and `RSI_SPEC` wants 57, so reading RSI first would fill the store
 * with 57 rows, mark the interval fetched, and then MACD would still miss on
 * depth and issue a SECOND fetch. Widest first, and the narrower read is served
 * from the same window: one fetch and two store reads per 5m interval.
 *
 * **No LLM call, ever.** Nothing in this module can reach a model client: it
 * takes a `MarketDataService` and pure functions, and that is the whole of its
 * dependency surface.
 *
 * ## Why the momentum axis alone
 *
 * Of #745's four voting axes, momentum is the one that turns FIRST — which is
 * exactly what an *early* release wants; trend (an SMA cross) is the slowest,
 * and by the time it flips the bracket or the close has usually already
 * answered. It is also the only axis whose inputs are both registry kinds with
 * no bar-close read of their own, so it costs two indicator calls and no
 * `getBars` the exit did not already need. `momentumVote` combines RSI and the
 * MACD histogram, so this is a two-oscillator read rather than the
 * single-oscillator guess #745 was filed against.
 *
 * Structure/participation are deliberately out: participation reads raw bars
 * (a third fetch) and structure's Donchian position is a *location* read that
 * says little about whether a thesis is still alive.
 */
import {
  InsufficientBarsError,
  type MarketDataService,
} from '../../providers/market-data-service/index.js';
import { type AxisVote, MACD_SPEC, momentumVote, RSI_SPEC } from '../analysts/index.js';

/**
 * The decay criterion — INJECTED, never a constant read from module scope
 * (#748's acceptance criterion). Lives on `TraderConfig.early_exit`.
 */
export interface EarlyExitConfig {
  /**
   * Release the position when the momentum axis's vote, SIGNED so that `+1`
   * agrees with the held side, is at or below this.
   *
   * The type is the two admissible values rather than `number`, so a
   * misconfiguration is a compile error instead of a runtime one and
   * `assertTraderConfigSound` needs no clause for it. `+1` is excluded on
   * purpose: it would release a position the moment its own thesis was
   * CONFIRMED, which is not a decay criterion at all.
   *
   * - `-1` — release only when momentum has flipped AGAINST the held side.
   * - `0`  — release as soon as momentum stops confirming it.
   *
   * See `DEFAULT_EARLY_EXIT_CONFIG` for which one ships and why.
   */
  momentum_release_at: -1 | 0;
}

/**
 * **`-1` — release on contradiction, not on mere silence.** Recorded here with
 * the reasoning, per #748.
 *
 * Every early exit pays a full round trip — ~0.18% on the 3x index-ETP
 * subclass, the same cost input `trader-spec.md`'s exit model prices the
 * +2.00%/−2.16% bracket against. A vote of `0` is the MODAL state of a quiet
 * intraday tape: RSI mid-range and a MACD histogram near zero is what most
 * bars look like most of the session. Releasing on `0` would therefore fire on
 * most positions in most sessions, converting the truncation cost the take-
 * profit leg exists to manage into a near-certainty and paying a round trip for
 * it each time.
 *
 * `-1` requires both oscillator inputs to net AGAINST the held side — the
 * thesis contradicted rather than merely unconfirmed. That is the reading of
 * "the signal has decayed" that is worth a round trip, and it is the
 * conservative choice on a rule that can close real positions.
 *
 * It is a starting point, not a tuned value — the same status every threshold
 * in `DEFAULT_TRADER_CONFIG` carries (trader-spec.md "Out of Scope" → Exact
 * parameter values), and it is unfitted, per ADR-0018 D4.
 */
export const DEFAULT_EARLY_EXIT_CONFIG: EarlyExitConfig = {
  momentum_release_at: -1,
};

/**
 * What the decay read concluded.
 *
 * `'signal_unavailable'` is a first-class outcome rather than a thrown error or
 * a folded-into-`holds` silence: an instrument too cold for a 112-bar MACD
 * warm-up must not be released on a read nobody could take, and a soak must be
 * able to tell "momentum still supports the position" from "momentum could not
 * be read at all". The two are the same row otherwise, and only one of them is
 * the system working.
 */
export type SignalDecayVerdict = 'decayed' | 'holds' | 'signal_unavailable';

export interface SignalDecayRead {
  verdict: SignalDecayVerdict;
  /**
   * The momentum vote SIGNED against the held side: `+1` agrees with the
   * position, `-1` contradicts it, `0` is neutral. `null` when the read was
   * unavailable.
   */
  signed_momentum: AxisVote | null;
}

/**
 * Reads the momentum axis and decides whether the held side's signal has
 * decayed past `config.momentum_release_at`.
 *
 * Pure with respect to everything but `marketData`: no store writes, no
 * alerting, no clock reads of its own (`asOf` is passed in, from the tick's
 * one clock read), so it is as replay-safe as the rest of the Trader.
 *
 * ## Failure posture
 *
 * `InsufficientBarsError` — and ONLY that — is caught, mirroring #745's
 * enrichment reads. A cold instrument yields `'signal_unavailable'` and holds.
 * Anything else (a store outage, a source that serves no bars at this
 * timeframe) propagates, deliberately: a bare `catch` here would silently
 * disable the exit for the rest of the run, which is this repo's dominant
 * defect class. That is safe to do because the caller evaluates the
 * flat-by-close window BEFORE this function and returns on it — so no throw
 * from here can cost a flatten (`decide.test.ts`,
 * "flattens inside the window even when the decay read THROWS").
 */
export async function readSignalDecay(input: {
  instrument: string;
  /** The side of the lot being held — the direction the signal has to still support */
  side: 'buy' | 'sell';
  marketData: MarketDataService;
  asOf: Date;
  config: EarlyExitConfig;
}): Promise<SignalDecayRead> {
  const { asOf, config, instrument, marketData, side } = input;

  let rsi: number;
  let macd: number;
  try {
    // Sequential and WIDEST FIRST, on purpose. The two share one
    // (instrument, 5m) bar window, and `cachedBars` rejects a hit on
    // `rows.length < window.lookback` before it ever looks at the per-interval
    // fetch record. MACD's 112-bar window therefore has to be the one that
    // populates the store; RSI's 57 is then served from it. Racing them with
    // `Promise.all`, or reading RSI first, makes the second call miss and
    // doubles the upstream fetches this module claims not to make
    macd = (await marketData.getIndicator(instrument, MACD_SPEC, asOf)).value;
    rsi = (await marketData.getIndicator(instrument, RSI_SPEC, asOf)).value;
  } catch (cause) {
    if (cause instanceof InsufficientBarsError) {
      return { verdict: 'signal_unavailable', signed_momentum: null };
    }
    throw cause;
  }

  const vote = momentumVote(rsi, macd);
  // `momentumVote` answers "which way is momentum", in market terms. The
  // position's own side turns that into "does momentum still support THIS
  // lot": a short is supported by bearish momentum
  const signed: AxisVote = vote === 0 || side === 'buy' ? vote : ((0 - vote) as AxisVote);

  return {
    verdict: signed <= config.momentum_release_at ? 'decayed' : 'holds',
    signed_momentum: signed,
  };
}
