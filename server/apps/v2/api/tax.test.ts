import { describe, expect, it } from 'vitest';
import type {
  BookFill,
  JournalledFill,
  OrderOutcome,
  SleeveSpec,
} from '../../../../contracts/index.js';
import { V2_CONTRACT_VERSION } from '../../../../contracts/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import { Journal } from '../journal/index.js';
import { PaperBooks } from '../risk/books.js';
import { CapitalConfigStore } from '../risk/capital-config.js';
import { dayRateOf, TaxReader, taxCfdCsv, taxCsv, taxYearLabel } from './tax.js';

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
  const db = migratedMemoryStore();
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
    broker_mode: 'paper',
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
    expect(new TaxReader(db, clock, () => FX).read({ year: null, format: 'json' })).toEqual({
      contract_version: V2_CONTRACT_VERSION,
      year: 2026,
      years: [],
      disposals: { status: 'empty' },
      cfd_disposals: { status: 'empty' },
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
    const served = new TaxReader(store.db, clock, () => FX).read({ year: 2026, format: 'json' });
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
          cash_in_lieu_activity: null,
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
    const served = new TaxReader(store.db, clock, () => FX).read({ year: 2026, format: 'json' });
    expect(served.disposals).toMatchObject({
      status: 'fed',
      rows: [{ qty: 20, cost_gbp: 900, proceeds_gbp: 1_000, gain_gbp: 100 }],
    });
  });

  it("reads the broker's journalled cash in lieu in place of the latest-close estimate (#2001)", () => {
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
      leg: 'cash_in_lieu',
      qty: 0.5,
      price_native: 170,
      fill_date: '2026-07-01',
    });
    const reader = new TaxReader(store.db, clock, () => FX);
    expect(reader.read({ year: 2026, format: 'json' }).disposals).toMatchObject({
      rows: [{ proceeds_gbp: 85 / 1.3, cash_in_lieu: true, cash_in_lieu_activity: null }],
    });
    store.journal.recordCashInLieu({
      venue: 'alpaca',
      activity_id: 'cil-1',
      instrument: 'AAPL',
      activity_date: '2026-07-03',
      qty: 0.5,
      amount_native: 91,
      currency: 'USD',
      status: 'executed',
      fx_quote_per_gbp: 1.3,
      fx_source: 'boe-xudluss:year-start:2026@2025-12-31',
      trading_date: '2026-07-03',
    });
    expect(reader.read({ year: 2026, format: 'json' }).disposals).toMatchObject({
      rows: [{ proceeds_gbp: 91 / 1.3, cash_in_lieu: true, cash_in_lieu_activity: 'alpaca:cil-1' }],
    });
    expect(reader.csv({ year: 2026, format: 'csv' }).body.split('\n')[1]).toMatch(
      /,USD,1\.3,boe-xudluss:2026-07-01,false,true,alpaca:cil-1,$/,
    );
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
    const served = new TaxReader(store.db, clock, () => FX).read({ year: null, format: 'json' });
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
    const csv = new TaxReader(store.db, clock, () => FX).csv({ year: 2026, format: 'csv' });
    expect(csv.filename).toBe('samurai-tax-2026-27.csv');
    expect(csv.body.split('\n')).toEqual([
      'disposal_date,instrument,venue,qty,proceeds_gbp,cost_gbp,gain_gbp,rule,acquisition_date,' +
        'currency,fx_quote_per_gbp,fx_source,provisional,cash_in_lieu,cash_in_lieu_activity,note',
      '2026-07-01,VUSA,saxo,3,37.03,30.00,7.03,section-104,,GBP,1,gbp,false,false,,',
      '',
    ]);
    expect(
      new TaxReader(store.db, clock, () => FX).csv({ year: null, format: 'csv' }).filename,
    ).toBe('samurai-tax-2026-27.csv');
  });
});

const CFD_SPEC: SleeveSpec = {
  capitalShare: 1,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'forward-paper',
  macroGate: true,
  sizing: {
    riskFraction: 0.005,
    stopAtrMultiple: 2,
    targetAtrMultiple: 3,
    timeStopTradingDays: 10,
    advShare: 0.01,
    advWindowBars: 20,
  },
  books: [{ variant: 'primary', instantiated: true }],
};

interface CfdTrade {
  readonly id: string;
  readonly instrument: string;
  readonly venue: 'saxo_cfd_gbp' | 'saxo_cfd_usd';
  readonly side: 'buy' | 'sell';
  readonly leg: BookFill['leg'];
  readonly qty: number;
  readonly price: number;
  readonly date: string;
}

