import { describe, expect, it } from 'vitest';
import type { JournalledOrder, Sleeve, SleeveDecision } from '../../../../contracts/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { migratedMemoryStore } from '../../../shared/store/index.js';
import { CapitalConfigStore, PaperBooks } from '../risk/index.js';
import { inputsHash, Journal } from './journal.js';

const CAPTURED = {
  currency: 'USD',
  price_native: 100,
  fee_native: 0,
  fx_quote_per_gbp: 1.25,
  fx_source: 'boe-xudluss:year-start:2026@2025-12-31',
  fill_date: null,
  broker_mode: 'paper',
} as const;

const decision: SleeveDecision = {
  sleeve_id: 'debate',
  instrument: 'AAPL',
  venue: 'alpaca',
  direction: 'bullish',
  confidence: 0.7,
  action: 'enter_long',
  reason: 'judge bullish',
  price: 100,
  atr: 2,
  stop_price: 96,
  inputs_hash: 'abc',
  debate_id: 'd1',
  payload: { rounds: 1 },
};

const DEBATE: Pick<Sleeve, 'id' | 'spec'> = {
  id: 'debate',
  spec: {
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
  },
};

describe('Journal', () => {
  const clock = new SimulatedClock(new Date('2026-09-25T12:00:00.000Z'));

  it('names only the refusals the previous recorded day did not already carry, never entry sizing', () => {
    const journal = new Journal(migratedMemoryStore(), clock);
    const refuse = (trading_date: string, scope: string, parameter: string, message: string) =>
      journal.recordRefusal({ trading_date, scope, parameter, ticket: '#1', message });
    refuse('2026-09-24', 'data', 'OLD', 'gone');
    refuse('2026-09-25', 'parameter', 'UNSET', 'not set');
    refuse('2026-09-25', 'data', 'MARK', 'AAPL stale');
    refuse('2026-09-28', 'parameter', 'UNSET', 'not set');
    refuse('2026-09-28', 'data', 'MARK', 'MSFT stale');
    refuse('2026-09-28', 'entry', 'ADV_WINDOW_COVERAGE', 'AAPL no_adv');
    refuse('2026-09-28', 'data', 'OLD', 'gone');
    refuse('2026-09-29', 'parameter', 'UNSET', 'not set');
    const shape = (parameter: string, scope: string, message: string, date = '2026-09-28') => ({
      trading_date: date,
      scope,
      parameter,
      ticket: '#1',
      message,
    });
    expect(journal.newRefusals('2026-09-28')).toEqual([
      shape('MARK', 'data', 'MSFT stale'),
      shape('OLD', 'data', 'gone'),
    ]);
    expect(journal.newRefusals('2026-09-25')).toEqual([
      shape('UNSET', 'parameter', 'not set', '2026-09-25'),
      shape('MARK', 'data', 'AAPL stale', '2026-09-25'),
    ]);
    expect(journal.newRefusals('2026-09-24')).toEqual([shape('OLD', 'data', 'gone', '2026-09-24')]);
    expect(journal.newRefusals('2026-09-29')).toEqual([]);
    expect(journal.newRefusals('2026-09-30')).toEqual([]);
  });

  it('records decisions, orders, fills and refusals and reads an order back by id', () => {
    const db = migratedMemoryStore();
    const capital = new CapitalConfigStore(db, clock);
    capital.setYear(2026, 1_000, 1_500);
    new PaperBooks(db, clock, capital, '2026-09-25', [DEBATE]);
    const journal = new Journal(db, clock);
    const decisionId = journal.recordDecision('debate/primary', '2026-09-25', decision, 3);
    const order: JournalledOrder = {
      client_order_id: 'o1',
      decision_id: decisionId,
      book_id: 'debate/primary',
      trading_date: '2026-09-25',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: true,
      outcome: 'refused_dry_run',
      payload: { size: 3, stop: 96 },
    };
    journal.recordOrder(order);
    expect(journal.orderFor('o1')).toEqual(order);
    expect(journal.orderFor('missing')).toBeUndefined();
    const fill = {
      ...CAPTURED,
      fill_id: 'alpaca:f1',
      client_order_id: 'o1',
      book_id: 'debate/primary',
      trading_date: '2026-09-25',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy' as const,
      qty: 3,
      price_gbp: 80,
      fee_gbp: 0.1,
    };
    expect(journal.recordFill(fill)).toBe(true);
    expect(journal.recordFill(fill)).toBe(false);
    journal.recordRefusal({
      trading_date: '2026-09-25',
      scope: 'universe',
      parameter: 'G18_SMALL_CAP_FLOORS',
      ticket: '#1753',
      message: 'unset',
    });
    const stored = db
      .prepare('SELECT payload, size_shares, stop_price FROM v2_decisions')
      .get() as { payload: string; size_shares: number; stop_price: number };
    expect(JSON.parse(stored.payload)).toEqual({ rounds: 1, debate_id: 'd1' });
    expect(stored.size_shares).toBe(3);
    expect(stored.stop_price).toBe(96);
    expect(db.prepare('SELECT COUNT(*) AS n FROM v2_fills').get()).toEqual({ n: 1 });
    const refusal = db.prepare('SELECT parameter, ticket FROM v2_refusals').get();
    expect(refusal).toEqual({ parameter: 'G18_SMALL_CAP_FLOORS', ticket: '#1753' });
  });

  it("reads back a broker order's fill parts: the bare id and its '#' top-ups, never a longer id", () => {
    const db = migratedMemoryStore();
    const journal = new Journal(db, clock);
    journal.recordOrder({
      client_order_id: 'o1',
      decision_id: null,
      book_id: 'debate/primary',
      trading_date: '2026-09-25',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: false,
      outcome: 'submitted',
      payload: {},
    });
    const base = {
      client_order_id: 'o1',
      book_id: 'debate/primary',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy' as const,
      fee_gbp: 0,
    };
    journal.recordFill({
      ...base,
      ...CAPTURED,
      fill_id: 'alpaca:f1',
      trading_date: '2026-09-25',
      qty: 4,
      price_gbp: 16,
    });
    journal.recordFill({
      ...base,
      ...CAPTURED,
      fill_id: 'alpaca:f1#10',
      trading_date: '2026-09-28',
      qty: 6,
      price_gbp: 17,
      fee_gbp: 0.2,
    });
    journal.recordFill({
      ...base,
      ...CAPTURED,
      fill_id: 'alpaca:f10',
      trading_date: '2026-09-25',
      qty: 1,
      price_gbp: 1,
    });
    journal.recordFill({
      ...base,
      ...CAPTURED,
      fill_id: 'alpaca:f1x#2',
      trading_date: '2026-09-25',
      qty: 1,
      price_gbp: 1,
    });
    expect([...journal.fillPartsOf('alpaca:f1')].sort((a, b) => a.qty - b.qty)).toEqual([
      { qty: 4, price_gbp: 16, fee_gbp: 0, trading_date: '2026-09-25' },
      { qty: 6, price_gbp: 17, fee_gbp: 0.2, trading_date: '2026-09-28' },
    ]);
    expect(journal.fillPartsOf('alpaca:f%')).toEqual([]);
    expect(journal.fillPartsOf('alpaca:none')).toEqual([]);
  });

  it('records a refusal scoped to a book and instrument, and leaves both NULL when unset', () => {
    const db = migratedMemoryStore();
    const journal = new Journal(db, clock);
    journal.recordRefusal({
      trading_date: '2026-09-25',
      scope: 'entry',
      parameter: 'ADV_WINDOW_COVERAGE',
      ticket: '#1806',
      message: 'debate/primary THIN: no_adv',
      book_id: 'debate/primary',
      instrument: 'THIN',
    });
    journal.recordRefusal({
      trading_date: '2026-09-25',
      scope: 'control',
      parameter: 'MANUAL_PAUSE',
      ticket: '#1745',
      message: 'paused',
    });
    expect(
      db
        .prepare('SELECT parameter, book_id, instrument FROM v2_refusals ORDER BY refusal_id')
        .all(),
    ).toEqual([
      { parameter: 'ADV_WINDOW_COVERAGE', book_id: 'debate/primary', instrument: 'THIN' },
      { parameter: 'MANUAL_PAUSE', book_id: null, instrument: null },
    ]);
  });

  it('records an identical refusal once per trading date, and once more on the next (#1907)', () => {
    const db = migratedMemoryStore();
    const faults: unknown[] = [];
    const journal = new Journal(db, clock, { record: (fault) => faults.push(fault) });
    const saxo = (trading_date: string) =>
      journal.recordRefusal({
        trading_date,
        scope: 'data',
        parameter: 'SAXO_SESSION',
        ticket: '#1876',
        message: 'LSE leg refused: the Saxo live session was lost',
      });
    const stale = (instrument: string) =>
      journal.recordRefusal({
        trading_date: '2026-09-25',
        scope: 'data',
        parameter: 'MARK_FRESHNESS',
        ticket: '#1804',
        message: `debate/primary ${instrument}: stale`,
        book_id: 'debate/primary',
        instrument,
      });
    saxo('2026-09-25');
    saxo('2026-09-25');
    stale('AAPL');
    stale('AAPL');
    stale('MSFT');
    saxo('2026-09-28');
    expect(
      db
        .prepare('SELECT trading_date, parameter, instrument FROM v2_refusals ORDER BY refusal_id')
        .all(),
    ).toEqual([
      { trading_date: '2026-09-25', parameter: 'SAXO_SESSION', instrument: null },
      { trading_date: '2026-09-25', parameter: 'MARK_FRESHNESS', instrument: 'AAPL' },
      { trading_date: '2026-09-25', parameter: 'MARK_FRESHNESS', instrument: 'MSFT' },
      { trading_date: '2026-09-28', parameter: 'SAXO_SESSION', instrument: null },
    ]);
    expect(faults).toHaveLength(4);
    expect(journal.newRefusals('2026-09-25').map((refusal) => refusal.parameter)).toEqual([
      'SAXO_SESSION',
      'MARK_FRESHNESS',
      'MARK_FRESHNESS',
    ]);
  });

  it('lists submitted entries from earlier dates that never filled and marks them cancelled', () => {
    const db = migratedMemoryStore();
    const capital = new CapitalConfigStore(db, clock);
    capital.setYear(2026, 1_000, 1_500);
    new PaperBooks(db, clock, capital, '2026-09-25', [DEBATE]);
    const journal = new Journal(db, clock);
    const base: JournalledOrder = {
      client_order_id: 'old',
      decision_id: null,
      book_id: 'debate/primary',
      trading_date: '2026-09-24',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: false,
      outcome: 'submitted',
      payload: {},
    };
    journal.recordOrder(base);
    journal.recordOrder({ ...base, client_order_id: 'filled', instrument: 'MSFT' });
    journal.recordOrder({ ...base, client_order_id: 'today', trading_date: '2026-09-25' });
    journal.recordOrder({ ...base, client_order_id: 'exit', leg: 'exit', side: 'sell' });
    journal.recordOrder({ ...base, client_order_id: 'refused', outcome: 'refused_dry_run' });
    journal.recordFill({
      ...CAPTURED,
      fill_id: 'alpaca:1',
      client_order_id: 'filled',
      book_id: 'debate/primary',
      trading_date: '2026-09-24',
      instrument: 'MSFT',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      qty: 1,
      price_gbp: 1,
      fee_gbp: 0,
    });
    expect(
      journal.unfilledEntriesBefore('debate/primary', '2026-09-25').map((o) => o.client_order_id),
    ).toEqual(['old']);
    journal.markCancelled('old', '2026-09-25');
    expect(journal.orderFor('old')).toMatchObject({
      outcome: 'cancelled',
      payload: { cancelled: '2026-09-25' },
    });
    expect(journal.unfilledEntriesBefore('debate/primary', '2026-09-25')).toEqual([]);
  });

  it('lists broker entries booked below their size, before a date or at any date (#1990)', () => {
    const db = migratedMemoryStore();
    const capital = new CapitalConfigStore(db, clock);
    capital.setYear(2026, 1_000, 1_500);
    new PaperBooks(db, clock, capital, '2026-09-25', [DEBATE]);
    const journal = new Journal(db, clock);
    const base: JournalledOrder = {
      client_order_id: 'part',
      decision_id: null,
      book_id: 'debate/primary',
      trading_date: '2026-09-23',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: false,
      outcome: 'submitted',
      payload: { size: 10 },
    };
    const fill = (clientOrderId: string, qty: number, leg = 'entry', n = 1) =>
      journal.recordFill({
        ...CAPTURED,
        fill_id: `alpaca:${clientOrderId}-${leg}-${n}`,
        client_order_id: clientOrderId,
        book_id: 'debate/primary',
        trading_date: '2026-09-24',
        instrument: 'AAPL',
        venue: 'alpaca',
        leg: leg as 'entry',
        side: 'buy',
        qty,
        price_gbp: 1,
        fee_gbp: 0,
      });
    journal.recordOrder(base);
    journal.recordOrder({ ...base, client_order_id: 'full' });
    journal.recordOrder({ ...base, client_order_id: 'none' });
    journal.recordOrder({ ...base, client_order_id: 'today', trading_date: '2026-09-25' });
    journal.recordOrder({ ...base, client_order_id: 'gone', outcome: 'cancelled' });
    journal.recordOrder({ ...base, client_order_id: 'other', book_id: 'debate/no-veto' });
    fill('part', 3);
    fill('part', 1, 'entry', 2);
    fill('part', 6, 'stop');
    fill('full', 10);
    fill('today', 4);
    fill('gone', 4);
    fill('other', 4);
    const ids = (before?: string) =>
      journal.partFilledEntries('debate/primary', before).map((order) => order.client_order_id);
    expect(ids('2026-09-25')).toEqual(['part']);
    expect(ids()).toEqual(['part', 'today']);
  });

  it('lists unfilled simulated and dry-run entries from earlier dates, oldest first', () => {
    const db = migratedMemoryStore();
    const capital = new CapitalConfigStore(db, clock);
    capital.setYear(2026, 1_000, 1_500);
    new PaperBooks(db, clock, capital, '2026-09-25', [DEBATE]);
    const journal = new Journal(db, clock);
    const base: JournalledOrder = {
      client_order_id: 'b-sim',
      decision_id: null,
      book_id: 'debate/primary',
      trading_date: '2026-09-24',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: true,
      outcome: 'simulated',
      payload: {},
    };
    journal.recordOrder(base);
    journal.recordOrder({ ...base, client_order_id: 'a-dry', outcome: 'refused_dry_run' });
    journal.recordOrder({ ...base, client_order_id: 'z-early', trading_date: '2026-09-23' });
    journal.recordOrder({ ...base, client_order_id: 'today', trading_date: '2026-09-25' });
    journal.recordOrder({ ...base, client_order_id: 'submitted', outcome: 'submitted' });
    journal.recordOrder({ ...base, client_order_id: 'rejected', outcome: 'rejected' });
    journal.recordOrder({ ...base, client_order_id: 'cancelled', outcome: 'cancelled' });
    journal.recordOrder({ ...base, client_order_id: 'exit', leg: 'exit', side: 'sell' });
    journal.recordOrder({ ...base, client_order_id: 'filled' });
    journal.recordOrder({
      ...base,
      client_order_id: 'shadow',
      book_id: 'debate/no-macro-gate',
      trading_date: '2026-09-25',
    });
    journal.recordFill({
      ...CAPTURED,
      fill_id: 'alpaca:sim-filled',
      client_order_id: 'filled',
      book_id: 'debate/primary',
      trading_date: '2026-09-25',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      qty: 1,
      price_gbp: 1,
      fee_gbp: 0,
    });
    expect(
      journal.unfilledSimulatedEntriesBefore('2026-09-25').map((o) => o.client_order_id),
    ).toEqual(['z-early', 'a-dry', 'b-sim']);
    expect(journal.unfilledSimulatedEntriesBefore('2026-09-24')).toMatchObject([
      { client_order_id: 'z-early', dry_run: true, payload: {} },
    ]);
    expect(journal.restingEntries('debate/primary').map((o) => o.client_order_id)).toEqual([
      'z-early',
      'a-dry',
      'b-sim',
      'submitted',
      'today',
    ]);
    expect(journal.restingEntries('debate/no-macro-gate').map((o) => o.client_order_id)).toEqual([
      'shadow',
    ]);
  });

  it('hashes the same inputs to the same digest and different inputs differently', () => {
    const bar = {
      date: '2026-09-25',
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 1,
      rawClose: 1.5,
    };
    const view = {
      trace_id: 't',
      analyst_id: 'technical',
      analyst_type: 'technical',
      direction: 'bullish' as const,
      confidence: 0.6,
      key_points: ['up'],
      timestamp: new Date('2026-09-25T00:00:00.000Z'),
    };
    const models = ['a', 'b', 'judge'];
    const first = inputsHash([bar], [view], models);
    expect(first).toBe(
      inputsHash([bar], [{ ...view, trace_id: 'other', timestamp: new Date(0) }], models),
    );
    expect(first).not.toBe(inputsHash([bar], [{ ...view, direction: 'bearish' }], models));
    expect(first).not.toBe(inputsHash([bar], [{ ...view, key_points: ['headline'] }], models));
    expect(first).not.toBe(inputsHash([{ ...bar, close: 2 }], [view], models));
    expect(first).not.toBe(inputsHash([bar], [view], ['b', 'a', 'judge']));
  });
});

