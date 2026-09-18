import type { ClosedTrade, OpenPosition, OrderState, TradingArm } from '../../shared/index.js';
import {
  type ClosedTradeRow,
  fromClosedTradeRow,
  fromOpenPositionRow,
  type OpenPositionRow,
  openSharedStore,
  type StoreHandle,
} from '../../shared/store/index.js';
import { SqliteExecutionStore } from './sqlite-shared-store.js';
import type { FlattenSubmissionWriteAhead } from './types.js';

export interface FlattenSubmissionRow {
  idempotency_key: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  size: number;
  status: 'submitting' | 'submitted' | 'error';
  order_state: OrderState | null;
  broker_order_ids: string | null;
  reason: string | null;
  submitted_at: string;
  resolved_at: string | null;
  lot_idempotency_keys: string | null;
  lot_held_quantities: string | null;
  fills_swept_at: string | null;
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: string | null;
  modelled_cost_breakdown_json: string | null;
  arm: 'live' | 'control';
}

export class TestExecutionStore extends SqliteExecutionStore {
  readonly writeLog: string[] = [];

  constructor(
    private readonly testDb: StoreHandle,
    arm: TradingArm = 'live',
  ) {
    super(testDb, arm);
  }

  override async writeAheadPosition(position: OpenPosition): Promise<void> {
    this.writeLog.push(`write-ahead:${position.idempotency_key}`);
    return super.writeAheadPosition(position);
  }

  override async updatePositionState(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void> {
    this.writeLog.push(`update:${idempotency_key}:${update.order_state}`);
    return super.updatePositionState(idempotency_key, update);
  }

  override async writeAheadFlatten(submission: FlattenSubmissionWriteAhead): Promise<void> {
    this.writeLog.push(`write-ahead-flatten:${submission.idempotency_key}`);
    return super.writeAheadFlatten(submission);
  }

  override async resolveFlattenSubmitted(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
    resolved_at: Date,
  ): Promise<void> {
    this.writeLog.push(`resolve-flatten:${idempotency_key}:${update.order_state}`);
    return super.resolveFlattenSubmitted(idempotency_key, update, resolved_at);
  }

  override async resolveFlattenError(
    idempotency_key: string,
    reason: string,
    resolved_at: Date,
  ): Promise<void> {
    this.writeLog.push(`resolve-flatten-error:${idempotency_key}`);
    return super.resolveFlattenError(idempotency_key, reason, resolved_at);
  }

  override async recordFlattenOrderStateObserved(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void> {
    this.writeLog.push(`record-flatten-order-state:${idempotency_key}:${update.order_state}`);
    return super.recordFlattenOrderStateObserved(idempotency_key, update);
  }

  override async markFlattenFillsSwept(idempotency_key: string, swept_at: Date): Promise<void> {
    this.writeLog.push(`mark-flatten-fills-swept:${idempotency_key}`);
    return super.markFlattenFillsSwept(idempotency_key, swept_at);
  }

  ageFlattenHeldQuantities(idempotency_key: string, raw: string | null = null): void {
    this.testDb
      .prepare('UPDATE flatten_submissions SET lot_held_quantities = ? WHERE idempotency_key = ?')
      .run(raw, idempotency_key);
  }

  override async markResidualUnprotected(
    idempotency_key: string,
    observed_at: Date,
  ): Promise<void> {
    this.writeLog.push(`mark-residual-unprotected:${idempotency_key}`);
    return super.markResidualUnprotected(idempotency_key, observed_at);
  }

  override async confirmResidualProtected(idempotency_key: string): Promise<void> {
    this.writeLog.push(`confirm-residual-protected:${idempotency_key}`);
    return super.confirmResidualProtected(idempotency_key);
  }

  override async markResidualAlerted(idempotency_key: string, alerted_at: Date): Promise<boolean> {
    this.writeLog.push(`mark-residual-alerted:${idempotency_key}`);
    return super.markResidualAlerted(idempotency_key, alerted_at);
  }

  override async markResidualRearmUnsupportedAlerted(
    idempotency_key: string,
    alerted_at: Date,
  ): Promise<boolean> {
    this.writeLog.push(`mark-residual-rearm-unsupported-alerted:${idempotency_key}`);
    return super.markResidualRearmUnsupportedAlerted(idempotency_key, alerted_at);
  }

  override async sweepTerminalPositions(cutoff: Date): Promise<number> {
    const swept = await super.sweepTerminalPositions(cutoff);
    if (swept > 0) this.writeLog.push(`sweep-terminal-positions:${swept}`);
    return swept;
  }

  override async abandonWedgedZeroFillLot(
    idempotency_key: string,
    reason: string,
  ): Promise<boolean> {
    const abandoned = await super.abandonWedgedZeroFillLot(idempotency_key, reason);
    if (abandoned) this.writeLog.push(`abandon-wedged-zero-fill:${idempotency_key}`);
    return abandoned;
  }

  async getResidualProtectionMarker(
    idempotency_key: string,
  ): Promise<{ unprotected_since: string | null; alerted_at: string | null } | null> {
    const row = this.testDb
      .prepare(
        `SELECT residual_unprotected_since AS unprotected_since,
                residual_rearm_alerted_at AS alerted_at
           FROM open_positions WHERE idempotency_key = ?`,
      )
      .get(idempotency_key) as
      | { unprotected_since: string | null; alerted_at: string | null }
      | undefined;
    return row === undefined ? null : row;
  }

  async getResidualRearmUnsupportedAlertedAtRaw(idempotency_key: string): Promise<string | null> {
    const row = this.testDb
      .prepare(
        `SELECT residual_rearm_unsupported_alerted_at AS alerted_at
           FROM open_positions WHERE idempotency_key = ?`,
      )
      .get(idempotency_key) as { alerted_at: string | null } | undefined;
    return row === undefined ? null : row.alerted_at;
  }

  async getPosition(idempotency_key: string): Promise<OpenPosition | null> {
    const row = this.testDb
      .prepare('SELECT * FROM open_positions WHERE idempotency_key = ?')
      .get(idempotency_key) as OpenPositionRow | undefined;
    return row === undefined ? null : fromOpenPositionRow(row);
  }

  async countAllPositions(): Promise<number> {
    const row = this.testDb.prepare('SELECT COUNT(*) AS n FROM open_positions').get() as {
      n: number;
    };
    return row.n;
  }

  async getClosedTrades(): Promise<ClosedTrade[]> {
    const rows = this.testDb
      .prepare('SELECT * FROM closed_trades ORDER BY rowid')
      .all() as ClosedTradeRow[];
    return rows.map(fromClosedTradeRow);
  }

  async getFlattenSubmission(idempotency_key: string): Promise<FlattenSubmissionRow | null> {
    const row = this.testDb
      .prepare('SELECT * FROM flatten_submissions WHERE idempotency_key = ?')
      .get(idempotency_key) as FlattenSubmissionRow | undefined;
    return row === undefined ? null : row;
  }

  async countAllFlattenSubmissions(): Promise<number> {
    const row = this.testDb.prepare('SELECT COUNT(*) AS n FROM flatten_submissions').get() as {
      n: number;
    };
    return row.n;
  }
}

export function openTestExecutionStore(): { db: StoreHandle; store: TestExecutionStore } {
  const db = openSharedStore(':memory:');
  return { db, store: new TestExecutionStore(db) };
}
