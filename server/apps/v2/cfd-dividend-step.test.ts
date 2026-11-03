import type { MarketData, Position, V2Bar, Venue } from '../../../contracts/index.js';
import { bookCfdDividends, type CfdDividendStepDeps } from './cfd-dividend-step.js';
import type { CfdDividendBooking } from './cfd-dividends.js';
import { addDays, dividendsAcross } from './data/index.js';
import type { CfdDividendFeed, DividendRequest } from './dividend-feed.js';

const USD_PER_GBP = 1.25;

const MARKET: Pick<MarketData, 'lastBarBefore' | 'barsBefore'> = {
  barsBefore: (_instrument, tradingDate, count) =>
    Array.from({ length: count }, (_, back) => {
      const date = addDays(tradingDate, back - count);
      return { date, open: 20, high: 20, low: 20, close: 20, volume: 1, rawClose: 20 };
    }) as V2Bar[],
  lastBarBefore: (_instrument, date) => ({
    date: addDays(date, -1),
    open: 20,
    high: 20,
    low: 20,
    close: 20,
    volume: 1,
    rawClose: 20,
  }),
};

function position(instrument: string, venue: Venue, qty: number): Position {
  return {
    instrument,
    venue,
    qty,
    avgPriceGbp: 20,
    stopGbp: undefined,
    targetGbp: undefined,
    clientOrderId: `entry-${instrument}`,
    exitClientOrderId: undefined,
    openedDate: '2026-05-20',
    marksHeld: 1,
    stray: false,
    splitFactor: 1,
    splitAnchorDate: undefined,
  };
}

const HELD = [
  position('VOD_XLON', 'saxo_cfd_gbp', 100),
  position('AAPL', 'saxo_cfd_usd', -10),
  position('VUSA', 'saxo', 50),
];

function feed(requests: DividendRequest[][] = [], lseCurrency = 'GBP'): CfdDividendFeed {
  return {
    refresh: (asked) => {
      requests.push([...asked]);
      return Promise.resolve();
    },
    across: (instrument, _exchange, window) => {
      const perShare = instrument === 'AAPL' ? 0.26 : 0.02;
      const currency = instrument === 'AAPL' ? 'USD' : lseCurrency;
      const read = { symbol: instrument, from: '2026-01-01', to: '2026-12-31', asOf: '2027-01-01' };
      const dividends = [{ exDate: '2026-06-04', perShare, currency }];
      return dividendsAcross([{ ...read, dividends }], window.after, window.through);
    },
  };
}

function deps(overrides: Partial<CfdDividendStepDeps> = {}) {
  const cash: [string, number][] = [];
  const recorded: CfdDividendBooking[] = [];
  const step: CfdDividendStepDeps = {
    books: {
      positions: () => HELD,
      lastDay: () =>
        ({ tradingDate: '2026-06-03' }) as ReturnType<CfdDividendStepDeps['books']['lastDay']>,
      applyCashAdjustment: (bookId, amount) => {
        cash.push([bookId, amount]);
      },
    },
    bookIds: ['debate-primary'],
    market: MARKET,
    feed: feed(),
    ledger: { booked: () => false, record: (booking) => recorded.push(booking) },
    tradingDate: '2026-06-05',
    fxFor: (currency) => (currency === 'USD' ? USD_PER_GBP : 1),
    atomically: (work) => work(),
    ...overrides,
  };
  return { step, cash, recorded };
}

describe('bookCfdDividends', () => {
  it('asks the feed for each held CFD window, then books the cash and records it together', async () => {
    const requests: DividendRequest[][] = [];
    const { step, cash, recorded } = deps({ feed: feed(requests) });
    const report = await bookCfdDividends(step);
    expect(requests).toEqual([
      [
        { instrument: 'VOD_XLON', exchange: 'LSE', after: '2026-06-02', through: '2026-06-04' },
        { instrument: 'AAPL', exchange: 'US', after: '2026-06-02', through: '2026-06-04' },
      ],
    ]);
    expect(cash).toEqual([
      ['debate-primary', 2],
      ['debate-primary', (-10 * 0.26) / USD_PER_GBP],
    ]);
    expect(recorded.map((booking) => booking.instrument)).toEqual(['VOD_XLON', 'AAPL']);
    expect(report.booked).toEqual(recorded);
    expect(report.unmodelled).toEqual([]);
    expect(report.refused).toEqual([]);
  });

  it('converts a USD line on an LSE CFD at the mark FX and reports a line in EUR as refused', async () => {
    const usd = deps({ feed: feed([], 'USD') });
    await bookCfdDividends(usd.step);
    expect(usd.cash).toEqual([
      ['debate-primary', 2 / USD_PER_GBP],
      ['debate-primary', (-10 * 0.26) / USD_PER_GBP],
    ]);
    const eur = deps({ feed: feed([], 'EUR') });
    const report = await bookCfdDividends(eur.step);
    expect(eur.recorded.map((booking) => booking.instrument)).toEqual(['AAPL']);
    expect(report.refused).toEqual([
      {
        bookId: 'debate-primary',
        instrument: 'VOD_XLON',
        detail: 'ex-date 2026-06-04 declared in EUR',
      },
    ]);
    expect(report.unread).toEqual([]);
  });

  it('names every held CFD, and only those, as unmodelled when there is no feed', async () => {
    const { step, cash } = deps({ feed: undefined });
    const report = await bookCfdDividends(step);
    expect(report.unmodelled).toEqual([
      { bookId: 'debate-primary', instrument: 'VOD_XLON', detail: 'no feed' },
      { bookId: 'debate-primary', instrument: 'AAPL', detail: 'no feed' },
    ]);
    expect(cash).toEqual([]);
  });

  it('reports a position whose window the feed cannot vouch for as unread', async () => {
    const unread: CfdDividendFeed = {
      refresh: () => Promise.resolve(),
      across: () => ({ kind: 'uncovered', from: '2026-06-03' }),
    };
    const { step, cash } = deps({ feed: unread });
    const report = await bookCfdDividends(step);
    expect(report.unread.map((entry) => entry.instrument)).toEqual(['VOD_XLON', 'AAPL']);
    expect(cash).toEqual([]);
  });

  it('leaves the cash unbooked when recording the booking fails', async () => {
    const cash: number[] = [];
    const { step } = deps({
      ledger: {
        booked: () => false,
        record: () => {
          throw new Error('constraint');
        },
      },
      atomically: (work) => {
        const before = cash.length;
        try {
          return work();
        } catch (error) {
          cash.length = before;
          throw error;
        }
      },
    });
    const books = {
      ...step.books,
      applyCashAdjustment: (_: string, amount: number) => cash.push(amount),
    };
    await expect(bookCfdDividends({ ...step, books })).rejects.toThrow('constraint');
    expect(cash).toEqual([]);
  });
});