describe('Journal.recordReconcile (#1872)', () => {
  it('appends each run with its diff, and the row can be neither changed nor removed', () => {
    const db = migratedMemoryStore();
    const journal = new Journal(db, new SimulatedClock(new Date('2026-09-28T07:00:00.000Z')));
    journal.recordReconcile({
      trading_date: '2026-09-28',
      venue: 'alpaca',
      source: 'broker',
      status: 'mismatch',
      book_ids: ['debate/primary'],
      diffs: [{ kind: 'position_qty', instrument: 'AAPL', order_id: null, store: 6, broker: 5 }],
      detail: 'position_qty AAPL store 6 broker 5',
      broker_mode: 'paper',
      cash_quote: null,
    });

    expect(
      db
        .prepare(
          'SELECT trading_date, venue, source, status, book_ids, diffs, detail, recorded_at FROM v2_reconciles',
        )
        .all(),
    ).toEqual([
      {
        trading_date: '2026-09-28',
        venue: 'alpaca',
        source: 'broker',
        status: 'mismatch',
        book_ids: '["debate/primary"]',
        diffs: '[{"kind":"position_qty","instrument":"AAPL","order_id":null,"store":6,"broker":5}]',
        detail: 'position_qty AAPL store 6 broker 5',
        recorded_at: '2026-09-28T07:00:00.000Z',
      },
    ]);
    expect(() => db.prepare("UPDATE v2_reconciles SET status = 'clean'").run()).toThrow();
    expect(() => db.prepare('DELETE FROM v2_reconciles').run()).toThrow();
  });
});

