import type { OrderIntent } from '../../shared/index.js';
import type { Direction } from '../debate-engine/index.js';
import { riskFractionFor, type SubclassBracket } from './subclass-bracket.js';
import type { AssetClass, TraderConfig, TraderReasonDetail, TraderSkipReason } from './types.js';

export type TradeDirection = Exclude<Direction, 'neutral'>;

export function sideFor(direction: TradeDirection): 'buy' | 'sell' {
  return direction === 'bullish' ? 'buy' : 'sell';
}

type BracketSkipReason = Extract<
  TraderSkipReason,
  'stop_distance_not_positive' | 'size_not_finite' | 'rounds_to_zero_shares' | 'below_min_notional'
>;

interface BracketSkip {
  reason: BracketSkipReason;
  reason_detail: TraderReasonDetail | null;
}

export interface PriceBracketInput {
  direction: TradeDirection;
  entry: number;
  atr: number;
  bracket: SubclassBracket | null;
  config: Pick<TraderConfig, 'vol_floor_fraction' | 'atr_k' | 'reward_risk_multiple'>;
}

export interface PricedBracket {
  side: 'buy' | 'sell';
  stop: number;
  target: number;
  stop_distance: number;
  vol_floor_factor: number;
}

export type PriceBracketResult =
  | { priced: PricedBracket; skip: null }
  | { priced: null; skip: BracketSkip };

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

interface SizedBracket {
  size: number;
  sizing: OrderIntent['metadata']['sizing'];
}

export type SizeBracketResult =
  | { sized: SizedBracket; skip: null }
  | { sized: null; skip: BracketSkip };

function convictionMultiplier(conviction: number, floor: number): number {
  const span = 1 - floor;
  if (span <= 0) return 1;
  return Math.min(1, (conviction - floor) / span);
}

function maxRiskFor(assetClass: AssetClass, config: SizeBracketInput['config']): number {
  return config.max_risk_per_trade * config.asset_class_risk_multiplier[assetClass];
}

export function sizeBracket(input: SizeBracketInput): SizeBracketResult {
  const { asset_class, bracket, config, converged, conviction, cosine_multiplier, entry, equity } =
    input;
  const { stop_distance: stopDistance, vol_floor_factor } = input.priced;

  const convictionMult = convictionMultiplier(conviction, config.conviction_floor);
  const maxRiskFraction =
    bracket === null ? maxRiskFor(asset_class, config) : riskFractionFor(bracket);
  const baseRiskFraction = maxRiskFraction * convictionMult;
  const nonConvergedHaircut = converged ? 1 : config.non_converged_haircut;

  const riskFraction = baseRiskFraction * nonConvergedHaircut * cosine_multiplier;
  const size = (equity * riskFraction) / stopDistance;

  if (!Number.isFinite(size)) {
    return { sized: null, skip: { reason: 'size_not_finite', reason_detail: null } };
  }

  const submittableSize = config.whole_share_sizing ? Math.floor(size) : size;

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
        ...(bracket === null ? {} : { frozen_bracket: { ...bracket } }),
        ...(submittableSize === size ? {} : { unquantised_size: size }),
      },
    },
    skip: null,
  };
}
