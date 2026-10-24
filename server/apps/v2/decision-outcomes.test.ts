import { afterEach, describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { EvidenceReader } from './api/evidence.js';
import type { BarsSource } from './data/index.js';
import {
  benchmarkWindowOf,
  type ClosedTrade,
  exitReasonOf,
  type FillBars,
  fillBarsOf,
  needsAttention,
  type OutcomeFill,
  outcomeOf,
  rebuildDecisionOutcomes,
} from './decision-outcomes.js';

function bar(date: string, open: number, close: number): DailyBar {
  return {
    date,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
    rawClose: close,
  };
}

const SPY: BarSeries = {
  symbol: 'SPY',
  bars: [
    bar('2026-10-05', 100, 101),
    bar('2026-10-06', 101, 102),
    bar('2026-10-07', 102, 103),
    bar('2026-10-08', 103, 104),
    bar('2026-10-09', 104, 105),
  ],
};

function fill(overrides: Partial<OutcomeFill> = {}): OutcomeFill {
  return {
    qty: 1,
    price_gbp: 100,
    price_native: 125,
    fee_gbp: 0,
    fill_date: '2026-10-06',
    filled_at: null,
    trading_date: '2026-10-06',
    ...overrides,
  };
}

function trade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    bookId: 'debate/primary',
    instrument: 'AAPL',
    entryOrderId: 'entry-1',
    exitOrderId: 'exit-1',
    settledAt: '2026-10-09',
    entry: {
      entry_order_id: 'entry-1',
      decision_id: 'd-1',
      decision_date: '2026-10-05',
      order_date: '2026-10-05',
      sleeve_id: 'debate',
      venue: 'alpaca',
      side: 'buy',
      limit: 125,
      trigger: null,
      quoted: 0,
      quote_fill: null,
      stop: 120,
      target: 135,
      pin_digest: 'pin',
      entry_offset_bps: 50,
    },
    exit: {
      leg: 'exit',
      order_date: '2026-10-07',
      reason: 'time_stop',
      detail: null,
      trigger: null,
    },
    entryFills: [fill()],
    exitFills: [fill({ price_gbp: 110, price_native: 137.5, fill_date: '2026-10-08' })],
    exitShare: 1,
    carryGbp: 0,
    rescaled: false,
    splitBlocked: false,
    ...overrides,
  };
}

const DATES: FillBars = { entry: '2026-10-06', exit: '2026-10-08' };

