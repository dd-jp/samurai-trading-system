import { randomUUID } from 'node:crypto';
import type {
  DecisionJournal,
  JournalledFill,
  JournalledOrder,
  JournalledRefusal,
  SleeveDecision,
} from '../../../../contracts/index.js';
import type { AnalystView } from '../../../pipeline/debate-engine/index.js';
import type { DailyBar } from '../../../pipeline/momentum/index.js';
import type { Clock } from '../../../shared/index.js';
import { digest } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/index.js';

export function inputsHash(
  bars: readonly DailyBar[],
  views: readonly AnalystView[],
  models: readonly string[],
): string {
  return digest({
    bars,
    models,
    views: views.map((view) => ({
      analyst_id: view.analyst_id,
      analyst_type: view.analyst_type,
      direction: view.direction,
      confidence: view.confidence,
      key_points: view.key_points,
    })),
  });
}

export class Journal implements DecisionJournal {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  recordDecision(
    bookId: string,
    tradingDate: string,
    decision: SleeveDecision,
    sizeShares: number,
  ): string {
    const decisionId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash,
           direction, confidence, action, reason, size_shares, stop_price, payload, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decisionId,
        bookId,
        tradingDate,
        decision.instrument,
        decision.venue,
        decision.inputs_hash,
        decision.direction,
        decision.confidence,
        decision.action,
        decision.reason,
        sizeShares,
        decision.stop_price ?? null,
        JSON.stringify({ ...decision.payload, debate_id: decision.debate_id }),
        this.#now(),
      );
    return decisionId;
  }

  recordOrder(order: JournalledOrder): void {
    this.db
      .prepare(
        `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
           leg, side, dry_run, outcome, payload, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.client_order_id,
        order.decision_id,
        order.book_id,
        order.trading_date,
        order.instrument,
        order.venue,
        order.leg,
        order.side,
        order.dry_run ? 1 : 0,
        order.outcome,
        JSON.stringify(order.payload),
        this.#now(),
      );
  }

  orderFor(clientOrderId: string): JournalledOrder | undefined {
    const row = this.db
      .prepare(
        `SELECT client_order_id, decision_id, book_id, trading_date, instrument, venue, leg, side,
           dry_run, outcome, payload
         FROM v2_orders WHERE client_order_id = ?`,
      )
      .get(clientOrderId) as
      | (Omit<JournalledOrder, 'dry_run' | 'payload'> & { dry_run: number; payload: string })
      | undefined;
    if (row === undefined) return undefined;
    return {
      ...row,
      dry_run: row.dry_run === 1,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    };
  }

  unfilledEntriesBefore(bookId: string, tradingDate: string): readonly JournalledOrder[] {
    const rows = this.db
      .prepare(
        `SELECT client_order_id FROM v2_orders o
         WHERE book_id = ? AND leg = 'entry' AND outcome = 'submitted' AND trading_date < ?
           AND NOT EXISTS (SELECT 1 FROM v2_fills f WHERE f.client_order_id = o.client_order_id)
         ORDER BY client_order_id`,
      )
      .all(bookId, tradingDate) as { client_order_id: string }[];
    return rows.flatMap((row) => this.orderFor(row.client_order_id) ?? []);
  }

  unfilledSimulatedEntriesBefore(tradingDate: string): readonly JournalledOrder[] {
    const rows = this.db
      .prepare(
        `SELECT client_order_id FROM v2_orders o
         WHERE leg = 'entry' AND outcome IN ('simulated', 'refused_dry_run') AND trading_date < ?
           AND NOT EXISTS (SELECT 1 FROM v2_fills f WHERE f.client_order_id = o.client_order_id)
         ORDER BY trading_date, client_order_id`,
      )
      .all(tradingDate) as { client_order_id: string }[];
    return rows.flatMap((row) => this.orderFor(row.client_order_id) ?? []);
  }

  markCancelled(clientOrderId: string, detail: string): void {
    this.db
      .prepare(
        `UPDATE v2_orders SET outcome = 'cancelled',
           payload = json_set(payload, '$.cancelled', ?) WHERE client_order_id = ?`,
      )
      .run(detail, clientOrderId);
  }

  recordFill(fill: JournalledFill): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument,
           venue, leg, side, qty, price_gbp, fee_gbp, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fill.fill_id,
        fill.client_order_id,
        fill.book_id,
        fill.trading_date,
        fill.instrument,
        fill.venue,
        fill.leg,
        fill.side,
        fill.qty,
        fill.price_gbp,
        fill.fee_gbp,
        this.#now(),
      );
    return result.changes === 1;
  }

  recordRefusal(refusal: JournalledRefusal): void {
    this.db
      .prepare(
        `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        refusal.trading_date,
        refusal.scope,
        refusal.parameter,
        refusal.ticket,
        refusal.message,
        this.#now(),
      );
  }

  #now(): string {
    return toStoredTimestamp(this.clock.now());
  }
}
