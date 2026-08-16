/**
 * A1 (#703) — the subclass dimension ADR-0018 prices against.
 *
 * These tests exist for one reason: ADR-0018 D5 sizes the equity leg *down*
 * (~35% for index ETPs, ~25% for single-stock) because the measured
 * volatility envelope at full deployment runs 2.2x-3.5x outside
 * `CONTEXT.md`'s drawdown tolerance *before any edge exists*. So the failure
 * mode worth a test is not "the wrong bracket" — it is a missing subclass
 * quietly resolving to a default, on the money path, where the only available
 * default is the full deployment the ADR exists to forbid.
 */
import { describe, expect, it } from 'vitest';

import { requireSubclass, type UniverseInstrument } from './types.js';

const indexEtp: UniverseInstrument = {
  asset: '3USL',
  asset_class: 'stocks',
  subclass: 'index_etp_3x',
};

describe('requireSubclass', () => {
  it('returns the subclass when the pool file supplied one', () => {
    expect(requireSubclass(indexEtp)).toBe('index_etp_3x');
  });

  it('distinguishes the two ETP subclasses that share an asset_class', () => {
    const singleStock: UniverseInstrument = {
      asset: '3LTS',
      asset_class: 'stocks',
      subclass: 'single_stock_etp_3x',
    };

    // The whole point of the dimension: `asset_class` is identical here, and
    // ADR-0018 D3 gives these two a +2.00/-2.16 and a +6.00/-6.25 bracket
    // respectively. Keying on asset_class cannot express that.
    expect(indexEtp.asset_class).toBe(singleStock.asset_class);
    expect(requireSubclass(indexEtp)).not.toBe(requireSubclass(singleStock));
  });

  it('throws rather than defaulting when the subclass is absent', () => {
    const unpriced: UniverseInstrument = {
      asset: 'SPY',
      asset_class: 'stocks',
    };

    expect(() => requireSubclass(unpriced)).toThrow(/SPY/);
    expect(() => requireSubclass(unpriced)).toThrow(/ADR-0018/);
  });

  it('names full deployment in the refusal, so the reason survives the stack trace', () => {
    expect(() => requireSubclass({ asset: 'QQQ', asset_class: 'stocks' })).toThrow(
      /default here is full deployment/,
    );
  });

  it('leaves instruments that never priced against ADR-0018 constructible', () => {
    // The smoke universe, the backtest fixtures and every existing profile
    // name instruments without a subclass. They must keep compiling and
    // running; they simply may not reach a bracket or a sizing call.
    const smoke: UniverseInstrument = {
      asset: 'BTC-USD',
      asset_class: 'crypto',
    };

    expect(smoke.subclass).toBeUndefined();
    expect(() => requireSubclass(smoke)).toThrow();
  });
});
