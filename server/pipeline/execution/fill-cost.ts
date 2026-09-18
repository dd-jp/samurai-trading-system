import type { Fill, OpenPosition } from '../../shared/index.js';

export function chargeTopUpTo(venueFee: number, modelledCommission: number | undefined): number {
  return modelledCommission === undefined ? venueFee : Math.max(venueFee, modelledCommission);
}

export function prorateCostBreakdown(
  breakdown: NonNullable<Fill['cost_breakdown']>,
  share: number,
): NonNullable<Fill['cost_breakdown']> {
  return {
    spread_cost: breakdown.spread_cost * share,
    commission: breakdown.commission * share,
    slippage: breakdown.slippage * share,
    market_impact: breakdown.market_impact * share,
  };
}

export interface ModelledLegCost {
  breakdown: NonNullable<Fill['cost_breakdown']>;
  requestedSize: number;
}

function modelledEntryCostFor(position: OpenPosition): ModelledLegCost | null {
  return position.modelled_cost_breakdown === undefined
    ? null
    : { breakdown: position.modelled_cost_breakdown, requestedSize: position.requested_size };
}

function modelledProtectiveExitCostFor(position: OpenPosition): ModelledLegCost | null {
  return position.modelled_protective_exit_cost_breakdown === undefined
    ? null
    : {
        breakdown: position.modelled_protective_exit_cost_breakdown,
        requestedSize: position.requested_size,
      };
}

export interface ModelledLotCosts {
  entry: ModelledLegCost | null;
  protectiveExit: ModelledLegCost | null;
}

export function modelledLotCostsFor(position: OpenPosition): ModelledLotCosts {
  return {
    entry: modelledEntryCostFor(position),
    protectiveExit: modelledProtectiveExitCostFor(position),
  };
}