function cfdTrade({ journal }: Seeded, books: PaperBooks, trade: CfdTrade): void {
  const usd = trade.venue === 'saxo_cfd_usd';
  const booking = usd ? 1.3 : 1;
  journal.recordOrder({
    client_order_id: trade.id,
    decision_id: null,
    book_id: 'debate/primary',
    trading_date: trade.date,
    instrument: trade.instrument,
    venue: trade.venue,
    leg: trade.leg === 'entry' ? 'entry' : 'exit',
    side: trade.side,
    dry_run: false,
    outcome: 'submitted',
    payload: {},
  });
  journal.recordFill({
    fill_id: `fill-${trade.id}`,
    client_order_id: trade.id,
    book_id: 'debate/primary',
    trading_date: trade.date,
    instrument: trade.instrument,
    venue: trade.venue,
    leg: trade.leg,
    side: trade.side,
    qty: trade.qty,
    price_gbp: trade.price / booking,
    fee_gbp: 1 / booking,
    currency: usd ? 'USD' : 'GBP',
    price_native: trade.price,
    fee_native: 1,
    fx_quote_per_gbp: booking,
    fx_source: usd ? 'boe-xudluss:year-start:2026@2025-12-31' : 'gbp',
    fill_date: trade.date,
    broker_mode: 'paper',
  });
  books.applyFill('debate/primary', {
    instrument: trade.instrument,
    venue: trade.venue,
    side: trade.side,
    leg: trade.leg,
    qty: trade.qty,
    priceGbp: trade.price / booking,
    feeGbp: 1 / booking,
    clientOrderId: trade.id,
    tradingDate: trade.date,
    stopGbp: undefined,
    targetGbp: undefined,
  });
}

function cfdStore(): { store: Seeded; books: PaperBooks } {
  const store = seeded();
  const capital = new CapitalConfigStore(store.db, clock);
  capital.setYear(2026, 10_000, 1_500);
  const books = new PaperBooks(
    store.db,
    clock,
    capital,
    '2026-05-01',
    [{ id: 'debate', spec: CFD_SPEC }],
    {
      financing: { dailyRate: (_venue, side) => (side === 'long' ? 0.001 : 0.0005) },
      borrow: { dailyRate: (_venue, quoted) => quoted ?? 0.0002 },
      quotedBorrowPerDay: () => undefined,
    },
  );
  return { store, books };
}

function vodLongAndTslaShort(store: Seeded, books: PaperBooks): void {
  cfdTrade(store, books, {
    id: 'vod-in',
    instrument: 'VOD',
    venue: 'saxo_cfd_gbp',
    side: 'buy',
    leg: 'entry',
    qty: 100,
    price: 0.7,
    date: '2026-05-01',
  });
  cfdTrade(store, books, {
    id: 'tsla-in',
    instrument: 'TSLA',
    venue: 'saxo_cfd_usd',
    side: 'sell',
    leg: 'entry',
    qty: 10,
    price: 200,
    date: '2026-05-01',
  });
  books.markDay('debate/primary', '2026-05-01', () => undefined, 1);
  books.markDay('debate/primary', '2026-05-04', () => undefined, 3);
  cfdTrade(store, books, {
    id: 'vod-out',
    instrument: 'VOD',
    venue: 'saxo_cfd_gbp',
    side: 'sell',
    leg: 'target',
    qty: 100,
    price: 0.8,
    date: '2026-07-01',
  });
  cfdTrade(store, books, {
    id: 'tsla-out',
    instrument: 'TSLA',
    venue: 'saxo_cfd_usd',
    side: 'buy',
    leg: 'stop',
    qty: 10,
    price: 180,
    date: '2026-07-01',
  });
}

