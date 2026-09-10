/**
 * The bracket arithmetic on its own, with no reads around it. The worked
 * example every ATR-geometry size below is pinned to, under
 * `DEFAULT_TRADER_CONFIG` with ATR = 2 and entry = 100:
 *   stop distance  = atr_k (2) x ATR (2)                        = 4
 *   conviction     = (0.775 - 0.55) / (1 - 0.55)                = 0.5
 *   base risk      = max_risk_per_trade (0.01) x 1.0 x 0.5      = 0.005
 *   risk fraction  = 0.005 x 1 (converged) x 0.75 (no precedent) = 0.00375
 *   size           = 100_000 x 0.00375 / 4                       = 93.75
 */
import { describe, expect, it } from 'vitest';
import {
  type PricedBracket,
  priceBracket,
  type SizeBracketInput,
  sideFor,
  sizeBracket,
} from './build-bracket.js';
import { NO_PRECEDENT_MULTIPLIER } from './cosine-precedent.js';
import { ADR_0018_SUBCLASS_BRACKETS, riskFractionFor } from './subclass-bracket.js';
import { DEFAULT_TRADER_CONFIG } from './types.js';

const INDEX_ETP = ADR_0018_SUBCLASS_BRACKETS.index_etp_3x;
const SINGLE_STOCK_ETP = ADR_0018_SUBCLASS_BRACKETS.single_stock_etp_3x;
if (INDEX_ETP === null || SINGLE_STOCK_ETP === null)
  throw new Error('ADR-0018 brackets are declared');

describe('sideFor', () => {
  it.each([
    ['bullish', 'buy'],
    ['bearish', 'sell'],
  ] as const)('%s -> %s', (direction, side) => {
    expect(sideFor(direction)).toBe(side);
  });
});

describe('priceBracket', () => {
  it.each([
    {
      name: 'long, ATR geometry: stop atr_k x ATR below entry, target reward_risk_multiple x that above',
      direction: 'bullish',
      entry: 100,
      atr: 2,
      bracket: null,
      expected: { side: 'buy', stop: 96, target: 108, stop_distance: 4, vol_floor_factor: 1 },
    },
    {
      name: 'short, ATR geometry: the same distances mirrored',
      direction: 'bearish',
      entry: 100,
      atr: 2,
      bracket: null,
      expected: { side: 'sell', stop: 104, target: 92, stop_distance: 4, vol_floor_factor: 1 },
    },
    {
      name: 'vol floor binds when ATR is below vol_floor_fraction x entry, and the factor records it',
      direction: 'bullish',
      entry: 100,
      atr: 0.1,
      bracket: null,
      expected: { side: 'buy', stop: 99.6, target: 100.8, stop_distance: 0.4, vol_floor_factor: 2 },
    },
    {
      name: 'a zero ATR leaves the floor as sole determinant and the factor at 1',
      direction: 'bullish',
      entry: 100,
      atr: 0,
      bracket: null,
      expected: { side: 'buy', stop: 99.6, target: 100.8, stop_distance: 0.4, vol_floor_factor: 1 },
    },
    {
      name: 'long, ADR-0018 D3 index bracket: +2.00% / -2.16% of entry, ATR ignored',
      direction: 'bullish',
      entry: 40,
      atr: 5,
      bracket: INDEX_ETP,
      expected: {
        side: 'buy',
        stop: 39.136,
        target: 40.8,
        stop_distance: 0.864,
        vol_floor_factor: 1,
      },
    },
    {
      name: 'short, ADR-0018 D3 index bracket: the same percentages mirrored',
      direction: 'bearish',
      entry: 40,
      atr: 5,
      bracket: INDEX_ETP,
      expected: {
        side: 'sell',
        stop: 40.864,
        target: 39.2,
        stop_distance: 0.864,
        vol_floor_factor: 1,
      },
    },
    {
      name: 'long, ADR-0018 D3 single-stock bracket: +6.00% / -6.25% of entry',
      direction: 'bullish',
      entry: 40,
      atr: 0.01,
      bracket: SINGLE_STOCK_ETP,
      expected: { side: 'buy', stop: 37.5, target: 42.4, stop_distance: 2.5, vol_floor_factor: 8 },
    },
  ] as const)('$name', ({ direction, entry, atr, bracket, expected }) => {
    const result = priceBracket({ direction, entry, atr, bracket, config: DEFAULT_TRADER_CONFIG });
    expect(result.skip).toBeNull();
    const priced = result.priced as PricedBracket;
    expect(priced.side).toBe(expected.side);
    expect(priced.stop).toBeCloseTo(expected.stop, 10);
    expect(priced.target).toBeCloseTo(expected.target, 10);
    expect(priced.stop_distance).toBeCloseTo(expected.stop_distance, 10);
    expect(priced.vol_floor_factor).toBeCloseTo(expected.vol_floor_factor, 10);
  });

  it('skips stop_distance_not_positive when neither ATR nor the floor is positive', () => {
    const result = priceBracket({
      direction: 'bullish',
      entry: 0,
      atr: 0,
      bracket: null,
      config: DEFAULT_TRADER_CONFIG,
    });
    expect(result).toEqual({
      priced: null,
      skip: { reason: 'stop_distance_not_positive', reason_detail: null },
    });
  });
});

