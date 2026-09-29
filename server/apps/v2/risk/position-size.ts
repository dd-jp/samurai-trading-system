import { wholeShares } from '../../../pipeline/momentum/index.js';
import { MACRO_DAY_SIZE_FRACTION } from '../data/index.js';

export const MAX_POSITION_FRACTION_OF_EQUITY = 0.1;
export const CFD_SHORT_GAP_FRACTION = 0.3;
export const CFD_SHORT_GAP_BUDGET_FRACTION = 0.1;

export interface PositionSizeInput {
  readonly equityGbp: number;
  readonly riskFraction: number;
  readonly priceGbp: number;
  readonly atrGbp: number;
  readonly stopAtrMultiple: number;
  readonly sizeMultiplier: number;
  readonly macroDay: boolean;
  readonly volumeCapShares: number;
  readonly gapBudgetGbp?: number | undefined;
}

export function positionSizeShares(input: PositionSizeInput): number {
  const { equityGbp, riskFraction, priceGbp, atrGbp, stopAtrMultiple, sizeMultiplier, macroDay } =
    input;
  if (!(atrGbp > 0)) return 0;
  const scale = sizeMultiplier * (macroDay ? MACRO_DAY_SIZE_FRACTION : 1);
  const riskCash = equityGbp * riskFraction * scale;
  const byRisk = Math.floor(riskCash / (atrGbp * stopAtrMultiple));
  const byNotional = wholeShares(equityGbp * MAX_POSITION_FRACTION_OF_EQUITY * scale, priceGbp);
  const byGap =
    input.gapBudgetGbp === undefined
      ? Number.POSITIVE_INFINITY
      : wholeShares(input.gapBudgetGbp / CFD_SHORT_GAP_FRACTION, priceGbp);
  const shares = Math.min(byRisk, byNotional, input.volumeCapShares, byGap);
  return Number.isFinite(shares) ? Math.max(0, shares) : 0;
}
