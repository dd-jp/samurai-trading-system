/**
 * Test-only helpers over `SqliteExecutionStore` (#195) — what `execute.test.ts`,
 * `reconcile.test.ts` and `ingest-fills.test.ts` build on in place of their
 * former test-local `InMemoryStore` doubles, so the suites exercise the real
 * SQLite-backed store rather than a Map's semantics.
 *
 * Two additions beyond the production `SharedStore` port, both read-only and
 * both because assertions need to see states the port deliberately hides:
 *
 * - `getPosition`/`countAllPositions` read EVERY state, including terminal —
 *   `getOpenPositions()` excludes those by design (execution-spec.md), but a
 *   test asserting "the lot ended up `rejected`" needs to see it anyway.
 * - `writeLog` records write-ahead/update-state calls in order, mirroring
 *   what the old `InMemoryStore.writeLog` gave tests that assert not just
 *   the end state but what was durable at each point.
 *
 * Kept out of `SqliteExecutionStore` itself so that module's exported surface
 * stays exactly the port it implements — no test-only reads on the
 * production class.
 */

import type { ClosedTrade, OpenPosition, OrderState } from '../shared/index.js';
import {
  type ClosedTradeRow,
  type SharedStore as Db,
  fromClosedTradeRow,
  openSharedStore,
} from '../shared/store/index.js';
import {
  fromPositionRow,
  type OpenPositionRow,
  SqliteExecutionStore,
} from './sqlite-shared-store.js';
import type { FlattenSubmissionWriteAhead } from './types.js';

/** Row shape for `TestExecutionStore.getFlattenSubmission` — a read the production port never needs. */
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
  /** JSON `string[]` — NULL for a row written before migration 0020 (#517). */
  lot_idempotency_keys: string | null;
  /** JSON `number[]`, positionally parallel to the keys — NULL before migration 0021 (#571). */
  lot_held_quantities: string | null;
  /** NULL until `markFlattenFillsSwept` runs — migration 0023 (#519/#526). */
  fills_swept_at: string | null;
}

export class TestExecutionStore extends SqliteExecutionStore {
  readonly writeLog: string[] = [];

  constructor(private readonly testDb: Db) {
    super(testDb);
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

  /** Raw read of the #549 marker columns (migration 0024) — production reads them only via `getUnprotectedResidualLots`. */
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

  /** Every state, including terminal — what `getOpenPositions()` deliberately excludes. */
  async getPosition(idempotency_key: string): Promise<OpenPosition | null> {
    const row = this.testDb
      .prepare('SELECT * FROM open_positions WHERE idempotency_key = ?')
      .get(idempotency_key) as OpenPositionRow | undefined;
    return row === undefined ? null : fromPositionRow(row);
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

  /** Raw read of the flatten journal (#508 review, PR #516) — production never reads this back. */
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

export function openTestExecutionStore(): { db: Db; store: TestExecutionStore } {
  const db = openSharedStore(':memory:');
  return { db, store: new TestExecutionStore(db) };
}
