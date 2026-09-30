import { describe, expect, it } from 'vitest';
import type { Position, Venue } from '../../../../contracts/index.js';
import { type CfdCarryRates, cfdCarryAccrual } from './cfd-carry.js';

function held(instrument: string, venue: Venue, qty: number, avgPriceGbp = 100): Position {
  return {
    instrument,
    venue,
    qty,
    avgPriceGbp,
    stopGbp: undefined,
    targetGbp: undefined,
    clientOrderId: `c-${instrument}`,
    exitClientOrderId: undefined,
    openedDate: '2026-09-25',
    marksHeld: 0,
    stray: false,
    splitFactor: 1,
    splitAnchorDate: undefined,
  };
}

const RATES: CfdCarryRates = {
  financing: {
    dailyRate: (venue, side) =>
      ({ long: 0.001, short: 0.0005 })[side] * (venue === 'saxo_cfd_usd' ? 2 : 1),
  },
  borrow: { dailyRate: (venue, quoted) => (quoted ?? 0.01) * (venue === 'saxo_cfd_usd' ? 2 : 1) },
  quotedBorrowPerDay: (instrument) => ({ AAPL: 0.0001, ISF: 0.0003 })[instrument],
};

const mark = (price: number | undefined) => () => price;

describe('cfdCarryAccrual', () => {
  it('charges a long financing on its marked notional per calendar day and no borrow', () => {
    expect(cfdCarryAccrual([held('VOD', 'saxo_cfd_gbp', 3)], mark(50), 2, RATES)).toEqual({
      financingGbp: 3 * 50 * 0.001 * 2,
      borrowGbp: 0,
    });
  });

  it('charges a short the short financing rate and its own name borrow on absolute notional', () => {
    const carry = cfdCarryAccrual([held('AAPL', 'saxo_cfd_usd', -4)], mark(25), 3, RATES);
    expect(carry.financingGbp).toBeCloseTo(4 * 25 * 0.0005 * 2 * 3, 12);
    expect(carry.borrowGbp).toBeCloseTo(4 * 25 * 0.0001 * 2 * 3, 12);
  });

  it('reads borrow by name, passing an unquoted name through to the model', () => {
    const carry = cfdCarryAccrual(
      [held('ISF', 'saxo_cfd_gbp', -1), held('ZZZ', 'saxo_cfd_gbp', -1)],
      mark(100),
      1,
      RATES,
    );
    expect(carry.borrowGbp).toBeCloseTo(100 * 0.0003 + 100 * 0.01, 12);
  });

  it('skips cash venues and marks an unpriced CFD at its average price', () => {
    const carry = cfdCarryAccrual(
      [held('AAPL', 'alpaca', 5), held('CSP1', 'saxo', 5), held('VOD', 'saxo_cfd_gbp', 2, 40)],
      mark(undefined),
      1,
      RATES,
    );
    expect(carry).toEqual({ financingGbp: 2 * 40 * 0.001, borrowGbp: 0 });
  });

  it('accrues nothing over zero days or with no rates wired', () => {
    const positions = [held('AAPL', 'saxo_cfd_usd', -1)];
    expect(cfdCarryAccrual(positions, mark(100), 0, RATES)).toEqual({
      financingGbp: 0,
      borrowGbp: 0,
    });
    expect(cfdCarryAccrual(positions, mark(100), 5, undefined)).toEqual({
      financingGbp: 0,
      borrowGbp: 0,
    });
  });
});