describe('TaxReader CFD log (#1867)', () => {
  it('logs a long GBP and a short USD CFD from the journalled fills and per-position carry', () => {
    const { store, books } = cfdStore();
    vodLongAndTslaShort(store, books);
    const reader = new TaxReader(store.db, clock, () => FX);
    const served = reader.read({ year: 2026, format: 'json' });
    expect(served.disposals).toEqual({ status: 'empty' });
    expect(served.years).toEqual([2026]);
    const cfd = served.cfd_disposals;
    if (cfd.status !== 'fed') throw new Error(`cfd log ${cfd.status}`);
    const vodFinancing = 100 * (0.7 / 1) * 0.001 * 4;
    const tslaNotional = 10 * (200 / 1.3);
    const tslaFinancing = tslaNotional * 0.0005 * 4;
    const tslaBorrow = tslaNotional * 0.0002 * 4;
    expect(cfd.rows).toEqual([
      expect.objectContaining({
        instrument: 'TSLA',
        direction: 'short',
        open_fx_quote_per_gbp: 1.25,
        close_fx_quote_per_gbp: 1.3,
        realised_pnl_gbp: expect.closeTo(2000 / 1.25 - 1800 / 1.3, 9),
        commission_gbp: expect.closeTo(1 / 1.25 + 1 / 1.3, 12),
        financing_gbp: expect.closeTo(tslaFinancing, 9),
        borrow_gbp: expect.closeTo(tslaBorrow, 9),
        treatment: 'unconfirmed',
      }),
      expect.objectContaining({
        instrument: 'VOD',
        direction: 'long',
        realised_pnl_gbp: expect.closeTo(10, 9),
        commission_gbp: 2,
        financing_gbp: expect.closeTo(vodFinancing, 12),
        borrow_gbp: 0,
      }),
    ]);
    expect(cfd.financing_gbp).toBeCloseTo(vodFinancing + tslaFinancing, 9);
    expect(cfd.held_out).toEqual([]);
  });

  it('downloads the CFD year as its own CSV with a total line', () => {
    const { store, books } = cfdStore();
    vodLongAndTslaShort(store, books);
    const csv = new TaxReader(store.db, clock, () => FX).csv({ year: 2026, format: 'cfd-csv' });
    expect(csv.filename).toBe('samurai-tax-cfd-2026-27.csv');
    const lines = csv.body.split('\n');
    expect(lines[0]).toBe(
      'close_date,open_date,instrument,venue,direction,qty,currency,open_price_native,' +
        'close_price_native,open_fx_quote_per_gbp,close_fx_quote_per_gbp,fx_source,open_value_gbp,' +
        'close_value_gbp,realised_pnl_gbp,commission_gbp,financing_gbp,borrow_gbp,net_gbp,' +
        'treatment,note',
    );
    expect(lines[2]).toBe(
      '2026-07-01,2026-05-01,VOD,saxo_cfd_gbp,long,100,GBP,0.7,0.8,1,1,gbp,70.00,80.00,10.00,2.00,' +
        '0.28,0.00,7.72,unconfirmed,',
    );
    expect(lines[3]).toBe(',,total,,,,,,,,,,,,225.38,3.57,3.36,1.23,217.23,unconfirmed,');
    expect(lines).toHaveLength(5);
  });

  it('leaves the share-matching log and its CSV byte-identical with CFD fills beside them', () => {
    const plain = seeded();
    const { store, books } = cfdStore();
    for (const target of [plain, store]) {
      trade(target, 'submitted', {
        instrument: 'VUSA',
        venue: 'saxo',
        side: 'buy',
        qty: 3,
        price_native: 10,
      });
      trade(target, 'submitted', {
        instrument: 'VUSA',
        venue: 'saxo',
        side: 'sell',
        qty: 3,
        price_native: 12.344,
        fill_date: '2026-07-01',
      });
    }
    vodLongAndTslaShort(store, books);
    const without = new TaxReader(plain.db, clock, () => FX);
    const withCfds = new TaxReader(store.db, clock, () => FX);
    const query = { year: 2026, format: 'csv' } as const;
    expect(withCfds.csv(query).body).toBe(without.csv(query).body);
    expect(JSON.stringify(withCfds.read({ ...query, format: 'json' }).disposals)).toBe(
      JSON.stringify(without.read({ ...query, format: 'json' }).disposals),
    );
  });
});

describe('taxCfdCsv', () => {
  it('lists a held-out CFD with its reason and a total line under the header', () => {
    const body = taxCfdCsv({
      rows: [],
      held_out: [{ instrument: 'TSLA', venue: 'saxo_cfd_usd', reason: 'no fix', fills: 2 }],
      realised_pnl_gbp: 0,
      commission_gbp: 0,
      financing_gbp: 0,
      borrow_gbp: 0,
      net_gbp: 0,
      treatment: 'unconfirmed',
    });
    expect(body.split('\n').slice(1)).toEqual([
      ',,TSLA,saxo_cfd_usd,,,,,,,,,,,,,,,,held_out,2 fills held out: no fix',
      ',,total,,,,,,,,,,,,0.00,0.00,0.00,0.00,0.00,unconfirmed,',
      '',
    ]);
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
      ',AAPL,alpaca,,,,,held_out,,,,,,,,"2 fills held out: a ""quoted"", reason"',
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
