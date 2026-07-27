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
import { type SharedStore as Db, openSharedStore } from '../shared/store/open-shared-store.js';
import type { ClosedTrade, OpenPosition, OrderState } from '../shared/types.js';
import {
  fromPositionRow,
  type OpenPositionRow,
  SqliteExecutionStore,
} from './sqlite-shared-store.js';

interface ClosedTradeRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
  filled_size: number;
  realized_pnl_net: number;
  fees_total: number;
  opened_at: string;
  closed_at: string;
  close_reason: 'stop' | 'target' | 'exit';
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
}

export function openTestExecutionStore(): { db: Db; store: TestExecutionStore } {
  const db = openSharedStore(':memory:');
  return { db, store: new TestExecutionStore(db) };
}

function fromClosedTradeRow(row: ClosedTradeRow): ClosedTrade {
  return {
    idempotency_key: row.idempotency_key,
    debate_id: row.debate_id,
    instrument: row.instrument,
    asset_class: row.asset_class,
    side: row.side,
    entry: row.entry,
    stop: row.stop,
    filled_size: row.filled_size,
    realized_pnl_net: row.realized_pnl_net,
    fees_total: row.fees_total,
    opened_at: new Date(row.opened_at),
    closed_at: new Date(row.closed_at),
    close_reason: row.close_reason,
  };
}
