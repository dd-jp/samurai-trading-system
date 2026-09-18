import BetterSqlite3 from 'better-sqlite3';
import type { StoreHandle } from '../../shared/store/index.js';

const REQUIRED_CGT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  fills: [
    'idempotency_key',
    'broker_fill_id',
    'leg',
    'price',
    'qty',
    'fee',
    'timestamp',
    'cost_breakdown_json',
    'exit_reason',
    'flatten_idempotency_key',
    'fee_currency',
  ],
  closed_trades: ['idempotency_key', 'instrument', 'asset_class', 'side', 'arm'],
  open_positions: ['idempotency_key', 'instrument', 'asset_class', 'side', 'arm'],
};

interface TableInfoRow {
  name: string;
}

export function openReadOnlyCgtStore(dbPath: string): StoreHandle {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  assertHasCgtSchema(db, dbPath);
  return db;
}

function assertHasCgtSchema(db: BetterSqlite3.Database, dbPath: string): void {
  for (const [table, columns] of Object.entries(REQUIRED_CGT_COLUMNS)) {
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (exists === undefined) {
      throw new Error(
        `CGT report: ${dbPath} has no '${table}' table. This report was written against a ` +
          'migrated store; run the orchestrator (which runs migrations) against this file at ' +
          'least once before reporting from it.',
      );
    }
    const present = new Set(
      (db.pragma(`table_info(${table})`) as TableInfoRow[]).map((row) => row.name),
    );
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(
          `CGT report: ${dbPath}'s '${table}' table has no '${column}' column. This store predates ` +
            'a migration this report depends on — run the orchestrator (which runs migrations) ' +
            'against this file, then re-run the report.',
        );
      }
    }
  }
}
