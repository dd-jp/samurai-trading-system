import { describe, expect, it } from 'vitest';
import type { TaxCashInLieuRow } from './tax-cash-in-lieu.js';
import {
  buildTaxLog,
  type DayRate,
  type TaxFillRow,
  type TaxSplitRow,
  taxYearLog,
  taxYearOf,
  taxYearsOf,
} from './tax-log.js';

const USD_PER_GBP: Readonly<Record<string, number>> = {
  '2026-05-01': 1.25,
  '2026-07-01': 1.3,
  '2026-09-01': 1.2,
  '2026-09-15': 1.2,
  '2026-09-29': 1.25,
  '2026-10-15': 1.25,
};

const dayRate: DayRate = (currency, date) => {
  if (currency === 'GBP') return { ok: true, quotePerGbp: 1, source: 'gbp' };
  const rate = USD_PER_GBP[date];
  return rate === undefined
    ? { ok: false, reason: `no fix for ${date}` }
    : { ok: true, quotePerGbp: rate, source: `boe-xudluss:${date}` };
};

let sequence = 0;

function fill(
  side: 'buy' | 'sell',
  date: string,
  qty: number,
  price: number,
  overrides: Partial<TaxFillRow> = {},
): TaxFillRow {
  sequence += 1;
  return {
    fill_id: `f${sequence}`,
    instrument: 'VUSA',
    venue: 'saxo',
    leg: side === 'buy' ? 'entry' : 'exit',
    side,
    qty,
    trading_date: date,
    fill_date: date,
    currency: 'GBP',
    price_native: price,
    fee_native: 0,
    ...overrides,
  };
}

function usd(side: 'buy' | 'sell', date: string, qty: number, price: number, fee = 0) {
  return fill(side, date, qty, price, {
    instrument: 'AAPL',
    venue: 'alpaca',
    currency: 'USD',
    fee_native: fee,
  });
}

const AS_OF = '2027-01-15';

describe('taxYearOf', () => {
  it('starts the UK tax year on 6 April', () => {
    expect(taxYearOf('2026-04-05')).toBe(2025);
    expect(taxYearOf('2026-04-06')).toBe(2026);
    expect(taxYearOf('2027-01-15')).toBe(2026);
    expect(taxYearOf('2026-12-31')).toBe(2026);
  });
});

