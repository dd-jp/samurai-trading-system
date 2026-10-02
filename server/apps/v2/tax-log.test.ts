import { describe, expect, it } from 'vitest';
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
        reason: `fill ${legacy.fill_id} predates native price and FX capture (migration 0084)`,
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
