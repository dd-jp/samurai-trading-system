import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from './migrate.js';
import { openSharedStore, STORE_ENVIRONMENTS, sharedStorePath } from './open-shared-store.js';

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
  'breaker_state',
  'verdict_log',
  'audit_log',
  'current_tick',
  'cii_snapshots',
  // `account_state` shipped in 0006 without being listed here — the assertion
  // is only as good as the list, so it is added with 0007's two.
  'account_state',
  'broker_brackets',
  'broker_observed_fills',
  'broker_unpriced_fills',
  // `session_equity` (0009) very nearly repeated `account_state`'s omission
  // above, which is why the assertion below is now an exact set rather than a
  // one-directional "every listed table exists": that form is blind to a table
  // nobody listed, so it could never have caught either miss.
  'session_equity',
  // `llm_spend` (0010) — locally-metered Anthropic token spend, the stand-in
  // for the credit-balance endpoint Anthropic does not publish.
  'llm_spend',
  // `daily_equity` (0011) — the append-only daily equity series `computeMetrics`
  // derives a live `ReturnSeries` from (#345). Samples the same boundary
  // `session_equity` above does; unlike it, never overwrites a row.
  'daily_equity',
];

/**
 * Mirrors shared-sqlite-store-spec.md's "Consolidated Schema" count, which the
 * Non-Collision Verification section asserts it has checked every table in.
 * That prose number silently drifted twice (it read "twenty" and "twenty-one"
 * simultaneously while the schema held 22), so it is pinned here.
 */
const CONSOLIDATED_SCHEMA_TABLE_COUNT = 24;

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

    // Exact set, both directions. A migration that adds a table without adding
    // it here now FAILS rather than passing unnoticed — the gap that let
    // `account_state` (0006) and `session_equity` (0009) both ship unlisted.
    // `sqlite_sequence` is SQLite's own AUTOINCREMENT bookkeeping, created
    // implicitly, so it is excluded rather than declared.
    const declared = new Set([...TABLES, 'schema_migrations']);
    const unexpected = [...names].filter(
      (name) => !declared.has(name) && name !== 'sqlite_sequence',
    );
    expect(unexpected, `tables in the DB but not declared in TABLES: ${unexpected}`).toEqual([]);

    expect(TABLES).toHaveLength(CONSOLIDATED_SCHEMA_TABLE_COUNT);
  });

  it('records applied versions and re-migrating is a no-op', () => {
    const db = openSharedStore(':memory:');

    const versions = db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
    ]);
    expect(runMigrations(db)).toEqual([]);
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
    ]);
  });

  it('sets WAL mode and synchronous=FULL on a file-backed connection', () => {
    const db = openSharedStore(tempDbPath());

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    // synchronous=FULL is 2 in SQLite's pragma encoding.
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
  });

  it('creates the parent directory rather than failing on a fresh checkout (#323)', () => {
    // `sharedStorePath()` resolves to `data/samurai-{env}.sqlite`, and `data/`
    // is gitignored — so on any fresh clone it does not exist. Without this,
    // `yarn orchestrator` died at the store open with better-sqlite3's
    // "Cannot open database because the directory does not exist": no path, no
    // stage, no hint that a `mkdir` is all it wanted.
    const root = mkdtempSync(join(tmpdir(), 'samurai-store-'));
    const path = join(root, 'data', 'nested', 'samurai-development.sqlite');

    const db = openSharedStore(path);

    try {
      expect(existsSync(path)).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
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

  it('enforces the CHECK constraint on breaker_state.tier', () => {
    const db = openSharedStore(':memory:');

    expect(() =>
      db
        .prepare(
          `INSERT INTO breaker_state (tier, tripped, tripped_at, reset_at, reason)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('daily_loss', 0, null, null, null),
    ).toThrow();

    db.prepare(
      `INSERT INTO breaker_state (tier, tripped, tripped_at, reset_at, reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('kill_switch', 1, '2026-07-26T00:00:00.000Z', null, 'manual halt');

    expect(db.prepare('SELECT COUNT(*) AS n FROM breaker_state').get()).toEqual({ n: 1 });
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

describe('sharedStorePath', () => {
  it('names one file per environment, the convention both entrypoints share', () => {
    expect(sharedStorePath('production')).toBe('data/samurai-production.sqlite');
    expect(sharedStorePath('development')).toBe('data/samurai-development.sqlite');
    // Distinct files is the mechanism, not a detail: paper and live sharing a
    // file would make cross-contamination possible.
    expect(new Set(STORE_ENVIRONMENTS.map((env) => sharedStorePath(env))).size).toBe(
      STORE_ENVIRONMENTS.length,
    );
  });

  it('reads NODE_ENV when called with no argument — both entrypoints rely on that', () => {
    // vitest sets NODE_ENV=test, which is why `test` is allow-listed.
    expect(sharedStorePath()).toBe('data/samurai-test.sqlite');
  });

  it('defaults to development when NODE_ENV is unset', () => {
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(sharedStorePath()).toBe('data/samurai-development.sqlite');
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('throws on an unrecognised environment rather than opening a different file', () => {
    // The failure this prevents is silent: `prod` would open an empty
    // data/samurai-prod.sqlite while real positions sit open at the broker.
    for (const raw of ['prod', 'Production', 'PRODUCTION', '', 'live']) {
      expect(() => sharedStorePath(raw)).toThrow(/must be one of/i);
    }
  });

  it('refuses a path-bearing environment instead of interpolating it', () => {
    for (const raw of ['../../etc/passwd', 'production/../../x', 'a/b']) {
      expect(() => sharedStorePath(raw)).toThrow(/must be one of/i);
    }
  });

  it('names the offending value so an operator can see the typo', () => {
    expect(() => sharedStorePath('prod')).toThrow(/"prod"/);
  });

  it('resolves identically whether NODE_ENV is passed explicitly or read here', () => {
    // Both entrypoints call it with no argument, but the equivalence is what
    // makes that safe: the orchestrator writes the file the dashboard reads,
    // so any divergence between the two call shapes is a silent split-brain.
    for (const raw of [...STORE_ENVIRONMENTS, undefined]) {
      const saved = process.env.NODE_ENV;
      if (raw === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = raw;
      try {
        expect(sharedStorePath()).toBe(sharedStorePath(process.env.NODE_ENV ?? 'development'));
      } finally {
        process.env.NODE_ENV = saved;
      }
    }
  });
});
