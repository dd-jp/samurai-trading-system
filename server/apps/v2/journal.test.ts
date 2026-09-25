import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { PaperBooks } from './books.js';
import { inputsHash, Journal } from './journal.js';
import type { SleeveDecision } from './sleeve.js';

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

  it('records decisions, orders and refusals and counts outcomes', () => {
    const db = openSharedStore(':memory:');
    new PaperBooks(db, clock);
    const journal = new Journal(db, clock);
    const decisionId = journal.recordDecision('debate/primary', '2026-09-25', decision, 3);
    journal.recordOrder({
      client_order_id: 'o1',
      decision_id: decisionId,
      book_id: 'debate/primary',
      venue: 'alpaca',
      dry_run: true,
      outcome: 'refused_dry_run',
      payload: { size: 3 },
    });
    journal.recordRefusal({
      trading_date: '2026-09-25',
      scope: 'universe',
      parameter: 'G4_MOVERS_SELECTION_RULE',
      ticket: '#1710',
      message: 'unset',
    });
    expect(journal.countOrders('refused_dry_run')).toBe(1);
    expect(journal.countOrders('submitted')).toBe(0);
    expect(journal.decisionsFor('debate/primary', '2026-09-25')).toEqual([
      { instrument: 'AAPL', action: 'enter_long', inputs_hash: 'abc' },
    ]);
    const stored = db
      .prepare('SELECT payload, size_shares, stop_price FROM v2_decisions')
      .get() as { payload: string; size_shares: number; stop_price: number };
    expect(JSON.parse(stored.payload)).toEqual({ rounds: 1, debate_id: 'd1' });
    expect(stored.size_shares).toBe(3);
    expect(stored.stop_price).toBe(96);
    const refusal = db.prepare('SELECT parameter, ticket FROM v2_refusals').get();
    expect(refusal).toEqual({ parameter: 'G4_MOVERS_SELECTION_RULE', ticket: '#1710' });
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
    expect(first).not.toBe(inputsHash([{ ...bar, close: 2 }], [view], models));
    expect(first).not.toBe(inputsHash([bar], [view], ['b', 'a', 'judge']));
  });
});
