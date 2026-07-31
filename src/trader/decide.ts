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
 * Cosine precedent retrieval is #75 — see NO_PRECEDENT_COSINE_MULTIPLIER.
 */
import type { Bar } from '../market-data-service/index.js';
import type { OpenPosition, OrderIntent } from '../shared/types.js';
import { computeIdempotencyKey } from './idempotency-key.js';
import type { AssetClass, TraderConfig, TraderInput } from './types.js';

/**
 * trader-spec.md's "no close neighbor" default (Module: Cosine Precedent
 * Retrieval). #75 owns retrieval, but `OrderIntentMetadata.cosine_*` is
 * non-optional (cross-spec-contracts.md registry #1) so #73 must populate
 * it. The spec's warm-up decision (Module: Determinism & Replay) says an
 * empty store yields the no-precedent default "naturally — no
 * special-casing", so hardcoding it here is what #75 will compute anyway
 * when it queries an empty store.
 *
 * It is APPLIED, not merely recorded: multiplicative stacking is a spec
 * invariant, so the recorded decomposition must reproduce the actual size.
 */
const NO_PRECEDENT_COSINE_MULTIPLIER = 0.75;

/** trader-spec.md Module: Side Derivation. `neutral` has no directional edge to act on. */
function sideFor(direction: 'bullish' | 'bearish'): 'buy' | 'sell' {
  return direction === 'bullish' ? 'buy' : 'sell';
}

/**
 * Average true range over the last `lookback` true ranges.
 *
 * Computed here from `getBars` rather than read from the Market Data
 * Service because #73 is blocked by #64 (bar/mark serving) and not by #65,
 * which owns `getIndicator` and the indicator cache — the MDS interface has
 * no indicator method yet (see src/market-data-service/types.ts). Interim:
 * supersede this with `getIndicator(instrument, {indicator: 'atr'...})` once
 * #65 lands, so ATR is computed once, deterministically, in one place.
 *
 * Returns null when there is not enough history to form a single true range;
 * a stop cannot be sized without one.
 */
function computeAtr(bars: Bar[], lookback: number): number | null {
  // Sorted rather than trusting arrival order, so ATR is independent of how
  // the data source happened to return the window.
  const [earliest, ...rest] = [...bars].sort(
    (a, b) => a.close_time.getTime() - b.close_time.getTime(),
  );
  if (earliest === undefined || rest.length === 0) return null;

  let previousClose = earliest.close;
  const trueRanges: number[] = [];
  for (const current of rest) {
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(previousClose - current.low),
      ),
    );
    previousClose = current.close;
  }

  const window = trueRanges.slice(-lookback);
  return window.reduce((sum, tr) => sum + tr, 0) / window.length;
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
  const { clock, config, debate, equity, instrument, marketData } = input;

  if (debate.confidence < config.conviction_floor) return null;

  const asOf = clock.now();
  const [mark, bars] = await Promise.all([
    marketData.getMark(instrument, asOf),
    marketData.getBars(
      instrument,
      // lookback + 1 bars yield `lookback` true ranges: each needs its
      // predecessor's close.
      { timeframe: config.atr_timeframe, lookback: config.atr_lookback + 1 },
      asOf,
    ),
  ]);

  const atr = computeAtr(bars, config.atr_lookback);
  if (atr === null) return null;

  const entry = mark.price;
  const volFloor = config.vol_floor_fraction * entry;
  const effectiveVol = Math.max(atr, volFloor);
  const stopDistance = config.atr_k * effectiveVol;
  if (stopDistance <= 0) return null;

  const convictionMult = convictionMultiplier(debate.confidence, config.conviction_floor);
  const baseRiskFraction = maxRiskFor(mark.asset_class, config) * convictionMult;
  const nonConvergedHaircut = debate.converged ? 1 : config.non_converged_haircut;

  // Multiplicative stacking — penalties compound honestly (trader-spec.md
  // Module: Non-Convergence & Skip Policy).
  const riskFraction = baseRiskFraction * nonConvergedHaircut * NO_PRECEDENT_COSINE_MULTIPLIER;
  const size = (equity * riskFraction) / stopDistance;

  if (size * entry < config.min_viable_notional) return null;

  const side = sideFor(debate.direction as 'bullish' | 'bearish');
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
    time_in_force: config.time_in_force,
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
        cosine_multiplier: NO_PRECEDENT_COSINE_MULTIPLIER,
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
): Promise<OrderIntent> {
  const { clock, config, debate, instrument, marketData } = input;

  const asOf = clock.now();
  const mark = await marketData.getMark(instrument, asOf);
  const decisionBar = mark.observed_at;
  const existingSide = positions[0]?.side;
  if (existingSide === undefined) {
    throw new Error('buildExitIntent: positions must be non-empty');
  }
  const closingSide = existingSide === 'buy' ? 'sell' : 'buy';
  const totalSize = positions.reduce((sum, lot) => sum + lot.filled_size, 0);

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
    time_in_force: config.time_in_force,
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
        cosine_multiplier: NO_PRECEDENT_COSINE_MULTIPLIER,
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
