import { describe, expect, it } from 'vitest';
import type { JournalledFill, OrderOutcome } from '../../../../contracts/index.js';
import { V2_CONTRACT_VERSION } from '../../../../contracts/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { Journal } from '../journal/index.js';
import { dayRateOf, TaxReader, taxCsv, taxYearLabel } from './tax.js';

const clock = { now: () => new Date('2026-10-06T21:40:00.000Z') };
const FX = [
  { date: '2026-05-01', gbpUsd: 1.25 },
  { date: '2026-07-01', gbpUsd: 1.3 },
  { date: '2026-10-05', gbpUsd: 1.28 },
];

interface Seeded {
  readonly db: StoreHandle;
  readonly journal: Journal;
}

function seeded(): Seeded {
  const db = openSharedStore(':memory:');
  return { db, journal: new Journal(db, clock) };
}

let sequence = 0;

function trade(
  { journal }: Seeded,
  outcome: OrderOutcome,
  fill: Pick<JournalledFill, 'instrument' | 'venue' | 'side' | 'qty' | 'price_native'> &
    Partial<JournalledFill>,
): void {
  sequence += 1;
  const orderId = `o${sequence}`;
  journal.recordOrder({
    client_order_id: orderId,
    decision_id: null,
    book_id: 'debate/primary',
    trading_date: fill.fill_date ?? '2026-05-01',
    instrument: fill.instrument,
    venue: fill.venue,
    leg: fill.side === 'buy' ? 'entry' : 'exit',
    side: fill.side,
    dry_run: outcome === 'refused_dry_run',
    outcome,
    payload: {},
  });
  const usd = fill.venue === 'alpaca';
  journal.recordFill({
    fill_id: `f${sequence}`,
    client_order_id: orderId,
    book_id: 'debate/primary',
    trading_date: fill.fill_date ?? '2026-05-01',
    leg: fill.side === 'buy' ? 'entry' : 'exit',
    price_gbp: fill.price_native,
    fee_gbp: 0,
    currency: usd ? 'USD' : 'GBP',
    fee_native: 0,
    fx_quote_per_gbp: usd ? 1.3 : 1,
    fx_source: usd ? 'boe-xudluss:year-start:2026@2025-12-31' : 'gbp',
    fill_date: '2026-05-01',
    ...fill,
  });
}

describe('dayRateOf', () => {
  it('needs no rate for sterling and takes the BoE day fix for dollars', () => {
    expect(dayRateOf(FX, 'GBP', '2026-05-01')).toEqual({
      ok: true,
      quotePerGbp: 1,
      source: 'gbp',
    });
    expect(dayRateOf(FX, 'USD', '2026-05-03')).toEqual({
      ok: true,
      quotePerGbp: 1.25,
      source: 'boe-xudluss:2026-05-01',
    });
  });

  it('refuses a currency it has no source for and a dollar date the series does not cover', () => {
    expect(dayRateOf(FX, 'EUR', '2026-05-01')).toEqual({
      ok: false,
      reason: 'no day-rate source for EUR',
    });
    expect(dayRateOf(FX, 'USD', '2026-10-06')).toEqual({
      ok: false,
      reason: 'BoE XUDLUSS series ends 2026-10-05, before 2026-10-06',
    });
  });
});

