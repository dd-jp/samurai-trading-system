import { describe, expect, it } from 'vitest';
import {
  buildCfdTaxLog,
  type CfdTaxJournal,
  cfdTaxYearLog,
  cfdTaxYearsOf,
  type TaxCfdBookDayRow,
  type TaxCfdCarryRow,
  type TaxCfdFillRow,
} from './tax-cfd-log.js';
import { buildTaxLog, type DayRate, taxYearLog } from './tax-log.js';

const USD: Readonly<Record<string, number>> = { '2026-05-01': 1.25, '2026-07-01': 1.3 };

const dayRate: DayRate = (currency, date) => {
  if (currency === 'GBP') return { ok: true, quotePerGbp: 1, source: 'gbp' };
  const rate = USD[date];
  return rate === undefined
    ? { ok: false, reason: `no fix for ${date}` }
    : { ok: true, quotePerGbp: rate, source: `boe-xudluss:${date}` };
};

function fill(overrides: Partial<TaxCfdFillRow> & Pick<TaxCfdFillRow, 'fill_id'>): TaxCfdFillRow {
  return {
    book_id: 'debate/primary',
    client_order_id: `order-${overrides.fill_id}`,
    instrument: 'VOD',
    venue: 'saxo_cfd_gbp',
    leg: 'entry',
    side: 'buy',
    qty: 100,
    trading_date: '2026-05-01',
    fill_date: '2026-05-01',
    currency: 'GBP',
    price_native: 0.7,
    fee_native: 3,
    ...overrides,
  };
}

const LONG_GBP = [
  fill({ fill_id: 'vod-open', client_order_id: 'vod-entry' }),
  fill({
    fill_id: 'vod-close',
    leg: 'target',
    side: 'sell',
    price_native: 0.8,
    trading_date: '2026-05-11',
    fill_date: '2026-05-11',
  }),
];

const SHORT_USD = [
  fill({
    fill_id: 'tsla-open',
    client_order_id: 'tsla-entry',
    instrument: 'TSLA',
    venue: 'saxo_cfd_usd',
    side: 'sell',
    qty: 10,
    currency: 'USD',
    price_native: 200,
    fee_native: 2.5,
  }),
  fill({
    fill_id: 'tsla-close',
    instrument: 'TSLA',
    venue: 'saxo_cfd_usd',
    leg: 'stop',
    side: 'buy',
    qty: 10,
    currency: 'USD',
    price_native: 180,
    fee_native: 2.6,
    trading_date: '2026-07-01',
    fill_date: '2026-07-01',
  }),
];

function carry(
  instrument: string,
  clientOrderId: string,
  tradingDate: string,
  financing: number,
  borrow: number,
): TaxCfdCarryRow {
  return {
    book_id: 'debate/primary',
    trading_date: tradingDate,
    instrument,
    client_order_id: clientOrderId,
    financing_gbp: financing,
    borrow_gbp: borrow,
  };
}

const CARRY = [
  carry('VOD', 'vod-entry', '2026-05-04', 0.5, 0),
  carry('TSLA', 'tsla-entry', '2026-05-04', 0.6, 0.4),
  carry('VOD', 'vod-entry', '2026-05-05', 0.25, 0),
  carry('TSLA', 'tsla-entry', '2026-05-05', 0.6, 0.4),
];

function bookDay(tradingDate: string, financing: number, borrow: number): TaxCfdBookDayRow {
  return {
    book_id: 'debate/primary',
    trading_date: tradingDate,
    financing_gbp: financing,
    borrow_gbp: borrow,
  };
}

const BOOK_DAYS = [bookDay('2026-05-04', 1.1, 0.4), bookDay('2026-05-05', 0.85, 0.4)];

function journal(overrides: Partial<CfdTaxJournal> = {}): CfdTaxJournal {
  return {
    fills: [...LONG_GBP, ...SHORT_USD],
    carry: CARRY,
    bookDays: BOOK_DAYS,
    splits: [],
    ...overrides,
  };
}

