import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { openSharedStore } from '../../shared/store/index.js';
import { openReadOnlyCgtStore } from './open-readonly-cgt-store.js';

function migratedTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cgt-readonly-'));
  const dbPath = join(dir, 'store.sqlite');
  openSharedStore(dbPath).close(); // creates the file and runs every migration
  return dbPath;
}

describe('openReadOnlyCgtStore', () => {
  it('opens a fully-migrated store read-only and can read from it', () => {
    const dbPath = migratedTempDbPath();

    const db = openReadOnlyCgtStore(dbPath);
    const row = db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number };

    expect(row.n).toBe(0);
    db.close();
  });

  it('cannot write through the handle it returns', () => {
    const dbPath = migratedTempDbPath();
    const db = openReadOnlyCgtStore(dbPath);

    expect(() =>
      db
        .prepare(
          `INSERT INTO fills (idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp)
           VALUES ('k', 'f', 'entry', 1, 1, 0, '2025-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/readonly/i);
    db.close();
  });

  it('refuses rather than create a fresh empty store when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgt-readonly-missing-'));
    expect(() => openReadOnlyCgtStore(join(dir, 'does-not-exist.sqlite'))).toThrow();
  });

  it('refuses, naming the table, when the store predates a migration this report needs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgt-readonly-no-table-'));
    const dbPath = join(dir, 'bare.sqlite');
    // A bare SQLite file with none of the money-path tables — the schema this
    // report was NOT written against.
    const bare = new BetterSqlite3(dbPath);
    bare.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY);');
    bare.close();

    expect(() => openReadOnlyCgtStore(dbPath)).toThrow(/fills/);
  });

  it('refuses, naming the column, when fills predates fee_currency (migration 0054)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgt-readonly-no-column-'));
    const dbPath = join(dir, 'old-schema.sqlite');
    const bare = new BetterSqlite3(dbPath);
    bare.exec(`
      CREATE TABLE fills (
        idempotency_key TEXT NOT NULL,
        broker_fill_id TEXT NOT NULL,
        leg TEXT NOT NULL,
        price REAL NOT NULL,
        qty REAL NOT NULL,
        fee REAL NOT NULL,
        timestamp TEXT NOT NULL,
        cost_breakdown_json TEXT,
        exit_reason TEXT,
        flatten_idempotency_key TEXT,
        PRIMARY KEY (idempotency_key, broker_fill_id)
      );
      CREATE TABLE closed_trades (idempotency_key TEXT PRIMARY KEY, instrument TEXT, asset_class TEXT, side TEXT, arm TEXT);
      CREATE TABLE open_positions (idempotency_key TEXT PRIMARY KEY, instrument TEXT, asset_class TEXT, side TEXT, arm TEXT);
    `);
    bare.close();

    expect(() => openReadOnlyCgtStore(dbPath)).toThrow(/fee_currency/);
  });
});