describe('sizeBracket', () => {
  const EQUITY = 100_000;
  const ENTRY = 100;
  const priced: PricedBracket = {
    side: 'buy',
    stop: 96,
    target: 108,
    stop_distance: 4,
    vol_floor_factor: 1,
  };
  const baseline: SizeBracketInput = {
    priced,
    entry: ENTRY,
    equity: EQUITY,
    conviction: 0.775,
    converged: true,
    cosine_multiplier: NO_PRECEDENT_MULTIPLIER,
    bracket: null,
    asset_class: 'stocks',
    config: DEFAULT_TRADER_CONFIG,
  };

  it.each([
    {
      name: 'the worked example',
      input: {},
      size: 93.75,
      sizing: { base_risk_fraction: 0.005, conviction_multiplier: 0.5, non_converged_haircut: 1 },
    },
    {
      name: 'conviction at 1.0 takes the full risk fraction',
      input: { conviction: 1 },
      size: 187.5,
      sizing: { base_risk_fraction: 0.01, conviction_multiplier: 1, non_converged_haircut: 1 },
    },
    {
      name: 'conviction above 1.0 is capped, not extrapolated',
      input: { conviction: 1.5 },
      size: 187.5,
      sizing: { base_risk_fraction: 0.01, conviction_multiplier: 1, non_converged_haircut: 1 },
    },
    {
      name: 'a non-converged debate halves the size',
      input: { converged: false },
      size: 46.875,
      sizing: { base_risk_fraction: 0.005, conviction_multiplier: 0.5, non_converged_haircut: 0.5 },
    },
    {
      name: 'the crypto asset-class multiplier halves the base risk',
      input: { asset_class: 'crypto' },
      size: 46.875,
      sizing: { base_risk_fraction: 0.0025, conviction_multiplier: 0.5, non_converged_haircut: 1 },
    },
    {
      name: 'precedent scales multiplicatively',
      input: { cosine_multiplier: 1.5 },
      size: 187.5,
      sizing: { base_risk_fraction: 0.005, conviction_multiplier: 0.5, non_converged_haircut: 1 },
    },
  ] as const)('$name', ({ input, size, sizing }) => {
    const result = sizeBracket({ ...baseline, ...input });
    expect(result.skip).toBeNull();
    expect(result.sized?.size).toBeCloseTo(size, 10);
    expect(result.sized?.sizing).toEqual({
      ...sizing,
      vol_floor_factor: 1,
      cosine_multiplier: input.cosine_multiplier ?? NO_PRECEDENT_MULTIPLIER,
    });
  });

  it('carries the priced vol_floor_factor into the sizing record unchanged', () => {
    const result = sizeBracket({ ...baseline, priced: { ...priced, vol_floor_factor: 2 } });
    expect(result.sized?.sizing.vol_floor_factor).toBe(2);
  });

  describe('whole_share_sizing', () => {
    const config = { ...DEFAULT_TRADER_CONFIG, whole_share_sizing: true };

    it('floors the size and records the unquantised size beside it', () => {
      const result = sizeBracket({ ...baseline, config });
      expect(result.sized?.size).toBe(93);
      expect(result.sized?.sizing.unquantised_size).toBe(93.75);
    });

    it('omits unquantised_size when the floor moved nothing', () => {
      const result = sizeBracket({ ...baseline, config, equity: 96_000 });
      expect(result.sized?.size).toBe(90);
      expect(result.sized?.sizing).not.toHaveProperty('unquantised_size');
    });

    it('skips rounds_to_zero_shares when a real position floors to nothing', () => {
      expect(sizeBracket({ ...baseline, config, equity: 1_000 })).toEqual({
        sized: null,
        skip: { reason: 'rounds_to_zero_shares', reason_detail: null },
      });
    });

    it('reports a size of exactly zero as below_min_notional, not as the grid eating it', () => {
      const result = sizeBracket({
        ...baseline,
        config,
        conviction: DEFAULT_TRADER_CONFIG.conviction_floor,
      });
      expect(result.skip).toEqual({
        reason: 'below_min_notional',
        reason_detail: { compared_value: 0, threshold: DEFAULT_TRADER_CONFIG.min_viable_notional },
      });
    });
  });

  it('skips below_min_notional with the notional it compared', () => {
    expect(sizeBracket({ ...baseline, equity: 100 })).toEqual({
      sized: null,
      skip: {
        reason: 'below_min_notional',
        reason_detail: {
          compared_value: 9.375,
          threshold: DEFAULT_TRADER_CONFIG.min_viable_notional,
        },
      },
    });
  });

  it('skips size_not_finite before any notional comparison can pass NaN', () => {
    expect(sizeBracket({ ...baseline, equity: Number.NaN })).toEqual({
      sized: null,
      skip: { reason: 'size_not_finite', reason_detail: null },
    });
  });

  describe('ADR-0018 D5 frozen bracket', () => {
    it.each([
      { name: 'index ETP', bracket: INDEX_ETP },
      { name: 'single-stock ETP', bracket: SINGLE_STOCK_ETP },
    ])('$name: size x entry lands on deployment x (1 - reserve) x equity at full conviction', ({
      bracket,
    }) => {
      const entry = 40;
      const stopDistance = bracket.stop_pct * entry;
      const result = sizeBracket({
        ...baseline,
        entry,
        conviction: 1,
        cosine_multiplier: 1,
        bracket,
        priced: { ...priced, stop_distance: stopDistance },
      });
      expect(result.skip).toBeNull();
      expect((result.sized?.size ?? Number.NaN) * entry).toBeCloseTo(
        bracket.deployment_fraction * (1 - bracket.headroom_reserve_fraction) * EQUITY,
        6,
      );
      expect(result.sized?.sizing.base_risk_fraction).toBeCloseTo(riskFractionFor(bracket), 12);
      expect(result.sized?.sizing.frozen_bracket).toEqual(bracket);
      expect(result.sized?.sizing.frozen_bracket).not.toBe(bracket);
    });

    it('ignores the asset-class multiplier under a frozen bracket', () => {
      const stopDistance = INDEX_ETP.stop_pct * 40;
      const size = (assetClass: 'stocks' | 'crypto') =>
        sizeBracket({
          ...baseline,
          entry: 40,
          bracket: INDEX_ETP,
          asset_class: assetClass,
          priced: { ...priced, stop_distance: stopDistance },
        }).sized?.size;
      expect(size('crypto')).toBe(size('stocks'));
    });
  });
});