describe('outcomeOf', () => {
  it('scores a long against its venue index from the entry open to the exit close', () => {
    const broker = trade({
      entryFills: [fill({ filled_at: '2026-10-06T14:30:00Z' })],
      exitFills: [fill({ price_gbp: 110, price_native: 137.5, fill_date: '2026-10-08' })],
    });
    expect(outcomeOf(broker, DATES, SPY)).toMatchObject({
      direction: 'long',
      entry_filled_at: '2026-10-06T14:30:00Z',
      exit_filled_at: null,
      entry_date: '2026-10-06',
      exit_date: '2026-10-08',
      holding_days: 2,
      realised_pnl_gbp: 10,
      trade_return: 0.1,
      r_multiple: 2.5,
      benchmark_symbol: 'SPY',
      benchmark_return: 104 / 101 - 1,
      excess_return: 0.1 - (104 / 101 - 1),
      exit_reason: 'time_stop',
      pin_digest: 'pin',
      entry_offset_bps: 50,
      settled_at: '2026-10-09',
      schema_version: 1,
    });
  });

  it('turns the sign of the index for a short and charges fees and carry', () => {
    const outcome = outcomeOf(
      trade({
        entry: { ...trade().entry, side: 'sell', venue: 'saxo_cfd_usd', stop: 130 },
        entryFills: [fill({ fee_gbp: 1 })],
        exitFills: [
          fill({ price_gbp: 90, price_native: 112.5, fee_gbp: 1, fill_date: '2026-10-08' }),
        ],
        carryGbp: 2,
      }),
      DATES,
      SPY,
    );
    expect(outcome).toMatchObject({
      direction: 'short',
      realised_pnl_gbp: 6,
      fees_gbp: 2,
      carry_gbp: 2,
    });
    expect(outcome?.r_multiple).toBeCloseTo(2.5);
    expect(outcome?.excess_return).toBeCloseTo(0.06 + (104 / 101 - 1));
  });

  it('takes its share of the entry, fees and carry when the entry closed in parts', () => {
    const outcome = outcomeOf(
      trade({
        entryFills: [fill({ qty: 2, fee_gbp: 2 }), fill({ qty: 2, fill_date: '2026-10-05' })],
        exitFills: [fill({ price_gbp: 110, fill_date: '2026-10-08' })],
        exitShare: 0.25,
        carryGbp: 4,
      }),
      DATES,
      SPY,
    );
    expect(outcome).toMatchObject({
      entry_qty: 1,
      exit_qty: 1,
      fees_gbp: 0.5,
      carry_gbp: 1,
      realised_pnl_gbp: 8.5,
    });
  });

  it('leaves R out when a native price, the stop or the risk is missing, or a split landed', () => {
    const noNative = trade({ entryFills: [fill({ price_native: null })] });
    expect(outcomeOf(noNative, DATES, SPY)).toMatchObject({
      r_multiple: null,
      entry_price_native: null,
    });
    expect(
      outcomeOf(trade({ exitFills: [fill({ price_native: null })] }), DATES, SPY)?.r_multiple,
    ).toBeNull();
    expect(
      outcomeOf(trade({ entry: { ...trade().entry, stop: null } }), DATES, SPY)?.r_multiple,
    ).toBeNull();
    expect(
      outcomeOf(trade({ entry: { ...trade().entry, stop: 125 } }), DATES, SPY)?.r_multiple,
    ).toBeNull();
    expect(outcomeOf(trade({ rescaled: true }), DATES, SPY)?.r_multiple).toBeNull();
  });

  it('holds a stop on the entry bar for no session', () => {
    const sameBar = { entry: '2026-10-06', exit: '2026-10-06' };
    expect(outcomeOf(trade(), sameBar, SPY)).toMatchObject({
      entry_date: '2026-10-06',
      exit_date: '2026-10-06',
      holding_days: 0,
      benchmark_return: 102 / 101 - 1,
    });
  });

  it('compares the index price-only, as the trade prices are', () => {
    const adjusted: BarSeries = {
      symbol: 'SPY',
      bars: [{ ...bar('2026-10-06', 100, 100), rawClose: 50 }, bar('2026-10-08', 52, 55)],
    };
    expect(outcomeOf(trade(), DATES, adjusted)?.benchmark_return).toBeCloseTo(0.1);
  });

  it('waits while the index bars do not cover the window', () => {
    expect(outcomeOf(trade(), DATES, undefined)).toBeUndefined();
  });
});

