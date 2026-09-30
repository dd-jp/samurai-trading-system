import { describe, expect, it } from 'vitest';
import {
  SAXO_CFD_COMMISSION,
  SAXO_CFD_FINANCING,
  SAXO_CFD_SPREAD,
  saxoCfdBorrow,
} from './cfd-tariff.js';

describe('SAXO_CFD_COMMISSION', () => {
  it.each([
    [1, 10],
    [100, 10],
    [500, 10],
    [501, 10.02],
    [1_000, 20],
    [10_000, 200],
  ])('US CFD: %i shares cost $%s, $0.02 a share over a $10 minimum', (qty, fee) => {
    expect(SAXO_CFD_COMMISSION.fee('saxo_cfd_usd', 'sell', qty, 250)).toBeCloseTo(fee, 12);
    expect(SAXO_CFD_COMMISSION.fee('saxo_cfd_usd', 'buy', qty, 5)).toBeCloseTo(fee, 12);
  });

  it.each([
    [1, 100, 8],
    [80, 100, 8],
    [81, 100, 8.1],
    [1_000, 36.5, 36.5],
  ])('UK CFD: %i at £%s costs £%s, 0.10%% of notional over an £8 minimum', (qty, price, fee) => {
    expect(SAXO_CFD_COMMISSION.fee('saxo_cfd_gbp', 'sell', qty, price)).toBeCloseTo(fee, 12);
    expect(SAXO_CFD_COMMISSION.fee('saxo_cfd_gbp', 'buy', qty, price)).toBeCloseTo(fee, 12);
  });
});

describe('SAXO_CFD_SPREAD', () => {
  it('charges each venue its measured p90 as the half spread', () => {
    expect(SAXO_CFD_SPREAD.halfSpreadBps('saxo_cfd_usd')).toBe(4.48);
    expect(SAXO_CFD_SPREAD.halfSpreadBps('saxo_cfd_gbp')).toBe(30.6);
  });
});

describe('SAXO_CFD_FINANCING', () => {
  it('charges a long the paid rate on its currency day count: USD ACT/360, GBP ACT/365', () => {
    expect(SAXO_CFD_FINANCING.dailyRate('saxo_cfd_usd', 'long')).toBeCloseTo(0.072 / 360, 15);
    expect(SAXO_CFD_FINANCING.dailyRate('saxo_cfd_gbp', 'long')).toBeCloseTo(0.0704 / 365, 15);
  });

  it('credits a short nothing', () => {
    expect(SAXO_CFD_FINANCING.dailyRate('saxo_cfd_usd', 'short')).toBe(0);
    expect(SAXO_CFD_FINANCING.dailyRate('saxo_cfd_gbp', 'short')).toBe(0);
  });
});

describe('saxoCfdBorrow', () => {
  const borrow = saxoCfdBorrow(0.02);

  it("charges the catalogue's quoted per-day rate as is, a quoted zero included", () => {
    expect(borrow.dailyRate('saxo_cfd_usd', 0.0000138889)).toBe(0.0000138889);
    expect(borrow.dailyRate('saxo_cfd_gbp', 0)).toBe(0);
  });

  it('falls back to the ceiling on the currency day count when the name has no quote', () => {
    expect(borrow.dailyRate('saxo_cfd_usd', undefined)).toBeCloseTo(0.02 / 360, 15);
    expect(borrow.dailyRate('saxo_cfd_gbp', undefined)).toBeCloseTo(0.02 / 365, 15);
  });
});
