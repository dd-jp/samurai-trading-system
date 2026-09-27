import { describe, expect, it } from 'vitest';
import type { JournalledOrder, Sleeve, SleeveDecision } from '../../../../contracts/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { CapitalConfigStore, PaperBooks } from '../risk/index.js';
import { inputsHash, Journal } from './journal.js';

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
    const journal = new Journal(openSharedStore(':memory:'), clock);
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
    const db = openSharedStore(':memory:');
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

  it('lists submitted entries from earlier dates that never filled and marks them cancelled', () => {
    const db = openSharedStore(':memory:');
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

  it('lists unfilled simulated and dry-run entries from earlier dates, oldest first', () => {
    const db = openSharedStore(':memory:');
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
