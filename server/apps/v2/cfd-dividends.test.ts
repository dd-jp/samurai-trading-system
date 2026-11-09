import type { MarketData, Position, V2Bar, Venue } from '../../../contracts/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  CFD_DIVIDEND_LONG_WITHHOLDING,
  CFD_DIVIDEND_MAX_SHARE_OF_RAW_CLOSE,
  type CfdDividendSource,
  dividendWindow,
  type HeldDividendInputs,
  heldDividends,
  SqliteCfdDividends,
} from './cfd-dividends.js';
import { parseDividendsBody } from './data/eodhd-client.js';
import {
  addDays,
  type ConvertibleCurrency,
  type DividendsRead,
  dividendsAcross,
} from './data/index.js';

const USD_PER_GBP = 1.25;
const EUR_PER_GBP = 1.16;

function withEur(currency: ConvertibleCurrency): number {
  if (currency === 'EUR') return EUR_PER_GBP;
  return currency === 'USD' ? USD_PER_GBP : 1;
}

function dailyBars(splitOn?: string, rawClose = 20): MarketData['barsBefore'] {
  return (_instrument, tradingDate, count) =>
    Array.from({ length: count }, (_, back) => {
      const date = addDays(tradingDate, back - count);
      const raw = splitOn !== undefined && date < splitOn ? 2 * rawClose : rawClose;
      return { date, open: 20, high: 20, low: 20, close: 20, volume: 1, rawClose: raw };
    }) as V2Bar[];
}

