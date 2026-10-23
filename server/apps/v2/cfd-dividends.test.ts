import type { MarketData, Position, V2Bar, Venue } from '../../../contracts/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  CFD_DIVIDEND_LONG_WITHHOLDING,
  type CfdDividendSource,
  dividendWindow,
  type HeldDividendInputs,
  heldDividends,
  SqliteCfdDividends,
} from './cfd-dividends.js';
import { addDays, type DividendsRead, dividendsAcross } from './data/index.js';

const USD_PER_GBP = 1.25;

function dailyBars(splitOn?: string): MarketData['barsBefore'] {
  return (_instrument, tradingDate, count) =>
    Array.from({ length: count }, (_, back) => {
      const date = addDays(tradingDate, back - count);
      const raw = splitOn !== undefined && date < splitOn ? 40 : 20;
      return { date, open: 20, high: 20, low: 20, close: 20, volume: 1, rawClose: raw };
    }) as V2Bar[];
}

function market(splitOn?: string): Pick<MarketData, 'lastBarBefore' | 'barsBefore'> {
  const barsBefore = dailyBars(splitOn);
  return { barsBefore, lastBarBefore: (instrument, date) => barsBefore(instrument, date, 1)[0] };
}

function position(venue: Venue, qty: number, openedDate = '2026-05-20'): Position {
  return {
    instrument: venue === 'saxo_cfd_usd' || venue === 'alpaca' ? 'AAPL' : 'VOD_XLON',
    venue,
    qty,
    avgPriceGbp: 20,
    stopGbp: undefined,
    targetGbp: undefined,
    clientOrderId: 'entry-1',
    exitClientOrderId: undefined,
    openedDate,
    marksHeld: 1,
    stray: false,
    splitFactor: 1,
    splitAnchorDate: undefined,
  };
}

function source(dividends: DividendsRead['dividends'], seen: string[] = []): CfdDividendSource {
  return {
    across: (instrument, _exchange, window) => {
      seen.push(instrument);
      const read = { symbol: instrument, from: '2026-01-01', to: '2026-12-31', asOf: '2027-01-01' };
      return dividendsAcross([{ ...read, dividends }], window.after, window.through);
    },
  };
}

function inputs(overrides: Partial<HeldDividendInputs>): HeldDividendInputs {
  return {
    bookId: 'debate-primary',
    held: position('saxo_cfd_gbp', 100),
    tradingDate: '2026-06-05',
    lastMarkDate: '2026-06-03',
    market: market(),
    source: source([{ exDate: '2026-06-04', perShare: 0.02 }]),
    fxQuotePerGbp: 1,
    booked: () => false,
    ...overrides,
  };
}

function amounts(overrides: Partial<HeldDividendInputs>): number[] {
  return heldDividends(inputs(overrides)).bookings.map((booking) => booking.amount_gbp);
}