describe('decision and fill journal append-only (#1883)', () => {
  const clock = new SimulatedClock(new Date('2026-09-25T12:00:00.000Z'));

  function journalWithOneFill() {
    const db = migratedMemoryStore();
    const capital = new CapitalConfigStore(db, clock);
    capital.setYear(2026, 1_000, 1_500);
    new PaperBooks(db, clock, capital, '2026-09-25', [DEBATE]);
    const journal = new Journal(db, clock);
    const decisionId = journal.recordDecision('debate/primary', '2026-09-25', decision, 3);
    journal.recordOrder({
      client_order_id: 'o1',
      decision_id: decisionId,
      book_id: 'debate/primary',
      trading_date: '2026-09-25',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: false,
      outcome: 'submitted',
      payload: {},
    });
    const fill = {
      ...CAPTURED,
      fill_id: 'alpaca:f1',
      client_order_id: 'o1',
      book_id: 'debate/primary',
      trading_date: '2026-09-25',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy' as const,
      qty: 3,
      price_gbp: 80,
      fee_gbp: 0.1,
    };
    return { db, journal, fill, firstInsert: journal.recordFill(fill) };
  }

  it('inserts, and a replayed fill id is ignored rather than refused', () => {
    const { db, journal, fill, firstInsert } = journalWithOneFill();
    expect(firstInsert).toBe(true);
    expect(journal.recordFill(fill)).toBe(false);
    expect(journal.recordFill({ ...fill, fill_id: 'alpaca:f2' })).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM v2_decisions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT fill_id FROM v2_fills ORDER BY fill_id').all()).toEqual([
      { fill_id: 'alpaca:f1' },
      { fill_id: 'alpaca:f2' },
    ]);
  });

  it('refuses every update and delete and leaves the rows as written', () => {
    const { db } = journalWithOneFill();
    const decisionsBefore = db.prepare('SELECT * FROM v2_decisions').all();
    const fillsBefore = db.prepare('SELECT * FROM v2_fills').all();

    expect(() => db.prepare("UPDATE v2_decisions SET action = 'exit'").run()).toThrow(
      'v2_decisions is append-only',
    );
    expect(() => db.prepare('DELETE FROM v2_decisions').run()).toThrow(
      'v2_decisions is append-only',
    );
    expect(() => db.prepare('UPDATE v2_fills SET qty = 1').run()).toThrow(
      'v2_fills is append-only',
    );
    expect(() => db.prepare('DELETE FROM v2_fills').run()).toThrow('v2_fills is append-only');
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO v2_decisions SELECT decision_id, book_id, trading_date,
             instrument, venue, inputs_hash, direction, confidence, 'exit', reason, size_shares,
             stop_price, payload, recorded_at FROM v2_decisions`,
        )
        .run(),
    ).toThrow('v2_decisions is append-only');
    expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO v2_fills SELECT fill_seq, fill_id, client_order_id, book_id,
             trading_date, instrument, venue, leg, side, 1, price_gbp, fee_gbp, recorded_at,
             currency, price_native, fee_native, fx_quote_per_gbp, fx_source, fill_date, filled_at,
             broker_mode
           FROM v2_fills`,
        )
        .run().changes,
    ).toBe(0);

    expect(db.prepare('SELECT * FROM v2_decisions').all()).toEqual(decisionsBefore);
    expect(db.prepare('SELECT * FROM v2_fills').all()).toEqual(fillsBefore);
  });
});

