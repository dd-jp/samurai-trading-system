import { afterEach, describe, expect, it } from 'vitest';
import type { DailyBar } from '../../../pipeline/momentum/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { BarsMarketData, type LastBar, type MarkSource } from '../data/index.js';
import { PositionsPanel, readHoldings } from './positions.js';

const FX = [{ date: '2025-12-31', gbpUsd: 1.25 }];
const AS_OF = '2026-10-06';

let db: StoreHandle;

afterEach(() => db?.close());

function bar(date: string, rawClose: number): DailyBar {
  return {
    date,
    open: rawClose,
    high: rawClose,
    low: rawClose,
    close: rawClose,
    volume: 1,
    rawClose,
  };
}

function seedBook(bookId: string, variant: string, cashGbp: number): void {
  db.prepare(
    `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES (?, 'debate', ?, 1000, ?, '2026-09-01T00:00:00.000Z')`,
  ).run(bookId, variant, cashGbp);
  db.prepare(
    `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
       size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
     VALUES (?, ?, 1000, 0, 0, 0, 1, 0, 0, '2026-10-06T21:40:00.000Z')`,
  ).run(bookId, AS_OF);
}

function seedPosition(
  bookId: string,
  instrument: string,
  venue: string,
  qty: number,
  avgPriceGbp: number,
): void {
  db.prepare(
    `INSERT INTO v2_positions (book_id, instrument, venue, qty, avg_price_gbp, stop_gbp, target_gbp,
       client_order_id, exit_client_order_id, opened_date, marks_held, updated_at)
     VALUES (?, ?, ?, ?, ?, 90, NULL, ?, NULL, '2026-10-01', 3, '2026-10-06T21:40:00.000Z')`,
  ).run(bookId, instrument, venue, qty, avgPriceGbp, `${bookId}-${instrument}`);
}

function marksOf(bars: Record<string, LastBar>): MarkSource {
  return { lastBarsBefore: () => Promise.resolve(new Map(Object.entries(bars))) };
}

function panel(marks: MarkSource, fx = FX): PositionsPanel {
  return new PositionsPanel(marks, new BarsMarketData({ load: () => undefined }, fx));
}

function present(marks: MarkSource, fx = FX) {
  return panel(marks, fx).present(readHoldings(db));
}

