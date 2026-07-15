/**
 * Trader core decision — DebateResult -> OrderIntent bracket (ticket #73),
 * extended with position-aware branching (ticket #74). See
 * docs/specs/trader-spec.md (Module: Trader Core, Module: Position Sizing,
 * Module: Side Derivation, Module: Non-Convergence & Skip Policy, Module:
 * Position Awareness).
 *
 * Mechanical and deterministic: no LLM, no hidden state. The same code path
 * runs live and in replay; only the injected Clock and the data behind
 * MarketDataService/PositionStore differ.
 *
 * Cosine precedent retrieval is #75 — see NO_PRECEDENT_COSINE_MULTIPLIER.
 */
import type { Bar, Mark } from '../market-data-service/index.js';
import type { OrderIntent } from '../shared/types.js';
import { computeIdempotencyKey } from './idempotency-key.js';
import type { AssetClass, HeldPosition, TraderConfig, TraderInput } from './types.js';

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

interface BracketSizing {
  entry: number;
  stopDistance: number;
  size: number;
  convictionMult: number;
  baseRiskFraction: number;
  nonConvergedHaircut: number;
  atr: number;
  effectiveVol: number;
}

/**
 * The risk-based sizing formula shared by fresh entries and same-direction
 * scale-ins (trader-spec.md Module: Position Sizing) — conviction scaling ->
 * ATR/vol-floor stop -> non-converged haircut -> cosine multiplier. Returns
 * null when ATR can't be computed or the result is below the minimum
 * viable notional; both are skip conditions, not just entry-skip
 * conditions, so scale-in shares this gate too.
 */
function sizeBracket(
  debate: TraderInput['debate'],
  config: TraderConfig,
  mark: Mark,
  bars: Bar[],
  equity: number,
): BracketSizing | null {
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

  return {
    entry,
    stopDistance,
    size,
    convictionMult,
    baseRiskFraction,
    nonConvergedHaircut,
    atr,
    effectiveVol,
  };
}

/** Assembles the OrderIntent common to `entry` and `scale_in` — both are sized brackets on the debate's side. */
function buildBracket(
  intentType: 'entry' | 'scale_in',
  side: 'buy' | 'sell',
  instrument: string,
  mark: Mark,
  sizing: BracketSizing,
  debate: TraderInput['debate'],
  config: TraderConfig,
): OrderIntent {
  const direction = side === 'buy' ? 1 : -1;
  const {
    entry,
    stopDistance,
    size,
    convictionMult,
    baseRiskFraction,
    nonConvergedHaircut,
    atr,
    effectiveVol,
  } = sizing;

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
 * Flattens a held position (trader-spec.md Module: Position Awareness): a
 * reversal is exit-then-fresh-entry, not a blended flip, so this closes the
 * full `filled_size` and nothing more — the opposite-direction re-entry, if
 * still warranted, opens as a fresh `entry` on a later decision cycle once
 * flat. Bypasses the entry sizing pipeline entirely (no ATR/conviction
 * sizing, no min-viable-notional dust skip): the size to close is whatever
 * is actually held, not a computed risk fraction, and a small held position
 * must still be flattenable.
 *
 * `stop`/`target` have no meaning for a flatten (Execution's
 * `submitFlatten` doesn't consume them — execution-spec.md Module: Broker
 * Abstraction); collapsed to the exit price rather than left as leftover
 * bracket math. Sizing-decomposition metadata is similarly not applicable:
 * recorded as identity/zero values rather than a risk-based decomposition
 * that didn't happen.
 */
function buildExit(
  instrument: string,
  mark: Mark,
  position: HeldPosition,
  debate: TraderInput['debate'],
): OrderIntent {
  const side = position.side === 'buy' ? 'sell' : 'buy';
  const decisionBar = mark.observed_at;

  return {
    idempotency_key: computeIdempotencyKey(instrument, decisionBar),
    instrument,
    asset_class: mark.asset_class,
    side,
    intent_type: 'exit',
    size: position.filled_size,
    entry: mark.price,
    stop: mark.price,
    target: mark.price,
    time_in_force: 'day',
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
        cosine_multiplier: 1,
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
 * Returns an order intent, or null to hold / skip. Position-aware routing
 * (trader-spec.md Module: Position Awareness):
 * - No held position -> the #73 entry path (floor -> ATR/sizing -> dust skip).
 * - Held position, debate didn't converge -> hold, regardless of direction
 *   or conviction (spec: "holding + neutral/converged:false -> hold").
 * - Held position, opposite direction -> `exit` (flatten), even below the
 *   conviction floor: exits aren't gated by entry conviction (risk-manager-
 *   spec.md: "exits always pass through verbatim").
 * - Held position, same direction, conviction >= the (stricter) scale-in
 *   threshold -> bounded `scale_in` lot via the same sizing pipeline as an
 *   entry (so it's bounded by the same per-trade `max_risk_per_trade` cap —
 *   never an unbounded add).
 * - Held position, same direction, conviction below the scale-in threshold
 *   -> hold.
 */
export async function decide(input: TraderInput): Promise<OrderIntent | null> {
  const { clock, config, debate, equity, instrument, marketData, positionState } = input;

  if (debate.direction === 'neutral') return null;

  const asOf = clock.now();
  const position = await positionState.getOpenPosition(instrument, asOf);

  if (position !== null) {
    if (!debate.converged) return null;

    const newSide = sideFor(debate.direction);
    if (newSide !== position.side) {
      const mark = await marketData.getMark(instrument, asOf);
      return buildExit(instrument, mark, position, debate);
    }

    if (debate.confidence < config.scale_in_conviction_threshold) return null;

    const [mark, bars] = await Promise.all([
      marketData.getMark(instrument, asOf),
      marketData.getBars(
        instrument,
        { timeframe: config.atr_timeframe, lookback: config.atr_lookback + 1 },
        asOf,
      ),
    ]);

    const sizing = sizeBracket(debate, config, mark, bars, equity);
    if (sizing === null) return null;

    return buildBracket('scale_in', newSide, instrument, mark, sizing, debate, config);
  }

  if (debate.confidence < config.conviction_floor) return null;

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

  const sizing = sizeBracket(debate, config, mark, bars, equity);
  if (sizing === null) return null;

  return buildBracket('entry', sideFor(debate.direction), instrument, mark, sizing, debate, config);
}
