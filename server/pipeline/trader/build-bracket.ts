/**
 * The bracket arithmetic behind an entry or scale_in (trader-spec.md Module:
 * Position Sizing, "Sizing math"; ADR-0018 D3/D5): pure, synchronous, and
 * typed so that a neutral direction cannot reach it. `decide.ts`'s
 * `buildBracket` does the reads around it — equity, mark, bars, precedent —
 * and this module prices and sizes what those reads produced.
 */
import type { OrderIntent } from '../../shared/index.js';
// The same type-only carve-out `decide.ts` takes for `DebateResult`: a bare
// `import type` is erased, so this does not pull the debate engine's module
// graph into the Trader.
import type { Direction } from '../debate-engine/types.js';
import { riskFractionFor, type SubclassBracket } from './subclass-bracket.js';
import type { AssetClass, TraderConfig, TraderReasonDetail, TraderSkipReason } from './types.js';

/**
 * A direction the Trader can act on. `neutral` has no side to derive
 * (trader-spec.md Module: Side Derivation), so the router excludes it before
 * any bracket is priced and the type here keeps that exclusion from being
 * re-checked downstream.
 */
export type TradeDirection = Exclude<Direction, 'neutral'>;

export function sideFor(direction: TradeDirection): 'buy' | 'sell' {
  return direction === 'bullish' ? 'buy' : 'sell';
}

export type BracketSkipReason = Extract<
  TraderSkipReason,
  'stop_distance_not_positive' | 'size_not_finite' | 'rounds_to_zero_shares' | 'below_min_notional'
>;

export interface BracketSkip {
  reason: BracketSkipReason;
  reason_detail: TraderReasonDetail | null;
}

export interface PriceBracketInput {
  direction: TradeDirection;
  /** The mark, already checked finite by the caller. */
  entry: number;
  atr: number;
  /** `null` is the pre-ADR-0018 ATR geometry — see `resolveSubclassBracket`. */
  bracket: SubclassBracket | null;
  config: Pick<TraderConfig, 'vol_floor_fraction' | 'atr_k' | 'reward_risk_multiple'>;
}

export interface PricedBracket {
  side: 'buy' | 'sell';
  stop: number;
  target: number;
  stop_distance: number;
  /**
   * How much the floor widened the stop. A non-positive ATR (perfectly flat
   * history) leaves the ratio undefined and the floor as sole determinant;
   * recorded as 1.
   */
  vol_floor_factor: number;
}

export type PriceBracketResult =
  | { priced: PricedBracket; skip: null }
  | { priced: null; skip: BracketSkip };

/**
 * Stop and target around `entry`, on the side `direction` implies. Under a
 * frozen bracket the stop is a percentage of ENTRY and ATR does not enter it
 * at all — that is the withdrawal of the ATR-floating geometry
 * (trader-spec.md "Sizing math"), not a re-parameterisation of it.
 */
export function priceBracket(input: PriceBracketInput): PriceBracketResult {
  const { atr, bracket, config, direction, entry } = input;

  const volFloor = config.vol_floor_fraction * entry;
  const effectiveVol = Math.max(atr, volFloor);
  const stopDistance = bracket === null ? config.atr_k * effectiveVol : bracket.stop_pct * entry;
  if (stopDistance <= 0) {
    return { priced: null, skip: { reason: 'stop_distance_not_positive', reason_detail: null } };
  }
  const targetDistance =
    bracket === null ? config.reward_risk_multiple * stopDistance : bracket.take_profit_pct * entry;

  const side = sideFor(direction);
  const sign = side === 'buy' ? 1 : -1;
  return {
    priced: {
      side,
      stop: entry - sign * stopDistance,
      target: entry + sign * targetDistance,
      stop_distance: stopDistance,
      vol_floor_factor: atr > 0 ? effectiveVol / atr : 1,
    },
    skip: null,
  };
}

export interface SizeBracketInput {
  priced: PricedBracket;
  entry: number;
  equity: number;
  conviction: number;
  converged: boolean;
  cosine_multiplier: number;
  bracket: SubclassBracket | null;
  asset_class: AssetClass;
  config: Pick<
    TraderConfig,
    | 'conviction_floor'
    | 'max_risk_per_trade'
    | 'asset_class_risk_multiplier'
    | 'non_converged_haircut'
    | 'whole_share_sizing'
    | 'min_viable_notional'
  >;
}

export interface SizedBracket {
  /** The quantity to submit — floored to whole shares when the venue demands it. */
  size: number;
  sizing: OrderIntent['metadata']['sizing'];
}

export type SizeBracketResult =
  | { sized: SizedBracket; skip: null }
  | { sized: null; skip: BracketSkip };

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

function maxRiskFor(assetClass: AssetClass, config: SizeBracketInput['config']): number {
  return config.max_risk_per_trade * config.asset_class_risk_multiplier[assetClass];
}

/**
 * The quantity a priced bracket deploys, and the audit record of how it was
 * reached. Shared by entry and scale_in: a scale_in sizes exactly like an
 * entry and Risk enforces the exposure cap downstream (trader-spec.md Module:
 * Position Awareness).
 */
export function sizeBracket(input: SizeBracketInput): SizeBracketResult {
  const { asset_class, bracket, config, converged, conviction, cosine_multiplier, entry, equity } =
    input;
  const { stop_distance: stopDistance, vol_floor_factor } = input.priced;

  const convictionMult = convictionMultiplier(conviction, config.conviction_floor);
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
    bracket === null ? maxRiskFor(asset_class, config) : riskFractionFor(bracket);
  const baseRiskFraction = maxRiskFraction * convictionMult;
  const nonConvergedHaircut = converged ? 1 : config.non_converged_haircut;

  // Multiplicative stacking — penalties compound honestly (trader-spec.md
  // Module: Non-Convergence & Skip Policy).
  const riskFraction = baseRiskFraction * nonConvergedHaircut * cosine_multiplier;
  const size = (equity * riskFraction) / stopDistance;

  // Backstop covering every numeric inlet at once, including `equity`, which
  // comes from an account read the Trader does not validate. The per-input
  // checks upstream say WHICH input was bad; this one guarantees that no
  // future inlet can reach an emitted intent unchecked. Must precede the
  // min-notional line: `NaN < min_viable_notional` is false, so that check
  // passes NaN.
  if (!Number.isFinite(size)) {
    return { sized: null, skip: { reason: 'size_not_finite', reason_detail: null } };
  }

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
  if (submittableSize <= 0 && size > 0) {
    return { sized: null, skip: { reason: 'rounds_to_zero_shares', reason_detail: null } };
  }

  if (submittableSize * entry < config.min_viable_notional) {
    return {
      sized: null,
      skip: {
        reason: 'below_min_notional',
        reason_detail: {
          compared_value: submittableSize * entry,
          threshold: config.min_viable_notional,
        },
      },
    };
  }

  return {
    sized: {
      size: submittableSize,
      sizing: {
        base_risk_fraction: baseRiskFraction,
        conviction_multiplier: convictionMult,
        vol_floor_factor,
        non_converged_haircut: nonConvergedHaircut,
        cosine_multiplier,
        // Spread rather than field-by-field so a bracket field added to
        // config cannot be silently dropped from the audit record.
        ...(bracket === null ? {} : { frozen_bracket: { ...bracket } }),
        // Spread-or-absent for the same `exactOptionalPropertyTypes` reason
        // the bracket above is, and absent when the floor changed nothing so
        // that its PRESENCE means "this intent under-deploys D5" rather than
        // merely "the flag is on".
        ...(submittableSize === size ? {} : { unquantised_size: size }),
      },
    },
    skip: null,
  };
}
