/**
 * Test-only constructors over `SqliteTuningStore`/`SqliteClosedTradeStore`/
 * `SqliteAdjustmentLog` (#197) — what `daily-cycle.test.ts` and
 * `metrics.test.ts` build on in place of their former `InMemoryTuningStore`/
 * `InMemoryClosedTradeStore`/`InMemoryAdjustmentLog` fixtures, so the suites
 * exercise the real SQLite-backed stores rather than a Map's/array's
 * semantics. Mirrors `src/execution/sqlite-store-harness.ts`'s role for the
 * Execution cutover (#195).
 *
 * Each helper opens its own fresh `:memory:` store, so a call here is as
 * isolated as the old `new InMemoryXStore(...)` it replaces — tests that
 * override one store with different seed data get an independent database,
 * not a shared one that would leak a harness's default seed into the
 * override.
 *
 * `seedClosedTrades` writes directly to `closed_trades` rather than going
 * through `SqliteClosedTradeStore` (which has no write method — see that
 * class's doc on why) or through Execution's `SqliteExecutionStore` (would
 * make the Feedback Loop's test suite depend on Execution's async port for
 * synchronous seed data). The INSERT mirrors
 * `SqliteExecutionStore.writeClosedTrade`'s column list exactly.
 */
import { openSharedStore, type SharedStore } from '../shared/store/open-shared-store.js';
import type { ClosedTrade } from '../shared/types.js';
import { SqliteAdjustmentLog } from './sqlite-adjustment-log.js';
import { SqliteClosedTradeStore } from './sqlite-closed-trade-store.js';
import { SqliteTuningStore } from './sqlite-tuning-store.js';

export interface TuningSeed {
  weights?: Record<string, number>;
  params?: Record<string, number>;
  thresholds?: Record<string, number>;
}

export function openTuningStore(seed: TuningSeed = {}): SqliteTuningStore {
  const db = openSharedStore(':memory:');
  const store = new SqliteTuningStore(db);
  for (const [analyst_id, weight] of Object.entries(seed.weights ?? {})) {
    store.setAnalystWeight(analyst_id, weight);
  }
  for (const [name, value] of Object.entries(seed.params ?? {})) {
    store.setStrategyParam(name, value);
  }
  for (const [name, value] of Object.entries(seed.thresholds ?? {})) {
    store.setRiskThreshold(name, value);
  }
  return store;
}

export function openClosedTradeStore(trades: ClosedTrade[] = []): SqliteClosedTradeStore {
  const db = openSharedStore(':memory:');
  for (const trade of trades) {
    seedClosedTrade(db, trade);
  }
  return new SqliteClosedTradeStore(db);
}

export function openAdjustmentLog(): SqliteAdjustmentLog {
  return new SqliteAdjustmentLog(openSharedStore(':memory:'));
}

function seedClosedTrade(db: SharedStore, trade: ClosedTrade): void {
  db.prepare(
    `INSERT INTO closed_trades (
       idempotency_key, debate_id, instrument, asset_class, side,
       entry, stop, filled_size, realized_pnl_net, fees_total,
       opened_at, closed_at, close_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trade.idempotency_key,
    trade.debate_id,
    trade.instrument,
    trade.asset_class,
    trade.side,
    trade.entry,
    trade.stop,
    trade.filled_size,
    trade.realized_pnl_net,
    trade.fees_total,
    trade.opened_at.toISOString(),
    trade.closed_at.toISOString(),
    trade.close_reason,
  );
}
