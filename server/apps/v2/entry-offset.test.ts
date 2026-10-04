import { afterEach, describe, expect, it } from 'vitest';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { EvidenceReader } from './api/evidence.js';
import { readBrokerOrders } from './report-cost-fidelity.js';

let db: StoreHandle;

afterEach(() => db?.close());

function seed(
  orders: readonly (readonly [string, string, string, Record<string, unknown>])[],
  fills: readonly (readonly [string, string, string])[],
): void {
  db = migratedMemoryStore();
  db.prepare(
    `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES ('debate/primary', 'debate', 'primary', 1000, 1000, 'x')`,
  ).run();
  const order = db.prepare(
    `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
       leg, side, dry_run, outcome, payload, recorded_at)
     VALUES (?, NULL, 'debate/primary', '2026-10-05', ?, 'alpaca', ?, 'buy', 0, 'submitted', ?, 'x')`,
  );
  for (const [id, instrument, leg, payload] of orders) {
    order.run(id, instrument, leg, JSON.stringify(payload));
  }
  const fill = db.prepare(
    `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
       side, qty, price_gbp, fee_gbp, recorded_at, broker_mode)
     SELECT ?, client_order_id, book_id, '2026-10-05', instrument, venue, ?, 'buy', 1, 100, 0, 'x', 'paper'
       FROM v2_orders WHERE client_order_id = ?`,
  );
  for (const [id, orderId, leg] of fills) fill.run(id, leg, orderId);
}

function offsetsFromReport(): Map<string, number | null | undefined> {
  return new Map(readBrokerOrders(db).map((order) => [order.clientOrderId, order.offsetBps]));
}

function offsetsFromEvidence(): { entry_offset_bps: number | null; closed_trades: number }[] {
  const { trade_count: panel } = new EvidenceReader(db, { now: () => new Date() }).read();
  if (panel.status !== 'fed') throw new Error('no closed trades read');
  return panel.books[0]?.by_entry_offset.map((row) => ({ ...row })) ?? [];
}

const AT_OFFSET = { price: 20, limit: 20.1, entry_offset_bps: 50 };

describe('the entry offset an exit takes', () => {
  it('is one rule for the cost-fidelity report and the closed-trade count', () => {
    seed(
      [
        ['at-offset', 'AAA', 'entry', AT_OFFSET],
        ['flatten', 'AAA', 'exit', { size: 1 }],
        ['sleeve-limit', 'BBB', 'entry', { price: 20, limit: 19.8 }],
        ['pre-tag', 'CCC', 'entry', { price: 20 }],
        ['pre-tag-exit', 'CCC', 'exit', { size: 1 }],
        ['orphan-exit', 'DDD', 'exit', { size: 1 }],
      ],
      [
        ['f1', 'at-offset', 'entry'],
        ['f2', 'flatten', 'exit'],
        ['f3', 'sleeve-limit', 'entry'],
        ['f4', 'sleeve-limit', 'stop'],
        ['f5', 'pre-tag', 'entry'],
        ['f6', 'pre-tag-exit', 'exit'],
        ['f7', 'orphan-exit', 'exit'],
      ],
    );
    const report = offsetsFromReport();
    expect(report.get('flatten')).toBe(50);
    expect(report.get('sleeve-limit')).toBeNull();
    expect(report.get('pre-tag-exit')).toBe(0);
    expect(report.get('orphan-exit')).toBeUndefined();
    expect(offsetsFromEvidence()).toEqual([
      { entry_offset_bps: null, closed_trades: 2 },
      { entry_offset_bps: 0, closed_trades: 1 },
      { entry_offset_bps: 50, closed_trades: 1 },
    ]);
  });

  it('is the entry filled before the exit, not one filled after it on the same day', () => {
    seed(
      [
        ['a-entry', 'AAA', 'entry', AT_OFFSET],
        ['b-exit', 'AAA', 'exit', { size: 1 }],
        ['c-reentry', 'AAA', 'entry', { price: 20, limit: 20.2, entry_offset_bps: 100 }],
      ],
      [
        ['f1', 'a-entry', 'entry'],
        ['f2', 'b-exit', 'exit'],
        ['f3', 'c-reentry', 'entry'],
      ],
    );
    expect(offsetsFromReport().get('b-exit')).toBe(50);
    expect(offsetsFromEvidence()).toEqual([{ entry_offset_bps: 50, closed_trades: 1 }]);
  });

  it('is the order a bracket leg shares, whatever a later entry on the instrument carries', () => {
    seed(
      [
        ['a-entry', 'AAA', 'entry', AT_OFFSET],
        ['b-entry', 'AAA', 'entry', { price: 20, limit: 20.2, entry_offset_bps: 100 }],
      ],
      [
        ['f1', 'a-entry', 'entry'],
        ['f2', 'b-entry', 'entry'],
        ['f3', 'a-entry', 'stop'],
      ],
    );
    expect(offsetsFromReport().get('a-entry')).toBe(50);
    expect(offsetsFromEvidence()).toEqual([{ entry_offset_bps: 50, closed_trades: 1 }]);
  });
});
