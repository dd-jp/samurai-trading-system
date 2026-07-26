import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import { openSharedStore } from './open-shared-store.js';

const TABLES = [
  'bars',
  'latest_mark',
  'open_positions',
  'fills',
  'closed_trades',
  'config_trials',
  'analyst_weights',
  'strategy_params',
  'risk_thresholds',
  'dial_adjustments',
  'cosine_setups',
  'debate_log',
  'verdict_log',
  'audit_log',
  'current_tick',
];

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-store-'));
  tempDirs.push(dir);
  return join(dir, 'samurai-test.sqlite');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('openSharedStore', () => {
  it('creates every table in the consolidated schema on a fresh DB', () => {
    const db = openSharedStore(':memory:');

    const names = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );

    for (const table of TABLES) {
      expect(names.has(table), `missing table ${table}`).toBe(true);
    }
    expect(names.has('schema_migrations')).toBe(true);
  });

  it('records applied versions and re-migrating is a no-op', () => {
    const db = openSharedStore(':memory:');

    const versions = db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual([{ version: 1 }]);
    expect(runMigrations(db)).toEqual([]);
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
  });

  it('sets WAL mode and synchronous=FULL on a file-backed connection', () => {
    const db = openSharedStore(tempDbPath());

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    // synchronous=FULL is 2 in SQLite's pragma encoding.
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
  });

  it('persists across reopen of the same path', () => {
    const path = tempDbPath();
    const first = openSharedStore(path);
    first
      .prepare('INSERT INTO analyst_weights (analyst_id, weight, updated_at) VALUES (?, ?, ?)')
      .run('fundamentals', 0.4, '2026-07-26T00:00:00.000Z');
    first.close();

    const second = openSharedStore(path);
    expect(second.prepare('SELECT COUNT(*) AS n FROM analyst_weights').get()).toEqual({ n: 1 });
  });

  it('never shares state between two different paths (paper/live isolation)', () => {
    const paper = openSharedStore(tempDbPath());
    const live = openSharedStore(tempDbPath());

    paper
      .prepare('INSERT INTO analyst_weights (analyst_id, weight, updated_at) VALUES (?, ?, ?)')
      .run('fundamentals', 0.4, '2026-07-26T00:00:00.000Z');

    expect(live.prepare('SELECT COUNT(*) AS n FROM analyst_weights').get()).toEqual({ n: 0 });
  });

  it('enforces CHECK constraints on enum columns', () => {
    const db = openSharedStore(':memory:');

    expect(() =>
      db
        .prepare(
          `INSERT INTO current_tick (instrument, asset_class, stage, trace_id, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('AAPL', 'forex', 'trader', 'trace-1', '2026-07-26T00:00:00.000Z'),
    ).toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO dial_adjustments
             (dial_type, dial_name, from_value, to_value, direction, status, cycle_date, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('analyst_weight', 'fundamentals', 0.4, 0.5, null, 'maybe', '2026-07-26', 'now'),
    ).toThrow();
  });

  it('upserts config_trials on conflict, overwriting result_json', () => {
    const db = openSharedStore(':memory:');
    const upsert = db.prepare(
      `INSERT INTO config_trials (config_hash, seed, config_json, result_json, recorded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(config_hash) DO UPDATE SET result_json = excluded.result_json`,
    );

    upsert.run('hash-1', 7, '{}', '{"sharpe":1}', '2026-07-26T00:00:00.000Z');
    upsert.run('hash-1', 7, '{}', '{"sharpe":2}', '2026-07-26T01:00:00.000Z');

    expect(db.prepare('SELECT result_json FROM config_trials').all()).toEqual([
      { result_json: '{"sharpe":2}' },
    ]);
  });

  it('rejects a duplicate cosine_setups write for the same debate (PK)', () => {
    const db = openSharedStore(':memory:');
    const insert = db.prepare(
      `INSERT INTO cosine_setups (
         debate_id, idempotency_key, instrument, asset_class,
         debate_features_json, market_features_json, r_multiple, closed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    );

    insert.run('debate-1', 'key-1', 'AAPL', 'stocks', '[1]', '[1]', '2026-07-26T00:00:00.000Z');

    expect(() =>
      insert.run('debate-1', 'key-2', 'AAPL', 'stocks', '[1]', '[1]', '2026-07-26T00:00:00.000Z'),
    ).toThrow();
  });
});
