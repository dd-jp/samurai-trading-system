import { randomUUID } from 'node:crypto';
import type { AnalystView } from '../../pipeline/debate-engine/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import type { Clock } from '../../shared/index.js';
import { digest } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';
import type { SleeveDecision } from './sleeve.js';

export type OrderOutcome = 'submitted' | 'refused_dry_run' | 'rejected';

export interface JournalledOrder {
  readonly client_order_id: string;
  readonly decision_id: string;
  readonly book_id: string;
  readonly venue: string;
  readonly dry_run: boolean;
  readonly outcome: OrderOutcome;
  readonly payload: Record<string, unknown>;
}

export interface JournalledRefusal {
  readonly trading_date: string;
  readonly scope: string;
  readonly parameter: string;
  readonly ticket: string;
  readonly message: string;
}

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

export class Journal {
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
        `INSERT INTO v2_orders (client_order_id, decision_id, book_id, venue, dry_run, outcome, payload, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.client_order_id,
        order.decision_id,
        order.book_id,
        order.venue,
        order.dry_run ? 1 : 0,
        order.outcome,
        JSON.stringify(order.payload),
        this.#now(),
      );
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

  countOrders(outcome: OrderOutcome): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM v2_orders WHERE outcome = ?')
      .get(outcome) as { n: number };
    return row.n;
  }

  decisionsFor(
    bookId: string,
    tradingDate: string,
  ): readonly { instrument: string; action: string; inputs_hash: string }[] {
    return this.db
      .prepare(
        'SELECT instrument, action, inputs_hash FROM v2_decisions WHERE book_id = ? AND trading_date = ? ORDER BY instrument',
      )
      .all(bookId, tradingDate) as { instrument: string; action: string; inputs_hash: string }[];
  }

  refusalsFor(tradingDate: string): readonly JournalledRefusal[] {
    return this.db
      .prepare(
        `SELECT trading_date, scope, parameter, ticket, message FROM v2_refusals
         WHERE trading_date = ? ORDER BY refusal_id`,
      )
      .all(tradingDate) as JournalledRefusal[];
  }

  ordersFor(bookId: string): readonly JournalledOrder[] {
    const rows = this.db
      .prepare(
        `SELECT client_order_id, decision_id, book_id, venue, dry_run, outcome, payload
         FROM v2_orders WHERE book_id = ? ORDER BY client_order_id`,
      )
      .all(bookId) as (Omit<JournalledOrder, 'dry_run' | 'payload'> & {
      dry_run: number;
      payload: string;
    })[];
    return rows.map((row) => ({
      ...row,
      dry_run: row.dry_run === 1,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
  }

  sizeShares(bookId: string, tradingDate: string, instrument: string): number | undefined {
    const row = this.db
      .prepare(
        'SELECT size_shares FROM v2_decisions WHERE book_id = ? AND trading_date = ? AND instrument = ?',
      )
      .get(bookId, tradingDate, instrument) as { size_shares: number } | undefined;
    return row?.size_shares;
  }

  #now(): string {
    return toStoredTimestamp(this.clock.now());
  }
}