const VOD_ROW = {
  instrument: 'VOD',
  venue: 'saxo_cfd_gbp',
  direction: 'long',
  open_date: '2026-05-01',
  close_date: '2026-05-11',
  qty: 100,
  currency: 'GBP',
  open_fx_quote_per_gbp: 1,
  close_fx_quote_per_gbp: 1,
  fx_source: 'gbp',
  treatment: 'unconfirmed',
} as const;

const TSLA_ROW = {
  instrument: 'TSLA',
  venue: 'saxo_cfd_usd',
  direction: 'short',
  open_date: '2026-05-01',
  close_date: '2026-07-01',
  qty: 10,
  currency: 'USD',
  open_price_native: 200,
  close_price_native: 180,
  open_fx_quote_per_gbp: 1.25,
  close_fx_quote_per_gbp: 1.3,
  fx_source: 'boe-xudluss:2026-05-01 boe-xudluss:2026-07-01',
  open_value_gbp: 1600,
  treatment: 'unconfirmed',
} as const;

describe('buildCfdTaxLog', () => {
  it('logs a long GBP and a short USD CFD, each at its fill-day rate, with carry and commission as costs', () => {
    const log = buildCfdTaxLog(journal(), dayRate);
    expect(log.heldOut).toEqual([]);
    const [vod, tsla] = log.disposals;
    expect(vod).toMatchObject(VOD_ROW);
    expect(vod?.open_price_native).toBeCloseTo(0.7, 12);
    expect(vod?.close_price_native).toBeCloseTo(0.8, 12);
    expect(vod?.open_value_gbp).toBeCloseTo(70, 9);
    expect(vod?.close_value_gbp).toBeCloseTo(80, 9);
    expect(vod?.realised_pnl_gbp).toBeCloseTo(10, 9);
    expect(vod?.commission_gbp).toBeCloseTo(6, 12);
    expect(vod?.financing_gbp).toBeCloseTo(0.75, 12);
    expect(vod?.borrow_gbp).toBe(0);
    expect(vod?.net_gbp).toBeCloseTo(10 - 6 - 0.75, 9);

    expect(tsla).toMatchObject(TSLA_ROW);
    expect(tsla?.close_value_gbp).toBeCloseTo(1800 / 1.3, 9);
    expect(tsla?.realised_pnl_gbp).toBeCloseTo(1600 - 1800 / 1.3, 9);
    expect(tsla?.commission_gbp).toBeCloseTo(2.5 / 1.25 + 2.6 / 1.3, 12);
    expect(tsla?.financing_gbp).toBeCloseTo(1.2, 12);
    expect(tsla?.borrow_gbp).toBeCloseTo(0.8, 12);
    expect(tsla?.net_gbp).toBeCloseTo(1600 - 1800 / 1.3 - 4 - 1.2 - 0.8, 9);
  });

  it('sums the tax year, unconfirmed, and dates each position by its close', () => {
    const log = buildCfdTaxLog(journal(), dayRate);
    const year = cfdTaxYearLog(log, 2026);
    expect(year.rows).toHaveLength(2);
    expect(year.treatment).toBe('unconfirmed');
    expect(year.realised_pnl_gbp).toBeCloseTo(10 + 1600 - 1800 / 1.3, 9);
    expect(year.commission_gbp).toBeCloseTo(10, 9);
    expect(year.financing_gbp).toBeCloseTo(1.95, 12);
    expect(year.borrow_gbp).toBeCloseTo(0.8, 12);
    expect(year.net_gbp).toBeCloseTo(10 + 1600 - 1800 / 1.3 - 10 - 1.95 - 0.8, 9);
    expect(cfdTaxYearLog(log, 2025)).toEqual({
      rows: [],
      held_out: [],
      realised_pnl_gbp: 0,
      commission_gbp: 0,
      financing_gbp: 0,
      borrow_gbp: 0,
      net_gbp: 0,
      treatment: 'unconfirmed',
    });
    expect(cfdTaxYearsOf(log)).toEqual([2026]);
  });

  it('never touches the share-matching log: its output is the same with or without CFD fills', () => {
    const shares = [
      fill({ fill_id: 'isf-buy', instrument: 'ISF', venue: 'saxo', price_native: 8 }),
      fill({
        fill_id: 'isf-sell',
        instrument: 'ISF',
        venue: 'saxo',
        side: 'sell',
        qty: 40,
        price_native: 9,
        fill_date: '2026-06-01',
      }),
    ];
    const without = buildTaxLog(shares, [], dayRate, '2026-10-01');
    const withCfds = buildTaxLog([...LONG_GBP, ...shares, ...SHORT_USD], [], dayRate, '2026-10-01');
    expect(JSON.stringify(withCfds)).toBe(JSON.stringify(without));
    expect(JSON.stringify(taxYearLog(withCfds, 2026))).toBe(
      JSON.stringify(taxYearLog(without, 2026)),
    );
    expect(buildCfdTaxLog(journal({ fills: shares }), dayRate)).toEqual({
      disposals: [],
      heldOut: [],
    });
  });

  it('logs nothing for a position still open and one row per flat-to-flat round trip', () => {
    const reopened = [
      ...LONG_GBP,
      fill({ fill_id: 'vod-again', trading_date: '2026-06-01', fill_date: '2026-06-01' }),
    ];
    const log = buildCfdTaxLog(journal({ fills: reopened }), dayRate);
    expect(log.disposals.map((row) => row.instrument)).toEqual(['VOD']);
  });

  it('weights prices across partial fills and dates the row by its last close', () => {
    const partial = [
      fill({ fill_id: 'a', client_order_id: 'vod-entry', qty: 60, price_native: 0.7 }),
      fill({ fill_id: 'b', client_order_id: 'vod-entry-2', qty: 40, price_native: 0.75 }),
      fill({ fill_id: 'c', side: 'sell', qty: 50, price_native: 0.8, fill_date: '2026-05-11' }),
      fill({ fill_id: 'd', side: 'sell', qty: 50, price_native: 0.9, fill_date: '2026-05-12' }),
    ];
    const [row] = buildCfdTaxLog(journal({ fills: partial }), dayRate).disposals;
    expect(row?.qty).toBe(100);
    expect(row?.open_price_native).toBeCloseTo(0.72, 12);
    expect(row?.close_price_native).toBeCloseTo(0.85, 12);
    expect(row?.close_date).toBe('2026-05-12');
    expect(row?.commission_gbp).toBeCloseTo(12, 12);
    expect(row?.financing_gbp).toBeCloseTo(0.75, 12);
  });

  it.each([
    [
      'a fill without native capture',
      [fill({ fill_id: 'old', price_native: null }), ...LONG_GBP.slice(1)],
      'fill old predates native price and FX capture (migration 0085)',
    ],
    [
      'a fill crossing flat',
      [LONG_GBP[0] as TaxCfdFillRow, fill({ fill_id: 'flip', side: 'sell', qty: 150 })],
      'fill flip crosses the position through flat',
    ],
    [
      'a fill in a second currency',
      [LONG_GBP[0] as TaxCfdFillRow, fill({ fill_id: 'x', side: 'sell', currency: 'USD' })],
      'fills in more than one currency: GBP, USD',
    ],
  ])('holds the instrument out for %s', (_name, fills, reason) => {
    const log = buildCfdTaxLog(journal({ fills }), dayRate);
    expect(log.disposals).toEqual([]);
    expect(log.heldOut).toEqual([
      { instrument: 'VOD', venue: 'saxo_cfd_gbp', reason, fills: fills.length, taxYears: [2026] },
    ]);
  });

  it('holds a USD CFD out when its fill day has no rate', () => {
    const late = SHORT_USD.map((row) => ({ ...row, fill_date: '2026-09-30' }));
    const log = buildCfdTaxLog(journal({ fills: late }), dayRate);
    expect(log.heldOut[0]?.reason).toBe('fill tsla-open: no fix for 2026-09-30');
  });

  it('holds a name out when two books traded it, since the broker nets them', () => {
    const other = LONG_GBP.map((row) => ({
      ...row,
      book_id: 'debate/other',
      fill_id: `${row.fill_id}-2`,
    }));
    const log = buildCfdTaxLog(journal({ fills: [...LONG_GBP, ...other] }), dayRate);
    expect(log.heldOut[0]?.reason).toBe(
      'held in more than one book (debate/primary, debate/other); the broker nets them',
    );
  });

  it('holds a position out when a mark it spans has carry not journalled per position', () => {
    const log = buildCfdTaxLog(
      journal({ bookDays: [...BOOK_DAYS, bookDay('2026-05-06', 0.3, 0)] }),
      dayRate,
    );
    expect(log.disposals.map((row) => row.instrument)).toEqual([]);
    expect(log.heldOut.map((held) => [held.instrument, held.reason])).toEqual([
      ['TSLA', 'CFD carry on 2026-05-06 is not journalled per position (migration 0094)'],
      ['VOD', 'CFD carry on 2026-05-06 is not journalled per position (migration 0094)'],
    ]);
  });

  it('ignores an uncovered mark outside the position and in another book', () => {
    const log = buildCfdTaxLog(
      journal({
        fills: LONG_GBP,
        bookDays: [
          ...BOOK_DAYS,
          bookDay('2026-05-12', 0.3, 0),
          { ...bookDay('2026-05-06', 0.3, 0), book_id: 'debate/other' },
        ],
        carry: CARRY.filter((row) => row.instrument === 'VOD'),
      }),
      dayRate,
    );
    expect(log.heldOut).toEqual([
      expect.objectContaining({
        reason: 'CFD carry on 2026-05-04 is not journalled per position (migration 0094)',
      }),
    ]);
    const covered = buildCfdTaxLog(
      journal({
        fills: LONG_GBP,
        bookDays: [bookDay('2026-05-04', 0.5, 0), bookDay('2026-05-12', 0.3, 0)],
        carry: CARRY.filter((row) => row.instrument === 'VOD'),
      }),
      dayRate,
    );
    expect(covered.heldOut).toEqual([]);
  });

  it('holds a position out over a split while it was open', () => {
    const log = buildCfdTaxLog(
      journal({
        fills: LONG_GBP,
        splits: [
          { instrument: 'VOD', split_date: '2026-05-05', ratio: 2 },
          { instrument: 'TSLA', split_date: '2026-05-06', ratio: 3 },
        ],
      }),
      dayRate,
    );
    expect(log.heldOut[0]?.reason).toBe('split on 2026-05-05 while the CFD position was open');
    const outside = buildCfdTaxLog(
      journal({
        fills: LONG_GBP,
        splits: [{ instrument: 'VOD', split_date: '2026-05-01', ratio: 2 }],
      }),
      dayRate,
    );
    expect(outside.heldOut).toEqual([]);
  });

  it('holds a position out when its closing fills fall in two tax years', () => {
    const fills = [
      fill({ fill_id: 'open', fill_date: '2026-03-01', trading_date: '2026-03-01' }),
      fill({
        fill_id: 'c1',
        side: 'sell',
        qty: 50,
        fill_date: '2026-04-05',
        trading_date: '2026-04-05',
      }),
      fill({
        fill_id: 'c2',
        side: 'sell',
        qty: 50,
        fill_date: '2026-04-06',
        trading_date: '2026-04-06',
      }),
    ];
    const log = buildCfdTaxLog(journal({ fills, bookDays: [], carry: [] }), dayRate);
    expect(log.heldOut).toEqual([
      {
        instrument: 'VOD',
        venue: 'saxo_cfd_gbp',
        reason: 'closing fills span tax years 2025 and 2026',
        fills: 3,
        taxYears: [2025, 2026],
      },
    ]);
    expect(cfdTaxYearLog(log, 2025).held_out).toEqual([
      {
        instrument: 'VOD',
        venue: 'saxo_cfd_gbp',
        reason: 'closing fills span tax years 2025 and 2026',
        fills: 3,
      },
    ]);
  });
});
