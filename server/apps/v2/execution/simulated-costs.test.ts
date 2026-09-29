import { describe, expect, it, vi } from 'vitest';
import type { MarketData, OrderSide, V2Bar, Venue } from '../../../../contracts/index.js';
import {
  adversePrice,
  CfdCostModelUnsetError,
  dailyReturnVolatility,
  FALLBACK_IMPACT_BPS,
  IMPACT_K,
  IMPACT_WINDOW_BARS,
  impactLookup,
  marketImpactBps,
  quoteSimulatedFill,
  venueFee,
} from './simulated-costs.js';

const TRADING_DATE = '2026-09-25';

function bar(date: string, close: number, volume: number): V2Bar {
  return { date, open: close, high: close, low: close, close, volume, rawClose: close };
}

function window(closes: readonly number[], volume = 1_000_000): V2Bar[] {
  return closes.map((close, index) => {
    const day = new Date(Date.parse(TRADING_DATE) - (closes.length - index) * 86_400_000);
    return bar(day.toISOString().slice(0, 10), close, volume);
  });
}

const alternating = Array.from({ length: IMPACT_WINDOW_BARS + 1 }, (_, i) => (i % 2 ? 101 : 100));

describe('adversePrice', () => {
  it('moves a buy up and a sell down by the basis points, and nothing at zero', () => {
    expect(adversePrice(200, 'buy', 25)).toBeCloseTo(200.5, 9);
    expect(adversePrice(200, 'sell', 25)).toBeCloseTo(199.5, 9);
    expect(adversePrice(200, 'buy', 0)).toBe(200);
  });
});

describe('venueFee', () => {
  it('charges Saxo commission on both sides and Alpaca regulatory fees, sells only for SEC and TAF', () => {
    expect(venueFee('saxo', 'buy', 10, 100)).toBeCloseTo(0.8, 12);
    expect(venueFee('saxo', 'sell', 10, 100)).toBeCloseTo(0.8, 12);
    expect(venueFee('alpaca', 'buy', 1_000, 100)).toBeCloseTo(0.003, 12);
    expect(venueFee('alpaca', 'sell', 1_000, 100)).toBeCloseTo(0.003 + 2.06 + 0.195, 12);
    expect(venueFee('alpaca', 'sell', 1_000_000, 1)).toBeCloseTo(3 + 20.6 + 9.79, 9);
  });
});

describe('venueFee on a CFD venue', () => {
  const model = { fee: (side: OrderSide, qty: number, price: number) => (side === 'sell' ? 2 : 1) * qty * price };

  it.each(['saxo_cfd_gbp', 'saxo_cfd_usd'] as const)('%s throws with no cost model rather than pricing a zero fee', (venue) => {
    expect(() => venueFee(venue, 'sell', 10, 100)).toThrow(CfdCostModelUnsetError);
  });

  it.each(['saxo_cfd_gbp', 'saxo_cfd_usd'] as const)('%s takes the fee from the injected model, not the cash Saxo commission', (venue) => {
    expect(venueFee(venue, 'sell', 10, 100, model)).toBe(2_000);
    expect(venueFee(venue, 'buy', 10, 100, model)).toBe(1_000);
  });

  it('ignores a cost model on the cash venues', () => {
    expect(venueFee('saxo', 'buy', 10, 100, model)).toBeCloseTo(0.8, 12);
    expect(venueFee('alpaca', 'buy', 1_000, 100, model)).toBeCloseTo(0.003, 12);
  });
});

describe('dailyReturnVolatility', () => {
  it('is the sample standard deviation of close-to-close returns, undefined below two returns', () => {
    expect(dailyReturnVolatility(window([100, 110, 99, 99]))).toBeCloseTo(0.1, 12);
    expect(dailyReturnVolatility(window([100, 100, 100]))).toBe(0);
    expect(dailyReturnVolatility(window([100, 110]))).toBeUndefined();
  });
});

describe('marketImpactBps', () => {
  const bars = window(alternating);
  const volatility = dailyReturnVolatility(bars) ?? Number.NaN;
  const notional = (10 * 101 * 1_000_000 + 10 * 100 * 1_000_000) / 20;

  it('is k times daily volatility times the root of participation, in basis points', () => {
    expect(marketImpactBps(bars, 1_000, 100, TRADING_DATE)).toBeCloseTo(
      IMPACT_K * volatility * Math.sqrt(100_000 / notional) * 10_000,
      9,
    );
  });

  it('refuses an uncovered, empty or non-finite window', () => {
    expect(marketImpactBps(bars.slice(-5), 1_000, 100, TRADING_DATE)).toBeUndefined();
    expect(marketImpactBps(bars, 1_000, 100, '2026-10-30')).toBeUndefined();
    expect(marketImpactBps(window(alternating, 0), 1_000, 100, TRADING_DATE)).toBeUndefined();
    expect(marketImpactBps(bars, 1_000, Number.NaN, TRADING_DATE)).toBeUndefined();
    expect(marketImpactBps(bars, 1_000, -1, TRADING_DATE)).toBeUndefined();
  });
});