describe('buildTaxLog', () => {
  it('converts a US round trip at each day’s own rate, fees included, and shows the disposal rate', () => {
    const log = buildTaxLog(
      [usd('buy', '2026-05-01', 10, 150, 1), usd('sell', '2026-07-01', 10, 180, 1)],
      [],
      dayRate,
      AS_OF,
    );
    expect(log.heldOut).toEqual([]);
    expect(log.disposals).toEqual([
      {
        disposal_date: '2026-07-01',
        instrument: 'AAPL',
        venue: 'alpaca',
        qty: 10,
        proceeds_gbp: expect.closeTo(1_799 / 1.3, 9),
        cost_gbp: expect.closeTo(1_501 / 1.25, 9),
        gain_gbp: expect.closeTo(1_799 / 1.3 - 1_501 / 1.25, 9),
        rule: 'section-104',
        acquisition_date: null,
        currency: 'USD',
        fx_quote_per_gbp: 1.3,
        fx_source: 'boe-xudluss:2026-07-01',
        provisional: false,
        cash_in_lieu: false,
        cash_in_lieu_activity: null,
      },
    ]);
  });

  it('holds out an instrument with a fill journalled before capture, never converting its GBP price back', () => {
    const legacy = fill('buy', '2026-05-01', 10, 100, {
      currency: null,
      price_native: null,
      fee_native: null,
    });
    const log = buildTaxLog(
      [
        legacy,
        fill('sell', '2026-07-01', 10, 120),
        fill('buy', '2026-05-01', 1, 1, { instrument: 'ISF' }),
      ],
      [],
      dayRate,
      AS_OF,
    );
    expect(log.disposals).toEqual([]);
    expect(log.heldOut).toEqual([
      {
        instrument: 'VUSA',
        venue: 'saxo',
        reason: `fill ${legacy.fill_id} predates native price and FX capture (migration 0085)`,
        fills: 2,
        taxYears: [2026],
      },
    ]);
    for (const missing of ['currency', 'price_native', 'fee_native'] as const) {
      const partial = fill('sell', '2026-07-01', 10, 120, { [missing]: null });
      expect(buildTaxLog([partial], [], dayRate, AS_OF).heldOut[0]?.reason).toMatch(
        /predates native price/,
      );
    }
  });

  it('holds out an instrument whose day rate is not available, naming the fill and counting the rest', () => {
    const first = usd('buy', '2026-05-02', 10, 150);
    const log = buildTaxLog(
      [first, usd('sell', '2026-07-02', 10, 180), usd('sell', '2026-07-01', 1, 180)],
      [],
      dayRate,
      AS_OF,
    );
    expect(log.heldOut).toEqual([
      {
        instrument: 'AAPL',
        venue: 'alpaca',
        reason: `fill ${first.fill_id}: no fix for 2026-05-02 (and 1 more)`,
        fills: 3,
        taxYears: [2026],
      },
    ]);
    expect(log.disposals).toEqual([]);
  });

  it('holds out an instrument with fills in two currencies', () => {
    const log = buildTaxLog(
      [
        fill('buy', '2026-05-01', 10, 100),
        fill('sell', '2026-07-01', 10, 120, { currency: 'USD' }),
      ],
      [],
      dayRate,
      AS_OF,
    );
    expect(log.heldOut[0]?.reason).toBe('fills in more than one currency: GBP, USD');
  });

  it('holds out an instrument the section 104 pool cannot cover, keeping other instruments', () => {
    const log = buildTaxLog(
      [
        fill('sell', '2026-07-01', 10, 120),
        fill('buy', '2026-05-01', 5, 10, { instrument: 'ISF' }),
        fill('sell', '2026-07-01', 5, 12, { instrument: 'ISF' }),
      ],
      [],
      dayRate,
      AS_OF,
    );
    expect(log.heldOut).toMatchObject([
      { instrument: 'VUSA', reason: expect.stringMatching(/^section 104 pool holds 0 shares/) },
    ]);
    expect(log.disposals).toMatchObject([{ instrument: 'ISF', gain_gbp: expect.closeTo(10, 9) }]);
  });

  it('lists held-out instruments by name', () => {
    const log = buildTaxLog(
      [
        fill('sell', '2026-07-01', 1, 1, { instrument: 'ZZZ' }),
        fill('sell', '2026-07-01', 1, 1, { instrument: 'AAA' }),
      ],
      [],
      dayRate,
      AS_OF,
    );
    expect(log.heldOut.map((held) => held.instrument)).toEqual(['AAA', 'ZZZ']);
  });

  it('flags a day’s disposal as cash in lieu when any of its sells is, and never for a buy', () => {
    const cashInLieu = (side: 'buy' | 'sell', date: string) => ({
      ...fill(side, date, 0.5, 100),
      leg: 'cash_in_lieu',
    });
    const log = buildTaxLog(
      [
        fill('buy', '2026-05-01', 10, 100),
        fill('sell', '2026-07-01', 2, 110),
        cashInLieu('sell', '2026-07-01'),
        cashInLieu('buy', '2026-08-03'),
        fill('sell', '2026-08-03', 1, 120),
      ],
      [],
      dayRate,
      AS_OF,
    );
    expect(log.disposals.map((row) => [row.disposal_date, row.rule, row.cash_in_lieu])).toEqual([
      ['2026-07-01', 'section-104', true],
      ['2026-08-03', 'same-day', false],
      ['2026-08-03', 'section-104', false],
    ]);
  });

  it('dates a fill with no recorded fill date by its trading date', () => {
    const log = buildTaxLog(
      [
        fill('buy', '2026-05-01', 10, 100),
        fill('sell', '2026-07-01', 10, 120, { fill_date: null, trading_date: '2026-07-02' }),
      ],
      [],
      dayRate,
      AS_OF,
    );
    expect(log.disposals[0]?.disposal_date).toBe('2026-07-02');
  });

  it('leaves CFD fills to their own log (#1867)', () => {
    const log = buildTaxLog(
      [
        fill('sell', '2026-07-01', 10, 120, { venue: 'saxo_cfd_gbp' }),
        fill('sell', '2026-07-01', 10, 120, { venue: 'saxo_cfd_usd', instrument: 'AAPL' }),
      ],
      [],
      dayRate,
      AS_OF,
    );
    expect(log).toEqual({ disposals: [], heldOut: [] });
  });

  it('marks a section 104 match provisional until the 30-day window after it closes', () => {
    const fills = [fill('buy', '2026-05-01', 10, 100), fill('sell', '2026-07-01', 10, 120)];
    expect(buildTaxLog(fills, [], dayRate, '2026-07-31').disposals[0]?.provisional).toBe(true);
    expect(buildTaxLog(fills, [], dayRate, '2026-08-01').disposals[0]?.provisional).toBe(false);
    const bedAndBreakfast = [
      fill('buy', '2026-05-01', 10, 100),
      fill('sell', '2026-07-01', 10, 120),
      fill('buy', '2026-07-10', 10, 110),
    ];
    expect(buildTaxLog(bedAndBreakfast, [], dayRate, '2026-07-11').disposals[0]).toMatchObject({
      rule: '30-day',
      acquisition_date: '2026-07-10',
      provisional: false,
    });
  });

  it('matches across a split in post-split units, reports each disposal in its own day’s units, and flags cash in lieu', () => {
    const splits: TaxSplitRow[] = [{ instrument: 'AAPL', split_date: '2026-09-28', ratio: 1.5 }];
    const cashInLieu = { ...usd('sell', '2026-09-29', 0.5, 20), leg: 'cash_in_lieu' };
    const log = buildTaxLog(
      [
        usd('buy', '2026-09-01', 102, 30),
        usd('sell', '2026-09-15', 1, 31),
        cashInLieu,
        usd('sell', '2026-10-15', 151, 22),
      ],
      splits,
      dayRate,
      AS_OF,
    );
    const costPerNewShare = (102 * 30) / 1.2 / 153;
    expect(log.disposals).toMatchObject([
      {
        disposal_date: '2026-09-15',
        qty: 1,
        cost_gbp: expect.closeTo(1.5 * costPerNewShare, 9),
        proceeds_gbp: expect.closeTo(31 / 1.2, 9),
        cash_in_lieu: false,
      },
      {
        disposal_date: '2026-09-29',
        qty: 0.5,
        cost_gbp: expect.closeTo(0.5 * costPerNewShare, 9),
        proceeds_gbp: expect.closeTo(10 / 1.25, 9),
        cash_in_lieu: true,
      },
      {
        disposal_date: '2026-10-15',
        qty: 151,
        cost_gbp: expect.closeTo(151 * costPerNewShare, 9),
        cash_in_lieu: false,
      },
    ]);
    expect(log.heldOut).toEqual([]);
  });

  it('counts a split journalled by two venues once, and holds out venues that disagree on it', () => {
    const fills = [
      { ...usd('buy', '2026-05-01', 10, 400), fee_native: 1 },
      { ...usd('sell', '2026-07-01', 40, 110), fee_native: 1 },
    ];
    const once: TaxSplitRow[] = [{ instrument: 'AAPL', split_date: '2026-06-10', ratio: 4 }];
    const twice = [...once, { instrument: 'AAPL', split_date: '2026-06-10', ratio: 4 }];
    const expected = {
      qty: 40,
      cost_gbp: expect.closeTo(4_001 / 1.25, 9),
      gain_gbp: expect.closeTo(4_399 / 1.3 - 4_001 / 1.25, 9),
    };
    expect(buildTaxLog(fills, once, dayRate, AS_OF).disposals).toMatchObject([expected]);
    expect(buildTaxLog(fills, twice, dayRate, AS_OF).disposals).toMatchObject([expected]);
    const disagreeing = [...once, { instrument: 'AAPL', split_date: '2026-06-10', ratio: 2 }];
    expect(buildTaxLog(fills, disagreeing, dayRate, AS_OF)).toEqual({
      disposals: [],
      heldOut: [
        {
          instrument: 'AAPL',
          venue: 'alpaca',
          reason: 'split on 2026-06-10 journalled at ratios 4 and 2',
          fills: 2,
          taxYears: [2026],
        },
      ],
    });
  });

  it('applies only the splits after a fill, compounding two of them', () => {
    const splits: TaxSplitRow[] = [
      { instrument: 'VUSA', split_date: '2026-06-01', ratio: 2 },
      { instrument: 'VUSA', split_date: '2026-08-03', ratio: 3 },
      { instrument: 'ISF', split_date: '2026-06-01', ratio: 10 },
    ];
    const log = buildTaxLog(
      [
        fill('buy', '2026-05-01', 10, 60),
        fill('sell', '2026-06-01', 2, 35),
        fill('sell', '2026-07-01', 4, 40),
        fill('sell', '2026-09-01', 42, 15),
      ],
      splits,
      dayRate,
      AS_OF,
    );
    expect(log.disposals).toMatchObject([
      { disposal_date: '2026-06-01', qty: 2, cost_gbp: expect.closeTo(60, 9) },
      { disposal_date: '2026-07-01', qty: 4, cost_gbp: expect.closeTo(120, 9) },
      { disposal_date: '2026-09-01', qty: 42, cost_gbp: expect.closeTo(420, 9) },
    ]);
  });

  it('lists disposals by date, then instrument', () => {
    const log = buildTaxLog(
      [
        fill('buy', '2026-05-01', 1, 1, { instrument: 'ZZZ' }),
        fill('sell', '2026-07-01', 1, 2, { instrument: 'ZZZ' }),
        fill('buy', '2026-05-01', 1, 1, { instrument: 'AAA' }),
        fill('sell', '2026-07-01', 1, 2, { instrument: 'AAA' }),
        fill('buy', '2026-05-01', 1, 1, { instrument: 'MMM' }),
        fill('sell', '2026-06-01', 1, 2, { instrument: 'MMM' }),
      ],
      [],
      dayRate,
      AS_OF,
    );
    expect(log.disposals.map((row) => row.instrument)).toEqual(['MMM', 'AAA', 'ZZZ']);
  });
});