describe('Journal.latestReconcile (#1941)', () => {
  function run(
    journal: Journal,
    tradingDate: string,
    venue: 'alpaca' | 'saxo',
    source: 'broker' | 'simulated',
    status: 'clean' | 'mismatch' | 'read_failed',
    bookIds: string[],
  ): void {
    journal.recordReconcile({
      trading_date: tradingDate,
      venue,
      source,
      status,
      book_ids: bookIds,
      diffs: [],
      detail: '',
      broker_mode: 'paper',
      cash_quote: null,
    });
  }

  it('reads nothing reconciled on a day with no run', () => {
    const journal = new Journal(migratedMemoryStore(), new SimulatedClock(new Date()));
    run(journal, '2026-09-29', 'alpaca', 'broker', 'clean', ['signals/primary']);
    const verdict = journal.latestReconcile('2026-09-30', 'alpaca');
    expect([...verdict.reconciled]).toEqual([]);
    expect([...verdict.blocked]).toEqual([]);
  });

  it('reads the venue latest run per source, and blocks a book any of those left unclean', () => {
    const journal = new Journal(migratedMemoryStore(), new SimulatedClock(new Date()));
    run(journal, '2026-09-30', 'alpaca', 'broker', 'mismatch', [
      'debate/primary',
      'signals/primary',
    ]);
    run(journal, '2026-09-30', 'saxo', 'broker', 'read_failed', ['signals/primary']);
    run(journal, '2026-09-30', 'alpaca', 'simulated', 'mismatch', ['signals/no-veto']);
    run(journal, '2026-09-30', 'alpaca', 'broker', 'clean', ['debate/primary', 'signals/primary']);
    const alpaca = journal.latestReconcile('2026-09-30', 'alpaca');
    expect([...alpaca.reconciled].sort()).toEqual([
      'debate/primary',
      'signals/no-veto',
      'signals/primary',
    ]);
    expect([...alpaca.blocked]).toEqual(['signals/no-veto']);
    const saxo = journal.latestReconcile('2026-09-30', 'saxo');
    expect([...saxo.blocked]).toEqual(['signals/primary']);
  });
});

