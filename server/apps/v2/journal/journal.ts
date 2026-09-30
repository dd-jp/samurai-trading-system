import { randomUUID } from 'node:crypto';
import type {
  DecisionJournal,
  JournalledFill,
  JournalledOrder,
  JournalledReconcile,
  JournalledRefusal,
  RecordedFillPart,
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

export interface ReconcileVerdict {
  readonly reconciled: ReadonlySet<string>;
  readonly blocked: ReadonlySet<string>;
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

  restingEntries(bookId: string): readonly JournalledOrder[] {
    const rows = this.db
      .prepare(
        `SELECT client_order_id FROM v2_orders o
         WHERE book_id = ? AND leg = 'entry'
           AND outcome IN ('submitted', 'simulated', 'refused_dry_run')
           AND NOT EXISTS (SELECT 1 FROM v2_fills f WHERE f.client_order_id = o.client_order_id)
         ORDER BY trading_date, client_order_id`,
      )
      .all(bookId) as { client_order_id: string }[];
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

  fillPartsOf(baseFillId: string): readonly RecordedFillPart[] {
    return this.db
      .prepare(
        `SELECT qty, price_gbp, fee_gbp, trading_date FROM v2_fills
         WHERE fill_id = @base OR substr(fill_id, 1, length(@base) + 1) = @base || '#'`,
      )
      .all({ base: baseFillId }) as RecordedFillPart[];
  }

  recordRefusal(refusal: JournalledRefusal): void {
    this.db
      .prepare(
        `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, book_id, instrument,
           recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        refusal.trading_date,
        refusal.scope,
        refusal.parameter,
        refusal.ticket,
        refusal.message,
        refusal.book_id ?? null,
        refusal.instrument ?? null,
        this.#now(),
      );
  }

  latestReconcile(tradingDate: string): ReconcileVerdict {
    const rows = this.db
      .prepare(
        `SELECT status, book_ids FROM v2_reconciles r
         WHERE trading_date = ? AND reconcile_id = (
           SELECT MAX(reconcile_id) FROM v2_reconciles
           WHERE trading_date = r.trading_date AND venue = r.venue AND source = r.source)`,
      )
      .all(tradingDate) as { status: string; book_ids: string }[];
    const reconciled = new Set<string>();
    const blocked = new Set<string>();
    for (const row of rows) {
      const bookIds = JSON.parse(row.book_ids) as string[];
      for (const bookId of bookIds) {
        reconciled.add(bookId);
        if (row.status !== 'clean') blocked.add(bookId);
      }
    }
    return { reconciled, blocked };
  }

  recordReconcile(run: JournalledReconcile): void {
    this.db
      .prepare(
        `INSERT INTO v2_reconciles (trading_date, venue, source, status, book_ids, diffs, detail,
           recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.trading_date,
        run.venue,
        run.source,
        run.status,
        JSON.stringify(run.book_ids),
        JSON.stringify(run.diffs),
        run.detail,
        this.#now(),
      );
  }

  newRefusals(tradingDate: string): readonly JournalledRefusal[] {
    return this.db
      .prepare(
        `SELECT trading_date, scope, parameter, ticket, message FROM v2_refusals today
         WHERE trading_date = ? AND scope <> 'entry'
           AND NOT EXISTS (
             SELECT 1 FROM v2_refusals before
             WHERE before.trading_date =
                   (SELECT MAX(trading_date) FROM v2_refusals WHERE trading_date < ?)
               AND before.parameter = today.parameter AND before.message = today.message)
         ORDER BY today.rowid`,
      )
      .all(tradingDate, tradingDate) as JournalledRefusal[];
  }

  #now(): string {
    return toStoredTimestamp(this.clock.now());
  }
}
