import { randomUUID } from 'node:crypto';
import type {
  DecisionJournal,
  JournalledCashInLieu,
  JournalledFill,
  JournalledFillRead,
  JournalledOrder,
  JournalledReconcile,
  JournalledRefusal,
  JournalledRescale,
  JournalledSplit,
  OrderOutcome,
  RecordedFillPart,
  SleeveDecision,
  Venue,
} from '../../../../contracts/index.js';
import type { AnalystView } from '../../../shared/debate/index.js';
import type { Clock, DailyBar } from '../../../shared/index.js';
import { digest } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/index.js';
import { type Fault, type FaultSink, orderFault, reconcileFaults, refusalFault } from './faults.js';

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
    private readonly faults?: FaultSink | undefined,
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
    this.#recordFault(orderFault(order));
  }

  settleOrder(
    clientOrderId: string,
    outcome: OrderOutcome,
    payload: Record<string, unknown>,
  ): void {
    const { changes } = this.db
      .prepare(
        `UPDATE v2_orders SET outcome = ?, payload = ?
         WHERE client_order_id = ? AND outcome = 'pending'`,
      )
      .run(outcome, JSON.stringify(payload), clientOrderId);
    const settled = this.orderFor(clientOrderId);
    if (Number(changes) !== 1 || settled === undefined) {
      throw new Error(`journal: ${clientOrderId} is not a pending order`);
    }
    this.#recordFault(orderFault(settled));
  }

  pendingOrders(): readonly JournalledOrder[] {
    const rows = this.db
      .prepare(`SELECT client_order_id FROM v2_orders WHERE outcome = 'pending' ORDER BY rowid`)
      .all() as { client_order_id: string }[];
    return rows.flatMap((row) => this.orderFor(row.client_order_id) ?? []);
  }

  resolvePending(
    clientOrderId: string,
    outcome: 'submitted' | 'rejected',
    detail: string,
    tradingDate: string,
  ): void {
    this.db
      .prepare(
        `UPDATE v2_orders SET outcome = ?,
           payload = json_set(payload, '$.detail', ?, '$.resolved', ?)
         WHERE client_order_id = ? AND outcome = 'pending'`,
      )
      .run(outcome, detail, tradingDate, clientOrderId);
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
           AND outcome IN ('pending', 'submitted', 'simulated', 'refused_dry_run')
           AND NOT EXISTS (SELECT 1 FROM v2_fills f WHERE f.client_order_id = o.client_order_id)
         ORDER BY trading_date, client_order_id`,
      )
      .all(bookId) as { client_order_id: string }[];
    return rows.flatMap((row) => this.orderFor(row.client_order_id) ?? []);
  }

  // A broker entry booked below its size still rests at the venue for the remainder, under legs
  // Alpaca holds until it fills completely
  partFilledEntries(bookId: string, before?: string): readonly JournalledOrder[] {
    const rows = this.db
      .prepare(
        `SELECT client_order_id FROM v2_orders o
         WHERE book_id = ? AND leg = 'entry' AND outcome = 'submitted'
           AND (? IS NULL OR trading_date < ?)
           AND (SELECT SUM(f.qty) FROM v2_fills f
                 WHERE f.client_order_id = o.client_order_id AND f.leg = 'entry')
               < json_extract(o.payload, '$.size')
         ORDER BY trading_date, client_order_id`,
      )
      .all(bookId, before ?? null, before ?? null) as { client_order_id: string }[];
    return rows.flatMap((row) => this.orderFor(row.client_order_id) ?? []);
  }

  recordFillRead(read: JournalledFillRead): void {
    this.db
      .prepare(
        `INSERT INTO v2_fill_reads (run_id, trading_date, client_order_id, filled_qty, error,
           recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        read.run_id,
        read.trading_date,
        read.client_order_id,
        read.filled_qty,
        read.error,
        this.#now(),
      );
  }

  lastFillSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(fill_seq), 0) AS id FROM v2_fills').get() as {
      id: number;
    };
    return row.id;
  }

  recordFillSweep(runId: string, tradingDate: string, firstFillSeq: number): void {
    this.db
      .prepare(
        `INSERT INTO v2_fill_sweeps (run_id, trading_date, first_fill_seq, last_fill_seq,
           order_rowid, book_day_rowid, recorded_at)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(fill_seq), 0) FROM v2_fills),
           (SELECT COALESCE(MAX(rowid), 0) FROM v2_orders),
           (SELECT COALESCE(MAX(rowid), 0) FROM v2_book_days), ?)`,
      )
      .run(runId, tradingDate, firstFillSeq, this.#now());
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
           venue, leg, side, qty, price_gbp, fee_gbp, currency, price_native, fee_native,
           fx_quote_per_gbp, fx_source, fill_date, filled_at, broker_mode, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        fill.currency,
        fill.price_native,
        fill.fee_native,
        fill.fx_quote_per_gbp,
        fill.fx_source,
        fill.fill_date,
        fill.filled_at ?? null,
        fill.broker_mode,
        this.#now(),
      );
    return result.changes === 1;
  }

  recordSplit(split: JournalledSplit): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO v2_splits (instrument, venue, split_date, ratio, trading_date,
           recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        split.instrument,
        split.venue,
        split.split_date,
        split.ratio,
        split.trading_date,
        this.#now(),
      );
  }

  recordCashInLieu(row: JournalledCashInLieu): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO v2_cash_in_lieu (venue, activity_id, instrument, activity_date, qty,
           amount_native, currency, status, fx_quote_per_gbp, fx_source, trading_date, recorded_at)
         VALUES (@venue, @activity_id, @instrument, @activity_date, @qty, @amount_native,
           @currency, @status, @fx_quote_per_gbp, @fx_source, @trading_date, @recorded_at)`,
      )
      .run({ ...row, recorded_at: this.#now() });
    return result.changes === 1;
  }

  // Only a broker-routed order's estimate is a disposal the broker pays (api/tax.ts)
  earliestCashInLieuEstimate(venue: Venue, fromDate: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT MIN(COALESCE(f.fill_date, f.trading_date)) AS date
         FROM v2_fills f JOIN v2_orders o ON o.client_order_id = f.client_order_id
         WHERE f.leg = 'cash_in_lieu' AND f.venue = ?
           AND o.outcome NOT IN ('simulated', 'refused_dry_run')
           AND COALESCE(f.fill_date, f.trading_date) >= ?`,
      )
      .get(venue, fromDate) as { date: string | null };
    return row.date ?? undefined;
  }

  recordRescale(rescale: JournalledRescale): void {
    const { before, after } = rescale;
    this.db
      .prepare(
        `INSERT INTO v2_rescales (trading_date, book_id, instrument, source, ratio, anchor_date,
           fills_before, qty_before, qty_after, entry_before, entry_after, stop_before, stop_after,
           target_before, target_after, recorded_at)
         VALUES (@trading_date, @book_id, @instrument, @source, @ratio, @anchor_date,
           (SELECT COUNT(*) FROM v2_fills WHERE trading_date = @trading_date), @qty_before,
           @qty_after, @entry_before, @entry_after, @stop_before, @stop_after, @target_before,
           @target_after, @recorded_at)`,
      )
      .run({
        trading_date: rescale.trading_date,
        book_id: rescale.book_id,
        instrument: rescale.instrument,
        source: rescale.source,
        ratio: rescale.ratio,
        anchor_date: rescale.anchor_date,
        qty_before: before.qty,
        qty_after: after.qty,
        entry_before: before.avgPriceGbp,
        entry_after: after.avgPriceGbp,
        stop_before: before.stopGbp ?? null,
        stop_after: after.stopGbp ?? null,
        target_before: before.targetGbp ?? null,
        target_after: after.targetGbp ?? null,
        recorded_at: this.#now(),
      });
  }

  fillPartsOf(baseFillId: string): readonly RecordedFillPart[] {
    return this.db
      .prepare(
        `SELECT qty, price_gbp, fee_gbp, trading_date FROM v2_fills
         WHERE fill_id = @base OR substr(fill_id, 1, length(@base) + 1) = @base || '#'`,
      )
      .all({ base: baseFillId }) as RecordedFillPart[];
  }

  // A re-run on the same trading date re-raises the same refusals; a row identical in every
  // field but recorded_at adds nothing, so it is skipped, as v2_faults' UNIQUE key does
  recordRefusal(refusal: JournalledRefusal): void {
    const { changes } = this.db
      .prepare(
        `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, book_id, instrument,
           recorded_at)
         SELECT @trading_date, @scope, @parameter, @ticket, @message, @book_id, @instrument,
           @recorded_at
         WHERE NOT EXISTS (
           SELECT 1 FROM v2_refusals
           WHERE trading_date = @trading_date AND scope = @scope AND parameter = @parameter
             AND ticket = @ticket AND message = @message
             AND book_id IS @book_id AND instrument IS @instrument)`,
      )
      .run({
        trading_date: refusal.trading_date,
        scope: refusal.scope,
        parameter: refusal.parameter,
        ticket: refusal.ticket,
        message: refusal.message,
        book_id: refusal.book_id ?? null,
        instrument: refusal.instrument ?? null,
        recorded_at: this.#now(),
      });
    if (Number(changes) === 0) return;
    this.#recordFault(refusalFault(refusal));
  }

  latestReconcile(tradingDate: string, venue: Venue): ReconcileVerdict {
    const rows = this.db
      .prepare(
        `SELECT status, book_ids FROM v2_reconciles r
         WHERE trading_date = ? AND venue = ? AND reconcile_id = (
           SELECT MAX(reconcile_id) FROM v2_reconciles
           WHERE trading_date = r.trading_date AND venue = r.venue AND source = r.source)`,
      )
      .all(tradingDate, venue) as { status: string; book_ids: string }[];
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
           broker_mode, cash_quote, protecting_stops, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.trading_date,
        run.venue,
        run.source,
        run.status,
        JSON.stringify(run.book_ids),
        JSON.stringify(run.diffs),
        run.detail,
        run.broker_mode,
        run.cash_quote,
        run.protecting_stops === undefined ? null : JSON.stringify(run.protecting_stops),
        this.#now(),
      );
    for (const fault of reconcileFaults(run)) this.#recordFault(fault);
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

  #recordFault(fault: Fault | undefined): void {
    if (fault !== undefined) this.faults?.record(fault);
  }

  #now(): string {
    return toStoredTimestamp(this.clock.now());
  }
}
