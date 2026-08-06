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
} from '../market-data-service/index.js';
import type { OpenPosition, OrderIntent } from '../shared/index.js';
import { NO_PRECEDENT_MULTIPLIER, retrieveCosinePrecedent } from './cosine-precedent.js';
import { computeIdempotencyKey } from './idempotency-key.js';
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
function atrFor(bars: Bar[], lookback: number, timeframe: string): number | null {
  const spec = atrIndicatorSpec(lookback, timeframe);

  // `lookback + 1` bars yield `lookback` true ranges — the arity lives in
  // `minimumBarsFor`, not in a literal here. Skipping the trade is the only
  // safe answer: a stop cannot be priced off an ATR that does not exist.
  if (bars.length < minimumBarsFor(spec)) return null;

  const atr = computeIndicator(bars, spec);
  return Number.isFinite(atr) ? atr : null;
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
 * Builds a full entry or scale_in bracket, or null to skip. Skips when:
 * conviction is below the floor, ATR cannot be computed, or the resulting
 * position is below the minimum viable notional. Shared by both intent
 * types (trader-spec.md Module: Position Awareness — scale_in sizes exactly
 * like an entry; Risk enforces the exposure cap downstream).
 */
async function buildBracket(
  input: TraderInput,
  intentType: 'entry' | 'scale_in',
): Promise<OrderIntent | null> {
  const { clock, config, debate, equity, instrument, marketData, setupStore } = input;

  // Every caller must have already excluded 'neutral' — sideFor has no
  // direction to derive a side from. Checked here, not just assumed, so the
  // invariant is enforced rather than merely documented.
  if (debate.direction === 'neutral') {
    throw new Error('buildBracket: debate.direction must not be neutral');
  }
  if (debate.confidence < config.conviction_floor) return null;

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

  // Bars are still fetched here rather than read through
  // `marketData.getIndicator`, and #315 changed WHY.
  //
  // The old reason is gone: `IndicatorSpec` now carries a timeframe and
  // `getIndicator` builds its window from it, so routing through the serving
  // layer would no longer silently pin ATR to 1h.
  //
  // The remaining reason is arity. `atrFor` skips the trade when there are
  // fewer than `minimumBarsFor(spec)` bars, because a stop cannot be priced
  // off an ATR that does not exist. `getIndicator` does not enforce that: it
  // throws only when there are NO bars, and otherwise hands `computeIndicator`
  // whatever short window it got. Repointing here today would trade a cache
  // miss — one ATR per instrument per cycle — for silently repricing every
  // stop off an under-seeded ATR during any warm-up or data gap. That is the
  // worse defect, so the last step of #315 waits on `getIndicator` enforcing
  // indicator arity.
  const atr = atrFor(bars, config.atr_lookback, config.atr_timeframe);
  if (atr === null) return null;

  // The same NaN argument `atrFor` documents, applied to the OTHER priced
  // input. `atrFor` guards the bars; nothing guarded the quote. Alpaca's
  // latest-quote body is cast, not validated (`alpaca-http-client.ts`, `as
  // CryptoLatestQuoteResponse`), so a null `ap`/`bp` on the wire arrives here
  // as a NaN `mark.price` — and NaN then walks through every guard below,
  // because every comparison against it is false. Checked at the inlet rather
  // than only at `size` so the skip names the input that was bad.
  const entry = mark.price;
  if (!Number.isFinite(entry)) return null;

  const volFloor = config.vol_floor_fraction * entry;
  const effectiveVol = Math.max(atr, volFloor);
  const stopDistance = config.atr_k * effectiveVol;
  if (stopDistance <= 0) return null;

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
  if (!Number.isFinite(size)) return null;

  if (size * entry < config.min_viable_notional) return null;

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

  // The mark's OBSERVATION time is the decision bar coordinate — not
  // clock.now(), which differs across a crash-restart re-run of the same bar
  // and would break the idempotency guarantee.
  const decisionBar = mark.observed_at;

  return {
    idempotency_key: computeIdempotencyKey(instrument, decisionBar),
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
  };
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
): Promise<OrderIntent | null> {
  const { clock, config, debate, instrument, marketData } = input;

  const existingSide = positions[0]?.side;
  if (existingSide === undefined) {
    throw new Error('buildExitIntent: positions must be non-empty');
  }
  const closingSide = existingSide === 'buy' ? 'sell' : 'buy';
  // Only filled exposure needs flattening — a lot still `pending`/
  // `submitted` has nothing on the books yet, so an all-pending instrument
  // has no fill to close and there is nothing to emit.
  const totalSize = positions.reduce((sum, lot) => sum + lot.filled_size, 0);
  if (totalSize <= 0) return null;

  const asOf = clock.now();
  const mark = await marketData.getMark(instrument, asOf);
  const decisionBar = mark.observed_at;

  return {
    idempotency_key: computeIdempotencyKey(instrument, decisionBar),
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
      debate_id: debate.debate_id,
      conviction: debate.confidence,
      converged: debate.converged,
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
  };
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
export async function decide(input: TraderInput): Promise<OrderIntent | null> {
  const { config, debate, instrument, positionState } = input;

  const positions = (await positionState()).filter((lot) => lot.instrument === instrument);

  if (positions.length === 0) {
    if (debate.direction === 'neutral') return null;
    return buildBracket(input, 'entry');
  }

  // All lots for one instrument are the same side by construction (v1
  // per-lot design: scale_in only adds same-direction, exit flattens before
  // a fresh entry) — no defensive mixed-side reconciliation.
  const existingSide = positions[0]?.side;
  if (existingSide === undefined) return null;

  if (debate.direction === 'neutral' || !debate.converged) return null;

  const desiredSide = sideFor(debate.direction);
  if (desiredSide !== existingSide) {
    return buildExitIntent(input, positions);
  }

  const mostRecentLot = positions.reduce((latest, lot) =>
    lot.opened_at > latest.opened_at ? lot : latest,
  );
  if (debate.confidence - mostRecentLot.conviction < config.scale_in_conviction_delta) return null;

  return buildBracket(input, 'scale_in');
}