describe('taxYearLog and taxYearsOf', () => {
  const log = buildTaxLog(
    [
      fill('buy', '2025-05-01', 10, 100),
      fill('sell', '2026-04-05', 4, 110),
      fill('sell', '2026-04-06', 3, 120, { fill_date: '2026-04-06' }),
      fill('sell', '2027-05-01', 3, 90),
      fill('buy', '2024-06-01', 1, 1, { instrument: 'OLD', currency: null }),
      fill('sell', '2026-06-01', 1, 1, { instrument: 'OLD' }),
      fill('buy', '2025-06-01', 1, 1, { instrument: 'ZED', currency: null }),
    ],
    [],
    dayRate,
    AS_OF,
  );

  it('keeps a year’s disposals and the instruments held out over it, with totals', () => {
    const year = taxYearLog(log, 2026);
    expect(year.rows.map((row) => row.disposal_date)).toEqual(['2026-04-06']);
    expect(year.held_out).toEqual([
      { instrument: 'OLD', venue: 'saxo', reason: expect.any(String), fills: 2 },
    ]);
    expect(year.proceeds_gbp).toBeCloseTo(360, 9);
    expect(year.cost_gbp).toBeCloseTo(300, 9);
    expect(year.gain_gbp).toBeCloseTo(60, 9);
    expect(taxYearLog(log, 2025)).toMatchObject({
      rows: [{ disposal_date: '2026-04-05', qty: 4 }],
      proceeds_gbp: expect.closeTo(440, 9),
      cost_gbp: expect.closeTo(400, 9),
      gain_gbp: expect.closeTo(40, 9),
    });
    expect(taxYearLog(log, 2025).held_out.map((held) => held.instrument)).toEqual(['ZED']);
    expect(taxYearLog(log, 2030)).toEqual({
      rows: [],
      held_out: [],
      proceeds_gbp: 0,
      cost_gbp: 0,
      gain_gbp: 0,
    });
  });

  it('lists every tax year with a disposal or a held-out fill, oldest first and once each', () => {
    expect(taxYearsOf(log)).toEqual([2024, 2025, 2026, 2027]);
  });
});