describe('tax capture on fills and the split journal (#1947)', () => {
  const clock = new SimulatedClock(new Date('2026-10-02T07:00:00.000Z'));

  it('stores the native price, currency, FX rate and source and the fill date of each fill', () => {
    const db = migratedMemoryStore();
    const journal = new Journal(db, clock);
    journal.recordOrder({
      client_order_id: 'o1',
      decision_id: null,
      book_id: 'debate/primary',
      trading_date: '2026-10-02',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: false,
      outcome: 'submitted',
      payload: {},
    });
    journal.recordFill({
      fill_id: 'alpaca:f1',
      client_order_id: 'o1',
      book_id: 'debate/primary',
      trading_date: '2026-10-02',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      qty: 2,
      price_gbp: 160,
      fee_gbp: 0.4,
      currency: 'USD',
      price_native: 200,
      fee_native: 0.5,
      fx_quote_per_gbp: 1.25,
      fx_source: 'boe-xudluss:year-start:2026@2025-12-31',
      fill_date: '2026-10-01',
      filled_at: '2026-10-01T19:30:00.000Z',
      broker_mode: 'paper',
    });
    expect(
      db
        .prepare(
          'SELECT currency, price_native, fee_native, fx_quote_per_gbp, fx_source, fill_date, filled_at FROM v2_fills',
        )
        .get(),
    ).toEqual({
      currency: 'USD',
      price_native: 200,
      fee_native: 0.5,
      fx_quote_per_gbp: 1.25,
      fx_source: 'boe-xudluss:year-start:2026@2025-12-31',
      fill_date: '2026-10-01',
      filled_at: '2026-10-01T19:30:00.000Z',
    });
  });

  it('journals a split once per instrument, venue and date, whichever book sees it first', () => {
    const db = migratedMemoryStore();
    const journal = new Journal(db, clock);
    const split = {
      instrument: 'NVDA',
      venue: 'alpaca',
      split_date: '2026-09-30',
      ratio: 4,
      trading_date: '2026-10-01',
    };
    journal.recordSplit(split);
    journal.recordSplit({ ...split, trading_date: '2026-10-02' });
    journal.recordSplit({ ...split, venue: 'saxo' });
    expect(
      db
        .prepare(
          'SELECT instrument, venue, split_date, ratio, trading_date, recorded_at FROM v2_splits',
        )
        .all(),
    ).toEqual([
      { ...split, recorded_at: '2026-10-02T07:00:00.000Z' },
      { ...split, venue: 'saxo', recorded_at: '2026-10-02T07:00:00.000Z' },
    ]);
  });

  it('journals each rescale with the fills already journalled before it, so replay can place it (#1983)', () => {
    const db = migratedMemoryStore();
    const journal = new Journal(db, clock);
    const levels = { qty: 10, avgPriceGbp: 400, stopGbp: 380, targetGbp: undefined };
    const rescale = {
      trading_date: '2026-10-02',
      book_id: 'debate/primary',
      instrument: 'NVDA',
      source: 'detector' as const,
      ratio: 4,
      anchor_date: '2026-10-01',
      before: levels,
      after: { qty: 40, avgPriceGbp: 100, stopGbp: 95, targetGbp: undefined },
    };
    journal.recordRescale(rescale);
    journal.recordOrder({
      client_order_id: 'o1',
      decision_id: null,
      book_id: 'debate/primary',
      trading_date: '2026-10-01',
      instrument: 'NVDA',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: false,
      outcome: 'submitted',
      payload: {},
    });
    journal.recordFill({
      fill_id: 'alpaca:f1',
      client_order_id: 'o1',
      book_id: 'debate/primary',
      trading_date: '2026-10-02',
      instrument: 'NVDA',
      venue: 'alpaca',
      leg: 'stop',
      side: 'sell',
      qty: 40,
      price_gbp: 95,
      fee_gbp: 0,
      ...CAPTURED,
    });
    journal.recordRescale({ ...rescale, source: 'broker', ratio: 1, before: rescale.after });
    expect(
      db
        .prepare(
          `SELECT rescale_id, trading_date, book_id, instrument, source, ratio, anchor_date,
             fills_before, qty_before, qty_after, entry_before, entry_after, stop_before,
             stop_after, target_before, target_after, recorded_at
           FROM v2_rescales ORDER BY rescale_id`,
        )
        .all(),
    ).toEqual([
      {
        rescale_id: 1,
        trading_date: '2026-10-02',
        book_id: 'debate/primary',
        instrument: 'NVDA',
        source: 'detector',
        ratio: 4,
        anchor_date: '2026-10-01',
        fills_before: 0,
        qty_before: 10,
        qty_after: 40,
        entry_before: 400,
        entry_after: 100,
        stop_before: 380,
        stop_after: 95,
        target_before: null,
        target_after: null,
        recorded_at: '2026-10-02T07:00:00.000Z',
      },
      expect.objectContaining({
        rescale_id: 2,
        source: 'broker',
        ratio: 1,
        fills_before: 1,
        qty_before: 40,
        stop_before: 95,
      }),
    ]);
  });
});