describe('impactLookup', () => {
  it('reads the window before the date and falls back to the declared impact with a warning', () => {
    const barsBefore = vi.fn((symbol: string) => (symbol === 'OK' ? window(alternating) : []));
    const market: MarketData = {
      barsBefore,
      lastBarBefore: () => undefined,
      gbpUsdAtYearStart: () => 1,
    };
    const log = vi.fn();
    const impact = impactLookup(market, () => TRADING_DATE, { log });
    expect(impact('OK', 1_000, 100)).toBe(
      marketImpactBps(window(alternating), 1_000, 100, TRADING_DATE),
    );
    expect(barsBefore).toHaveBeenCalledWith('OK', TRADING_DATE, IMPACT_WINDOW_BARS + 1);
    expect(log).not.toHaveBeenCalled();
    expect(impact('GONE', 1_000, 100)).toBe(FALLBACK_IMPACT_BPS);
    expect(log).toHaveBeenCalledWith({
      trace_id: `v2-${TRADING_DATE}`,
      stage: 'v2',
      level: 'warn',
      event: 'v2_impact_fallback',
      message: `GONE: no covered ${IMPACT_WINDOW_BARS}-bar window, impact charged at ${FALLBACK_IMPACT_BPS} bps`,
    });
    expect(impactLookup(market, () => TRADING_DATE)('GONE', 1, 1)).toBe(FALLBACK_IMPACT_BPS);
  });
});

describe('quoteSimulatedFill', () => {
  it('crosses the spread and impact only when asked, and prices the fee at the fill price', () => {
    const fee = vi.fn(() => 1.5);
    const pricing = { halfSpreadBps: () => 10, impactBps: () => 5, fee };
    const request = {
      instrument: 'X',
      side: 'sell' as const,
      qty: 4,
      price: 100,
      crossesSpread: true,
    };
    expect(quoteSimulatedFill('alpaca', request, pricing)).toEqual({ price: 99.85, fee: 1.5 });
    expect(fee).toHaveBeenLastCalledWith('alpaca', 'sell', 4, 99.85);
    expect(quoteSimulatedFill('saxo', { ...request, crossesSpread: false }, pricing)).toEqual({
      price: 100,
      fee: 1.5,
    });
  });
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('simulated fill properties (seed 1783, 2,000 cases)', () => {
  it('is finite, never better than the reference price, never improves with size, and the fee is non-negative', () => {
    const random = mulberry32(1783);
    for (let run = 0; run < 2_000; run += 1) {
      const price = Math.exp(Math.log(1) + random() * Math.log(5_000));
      const closes = Array.from(
        { length: IMPACT_WINDOW_BARS + 1 },
        () => price * (0.9 + random() * 0.2),
      );
      const bars = window(closes, Math.floor(random() * 5_000_000));
      const venue: Venue = random() < 0.5 ? 'alpaca' : 'saxo';
      const side: OrderSide = random() < 0.5 ? 'buy' : 'sell';
      const pricing = {
        halfSpreadBps: () => random() * 50,
        impactBps: (_: string, qty: number, at: number) =>
          marketImpactBps(bars, qty, at, TRADING_DATE) ?? FALLBACK_IMPACT_BPS,
        fee: venueFee,
      };
      const spread = pricing.halfSpreadBps();
      const fixed = { ...pricing, halfSpreadBps: () => spread };
      const qty = 1 + Math.floor(random() * 10_000);
      const request = { instrument: 'X', side, qty, price, crossesSpread: true };
      const small = quoteSimulatedFill(venue, request, fixed);
      const large = quoteSimulatedFill(venue, { ...request, qty: qty * 2 }, fixed);
      const sign = side === 'buy' ? 1 : -1;
      expect(Number.isFinite(small.price) && Number.isFinite(small.fee)).toBe(true);
      expect(sign * (small.price - price)).toBeGreaterThanOrEqual(0);
      expect(sign * (large.price - small.price)).toBeGreaterThanOrEqual(0);
      expect(small.fee).toBeGreaterThanOrEqual(0);
      expect(large.price).toBeGreaterThan(0);
    }
  });
});