describe("buildTaxLog with the broker's cash in lieu (#2001)", () => {
  const SPLIT: TaxSplitRow[] = [{ instrument: 'AAPL', split_date: '2026-09-28', ratio: 1.5 }];

  function estimate(date: string, qty = 0.5, overrides: Partial<TaxFillRow> = {}): TaxFillRow {
    return { ...usd('sell', date, qty, 20), leg: 'cash_in_lieu', ...overrides };
  }

  function paid(overrides: Partial<TaxCashInLieuRow> = {}): TaxCashInLieuRow {
    return {
      venue: 'alpaca',
      activity_id: 'cil-1',
      instrument: 'AAPL',
      activity_date: '2026-09-29',
      qty: 0.5,
      amount_native: 11,
      currency: 'USD',
      status: 'executed',
      ...overrides,
    };
  }

  function logOf(fills: readonly TaxFillRow[], rows: readonly TaxCashInLieuRow[]) {
    return buildTaxLog([usd('buy', '2026-09-01', 102, 30), ...fills], SPLIT, dayRate, AS_OF, rows);
  }

  const costPerNewShare = (102 * 30) / 1.2 / 153;

  it("books the broker's amount in place of the latest-close estimate and names the activity", () => {
    const log = logOf([estimate('2026-09-29')], [paid()]);
    expect(log.heldOut).toEqual([]);
    expect(log.disposals).toEqual([
      {
        disposal_date: '2026-09-29',
        instrument: 'AAPL',
        venue: 'alpaca',
        qty: 0.5,
        proceeds_gbp: expect.closeTo(11 / 1.25, 9),
        cost_gbp: expect.closeTo(0.5 * costPerNewShare, 9),
        gain_gbp: expect.closeTo(11 / 1.25 - 0.5 * costPerNewShare, 9),
        rule: 'section-104',
        acquisition_date: null,
        currency: 'USD',
        fx_quote_per_gbp: 1.25,
        fx_source: 'boe-xudluss:2026-09-29',
        provisional: false,
        cash_in_lieu: true,
        cash_in_lieu_activity: 'alpaca:cil-1',
      },
    ]);
  });

  it('keeps the estimate, flagged as one, while no broker row pairs with it', () => {
    expect(logOf([estimate('2026-09-29')], []).disposals).toMatchObject([
      { proceeds_gbp: expect.closeTo(10 / 1.25, 9), cash_in_lieu_activity: null },
    ]);
  });

  it('pairs a payment up to 30 days either side of the estimate and keeps the estimate’s date', () => {
    for (const activityDate of ['2026-10-29', '2026-08-30', '2026-10-02']) {
      const log = logOf([estimate('2026-09-29')], [paid({ activity_date: activityDate })]);
      expect(log.heldOut).toEqual([]);
      expect(log.disposals).toMatchObject([
        { disposal_date: '2026-09-29', proceeds_gbp: expect.closeTo(11 / 1.25, 9) },
      ]);
    }
  });

  it('holds the name out when a payment has no estimate within 30 days, naming the activity', () => {
    const log = logOf([estimate('2026-09-29')], [paid({ activity_date: '2026-10-30' })]);
    expect(log.disposals).toEqual([]);
    expect(log.heldOut).toEqual([
      {
        instrument: 'AAPL',
        venue: 'alpaca',
        reason: 'broker cash in lieu alpaca:cil-1 on 2026-10-30 has no estimate within 30 days',
        fills: 2,
        taxYears: [2026],
      },
    ]);
  });

  it('replaces every estimate of the nearest date with one fill at their summed qty', () => {
    const books = [estimate('2026-09-29', 0.5), estimate('2026-09-29', 0.25)];
    for (const qty of [0.75, null, 0.75 + 9e-7, 0.75 - 9e-7]) {
      expect(logOf(books, [paid({ qty, amount_native: 16.5 })]).disposals).toMatchObject([
        { qty: 0.75, proceeds_gbp: expect.closeTo(16.5 / 1.25, 9), cash_in_lieu: true },
      ]);
    }
  });

  it('holds the name out when the broker’s qty differs from the estimates’ by more than 1e-6', () => {
    const books = [estimate('2026-09-29', 0.5), estimate('2026-09-29', 0.25)];
    for (const qty of [0.4, 0.75 + 2e-6, 0.75 - 2e-6]) {
      const log = logOf(books, [paid({ qty })]);
      expect(log.disposals).toEqual([]);
      expect(log.heldOut).toMatchObject([
        { reason: `broker cash in lieu alpaca:cil-1 is for ${qty} shares, its estimate for 0.75` },
      ]);
    }
  });

  it('drops every row of an activity the broker canceled, so the estimate stands', () => {
    const canceled = [paid(), paid({ status: 'canceled' })];
    for (const rows of [canceled, [paid({ status: 'canceled' })]]) {
      const log = logOf([estimate('2026-09-29')], rows);
      expect(log.heldOut).toEqual([]);
      expect(log.disposals).toMatchObject([
        { proceeds_gbp: expect.closeTo(10 / 1.25, 9), cash_in_lieu_activity: null },
      ]);
    }
    const replaced = logOf(
      [estimate('2026-09-29')],
      [...canceled, paid({ activity_id: 'cil-2', amount_native: 12 })],
    );
    expect(replaced.disposals).toMatchObject([
      { proceeds_gbp: expect.closeTo(12 / 1.25, 9), cash_in_lieu_activity: 'alpaca:cil-2' },
    ]);
    const orphan = buildTaxLog([], [], dayRate, AS_OF, [
      paid({ instrument: 'MSFT', status: 'canceled' }),
    ]);
    expect(orphan.heldOut).toEqual([]);
  });

  it('holds the name out on a correction, which the broker does not link to what it corrects', () => {
    const rows = [paid(), paid({ activity_id: 'cil-2', status: 'correct' })];
    const log = logOf([estimate('2026-09-29')], rows);
    expect(log.disposals).toEqual([]);
    expect(log.heldOut).toMatchObject([
      {
        reason:
          'broker cash in lieu alpaca:cil-2 is a correction the broker does not link to the activity it corrects',
      },
    ]);
  });

  it('pairs the nearest estimate date, the earlier one on a tie, and leaves the other estimate', () => {
    const fills = [estimate('2026-09-29'), estimate('2026-10-15')];
    const later = logOf(fills, [paid({ activity_date: '2026-10-14' })]);
    expect(later.disposals.map((d) => [d.disposal_date, d.cash_in_lieu_activity])).toEqual([
      ['2026-09-29', null],
      ['2026-10-15', 'alpaca:cil-1'],
    ]);
    const tie = logOf(fills, [paid({ activity_date: '2026-10-07' })]);
    expect(tie.disposals.map((d) => [d.disposal_date, d.cash_in_lieu_activity])).toEqual([
      ['2026-09-29', 'alpaca:cil-1'],
      ['2026-10-15', null],
    ]);
  });

  it('pairs each estimate once, taking payments by date and then id, whatever the read order', () => {
    const rows = [
      paid({ activity_id: 'cil-b', activity_date: '2026-09-30' }),
      paid({ activity_id: 'cil-c', activity_date: '2026-09-29' }),
      paid({ activity_id: 'cil-a', activity_date: '2026-09-30' }),
    ];
    const log = logOf([estimate('2026-09-29'), estimate('2026-09-15')], rows);
    expect(log.heldOut).toMatchObject([
      { reason: 'broker cash in lieu alpaca:cil-b on 2026-09-30 has no estimate within 30 days' },
    ]);
    const two = logOf([estimate('2026-09-29'), estimate('2026-09-15')], rows.slice(0, 2));
    expect(two.heldOut).toEqual([]);
    expect(two.disposals.map((d) => [d.disposal_date, d.cash_in_lieu_activity])).toEqual([
      ['2026-09-15', 'alpaca:cil-b'],
      ['2026-09-29', 'alpaca:cil-c'],
    ]);
  });

  it('pairs only an estimate at the payment’s own venue', () => {
    const elsewhere = estimate('2026-09-29', 0.5, { venue: 'saxo' });
    expect(logOf([elsewhere], [paid()]).heldOut).toMatchObject([
      { reason: expect.stringContaining('has no estimate within 30 days') },
    ]);
  });

  it('holds out a payment that disagrees with its estimate rather than guess', () => {
    const cases: [readonly TaxFillRow[], Partial<TaxCashInLieuRow>, string][] = [
      [[estimate('2026-09-29')], { currency: 'GBP' }, 'is in GBP, its estimate in USD'],
      [
        [estimate('2026-09-29')],
        { amount_native: -11 },
        'of -11 USD has the wrong sign for a sell',
      ],
      [[estimate('2026-09-29')], { amount_native: 0 }, 'of 0 USD has the wrong sign for a sell'],
      [
        [estimate('2026-09-29'), estimate('2026-09-29', 0.5, { side: 'buy' })],
        {},
        'pairs a buy and a sell',
      ],
    ];
    for (const [fills, override, reason] of cases) {
      expect(logOf(fills, [paid(override)]).heldOut).toMatchObject([
        { reason: `broker cash in lieu alpaca:cil-1 ${reason}` },
      ]);
    }
  });

  it('books a short’s cash in lieu paid out of the account as an acquisition at the broker’s amount', () => {
    const fills = [
      usd('sell', '2026-09-01', 10, 30),
      estimate('2026-09-29', 0.5, { side: 'buy' }),
      usd('buy', '2026-09-29', 14.5, 20),
    ];
    const log = buildTaxLog(fills, SPLIT, dayRate, AS_OF, [paid({ amount_native: -11 })]);
    expect(log.heldOut).toEqual([]);
    expect(log.disposals).toMatchObject([{ cash_in_lieu: false }]);
    expect(log.disposals[0]?.cost_gbp).toBeCloseTo((14.5 * 20) / 1.25 + 11 / 1.25, 9);
  });

  it('holds out a payment for a name with no fills, and ignores one at a CFD venue', () => {
    const cfdOnly = usd('buy', '2026-09-01', 1, 30);
    const log = buildTaxLog(
      [{ ...cfdOnly, instrument: 'MSFT', venue: 'saxo_cfd_usd' }],
      [],
      dayRate,
      AS_OF,
      [
        paid({ instrument: 'MSFT', activity_date: '2026-04-05' }),
        paid({ instrument: 'TSLA', venue: 'saxo_cfd_usd' }),
      ],
    );
    expect(log.heldOut).toEqual([
      {
        instrument: 'MSFT',
        venue: 'alpaca',
        reason: 'broker cash in lieu alpaca:cil-1 on 2026-04-05 for a name with no fills',
        fills: 0,
        taxYears: [2025],
      },
    ]);
  });
});