describe('PositionsPanel (P3)', () => {
  it('is empty before the first cycle', async () => {
    db = openSharedStore(':memory:');
    expect(await present(marksOf({}))).toEqual({ status: 'empty' });
  });

  it('marks a USD position at the last close over the 1 January rate, as the cycle does', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 500);
    seedPosition('debate/primary', 'AAPL', 'alpaca', 2, 80);
    const served = await present(marksOf({ 'alpaca:AAPL': bar('2026-10-05', 125) }));
    expect(served).toEqual({
      status: 'fed',
      as_of: AS_OF,
      fx: {
        gbp_usd: 1.25,
        year: 2026,
        source: 'Bank of England XUDLUSS, last observation on or before 1 January',
      },
      positions: [
        {
          book_id: 'debate/primary',
          variant: 'primary',
          instrument: 'AAPL',
          venue: 'alpaca',
          currency: 'USD',
          qty: 2,
          entry_gbp: 80,
          stop_gbp: 90,
          opened_date: '2026-10-01',
          marks_held: 3,
          mark: {
            status: 'fresh',
            bar_date: '2026-10-05',
            price_quote: 125,
            price_gbp: 100,
            market_value_gbp: 200,
            unrealised_gbp: 40,
          },
        },
      ],
      cash: [{ book_id: 'debate/primary', variant: 'primary', cash_gbp: 500 }],
      venues: [
        { venue: 'alpaca', currency: 'USD', positions_value_quote: 250, positions_value_gbp: 200 },
        { venue: 'saxo', currency: 'GBP', positions_value_quote: 0, positions_value_gbp: 0 },
      ],
      total_gbp: 700,
    });
  });

  it('marks a GBP position at par and a short with the loss sign it carries', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 0);
    seedPosition('debate/primary', 'VUSA', 'saxo', -3, 50);
    const served = await present(marksOf({ 'saxo:VUSA': bar('2026-10-05', 60) }));
    expect(served).toMatchObject({
      positions: [
        { currency: 'GBP', mark: { price_gbp: 60, market_value_gbp: -180, unrealised_gbp: -30 } },
      ],
      venues: [
        { venue: 'alpaca' },
        { venue: 'saxo', positions_value_quote: -180, positions_value_gbp: -180 },
      ],
    });
  });

  it('shows a stale or missing bar as stale, never as a price, and nulls the totals it feeds', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 100);
    seedPosition('debate/primary', 'AAPL', 'alpaca', 1, 80);
    seedPosition('debate/primary', 'MSFT', 'alpaca', 1, 80);
    const served = await present(marksOf({ 'alpaca:AAPL': bar('2026-09-30', 125) }));
    expect(served).toMatchObject({
      positions: [
        { instrument: 'AAPL', mark: { status: 'stale', bar_date: '2026-09-30' } },
        { instrument: 'MSFT', mark: { status: 'stale', bar_date: null } },
      ],
      venues: [
        { positions_value_quote: null, positions_value_gbp: null },
        { positions_value_gbp: 0 },
      ],
      total_gbp: null,
    });
  });

  it('keeps a bar exactly at the freshness limit fresh', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 0);
    seedPosition('debate/primary', 'AAPL', 'alpaca', 1, 80);
    const served = await present(marksOf({ 'alpaca:AAPL': bar('2026-10-01', 125) }));
    expect(served).toMatchObject({ positions: [{ mark: { status: 'fresh' } }] });
  });

  it('lists shadow books but totals only the primary books, like the loss-budget headline', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 100);
    seedBook('debate/no-veto', 'no-veto', 900);
    seedPosition('debate/primary', 'AAPL', 'alpaca', 1, 80);
    seedPosition('debate/no-veto', 'AAPL', 'alpaca', 5, 80);
    const served = await present(marksOf({ 'alpaca:AAPL': bar('2026-10-05', 125) }));
    expect(served).toMatchObject({
      positions: [
        { book_id: 'debate/primary' },
        { book_id: 'debate/no-veto', mark: { status: 'fresh' } },
      ],
      cash: [{ book_id: 'debate/primary' }, { book_id: 'debate/no-veto' }],
      venues: [{ positions_value_quote: 125, positions_value_gbp: 100 }, {}],
      total_gbp: 200,
    });
  });

  it('adds a venue row for a CFD venue only once a primary book holds one there', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 100);
    seedPosition('debate/primary', 'AAPL', 'saxo_cfd_usd', -2, 80);
    const served = await present(marksOf({ 'saxo_cfd_usd:AAPL': bar('2026-10-05', 125) }));
    expect(served).toMatchObject({
      positions: [{ venue: 'saxo_cfd_usd', currency: 'USD', qty: -2 }],
      venues: [
        { venue: 'alpaca' },
        { venue: 'saxo' },
        { venue: 'saxo_cfd_usd', currency: 'USD', positions_value_quote: -250 },
      ],
    });
    expect(served.status === 'fed' && served.venues).toHaveLength(3);
  });

  it('asks for the bars before the latest cycle date, for every holding', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 0);
    seedPosition('debate/primary', 'AAPL', 'alpaca', 1, 80);
    const asked: { held: string[]; date: string }[] = [];
    const recording: MarkSource = {
      lastBarsBefore: (held, date) => {
        asked.push({ held: held.map((one) => `${one.venue}:${one.instrument}`), date });
        return Promise.resolve(new Map());
      },
    };
    await present(recording);
    expect(asked).toEqual([{ held: ['alpaca:AAPL'], date: AS_OF }]);
  });

  it('gives up on a mark read that hangs and serves it as unavailable', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 0);
    seedPosition('debate/primary', 'AAPL', 'alpaca', 1, 80);
    const hanging: MarkSource = { lastBarsBefore: () => new Promise(() => undefined) };
    const slow = new PositionsPanel(hanging, new BarsMarketData({ load: () => undefined }, FX), 10);
    expect(await slow.present(readHoldings(db))).toMatchObject({
      positions: [{ mark: { status: 'unavailable' } }],
    });
  });

  it('serves marks it cannot read as unavailable, without failing the panel', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 0);
    seedPosition('debate/primary', 'AAPL', 'alpaca', 1, 80);
    const unreadable: MarkSource = { lastBarsBefore: () => Promise.reject(new Error('disk gone')) };
    expect(await present(unreadable)).toMatchObject({
      positions: [{ mark: { status: 'unavailable' } }],
      total_gbp: null,
    });
    expect(await present(marksOf({ 'alpaca:AAPL': new Error('bad file') }))).toMatchObject({
      positions: [{ mark: { status: 'unavailable' } }],
    });
  });

  it('has no USD mark and no rate when the year has no rate, while GBP still marks', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary', 0);
    seedPosition('debate/primary', 'AAPL', 'alpaca', 1, 80);
    seedPosition('debate/primary', 'VUSA', 'saxo', 1, 50);
    const served = await present(
      marksOf({ 'alpaca:AAPL': bar('2026-10-05', 125), 'saxo:VUSA': bar('2026-10-05', 60) }),
      [{ date: '2027-01-04', gbpUsd: 1.3 }],
    );
    expect(served).toMatchObject({
      fx: null,
      positions: [
        { instrument: 'AAPL', mark: { status: 'unavailable' } },
        { instrument: 'VUSA', mark: { status: 'fresh', price_gbp: 60 } },
      ],
    });
  });
});