describe('CFD dividend booking rule', () => {
  it('pays an LSE long the gross and a US long the gross less 30%, at the mark FX', () => {
    expect(CFD_DIVIDEND_LONG_WITHHOLDING).toEqual({ LSE: 0, US: 0.3 });
    expect(amounts({})).toEqual([2]);
    const us = amounts({
      held: position('saxo_cfd_usd', 100),
      source: source([{ exDate: '2026-06-04', perShare: 0.26 }]),
      fxQuotePerGbp: USD_PER_GBP,
    });
    expect(us[0]).toBeCloseTo((100 * 0.26 * 0.7) / USD_PER_GBP, 12);
  });

  it('debits a short the gross on both venues', () => {
    expect(amounts({ held: position('saxo_cfd_gbp', -100) })).toEqual([-2]);
    const us = heldDividends(
      inputs({
        held: position('saxo_cfd_usd', -100),
        source: source([{ exDate: '2026-06-04', perShare: 0.26 }]),
        fxQuotePerGbp: USD_PER_GBP,
      }),
    ).bookings;
    expect(us.map(({ withholding, amount_gbp }) => ({ withholding, amount_gbp }))).toEqual([
      { withholding: 0, amount_gbp: (-100 * 0.26) / USD_PER_GBP },
    ]);
  });

  it('leaves a position held outright untouched without asking the source', () => {
    for (const venue of ['saxo', 'alpaca'] as const) {
      const seen: string[] = [];
      expect(
        heldDividends(inputs({ held: position(venue, 100), source: source([], seen) })),
      ).toEqual({ bookings: [] });
      expect(seen).toEqual([]);
    }
  });

  it('records the booking with the cycle date, the ex-date and the inputs the cash came from', () => {
    expect(heldDividends(inputs({})).bookings).toEqual([
      {
        book_id: 'debate-primary',
        trading_date: '2026-06-05',
        instrument: 'VOD_XLON',
        venue: 'saxo_cfd_gbp',
        client_order_id: 'entry-1',
        ex_date: '2026-06-04',
        qty: 100,
        per_share_native: 0.02,
        withholding: 0,
        fx_quote_per_gbp: 1,
        amount_gbp: 2,
      },
    ]);
  });

  it('entitles a position booked by the cycle on the ex-date and not one booked the day after', () => {
    const exDate = { tradingDate: '2026-06-06', lastMarkDate: undefined };
    expect(amounts({ ...exDate, held: position('saxo_cfd_gbp', 100, '2026-06-04') })).toEqual([2]);
    expect(amounts({ ...exDate, held: position('saxo_cfd_gbp', 100, '2026-06-05') })).toEqual([]);
  });

  it('opens the window at the booking date when the book last marked before the position opened', () => {
    const dividends = [
      { exDate: '2026-06-03', perShare: 0.01 },
      { exDate: '2026-06-05', perShare: 0.02 },
    ];
    expect(
      amounts({
        tradingDate: '2026-06-06',
        lastMarkDate: '2026-06-01',
        held: position('saxo_cfd_gbp', 100, '2026-06-05'),
        source: source(dividends),
      }),
    ).toEqual([2]);
  });

  it('books each ex-date once, after the bar the last mark took and through the bar marked now', () => {
    const dividends = [
      { exDate: '2026-06-02', perShare: 0.01 },
      { exDate: '2026-06-03', perShare: 0.02 },
      { exDate: '2026-06-04', perShare: 0.04 },
      { exDate: '2026-06-05', perShare: 0.08 },
    ];
    expect(amounts({ source: source(dividends) })).toEqual([2, 4]);
    expect(amounts({ source: source(dividends), booked: (date) => date === '2026-06-03' })).toEqual(
      [4],
    );
  });

  it('opens no window when the last mark already took the bar this cycle marks', () => {
    const seen: string[] = [];
    expect(dividendWindow(inputs({ lastMarkDate: '2026-06-05' }))).toBeUndefined();
    expect(heldDividends(inputs({ lastMarkDate: '2026-06-05', source: source([], seen) }))).toEqual(
      { bookings: [] },
    );
    expect(seen).toEqual([]);
  });

  it('sums a regular and a special dividend on one ex-date into one booking', () => {
    const both = [
      { exDate: '2026-06-04', perShare: 0.02 },
      { exDate: '2026-06-04', perShare: 0.5 },
    ];
    expect(amounts({ source: source(both) })).toEqual([52]);
  });

  it('books nothing and reports why when the source cannot vouch for the window', () => {
    const uncovered: CfdDividendSource = {
      across: () => ({ kind: 'uncovered', from: '2026-06-03' }),
    };
    const conflict: CfdDividendSource = {
      across: () => ({ kind: 'conflict', date: '2026-06-04' }),
    };
    expect(heldDividends(inputs({ source: uncovered }))).toEqual({
      bookings: [],
      unread: 'no dividend read covers 2026-06-03',
    });
    expect(heldDividends(inputs({ source: conflict }))).toEqual({
      bookings: [],
      unread: 'dividend reads disagree on 2026-06-04',
    });
  });

  it('books the ex-dates before a split in the window and stops at the first one after it', () => {
    const result = heldDividends(
      inputs({
        lastMarkDate: '2026-06-01',
        market: market('2026-06-03'),
        source: source([
          { exDate: '2026-06-02', perShare: 0.02 },
          { exDate: '2026-06-03', perShare: 0.01 },
          { exDate: '2026-06-04', perShare: 0.01 },
        ]),
      }),
    );
    expect(result.bookings.map((booking) => booking.ex_date)).toEqual(['2026-06-02']);
    expect(result.splitBefore).toBe('2026-06-03');
  });
});

describe('SqliteCfdDividends', () => {
  it('records a booking with the fills already booked that day and refuses it twice', () => {
    const db = migratedMemoryStore();
    const ledger = new SqliteCfdDividends(db, { now: () => new Date('2026-06-05T06:30:00Z') });
    const [booking] = heldDividends(inputs({})).bookings;
    if (booking === undefined) throw new Error('no booking');
    expect(ledger.booked('debate-primary', 'VOD_XLON', '2026-06-04')).toBe(false);
    ledger.record(booking);
    expect(ledger.booked('debate-primary', 'VOD_XLON', '2026-06-04')).toBe(true);
    expect(ledger.booked('debate-no-macro-gate', 'VOD_XLON', '2026-06-04')).toBe(false);
    expect(db.prepare('SELECT fills_before, amount_gbp FROM v2_cfd_dividends').get()).toEqual({
      fills_before: 0,
      amount_gbp: 2,
    });
    expect(() => ledger.record(booking)).toThrow();
  });
});
