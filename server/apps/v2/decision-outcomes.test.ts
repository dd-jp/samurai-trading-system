import { afterEach, describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { EvidenceReader } from './api/evidence.js';
import type { BarsSource } from './data/index.js';
import {
  BENCHMARK_PENDING_MAX_SESSIONS,
  benchmarkWindowOf,
  type ClosedTrade,
  exitReasonOf,
  type FillBars,
  fillBarsOf,
  formatOutcomeRebuild,
  needsAttention,
  type OutcomeFill,
  outcomeOf,
  type PendingReason,
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
    cashInLieu: [],
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
    expect(fillBarsOf(simulatedEntry(), undefined)).toBeUndefined();
  });

  it('leaves a simulated entry undated only when a split falls in its own fill window', () => {
    expect(fillBarsOf({ ...simulatedEntry(), rescaled: true }, AAPL)?.entry).toBe('2026-10-07');
    const splitInWindow: BarSeries = {
      symbol: 'AAPL',
      bars: [
        { ...bar('2026-10-05', 130, 131), close: 65.5 },
        { ...bar('2026-10-06', 129, 130), close: 65 },
        bar('2026-10-07', 63, 62),
        bar('2026-10-08', 62, 63),
      ],
    };
    expect(fillBarsOf(simulatedEntry(), splitInWindow)).toBeUndefined();
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

  it('leaves a simulated bracket leg unclassified after a split, its trigger in new units', () => {
    const splitTarget = trade({
      entry: { ...trade().entry, stop: 90, target: 110 },
      exit: {
        leg: 'exit',
        order_date: '2026-10-07',
        reason: null,
        detail: 'bracket_leg_on_daily_bar',
        trigger: 55,
      },
      rescaled: true,
    });
    expect(exitReasonOf(splitTarget, 1)).toBe('unclassified');
    expect(exitReasonOf({ ...splitTarget, rescaled: false }, 1)).toBe('stop');
  });

  it('names the other simulated exits and leaves an unknown one unclassified', () => {
    expect(exitReasonOf(exit({ detail: 'stop_on_entry_bar' }), 1)).toBe('stop');
    expect(exitReasonOf(exit({ detail: 'series_ended_at_last_close' }), 1)).toBe('series_ended');
    expect(exitReasonOf(exit({ detail: 'something_else' }), 1)).toBe('unclassified');
    expect(exitReasonOf(exit({}), 1)).toBe('unclassified');
  });
});

describe('needsAttention', () => {
  const pending = (reason: PendingReason) => ({
    bookId: 'b',
    instrument: 'i',
    exitOrderId: 'x',
    reason,
  });
  const rebuild = { written: 0, settled: 0, pending: [], unmatched: [], anomalous: [] };

  it('lets a wait that settles itself pass quietly', () => {
    expect(
      needsAttention({
        ...rebuild,
        pending: [pending('position_open'), pending('benchmark_bars')],
      }),
    ).toBe(false);
  });

  it.each(['fill_bar', 'benchmark_missing', 'benchmark_stale'] as const)(
    'flags a close pending on %s',
    (reason) => {
      expect(needsAttention({ ...rebuild, pending: [pending(reason)] })).toBe(true);
    },
  );

  it('flags an unmatched or an anomalous close', () => {
    expect(needsAttention({ ...rebuild, unmatched: ['b|x'] })).toBe(true);
    expect(
      needsAttention({
        ...rebuild,
        anomalous: [{ bookId: 'b', instrument: 'i', exitOrderId: 'x', reason: 'close_side' }],
      }),
    ).toBe(true);
  });
});