describe('fillBarsOf', () => {
  const AAPL: BarSeries = {
    symbol: 'AAPL',
    bars: [
      bar('2026-10-05', 130, 131),
      bar('2026-10-06', 129, 130),
      bar('2026-10-07', 126, 124),
      bar('2026-10-08', 124, 126),
    ],
  };
  const simulatedEntry = (overrides: Partial<ClosedTrade['entry']> = {}, cycle = '2026-10-09') =>
    trade({
      entry: { ...trade().entry, ...overrides },
      entryFills: [fill({ fill_date: null, trading_date: cycle })],
    });

  it('takes the broker fill dates', () => {
    expect(fillBarsOf(trade(), undefined)).toEqual({ entry: '2026-10-06', exit: '2026-10-08' });
  });

  it('dates a simulated entry by its only bar, or the bar the limit first crossed', () => {
    expect(fillBarsOf(simulatedEntry({ order_date: '2026-10-08' }), AAPL)?.entry).toBe(
      '2026-10-08',
    );
    expect(fillBarsOf(simulatedEntry(), AAPL)?.entry).toBe('2026-10-07');
    expect(fillBarsOf(simulatedEntry({ quoted: 1, quote_fill: 131 }), AAPL)?.entry).toBe(
      '2026-10-05',
    );
  });

  it('leaves a simulated entry undated when the bars cannot say which one filled', () => {
    expect(fillBarsOf(simulatedEntry({ limit: 100 }), AAPL)).toBeUndefined();
    expect(fillBarsOf(simulatedEntry({ limit: null }), AAPL)).toBeUndefined();
    expect(fillBarsOf({ ...simulatedEntry(), rescaled: true }, AAPL)).toBeUndefined();
    expect(fillBarsOf(simulatedEntry(), undefined)).toBeUndefined();
  });

  it('dates each simulated exit by the bar the cycle priced it on', () => {
    const exit = (
      order_date: string,
      overrides: Partial<ClosedTrade> = {},
      detail: string | null = null,
    ) =>
      fillBarsOf(
        trade({
          exit: { leg: 'exit', order_date, reason: null, detail, trigger: null },
          exitFills: [fill({ fill_date: null, trading_date: '2026-10-09' })],
          ...overrides,
        }),
        AAPL,
      )?.exit;
    expect(exit('2026-10-06')).toBe('2026-10-06');
    expect(exit('2026-10-06', { splitBlocked: true })).toBe('2026-10-08');
    expect(exit('2026-10-09')).toBe('2026-10-08');
    expect(exit('2026-10-09', {}, 'stop_on_entry_bar')).toBe('2026-10-06');
    expect(
      fillBarsOf(
        trade({ exitFills: [fill({ fill_date: null, trading_date: '2026-10-09' })] }),
        undefined,
      ),
    ).toBeUndefined();
  });
});

describe('benchmarkWindowOf', () => {
  it('needs a bar on or after the exit bar', () => {
    const short: BarSeries = { symbol: 'SPY', bars: SPY.bars.slice(0, 3) };
    expect(benchmarkWindowOf(short, DATES)).toBeUndefined();
    expect(benchmarkWindowOf(SPY, DATES)).toMatchObject({ sessions: 2 });
  });

  it('refuses an entry after the last bar or a window with no index session', () => {
    expect(benchmarkWindowOf(SPY, { entry: '2026-10-10', exit: '2026-10-09' })).toBeUndefined();
    const weekend = { entry: '2026-10-10', exit: '2026-10-10' };
    const withMonday: BarSeries = { symbol: 'SPY', bars: [...SPY.bars, bar('2026-10-12', 1, 1)] };
    expect(benchmarkWindowOf(withMonday, weekend)).toBeUndefined();
  });
});

describe('exitReasonOf', () => {
  const exit = (overrides: Partial<ClosedTrade['exit']>): ClosedTrade =>
    trade({
      exit: {
        leg: 'exit',
        order_date: '2026-10-07',
        reason: null,
        detail: null,
        trigger: null,
        ...overrides,
      },
    });

  it('takes a venue leg, then the journalled reason', () => {
    expect(exitReasonOf(exit({ leg: 'stop', reason: 'time_stop' }), 1)).toBe('stop');
    expect(exitReasonOf(exit({ leg: 'target' }), 1)).toBe('target');
    expect(exitReasonOf(exit({ reason: 'manual_halt' }), 1)).toBe('manual_halt');
  });

  it('sides a simulated bracket leg by the stop-target midpoint, gaps included', () => {
    const bracket = (trigger: number | null): ClosedTrade =>
      exit({ detail: 'bracket_leg_on_daily_bar', trigger });
    expect(exitReasonOf(bracket(135.0000001), 1)).toBe('target');
    expect(exitReasonOf(bracket(118), 1)).toBe('stop');
    expect(exitReasonOf(bracket(118), -1)).toBe('target');
    expect(exitReasonOf(bracket(null), 1)).toBe('unclassified');
    const noTarget = trade({
      entry: { ...trade().entry, target: null },
      exit: {
        leg: 'exit',
        order_date: '2026-10-07',
        reason: null,
        detail: 'bracket_leg_on_daily_bar',
        trigger: 118,
      },
    });
    expect(exitReasonOf(noTarget, 1)).toBe('unclassified');
  });

  it('names the other simulated exits and leaves an unknown one unclassified', () => {
    expect(exitReasonOf(exit({ detail: 'stop_on_entry_bar' }), 1)).toBe('stop');
    expect(exitReasonOf(exit({ detail: 'series_ended_at_last_close' }), 1)).toBe('series_ended');
    expect(exitReasonOf(exit({ detail: 'something_else' }), 1)).toBe('unclassified');
    expect(exitReasonOf(exit({}), 1)).toBe('unclassified');
  });
});