function market(
  splitOn?: string,
  rawClose?: number,
): Pick<MarketData, 'lastBarBefore' | 'barsBefore'> {
  const barsBefore = dailyBars(splitOn, rawClose);
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
    lastMarkDate: '2026-06-04',
    market: market(),
    source: source([{ exDate: '2026-06-04', perShare: 0.02, currency: 'GBP' }]),
    fxFor: (currency) => (currency === 'USD' ? USD_PER_GBP : 1),
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
      source: source([{ exDate: '2026-06-04', perShare: 0.26, currency: 'USD' }]),
    });
    expect(us[0]).toBeCloseTo((100 * 0.26 * 0.7) / USD_PER_GBP, 12);
  });

  it('debits a short the gross on both venues', () => {
    expect(amounts({ held: position('saxo_cfd_gbp', -100) })).toEqual([-2]);
    const us = heldDividends(
      inputs({
        held: position('saxo_cfd_usd', -100),
        source: source([{ exDate: '2026-06-04', perShare: 0.26, currency: 'USD' }]),
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
        declared_per_share: 0.02,
        declared_currency: 'GBP',
        fx_declared_per_gbp: 1,
      },
    ]);
  });

  it('entitles a position booked by the cycle on the ex-date and not one booked the day after', () => {
    const exDate = { tradingDate: '2026-06-05', lastMarkDate: undefined };
    expect(amounts({ ...exDate, held: position('saxo_cfd_gbp', 100, '2026-06-04') })).toEqual([2]);
    expect(amounts({ ...exDate, held: position('saxo_cfd_gbp', 100, '2026-06-05') })).toEqual([]);
  });

  it('opens the window at the booking date when the book last marked before the position opened', () => {
    const dividends = [
      { exDate: '2026-06-03', perShare: 0.01, currency: 'GBP' },
      { exDate: '2026-06-05', perShare: 0.02, currency: 'GBP' },
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

  it('books the one ex-date after the bar the last mark took, through the bar marked now, once', () => {
    const dividends = [
      { exDate: '2026-06-02', perShare: 0.01, currency: 'GBP' },
      { exDate: '2026-06-03', perShare: 0.02, currency: 'GBP' },
      { exDate: '2026-06-04', perShare: 0.04, currency: 'GBP' },
      { exDate: '2026-06-05', perShare: 0.08, currency: 'GBP' },
    ];
    expect(amounts({ source: source(dividends) })).toEqual([4]);
    expect(amounts({ source: source(dividends), booked: (date) => date === '2026-06-04' })).toEqual(
      [],
    );
  });

  it('refuses every unbooked ex-date in a window of more than one session as unverifiable', () => {
    const dividends = [
      { exDate: '2026-06-02', perShare: 0.01, currency: 'GBP' },
      { exDate: '2026-06-03', perShare: 0.02, currency: 'GBP' },
      { exDate: '2026-06-04', perShare: 0.04, currency: 'GBP' },
    ];
    const result = heldDividends(
      inputs({
        lastMarkDate: '2026-06-02',
        source: source(dividends),
        booked: (date) => date === '2026-06-03',
      }),
    );
    expect(result).toEqual({
      bookings: [],
      refused: [],
      implausible: [],
      unverifiable: [
        'ex-date 2026-06-02 falls in a window from 2026-06-01 through 2026-06-04 of more than one session',
        'ex-date 2026-06-04 falls in a window from 2026-06-01 through 2026-06-04 of more than one session',
      ],
    });
  });

  it('reads a window with no bar between the last mark and the bar marked now as one session', () => {
    const daily = market();
    const gapped: Pick<MarketData, 'lastBarBefore' | 'barsBefore'> = {
      ...daily,
      lastBarBefore: (instrument, date) =>
        daily.lastBarBefore(instrument, date === '2026-06-04' ? '2026-06-03' : date),
    };
    expect(
      heldDividends(inputs({ lastMarkDate: '2026-06-03', market: gapped })).bookings,
    ).toMatchObject([{ ex_date: '2026-06-04', amount_gbp: 2 }]);
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
      { exDate: '2026-06-04', perShare: 0.02, currency: 'GBP' },
      { exDate: '2026-06-04', perShare: 0.5, currency: 'GBP' },
    ];
    expect(amounts({ source: source(both) })).toEqual([52]);
  });

  it('converts a line declared in another quote currency into the position quote at the mark FX', () => {
    const usdOnLse = heldDividends(
      inputs({ source: source([{ exDate: '2026-06-04', perShare: 0.5, currency: 'USD' }]) }),
    );
    expect(usdOnLse).toMatchObject({
      bookings: [
        {
          per_share_native: 0.5 / USD_PER_GBP,
          fx_quote_per_gbp: 1,
          amount_gbp: 50 / USD_PER_GBP,
          declared_per_share: 0.5,
          declared_currency: 'USD',
          fx_declared_per_gbp: USD_PER_GBP,
        },
      ],
      refused: [],
    });
    const [gbpOnUs] = heldDividends(
      inputs({
        held: position('saxo_cfd_usd', 100),
        source: source([{ exDate: '2026-06-04', perShare: 0.4, currency: 'GBP' }]),
      }),
    ).bookings;
    expect(gbpOnUs?.fx_quote_per_gbp).toBe(USD_PER_GBP);
    expect(gbpOnUs?.per_share_native).toBeCloseTo(0.4 * USD_PER_GBP, 12);
    expect(gbpOnUs?.amount_gbp).toBeCloseTo(100 * 0.4 * 0.7, 12);
    expect(gbpOnUs).toMatchObject({
      declared_per_share: 0.4,
      declared_currency: 'GBP',
      fx_declared_per_gbp: 1,
    });
  });

  it('keeps a line declared in the position quote exactly, with no round trip through GBP', () => {
    const [usdOnUs] = heldDividends(
      inputs({
        held: position('saxo_cfd_usd', 100),
        fxFor: (currency) => (currency === 'USD' ? 1.3 : 1),
        source: source([{ exDate: '2026-06-04', perShare: 0.123, currency: 'USD' }]),
      }),
    ).bookings;
    expect(usdOnUs).toMatchObject({
      per_share_native: 0.123,
      declared_per_share: 0.123,
      declared_currency: 'USD',
      fx_declared_per_gbp: 1.3,
      fx_quote_per_gbp: 1.3,
    });
  });

  it('sums the declared lines of one ex-date in one currency and declares none across two', () => {
    const declared = (...currencies: string[]) =>
      heldDividends(
        inputs({
          fxFor: withEur,
          source: source(
            currencies.map((currency, index) => ({
              exDate: '2026-06-04',
              perShare: 0.25 * (index + 1),
              currency,
            })),
          ),
        }),
      ).bookings.map(
        ({ per_share_native, declared_per_share, declared_currency, fx_declared_per_gbp }) => ({
          per_share_native,
          declared_per_share,
          declared_currency,
          fx_declared_per_gbp,
        }),
      );
    expect(declared('EUR', 'EUR')).toEqual([
      {
        per_share_native: 0.25 / EUR_PER_GBP + 0.5 / EUR_PER_GBP,
        declared_per_share: 0.75,
        declared_currency: 'EUR',
        fx_declared_per_gbp: EUR_PER_GBP,
      },
    ]);
    expect(declared('GBP', 'USD')).toEqual([
      {
        per_share_native: 0.25 + 0.5 / USD_PER_GBP,
        declared_per_share: null,
        declared_currency: null,
        fx_declared_per_gbp: null,
      },
    ]);
    expect(declared('USD', 'GBP', 'USD')).toMatchObject([{ declared_currency: null }]);
  });

  it('refuses only a line no year-start fix converts and books the rest', () => {
    const result = heldDividends(
      inputs({
        fxFor: withEur,
        source: source([
          { exDate: '2026-06-04', perShare: 0.01, currency: '' },
          { exDate: '2026-06-04', perShare: 0.02, currency: 'GBP' },
          { exDate: '2026-06-04', perShare: 0.03, currency: 'CHF' },
          { exDate: '2026-06-04', perShare: 0.04, currency: 'eur' },
        ]),
      }),
    );
    expect(result.bookings.map((booking) => [booking.ex_date, booking.amount_gbp])).toEqual([
      ['2026-06-04', 2],
    ]);
    expect(result.refused).toEqual([
      'ex-date 2026-06-04 declared in no currency',
      'ex-date 2026-06-04 declared in CHF',
      'ex-date 2026-06-04 declared in eur',
    ]);
  });

  it('converts a EUR line at the year-start GBP/EUR into either position quote (#2170)', () => {
    const eur = source([{ exDate: '2026-06-04', perShare: 0.58, currency: 'EUR' }]);
    const onLse = heldDividends(inputs({ fxFor: withEur, source: eur }));
    expect(onLse.refused).toEqual([]);
    expect(onLse.bookings).toHaveLength(1);
    expect(onLse.bookings[0]?.per_share_native).toBeCloseTo(0.58 / EUR_PER_GBP, 12);
    expect(onLse.bookings[0]?.fx_quote_per_gbp).toBe(1);
    expect(onLse.bookings[0]?.amount_gbp).toBeCloseTo(50, 12);
    expect(onLse.bookings[0]).toMatchObject({
      declared_per_share: 0.58,
      declared_currency: 'EUR',
      fx_declared_per_gbp: EUR_PER_GBP,
    });
    const [onUs] = heldDividends(
      inputs({ fxFor: withEur, source: eur, held: position('saxo_cfd_usd', -100) }),
    ).bookings;
    expect(onUs?.per_share_native).toBeCloseTo((0.58 * USD_PER_GBP) / EUR_PER_GBP, 12);
    expect(onUs?.fx_quote_per_gbp).toBe(USD_PER_GBP);
    expect(onUs?.amount_gbp).toBeCloseTo(-50, 12);
    expect(onUs).toMatchObject({ declared_per_share: 0.58, fx_declared_per_gbp: EUR_PER_GBP });
  });

  it('asks for a fix only for the currencies it converts, and throws when one is missing', () => {
    const asked: string[] = [];
    const noFix = (currency: string) => {
      asked.push(currency);
      if (currency !== 'GBP') throw new Error(`fx: no ${currency} fix on or before 2026-01-01`);
      return 1;
    };
    expect(amounts({ fxFor: noFix })).toEqual([2]);
    expect(asked).not.toContain('EUR');
    for (const currency of ['USD', 'EUR']) {
      expect(() =>
        heldDividends(
          inputs({
            fxFor: noFix,
            source: source([{ exDate: '2026-06-04', perShare: 0.5, currency }]),
          }),
        ),
      ).toThrow(`fx: no ${currency} fix`);
    }
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

  it('stops at an ex-date a split in the window precedes', () => {
    const result = heldDividends(
      inputs({
        market: market('2026-06-04'),
        source: source([{ exDate: '2026-06-04', perShare: 0.01, currency: 'GBP' }]),
      }),
    );
    expect(result.bookings).toEqual([]);
    expect(result.splitBefore).toBe('2026-06-04');
  });

  it('ignores a split the last mark already took, on a bar before the window opens', () => {
    const result = heldDividends(
      inputs({ market: sparseMarket(['2026-06-01', '2026-06-02', '2026-06-04'], '2026-06-02') }),
    );
    expect(result.splitBefore).toBeUndefined();
    expect(result.bookings).toMatchObject([{ ex_date: '2026-06-04', amount_gbp: 2 }]);
  });

  it('opens no window when no bar bounds its start or its end', () => {
    const fromJune4 = sparseMarket(['2026-06-04']);
    expect(
      dividendWindow(
        inputs({
          lastMarkDate: undefined,
          held: position('saxo_cfd_gbp', 100, '2026-06-04'),
          market: fromJune4,
        }),
      ),
    ).toBeUndefined();
    const daily = market();
    const noBarMarkedNow: Pick<MarketData, 'lastBarBefore' | 'barsBefore'> = {
      ...daily,
      lastBarBefore: (instrument, date) =>
        date === '2026-06-05' ? undefined : daily.lastBarBefore(instrument, date),
    };
    expect(dividendWindow(inputs({ market: noBarMarkedNow }))).toBeUndefined();
  });
});

function sparseMarket(
  dates: readonly string[],
  splitOn?: string,
): Pick<MarketData, 'lastBarBefore' | 'barsBefore'> {
  const bars = dates.map(
    (date) =>
      ({
        date,
        open: 20,
        high: 20,
        low: 20,
        close: 20,
        volume: 1,
        rawClose: splitOn !== undefined && date < splitOn ? 40 : 20,
      }) as V2Bar,
  );
  const barsBefore: MarketData['barsBefore'] = (_instrument, tradingDate, count) =>
    bars.filter((bar) => bar.date < tradingDate).slice(-count);
  return { barsBefore, lastBarBefore: (instrument, date) => barsBefore(instrument, date, 1)[0] };
}

// GET /api/div/VOD.LSE?fmt=json per EODHD's dividends documentation: one line declared GBX and one
// declaring the same pence amount as GBP, on a name whose ex-date close is 75p
const VOD_LSE_DIV_BODY = [
  {
    date: '2026-06-03',
    declarationDate: '2026-05-14',
    recordDate: '2026-06-04',
    paymentDate: '2026-08-01',
    period: 'Final',
    value: 4.5,
    unadjustedValue: 4.5,
    currency: 'GBX',
  },
  {
    date: '2026-06-04',
    declarationDate: '2026-05-14',
    recordDate: '2026-06-05',
    paymentDate: '2026-08-01',
    period: 'Final',
    value: 4.5,
    unadjustedValue: 4.5,
    currency: 'GBP',
  },
];

describe('CFD dividend plausibility bound', () => {
  function bounded(perShare: number) {
    return heldDividends(
      inputs({ source: source([{ exDate: '2026-06-04', perShare, currency: 'GBP' }]) }),
    );
  }

  it('books a dividend at a quarter of the ex-date raw close and refuses one above it', () => {
    expect(CFD_DIVIDEND_MAX_SHARE_OF_RAW_CLOSE).toBe(0.25);
    expect(bounded(5)).toMatchObject({ bookings: [{ amount_gbp: 500 }], implausible: [] });
    expect(bounded(5.01)).toEqual({
      bookings: [],
      refused: [],
      unverifiable: [],
      implausible: [
        'ex-date 2026-06-04 pays 5.01 GBP a share, over 25% of the 2026-06-04 raw close 20',
      ],
    });
  });

  it('books the GBX line of an EODHD body as pounds and refuses the pence amount labelled GBP', () => {
    const dividends = parseDividendsBody(VOD_LSE_DIV_BODY, 'VOD.LSE', {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const atClose = (tradingDate: string) =>
      heldDividends(
        inputs({
          tradingDate,
          lastMarkDate: addDays(tradingDate, -1),
          market: market(undefined, 0.75),
          source: source(dividends),
        }),
      );
    const gbx = atClose('2026-06-04');
    const result = { bookings: gbx.bookings, implausible: atClose('2026-06-05').implausible };
    expect(
      result.bookings.map(({ ex_date, per_share_native, amount_gbp }) => ({
        ex_date,
        per_share_native,
        amount_gbp,
      })),
    ).toEqual([{ ex_date: '2026-06-03', per_share_native: 0.045, amount_gbp: 4.5 }]);
    expect(result.implausible).toEqual([
      'ex-date 2026-06-04 pays 4.5 GBP a share, over 25% of the 2026-06-04 raw close 0.75',
    ]);
  });

  it('bounds a line converted from another currency in the position quote', () => {
    const usd = (perShare: number) =>
      heldDividends(
        inputs({ source: source([{ exDate: '2026-06-04', perShare, currency: 'USD' }]) }),
      );
    expect(usd(6.25).bookings).toHaveLength(1);
    expect(usd(6.26).implausible).toHaveLength(1);
  });

  it('refuses a line with no bar on or before its ex-date to bound it', () => {
    const base = market();
    const result = heldDividends(
      inputs({
        tradingDate: '2026-06-06',
        market: {
          ...base,
          lastBarBefore: (instrument, date) =>
            date === '2026-06-05' ? undefined : base.lastBarBefore(instrument, date),
        },
      }),
    );
    expect(result).toEqual({
      bookings: [],
      refused: [],
      unverifiable: [],
      implausible: ['ex-date 2026-06-04 has no bar to bound its amount'],
    });
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

  it('records the declared line beside the quoted one, or none of it', () => {
    const db = migratedMemoryStore();
    const ledger = new SqliteCfdDividends(db, { now: () => new Date('2026-06-05T06:30:00Z') });
    const [usd] = heldDividends(
      inputs({ source: source([{ exDate: '2026-06-04', perShare: 0.5, currency: 'USD' }]) }),
    ).bookings;
    if (usd === undefined) throw new Error('no booking');
    ledger.record(usd);
    ledger.record({
      ...usd,
      ex_date: '2026-06-03',
      declared_per_share: null,
      declared_currency: null,
      fx_declared_per_gbp: null,
    });
    expect(
      db
        .prepare(
          `SELECT ex_date, per_share_native, declared_per_share, declared_currency,
             fx_declared_per_gbp FROM v2_cfd_dividends ORDER BY ex_date`,
        )
        .all(),
    ).toEqual([
      {
        ex_date: '2026-06-03',
        per_share_native: 0.5 / USD_PER_GBP,
        declared_per_share: null,
        declared_currency: null,
        fx_declared_per_gbp: null,
      },
      {
        ex_date: '2026-06-04',
        per_share_native: 0.5 / USD_PER_GBP,
        declared_per_share: 0.5,
        declared_currency: 'USD',
        fx_declared_per_gbp: USD_PER_GBP,
      },
    ]);
  });
});
