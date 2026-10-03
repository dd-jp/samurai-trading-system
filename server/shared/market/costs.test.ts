import {
  ALPACA_CAT_FEE_PER_SHARE,
  ALPACA_FINRA_TAF_MAX_PER_TRADE,
  ALPACA_FINRA_TAF_PER_SHARE_ON_SELLS,
  ALPACA_SEC_FEE_RATE_ON_SELLS,
  alpacaFillCost,
  alpacaRegulatoryFees,
  halfSpreadCost,
  SAXO_COMMISSION_PER_SIDE,
  SAXO_CUSTODY_RATE_PER_YEAR,
  saxoCustodyAccrual,
  saxoFillCost,
} from './costs.js';

describe('halfSpreadCost', () => {
  it('charges half the spread in basis points on the notional', () => {
    expect(halfSpreadCost(10_000, 5)).toBeCloseTo(5);
    expect(halfSpreadCost(10_000, 0)).toBe(0);
  });

  it('rejects a negative half spread', () => {
    expect(() => halfSpreadCost(1, -1)).toThrow(/halfSpreadBps/);
  });
});

describe('saxoFillCost', () => {
  it('charges 0.08% per side with no minimum plus half spread', () => {
    expect(SAXO_COMMISSION_PER_SIDE).toBe(0.0008);
    expect(saxoFillCost({ side: 'buy', notional: 100, shares: 1, halfSpreadBps: 0 })).toBeCloseTo(
      0.08,
    );
    expect(
      saxoFillCost({ side: 'sell', notional: 10_000, shares: 10, halfSpreadBps: 10 }),
    ).toBeCloseTo(8 + 10);
  });

  it('rejects a negative notional or share count', () => {
    expect(() => saxoFillCost({ side: 'buy', notional: -1, shares: 1, halfSpreadBps: 0 })).toThrow(
      />= 0/,
    );
    expect(() => saxoFillCost({ side: 'buy', notional: 1, shares: -1, halfSpreadBps: 0 })).toThrow(
      />= 0/,
    );
  });
});

describe('saxoCustodyAccrual', () => {
  it('accrues 0.12% per year pro rata by calendar day', () => {
    expect(SAXO_CUSTODY_RATE_PER_YEAR).toBe(0.0012);
    expect(saxoCustodyAccrual(10_000, 365)).toBeCloseTo(12);
    expect(saxoCustodyAccrual(10_000, 1)).toBeCloseTo(12 / 365);
    expect(saxoCustodyAccrual(0, 3)).toBe(0);
  });

  it('accrues nothing over zero days', () => {
    expect(saxoCustodyAccrual(10_000, 0)).toBe(0);
  });

  it('rejects negative inputs', () => {
    expect(() => saxoCustodyAccrual(-1, 1)).toThrow(/bad inputs/);
    expect(() => saxoCustodyAccrual(1, -1)).toThrow(/bad inputs/);
  });
});

describe('alpacaRegulatoryFees', () => {
  it('charges only CAT on a buy', () => {
    expect(
      alpacaRegulatoryFees({ side: 'buy', notional: 10_000, shares: 100, halfSpreadBps: 0 }),
    ).toBeCloseTo(100 * ALPACA_CAT_FEE_PER_SHARE);
  });

  it('adds SEC and FINRA TAF on a sell', () => {
    const fee = alpacaRegulatoryFees({
      side: 'sell',
      notional: 10_000,
      shares: 100,
      halfSpreadBps: 0,
    });
    expect(fee).toBeCloseTo(
      100 * ALPACA_CAT_FEE_PER_SHARE +
        10_000 * ALPACA_SEC_FEE_RATE_ON_SELLS +
        100 * ALPACA_FINRA_TAF_PER_SHARE_ON_SELLS,
      10,
    );
  });

  it('caps the FINRA TAF per trade', () => {
    const shares = 1_000_000;
    const fee = alpacaRegulatoryFees({ side: 'sell', notional: 1, shares, halfSpreadBps: 0 });
    expect(fee).toBeCloseTo(
      shares * ALPACA_CAT_FEE_PER_SHARE +
        1 * ALPACA_SEC_FEE_RATE_ON_SELLS +
        ALPACA_FINRA_TAF_MAX_PER_TRADE,
      6,
    );
  });
});

describe('alpacaFillCost', () => {
  it('accepts a zero notional and zero shares and rejects negatives', () => {
    expect(alpacaFillCost({ side: 'buy', notional: 0, shares: 0, halfSpreadBps: 1 })).toBe(0);
    expect(() =>
      alpacaFillCost({ side: 'buy', notional: -1, shares: 0, halfSpreadBps: 1 }),
    ).toThrow(/>= 0/);
    expect(() =>
      alpacaFillCost({ side: 'buy', notional: 1, shares: -1, halfSpreadBps: 1 }),
    ).toThrow(/>= 0/);
  });

  it('has no commission: half spread plus regulatory fees only', () => {
    const fill = { side: 'sell' as const, notional: 10_000, shares: 100, halfSpreadBps: 2 };
    expect(alpacaFillCost(fill)).toBeCloseTo(2 + alpacaRegulatoryFees(fill));
  });
});
