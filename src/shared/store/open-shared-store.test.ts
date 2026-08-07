import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from './migrate.js';
import { openSharedStore, STORE_MODES, sharedStorePath } from './open-shared-store.js';

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
  // #328 — the Trader/Risk decision records, migration 0016.
  'trader_log',
  'risk_log',
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
  // `stage2_selected_config` (0014) — the frozen Stage 2 selection (#375,
  // #384). Where `DailyMetricsSample.revalidation` and the divergence baseline
  // both come from, and the reason four kill-lines out of four could not fire.
  'stage2_selected_config',
  // `flatten_submissions` (0019) — the durable journal for `execute()`'s
  // exit path (#508 review, PR #516): an exit writes no `open_positions`
  // row, so without this table a replayed flatten had nothing to dedupe
  // against and a lost `submitFlatten` response had no clientOrderId for
  // reconcile to resolve.
  'flatten_submissions',
];

/**
 * Mirrors shared-sqlite-store-spec.md's "Consolidated Schema" count, which the
 * Non-Collision Verification section asserts it has checked every table in.
 * That prose number silently drifted twice (it read "twenty" and "twenty-one"
 * simultaneously while the schema held 22), so it is pinned here.
 */
const CONSOLIDATED_SCHEMA_TABLE_COUNT = 28;

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
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
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
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
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

/**
 * #330 — the path is keyed off the TRADING MODE, not `NODE_ENV`.
 *
 * The hazard it closes is specific and is exactly the graduation this project
 * plans: on one `NODE_ENV=production` host, flipping `SAMURAI_MODE` from
 * `paper` to `live` used to leave both writing `samurai-production.sqlite`, so
 * a live composition root inherited paper lots and fills as real state and
 * computed risk caps and drawdown against them.
 */
describe('sharedStorePath', () => {
  const savedMode = process.env.SAMURAI_MODE;

  afterEach(() => {
    if (savedMode === undefined) delete process.env.SAMURAI_MODE;
    else process.env.SAMURAI_MODE = savedMode;
  });

  it('names one file per trading mode', () => {
    expect(sharedStorePath('paper')).toBe('data/samurai-paper.sqlite');
    expect(sharedStorePath('live')).toBe('data/samurai-live.sqlite');
    expect(sharedStorePath('backtest')).toBe('data/samurai-backtest.sqlite');
  });

  it('gives paper and live distinct files — the mechanism, not a detail', () => {
    // Two paths never share state, so paper/live cross-contamination is
    // physically impossible rather than merely discouraged.
    expect(new Set(STORE_MODES.map((mode) => sharedStorePath(mode))).size).toBe(STORE_MODES.length);
  });

  it('does NOT vary with NODE_ENV — that was the bug', () => {
    process.env.SAMURAI_MODE = 'paper';
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const inProduction = sharedStorePath();
      process.env.NODE_ENV = 'staging';
      expect(sharedStorePath()).toBe(inProduction);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('reads SAMURAI_MODE when called with no argument — both entrypoints rely on that', () => {
    process.env.SAMURAI_MODE = 'live';
    expect(sharedStorePath()).toBe('data/samurai-live.sqlite');
  });

  it('refuses an unset or unrecognised mode rather than defaulting to paper', () => {
    // A default of `paper` would be the #330 hazard inverted: a live run whose
    // SAMURAI_MODE failed to export would open the paper database and trade
    // real money against paper state.
    for (const raw of [undefined, '', 'Paper', 'PAPER', 'production', 'a/b', '../../etc/passwd']) {
      if (raw === undefined) delete process.env.SAMURAI_MODE;
      else process.env.SAMURAI_MODE = raw;
      expect(() => sharedStorePath()).toThrow(/must be one of/i);
    }
  });

  it('names the offending value so an operator can see the typo', () => {
    process.env.SAMURAI_MODE = 'papr';
    expect(() => sharedStorePath()).toThrow(/"papr"/);
  });
});

describe('sharedStorePath — the pre-#330 database (migration story)', () => {
  const savedMode = process.env.SAMURAI_MODE;
  const savedEnv = process.env.NODE_ENV;
  const savedCwd = process.cwd();
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'samurai-legacy-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    process.chdir(root);
    process.env.SAMURAI_MODE = 'paper';
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(root, { recursive: true, force: true });
    if (savedMode === undefined) delete process.env.SAMURAI_MODE;
    else process.env.SAMURAI_MODE = savedMode;
    process.env.NODE_ENV = savedEnv;
  });

  it('refuses to start against an empty store when a pre-#330 file is stranded', () => {
    // Without this, the run opens a fresh database and sees none of the
    // positions, fills or tuning history in the old one — while any real
    // positions stay open at the broker.
    writeFileSync(join(root, 'data', 'samurai-production.sqlite'), '');

    expect(() => sharedStorePath()).toThrow(/samurai-production\.sqlite/);
    expect(() => sharedStorePath()).toThrow(/mv data\/samurai-production\.sqlite/);
  });

  it('says nothing once the mode-keyed file exists', () => {
    writeFileSync(join(root, 'data', 'samurai-production.sqlite'), '');
    writeFileSync(join(root, 'data', 'samurai-paper.sqlite'), '');

    expect(sharedStorePath()).toBe('data/samurai-paper.sqlite');
  });

  it('says nothing on a clean install with no legacy file at all', () => {
    expect(sharedStorePath()).toBe('data/samurai-paper.sqlite');
  });

  it('refuses rather than renaming — moving live-money state is the operator call', () => {
    writeFileSync(join(root, 'data', 'samurai-production.sqlite'), '');

    expect(() => sharedStorePath()).toThrow();
    // The old file is exactly where it was: only the operator knows whether it
    // is paper history to carry forward or live state a paper run must not get.
    expect(existsSync(join(root, 'data', 'samurai-production.sqlite'))).toBe(true);
    expect(existsSync(join(root, 'data', 'samurai-paper.sqlite'))).toBe(false);
  });
});