describe('rebuildDecisionOutcomes', () => {
  let db: StoreHandle;
  afterEach(() => db?.close());

  const ISF_TO_OCT_6: BarSeries = { symbol: 'ISF', bars: SPY.bars.slice(0, 2) };
  const bars: BarsSource = {
    load: (symbol) => ({ SPY, ISF: ISF_TO_OCT_6 })[symbol as 'SPY' | 'ISF'],
  };

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
    expect(first.anomalous).toEqual([]);
    expect(
      first.settled + first.pending.length + first.unmatched.length + first.anomalous.length,
    ).toBe(closedTradeTotal());

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

  it('reports an over-sell as anomalous and settles none of its closes', () => {
    seed();
    db.prepare(
      `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
         side, qty, price_gbp, fee_gbp, recorded_at, broker_mode, price_native, fill_date)
       VALUES ('f15', 'a-exit-2', 'debate/primary', '2026-10-08', 'AAA', 'alpaca', 'exit', 'sell',
         1, 90, 0, 'x', 'paper', 112.5, '2026-10-08')`,
    ).run();
    const rebuild = rebuildDecisionOutcomes(db, bars);
    expect(db.prepare(`SELECT 1 FROM v2_decision_outcomes WHERE instrument = 'AAA'`).all()).toEqual(
      [],
    );
    expect(rebuild.anomalous).toEqual(
      ['a-exit-1', 'a-exit-2'].map((exitOrderId) => ({
        bookId: 'debate/primary',
        instrument: 'AAA',
        exitOrderId,
        reason: 'closed_qty',
      })),
    );
    expect(formatOutcomeRebuild(rebuild)).toContain(
      'anomalous debate/primary AAA a-exit-1: closed_qty',
    );
  });

  it('nulls R across a split that changed the share count', () => {
    seed();
    db.prepare(
      `INSERT INTO v2_rescales (trading_date, book_id, instrument, source, ratio, anchor_date,
         fills_before, qty_before, qty_after, entry_before, entry_after, recorded_at)
       VALUES ('2026-10-07', 'debate/primary', 'DDD', 'detector', 2, '2026-10-06', 0, 1, 2, 100, 50, 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
         side, qty, price_gbp, fee_gbp, recorded_at, broker_mode, price_native, fill_date)
       VALUES ('f16', 'd-entry', 'debate/primary', '2026-10-08', 'DDD', 'alpaca', 'target', 'sell',
         1, 54, 0, 'x', 'paper', 67.5, '2026-10-08')`,
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

describe('rebuildDecisionOutcomes across splits, strays and missing index bars', () => {
  const stores: StoreHandle[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  interface Leg {
    readonly instrument: string;
    readonly side: 'buy' | 'sell';
    readonly qty: number;
    readonly priceGbp: number;
    readonly date: string;
    readonly venue?: string;
    readonly leg?: string;
  }

  function journal(): StoreHandle {
    const db = migratedMemoryStore();
    stores.push(db);
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES ('debate/primary', 'debate', 'primary', 1000, 1000, 'x')`,
    ).run();
    return db;
  }

  function order(db: StoreHandle, id: string, decisionId: string | null, leg: Leg, payload = {}) {
    db.prepare(
      `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
         leg, side, dry_run, outcome, payload, recorded_at)
       VALUES (?, ?, 'debate/primary', ?, ?, ?, ?, ?, 0, 'submitted', ?, 'x')`,
    ).run(
      id,
      decisionId,
      leg.date,
      leg.instrument,
      leg.venue ?? 'alpaca',
      decisionId === null ? 'exit' : 'entry',
      leg.side,
      JSON.stringify(payload),
    );
  }

  function fill(db: StoreHandle, orderId: string, leg: Leg): void {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM v2_fills').get() as { n: number };
    db.prepare(
      `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
         side, qty, price_gbp, fee_gbp, recorded_at, broker_mode, price_native, fill_date)
       VALUES (?, ?, 'debate/primary', ?, ?, ?, ?, ?, ?, ?, 0, 'x', 'paper', ?, ?)`,
    ).run(
      `fill-${n}`,
      orderId,
      leg.date,
      leg.instrument,
      leg.venue ?? 'alpaca',
      leg.leg ?? 'exit',
      leg.side,
      leg.qty,
      leg.priceGbp,
      leg.priceGbp * 1.25,
      leg.date,
    );
  }

  function enter(db: StoreHandle, id: string, leg: Leg): void {
    db.prepare(
      `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash,
         direction, confidence, action, reason, size_shares, stop_price, payload, recorded_at)
       VALUES (?, 'debate/primary', ?, ?, ?, 'h', 'long', 0.6, 'enter', 'r', 1, 1, '{}', 'x')`,
    ).run(`d-${id}`, leg.date, leg.instrument, leg.venue ?? 'alpaca');
    order(db, id, `d-${id}`, leg, { stop: leg.priceGbp * 1.25 * 0.9, target: 999 });
    fill(db, id, { ...leg, leg: 'entry' });
  }

  function exit(db: StoreHandle, id: string, leg: Leg): void {
    order(db, id, null, leg, { reason: 'time_stop' });
    fill(db, id, leg);
  }

  function rescale(db: StoreHandle, instrument: string, ratio: number, date: string): void {
    db.prepare(
      `INSERT INTO v2_rescales (trading_date, book_id, instrument, source, ratio, anchor_date,
         fills_before, qty_before, qty_after, entry_before, entry_after, recorded_at)
       VALUES (?, 'debate/primary', ?, 'detector', ?, ?,
         (SELECT COUNT(*) FROM v2_fills WHERE trading_date = ?), 1, 1, 1, 1, 'x')`,
    ).run(date, instrument, ratio, date, date);
  }

  const source = (series: Readonly<Record<string, BarSeries>>): BarsSource => ({
    load: (symbol) => series[symbol],
  });

  const spyOnly = source({ SPY });

  function rows(db: StoreHandle): unknown[] {
    return (
      db
        .prepare('SELECT * FROM v2_decision_outcomes ORDER BY book_id, exit_client_order_id')
        .all() as Record<string, unknown>[]
    ).map(({ outcome_id: _id, ...row }) => row);
  }

  const SPLIT = 'SPL';

  function splitAndClose(db: StoreHandle): void {
    enter(db, 'spl-entry', {
      instrument: SPLIT,
      side: 'buy',
      qty: 5,
      priceGbp: 150,
      date: '2026-10-06',
    });
    rescale(db, SPLIT, 1.5, '2026-10-07');
    fill(db, 'spl-entry', {
      instrument: SPLIT,
      side: 'sell',
      qty: 0.5,
      priceGbp: 100,
      date: '2026-10-07',
      leg: 'cash_in_lieu',
    });
    exit(db, 'spl-exit', {
      instrument: SPLIT,
      side: 'sell',
      qty: 7,
      priceGbp: 100,
      date: '2026-10-08',
    });
  }

  it('books the cash in lieu a split paid as part of the exit, so a flat price nets to nothing', () => {
    const db = journal();
    splitAndClose(db);
    const rebuild = rebuildDecisionOutcomes(db, spyOnly);
    expect(rebuild).toMatchObject({ written: 1, pending: [], anomalous: [] });
    expect(
      db
        .prepare(
          'SELECT entry_qty, exit_qty, realised_pnl_gbp, r_multiple FROM v2_decision_outcomes',
        )
        .get(),
    ).toEqual({
      entry_qty: expect.closeTo(5, 9),
      exit_qty: 7,
      realised_pnl_gbp: expect.closeTo(0, 9),
      r_multiple: null,
    });
  });

  it('reports a close on the entry side, or past the entry quantity, as anomalous and keeps the settled close', () => {
    const db = journal();
    const leg = { instrument: 'STR', qty: 1 } as const;
    enter(db, 'str-entry', { ...leg, side: 'buy', priceGbp: 100, date: '2026-10-06' });
    exit(db, 'str-exit', { ...leg, side: 'sell', priceGbp: 110, date: '2026-10-07' });
    exit(db, 'str-buyback', { ...leg, side: 'buy', priceGbp: 105, date: '2026-10-08' });
    exit(db, 'str-oversell', { ...leg, side: 'sell', priceGbp: 104, date: '2026-10-08' });
    const rebuild = rebuildDecisionOutcomes(db, spyOnly);
    const anomaly = (exitOrderId: string, reason: string) => ({
      bookId: 'debate/primary',
      instrument: 'STR',
      exitOrderId,
      reason,
    });
    expect(rebuild.anomalous).toEqual([
      anomaly('str-buyback', 'close_side'),
      anomaly('str-oversell', 'closed_qty'),
    ]);
    expect(
      db.prepare('SELECT exit_client_order_id, realised_pnl_gbp FROM v2_decision_outcomes').all(),
    ).toEqual([{ exit_client_order_id: 'str-exit', realised_pnl_gbp: 10 }]);
  });

  it('writes the same rows from scratch on a fresh copy as run by run (#2146 ruling 1)', () => {
    const later = (db: StoreHandle) => {
      exit(db, 'spl-stray', {
        instrument: SPLIT,
        side: 'sell',
        qty: 1,
        priceGbp: 99,
        date: '2026-10-09',
      });
      const leg = { instrument: 'NEW', qty: 2 } as const;
      enter(db, 'new-entry', { ...leg, side: 'buy', priceGbp: 50, date: '2026-10-07' });
      exit(db, 'new-exit', { ...leg, side: 'sell', priceGbp: 55, date: '2026-10-09' });
    };
    const incremental = journal();
    splitAndClose(incremental);
    expect(rebuildDecisionOutcomes(incremental, spyOnly).written).toBe(1);
    later(incremental);
    expect(rebuildDecisionOutcomes(incremental, spyOnly)).toMatchObject({
      written: 1,
      anomalous: [expect.objectContaining({ exitOrderId: 'spl-stray', reason: 'closed_qty' })],
    });

    const fresh = journal();
    splitAndClose(fresh);
    later(fresh);
    expect(rebuildDecisionOutcomes(fresh, spyOnly).written).toBe(2);
    expect(rows(fresh)).toEqual(rows(incremental));
  });

  it('warns when the venue index series is absent', () => {
    const db = journal();
    const leg = { instrument: 'LSE1', venue: 'saxo', qty: 1, priceGbp: 10 } as const;
    enter(db, 'lse-entry', { ...leg, side: 'buy', date: '2026-10-06' });
    exit(db, 'lse-exit', { ...leg, side: 'sell', date: '2026-10-07' });
    const rebuild = rebuildDecisionOutcomes(db, spyOnly);
    expect(rebuild.pending).toEqual([
      {
        bookId: 'debate/primary',
        instrument: 'LSE1',
        exitOrderId: 'lse-exit',
        reason: 'benchmark_missing',
      },
    ]);
    expect(needsAttention(rebuild)).toBe(true);
  });

  it(`warns once the trade's own series runs ${BENCHMARK_PENDING_MAX_SESSIONS} sessions past an exit the index has no bar for`, () => {
    const db = journal();
    const leg = { instrument: 'GAP', qty: 1, priceGbp: 10, date: '2026-10-10' } as const;
    enter(db, 'gap-entry', { ...leg, side: 'buy' });
    exit(db, 'gap-stop', { ...leg, side: 'sell' });
    const spy: BarSeries = { symbol: 'SPY', bars: [...SPY.bars, bar('2026-10-12', 105, 106)] };
    const gap = (sessions: number): BarSeries => ({
      symbol: 'GAP',
      bars: ['2026-10-10', '2026-10-12', '2026-10-13', '2026-10-14']
        .slice(0, sessions + 1)
        .map((date) => bar(date, 10, 10)),
    });
    const reasonAfter = (sessions: number) =>
      rebuildDecisionOutcomes(db, source({ SPY: spy, GAP: gap(sessions) })).pending.map(
        (row) => row.reason,
      );
    expect(reasonAfter(BENCHMARK_PENDING_MAX_SESSIONS - 1)).toEqual(['benchmark_bars']);
    expect(reasonAfter(BENCHMARK_PENDING_MAX_SESSIONS)).toEqual(['benchmark_stale']);
  });
});