describe('TaxReader', () => {
  it('serves the current UK tax year as empty when nothing was disposed of', () => {
    const { db } = seeded();
    expect(new TaxReader(db, clock, FX).read({ year: null, format: 'json' })).toEqual({
      contract_version: V2_CONTRACT_VERSION,
      year: 2026,
      years: [],
      disposals: { status: 'empty' },
    });
  });

  it('logs broker fills only: shadow, control and dry-run fills are never disposals', () => {
    const store = seeded();
    trade(store, 'submitted', {
      instrument: 'AAPL',
      venue: 'alpaca',
      side: 'buy',
      qty: 10,
      price_native: 150,
    });
    trade(store, 'submitted', {
      instrument: 'AAPL',
      venue: 'alpaca',
      side: 'sell',
      qty: 4,
      price_native: 180,
      fill_date: '2026-07-01',
    });
    trade(store, 'cancelled', {
      instrument: 'AAPL',
      venue: 'alpaca',
      side: 'sell',
      qty: 1,
      price_native: 170,
      fill_date: '2026-07-01',
    });
    for (const outcome of ['simulated', 'refused_dry_run'] as const) {
      trade(store, outcome, {
        instrument: 'AAPL',
        venue: 'alpaca',
        side: 'sell',
        qty: 50,
        price_native: 1,
        fill_date: '2026-07-01',
      });
    }
    const served = new TaxReader(store.db, clock, FX).read({ year: 2026, format: 'json' });
    expect(served.disposals).toEqual({
      status: 'fed',
      rows: [
        {
          disposal_date: '2026-07-01',
          instrument: 'AAPL',
          venue: 'alpaca',
          qty: 5,
          proceeds_gbp: expect.closeTo(890 / 1.3, 9),
          cost_gbp: expect.closeTo(750 / 1.25, 9),
          gain_gbp: expect.closeTo(890 / 1.3 - 750 / 1.25, 9),
          rule: 'section-104',
          acquisition_date: null,
          currency: 'USD',
          fx_quote_per_gbp: 1.3,
          fx_source: 'boe-xudluss:2026-07-01',
          provisional: false,
          cash_in_lieu: false,
        },
      ],
      held_out: [],
      proceeds_gbp: expect.closeTo(890 / 1.3, 9),
      cost_gbp: expect.closeTo(750 / 1.25, 9),
      gain_gbp: expect.closeTo(890 / 1.3 - 750 / 1.25, 9),
    });
    expect(served.years).toEqual([2026]);
  });

  it('reads the journalled splits, so a post-split disposal matches the pre-split cost', () => {
    const store = seeded();
    trade(store, 'submitted', {
      instrument: 'VUSA',
      venue: 'saxo',
      side: 'buy',
      qty: 10,
      price_native: 90,
    });
    trade(store, 'submitted', {
      instrument: 'VUSA',
      venue: 'saxo',
      side: 'sell',
      qty: 20,
      price_native: 50,
      fill_date: '2026-07-01',
    });
    store.journal.recordSplit({
      instrument: 'VUSA',
      venue: 'saxo',
      split_date: '2026-06-01',
      ratio: 2,
      trading_date: '2026-06-02',
    });
    const served = new TaxReader(store.db, clock, FX).read({ year: 2026, format: 'json' });
    expect(served.disposals).toMatchObject({
      status: 'fed',
      rows: [{ qty: 20, cost_gbp: 900, proceeds_gbp: 1_000, gain_gbp: 100 }],
    });
  });

  it('serves a year with only held-out instruments as fed, so it never reads as no disposals', () => {
    const store = seeded();
    trade(store, 'submitted', {
      instrument: 'AAPL',
      venue: 'alpaca',
      side: 'sell',
      qty: 1,
      price_native: 180,
      fill_date: '2026-10-06',
    });
    const served = new TaxReader(store.db, clock, FX).read({ year: null, format: 'json' });
    expect(served.disposals).toEqual({
      status: 'fed',
      rows: [],
      held_out: [
        {
          instrument: 'AAPL',
          venue: 'alpaca',
          reason: `fill f${sequence}: BoE XUDLUSS series ends 2026-10-05, before 2026-10-06`,
          fills: 1,
        },
      ],
      proceeds_gbp: 0,
      cost_gbp: 0,
      gain_gbp: 0,
    });
  });

  it('downloads a year as a CSV named for the tax year', () => {
    const store = seeded();
    trade(store, 'submitted', {
      instrument: 'VUSA',
      venue: 'saxo',
      side: 'buy',
      qty: 3,
      price_native: 10,
    });
    trade(store, 'submitted', {
      instrument: 'VUSA',
      venue: 'saxo',
      side: 'sell',
      qty: 3,
      price_native: 12.344,
      fill_date: '2026-07-01',
    });
    const csv = new TaxReader(store.db, clock, FX).csv({ year: 2026, format: 'csv' });
    expect(csv.filename).toBe('samurai-tax-2026-27.csv');
    expect(csv.body.split('\n')).toEqual([
      'disposal_date,instrument,venue,qty,proceeds_gbp,cost_gbp,gain_gbp,rule,acquisition_date,' +
        'currency,fx_quote_per_gbp,fx_source,provisional,cash_in_lieu,note',
      '2026-07-01,VUSA,saxo,3,37.03,30.00,7.03,section-104,,GBP,1,gbp,false,false,',
      '',
    ]);
    expect(new TaxReader(store.db, clock, FX).csv({ year: null, format: 'csv' }).filename).toBe(
      'samurai-tax-2026-27.csv',
    );
  });
});

describe('taxCsv', () => {
  it('lists a held-out instrument with its reason quoted, and a year with nothing as the header alone', () => {
    const body = taxCsv({
      rows: [],
      held_out: [{ instrument: 'AAPL', venue: 'alpaca', reason: 'a "quoted", reason', fills: 2 }],
      proceeds_gbp: 0,
      cost_gbp: 0,
      gain_gbp: 0,
    });
    expect(body.split('\n').slice(1)).toEqual([
      ',AAPL,alpaca,,,,,held_out,,,,,,,"2 fills held out: a ""quoted"", reason"',
      '',
    ]);
    expect(
      taxCsv({ rows: [], held_out: [], proceeds_gbp: 0, cost_gbp: 0, gain_gbp: 0 }).split('\n'),
    ).toHaveLength(2);
  });

  it('quotes a field with a line break', () => {
    const body = taxCsv({
      rows: [],
      held_out: [{ instrument: 'AAPL', venue: 'alpaca', reason: 'two\nlines', fills: 1 }],
      proceeds_gbp: 0,
      cost_gbp: 0,
      gain_gbp: 0,
    });
    expect(body).toContain('"1 fills held out: two\nlines"');
  });

  it('labels a tax year by its two calendar years', () => {
    expect(taxYearLabel(2026)).toBe('2026-27');
    expect(taxYearLabel(2099)).toBe('2099-00');
    expect(taxYearLabel(2008)).toBe('2008-09');
  });
});