describe('needsAttention', () => {
  const pending = (reason: 'position_open' | 'fill_bar' | 'benchmark_bars') => ({
    bookId: 'b',
    instrument: 'i',
    exitOrderId: 'x',
    reason,
  });

  it('flags an unmatched close or an undatable fill, not a wait that settles itself', () => {
    const rebuild = { written: 0, settled: 0, unmatched: [] };
    expect(
      needsAttention({
        ...rebuild,
        pending: [pending('position_open'), pending('benchmark_bars')],
      }),
    ).toBe(false);
    expect(needsAttention({ ...rebuild, pending: [pending('fill_bar')] })).toBe(true);
    expect(needsAttention({ ...rebuild, pending: [], unmatched: ['b|x'] })).toBe(true);
  });
});

describe('rebuildDecisionOutcomes', () => {
  let db: StoreHandle;
  afterEach(() => db?.close());

  const bars: BarsSource = { load: (symbol) => (symbol === 'SPY' ? SPY : undefined) };

  function seed(): void {
    db = migratedMemoryStore();
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES ('debate/primary', 'debate', 'primary', 1000, 1000, 'x')`,
    ).run();
    const decision = db.prepare(
      `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash,
         direction, confidence, action, reason, size_shares, stop_price, payload, recorded_at)
       VALUES (?, 'debate/primary', '2026-10-05', ?, ?, 'h', 'long', 0.6, 'enter', 'r', 1, 120, '{}', 'x')`,
    );
    for (const [id, instrument, venue] of [
      ['d-a', 'AAA', 'alpaca'],
      ['d-b', 'BBB', 'alpaca'],
      ['d-c', 'CCC', 'saxo'],
      ['d-d', 'DDD', 'alpaca'],
      ['d-g', 'GGG', 'alpaca'],
    ]) {
      decision.run(id, instrument, venue);
    }
    const order = db.prepare(
      `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
         leg, side, dry_run, outcome, payload, recorded_at)
       VALUES (?, ?, 'debate/primary', '2026-10-05', ?, ?, ?, ?, 0, 'submitted', ?, 'x')`,
    );
    const entryPayload = JSON.stringify({ stop: 120, target: 135, pin_digest: 'pin' });
    for (const row of [
      ['a-entry', 'd-a', 'AAA', 'alpaca', 'entry', 'buy', entryPayload],
      ['a-exit-1', null, 'AAA', 'alpaca', 'exit', 'sell', JSON.stringify({ reason: 'time_stop' })],
      ['a-exit-2', null, 'AAA', 'alpaca', 'exit', 'sell', JSON.stringify({ reason: 'time_stop' })],
      ['b-entry', 'd-b', 'BBB', 'alpaca', 'entry', 'buy', entryPayload],
      ['c-entry', 'd-c', 'CCC', 'saxo', 'entry', 'buy', entryPayload],
      ['d-entry', 'd-d', 'DDD', 'alpaca', 'entry', 'buy', entryPayload],
      ['e-entry', null, 'EEE', 'alpaca', 'entry', 'buy', entryPayload],
      ['e-exit', null, 'EEE', 'alpaca', 'exit', 'sell', '{}'],
      ['f-exit', null, 'FFF', 'alpaca', 'exit', 'sell', '{}'],
      ['g-entry', 'd-g', 'GGG', 'alpaca', 'entry', 'buy', entryPayload],
      ['g-exit', null, 'GGG', 'alpaca', 'exit', 'sell', '{}'],
    ]) {
      order.run(...row);
    }
    const fillRow = db.prepare(
      `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
         side, qty, price_gbp, fee_gbp, recorded_at, broker_mode, price_native, fill_date)
       VALUES (?, ?, 'debate/primary', ?, ?, ?, ?, ?, ?, ?, 0, 'x', 'paper', ?, ?)`,
    );
    for (const row of [
      ['f1', 'a-entry', '2026-10-06', 'AAA', 'alpaca', 'entry', 'buy', 2, 100, 125, '2026-10-06'],
      [
        'f2',
        'a-exit-1',
        '2026-10-07',
        'AAA',
        'alpaca',
        'exit',
        'sell',
        1,
        110,
        137.5,
        '2026-10-07',
      ],
      ['f3', 'a-exit-2', '2026-10-08', 'AAA', 'alpaca', 'exit', 'sell', 1, 90, 112.5, '2026-10-08'],
      ['f4', 'b-entry', '2026-10-06', 'BBB', 'alpaca', 'entry', 'buy', 2, 100, 125, '2026-10-06'],
      ['f5', 'b-entry', '2026-10-07', 'BBB', 'alpaca', 'stop', 'sell', 1, 96, 120, '2026-10-07'],
      ['f6', 'c-entry', '2026-10-06', 'CCC', 'saxo', 'entry', 'buy', 1, 100, 100, '2026-10-06'],
      ['f7', 'c-entry', '2026-10-07', 'CCC', 'saxo', 'target', 'sell', 1, 108, 108, '2026-10-07'],
      ['f8', 'd-entry', '2026-10-06', 'DDD', 'alpaca', 'entry', 'buy', 1, 100, 125, '2026-10-06'],
      ['f9', 'd-entry', '2026-10-08', 'DDD', 'alpaca', 'target', 'sell', 1, 108, 135, '2026-10-08'],
      ['f10', 'e-entry', '2026-10-06', 'EEE', 'alpaca', 'entry', 'buy', 1, 100, 125, '2026-10-06'],
      ['f11', 'e-exit', '2026-10-07', 'EEE', 'alpaca', 'exit', 'sell', 1, 100, 125, '2026-10-07'],
      ['f12', 'f-exit', '2026-10-07', 'FFF', 'alpaca', 'exit', 'sell', 1, 100, 125, '2026-10-07'],
      ['f13', 'g-entry', '2026-10-06', 'GGG', 'alpaca', 'entry', 'buy', 1, 100, 125, null],
      ['f14', 'g-exit', '2026-10-07', 'GGG', 'alpaca', 'exit', 'sell', 1, 100, 125, null],
    ]) {
      fillRow.run(...row);
    }
    db.prepare(
      `INSERT INTO v2_positions (book_id, instrument, venue, qty, avg_price_gbp, client_order_id,
         opened_date, marks_held, updated_at)
       VALUES ('debate/primary', 'BBB', 'alpaca', 1, 100, 'b-entry', '2026-10-06', 0, 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO v2_cfd_carry (book_id, trading_date, instrument, venue, client_order_id,
         financing_gbp, borrow_gbp, recorded_at)
       VALUES ('debate/primary', '2026-10-07', 'AAA', 'alpaca', 'a-entry', 1, 1, 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO v2_rescales (trading_date, book_id, instrument, source, ratio, anchor_date,
         fills_before, qty_before, qty_after, entry_before, entry_after, recorded_at)
       VALUES ('2026-10-07', 'debate/primary', 'DDD', 'detector', 1, '2026-10-06', 0, 1, 1, 100, 100, 'x')`,
    ).run();
  }

  function closedTradeTotal(): number {
    const { trade_count: panel } = new EvidenceReader(db, { now: () => new Date() }).read();
    if (panel.status !== 'fed') throw new Error('no closed trades read');
    return panel.books
      .flatMap((book) => book.by_entry_offset)
      .reduce((sum, row) => sum + row.closed_trades, 0);
  }

  it('settles each final close once and accounts for every closed trade the evidence counts', () => {
    seed();
    const first = rebuildDecisionOutcomes(db, bars);
    expect(first).toMatchObject({ written: 3, settled: 3 });
    expect(first.pending).toEqual([
      {
        bookId: 'debate/primary',
        instrument: 'BBB',
        exitOrderId: 'b-entry',
        reason: 'position_open',
      },
      {
        bookId: 'debate/primary',
        instrument: 'CCC',
        exitOrderId: 'c-entry',
        reason: 'benchmark_bars',
      },
      {
        bookId: 'debate/primary',
        instrument: 'GGG',
        exitOrderId: 'g-exit',
        reason: 'fill_bar',
      },
    ]);
    expect(needsAttention(first)).toBe(true);
    expect(first.unmatched).toEqual(['debate/primary|e-exit', 'debate/primary|f-exit']);
    expect(first.settled + first.pending.length + first.unmatched.length).toBe(closedTradeTotal());

    const rows = db
      .prepare(
        `SELECT exit_client_order_id, exit_reason, entry_qty, realised_pnl_gbp, carry_gbp, r_multiple
           FROM v2_decision_outcomes ORDER BY outcome_id`,
      )
      .all();
    expect(rows).toEqual([
      {
        exit_client_order_id: 'a-exit-1',
        exit_reason: 'time_stop',
        entry_qty: 1,
        realised_pnl_gbp: 9,
        carry_gbp: 1,
        r_multiple: 2.5,
      },
      {
        exit_client_order_id: 'a-exit-2',
        exit_reason: 'time_stop',
        entry_qty: 1,
        realised_pnl_gbp: -11,
        carry_gbp: 1,
        r_multiple: -2.5,
      },
      {
        exit_client_order_id: 'd-entry',
        exit_reason: 'target',
        entry_qty: 1,
        realised_pnl_gbp: 8,
        carry_gbp: 0,
        r_multiple: 2,
      },
    ]);

    const before = db.prepare('SELECT * FROM v2_decision_outcomes ORDER BY outcome_id').all();
    expect(rebuildDecisionOutcomes(db, bars)).toMatchObject({ written: 0, settled: 3 });
    expect(db.prepare('SELECT * FROM v2_decision_outcomes ORDER BY outcome_id').all()).toEqual(
      before,
    );
  });

  it("prices a stray over-sell by the entry's own quantity", () => {
    seed();
    db.prepare(
      `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
         side, qty, price_gbp, fee_gbp, recorded_at, broker_mode, price_native, fill_date)
       VALUES ('f15', 'a-exit-2', 'debate/primary', '2026-10-08', 'AAA', 'alpaca', 'exit', 'sell',
         1, 90, 0, 'x', 'paper', 112.5, '2026-10-08')`,
    ).run();
    rebuildDecisionOutcomes(db, bars);
    expect(
      db
        .prepare(
          `SELECT exit_client_order_id, entry_qty, exit_qty FROM v2_decision_outcomes
            WHERE instrument = 'AAA' ORDER BY outcome_id`,
        )
        .all(),
    ).toEqual([
      { exit_client_order_id: 'a-exit-1', entry_qty: 1, exit_qty: 1 },
      { exit_client_order_id: 'a-exit-2', entry_qty: 2, exit_qty: 2 },
    ]);
  });

  it('nulls R across a split that changed the share count', () => {
    seed();
    db.prepare(
      `INSERT INTO v2_rescales (trading_date, book_id, instrument, source, ratio, anchor_date,
         fills_before, qty_before, qty_after, entry_before, entry_after, recorded_at)
       VALUES ('2026-10-07', 'debate/primary', 'DDD', 'detector', 2, '2026-10-06', 0, 1, 2, 100, 50, 'x')`,
    ).run();
    rebuildDecisionOutcomes(db, bars);
    expect(
      db
        .prepare(
          `SELECT r_multiple FROM v2_decision_outcomes WHERE exit_client_order_id = 'd-entry'`,
        )
        .get(),
    ).toEqual({ r_multiple: null });
  });
});
