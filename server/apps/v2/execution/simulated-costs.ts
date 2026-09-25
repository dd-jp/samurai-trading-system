import type {
  MarketData,
  OrderSide,
  SimulatedFillQuote,
  SimulatedFillRequest,
  V2Bar,
  Venue,
} from '../../../../contracts/index.js';
import {
  alpacaRegulatoryFees,
  SAXO_COMMISSION_PER_SIDE,
} from '../../../pipeline/momentum/index.js';
import type { Logger } from '../../../shared/index.js';
import { averageDailyNotional } from '../risk/index.js';

const BPS = 10_000;
export const IMPACT_K = 0.05;
export const IMPACT_WINDOW_BARS = 20;
export const FALLBACK_IMPACT_BPS = 25;

export interface FillPricing {
  halfSpreadBps(instrument: string): number;
  impactBps(instrument: string, qty: number, price: number): number;
  fee(venue: Venue, side: OrderSide, qty: number, price: number): number;
}

export function adversePrice(price: number, side: OrderSide, bps: number): number {
  const adjustment = (price * bps) / BPS;
  return side === 'buy' ? price + adjustment : price - adjustment;
}

export function venueFee(venue: Venue, side: OrderSide, qty: number, price: number): number {
  const notional = qty * price;
  if (venue === 'saxo') return notional * SAXO_COMMISSION_PER_SIDE;
  return alpacaRegulatoryFees({ side, notional, shares: qty, halfSpreadBps: 0 });
}

export function quoteSimulatedFill(
  venue: Venue,
  request: SimulatedFillRequest,
  pricing: FillPricing,
): SimulatedFillQuote {
  const { instrument, side, qty } = request;
  const slippageBps = request.crossesSpread
    ? pricing.halfSpreadBps(instrument) + pricing.impactBps(instrument, qty, request.price)
    : 0;
  const price = adversePrice(request.price, side, slippageBps);
  return { price, fee: pricing.fee(venue, side, qty, price) };
}

export function dailyReturnVolatility(bars: readonly V2Bar[]): number | undefined {
  const returns = bars.slice(1).map((bar, index) => bar.close / (bars[index]?.close ?? 0) - 1);
  if (returns.length < 2) return undefined;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const squares = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(squares / (returns.length - 1));
}

export function marketImpactBps(
  bars: readonly V2Bar[],
  qty: number,
  price: number,
  tradingDate: string,
): number | undefined {
  const notional = averageDailyNotional(bars, IMPACT_WINDOW_BARS, tradingDate);
  const volatility = dailyReturnVolatility(bars);
  if (notional === undefined || volatility === undefined) return undefined;
  const bps = IMPACT_K * volatility * Math.sqrt((qty * price) / notional) * BPS;
  return Number.isFinite(bps) ? bps : undefined;
}

export function impactLookup(
  market: MarketData,
  tradingDate: string,
  logger?: Logger,
): FillPricing['impactBps'] {
  return (instrument, qty, price) => {
    const bars = market.barsBefore(instrument, tradingDate, IMPACT_WINDOW_BARS + 1);
    const bps = marketImpactBps(bars, qty, price, tradingDate);
    if (bps !== undefined) return bps;
    logger?.log({
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      level: 'warn',
      event: 'v2_impact_fallback',
      message: `${instrument}: no covered ${IMPACT_WINDOW_BARS}-bar window, impact charged at ${FALLBACK_IMPACT_BPS} bps`,
    });
    return FALLBACK_IMPACT_BPS;
  };
}
