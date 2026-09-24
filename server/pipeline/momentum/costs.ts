export const SAXO_COMMISSION_PER_SIDE = 0.0008;
export const SAXO_CUSTODY_RATE_PER_YEAR = 0.0012;
export const DAYS_PER_YEAR = 365;

export const ALPACA_SEC_FEE_RATE_ON_SELLS = 0.0000206;
export const ALPACA_FINRA_TAF_PER_SHARE_ON_SELLS = 0.000195;
export const ALPACA_FINRA_TAF_MAX_PER_TRADE = 9.79;
export const ALPACA_CAT_FEE_PER_SHARE = 0.000003;

export type Side = 'buy' | 'sell';

export interface Fill {
  readonly side: Side;
  readonly notional: number;
  readonly shares: number;
  readonly halfSpreadBps: number;
}

export function halfSpreadCost(notional: number, halfSpreadBps: number): number {
  if (!(halfSpreadBps >= 0)) throw new Error(`halfSpreadBps must be >= 0 (got ${halfSpreadBps})`);
  return (notional * halfSpreadBps) / 10_000;
}

export function saxoFillCost(fill: Fill): number {
  assertFill(fill);
  return (
    fill.notional * SAXO_COMMISSION_PER_SIDE + halfSpreadCost(fill.notional, fill.halfSpreadBps)
  );
}

export function saxoCustodyAccrual(investedNotional: number, calendarDays: number): number {
  if (!(investedNotional >= 0) || !(calendarDays >= 0)) {
    throw new Error(`saxoCustodyAccrual: bad inputs (${investedNotional}, ${calendarDays})`);
  }
  return (investedNotional * SAXO_CUSTODY_RATE_PER_YEAR * calendarDays) / DAYS_PER_YEAR;
}

export function alpacaRegulatoryFees(fill: Fill): number {
  const cat = fill.shares * ALPACA_CAT_FEE_PER_SHARE;
  if (fill.side === 'buy') return cat;
  const sec = fill.notional * ALPACA_SEC_FEE_RATE_ON_SELLS;
  const taf = Math.min(
    fill.shares * ALPACA_FINRA_TAF_PER_SHARE_ON_SELLS,
    ALPACA_FINRA_TAF_MAX_PER_TRADE,
  );
  return cat + sec + taf;
}

export function alpacaFillCost(fill: Fill): number {
  assertFill(fill);
  return halfSpreadCost(fill.notional, fill.halfSpreadBps) + alpacaRegulatoryFees(fill);
}

function assertFill(fill: Fill): void {
  if (!(fill.notional >= 0) || !(fill.shares >= 0)) {
    throw new Error(`fill notional and shares must be >= 0 (got ${fill.notional}, ${fill.shares})`);
  }
}
