import { wholeShares } from '../../pipeline/momentum/index.js';
import { MACRO_DAY_SIZE_FRACTION } from './macro-calendar.js';

export const STOP_ATR_MULTIPLE = 2;
export const MAX_POSITION_FRACTION_OF_EQUITY = 0.1;

export interface PositionSizeInput {
  readonly equityGbp: number;
  readonly riskFraction: number;
  readonly priceGbp: number;
  readonly atrGbp: number;
  readonly sizeMultiplier: number;
  readonly macroDay: boolean;
}

export function positionSizeShares(input: PositionSizeInput): number {
  const { equityGbp, riskFraction, priceGbp, atrGbp, sizeMultiplier, macroDay } = input;
  if (!(atrGbp > 0)) return 0;
  const scale = sizeMultiplier * (macroDay ? MACRO_DAY_SIZE_FRACTION : 1);
  const riskCash = equityGbp * riskFraction * scale;
  const byRisk = Math.floor(riskCash / (atrGbp * STOP_ATR_MULTIPLE));
  const byNotional = wholeShares(equityGbp * MAX_POSITION_FRACTION_OF_EQUITY * scale, priceGbp);
  const shares = Math.min(byRisk, byNotional);
  return Number.isFinite(shares) ? Math.max(0, shares) : 0;
}
