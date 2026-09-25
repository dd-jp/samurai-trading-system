import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { PaperBooks } from '../risk/index.js';
import type { SleeveDecision } from '../signal/index.js';
import { inputsHash, Journal, type JournalledOrder } from './journal.js';

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

describe('Journal', () => {
  const clock = new SimulatedClock(new Date('2026-09-25T12:00:00.000Z'));

  it('records decisions, orders, fills and refusals and reads an order back by id', () => {
    const db = openSharedStore(':memory:');
    new PaperBooks(db, clock);
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
    new PaperBooks(db, clock);
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
