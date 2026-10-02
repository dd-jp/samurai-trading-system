import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { listMigrations, MIGRATIONS_DIR, runMigrations } from './migrate.js';
import {
  inMemoryCopyOf,
  openMigratedStore,
  openReadOnlyStore,
  openSharedStore,
  STORE_MODES,
  sharedStorePath,
} from './open-shared-store.js';

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
  'trader_log',
  'risk_log',
  'audit_log',
  'current_tick',
  'cii_snapshots',
  'account_state',
  'broker_brackets',
  'broker_unpriced_fills',
  'session_equity',
  'llm_spend',
  'daily_equity',
  'stage2_selected_config',
  'flatten_submissions',
  'risk_critic_log',
  'arm_comparison_samples',
  'outside_benchmark_samples',
  'llm_call_log',
  'alert_delivery_failures',
  'feedback_cycle_schedule',
  'llm_spend_cap',
  'debate_round_log',
  'llm_gate_refusals',
  'v2_books',
  'v2_book_days',
  'v2_decisions',
  'v2_positions',
  'v2_orders',
  'v2_fills',
  'v2_refusals',
  'v2_capital_config',
  'v2_trials',
  'v2_controls',
  'v2_commands',
  'v2_reconciles',
  'v2_news',
  'v2_signals',
  'v2_signal_events',
  'v2_run_lease',
  'v2_faults',
  'v2_heartbeat_pings',
  'v2_splits',
];

const CONSOLIDATED_SCHEMA_TABLE_COUNT = 55;

const MIGRATIONS = listMigrations(MIGRATIONS_DIR);
const MIGRATION_VERSIONS = MIGRATIONS.map((migration) => migration.version);
const HIGHEST_KNOWN_MIGRATION_VERSION = 84;

function copyMigrationsUpTo(throughVersion: number): string {
  const dir = mkdtempSync(join(tmpdir(), `samurai-migrations-through-${throughVersion}-`));
  for (const migration of MIGRATIONS) {
    if (migration.version <= throughVersion) {
      copyFileSync(join(MIGRATIONS_DIR, migration.filename), join(dir, migration.filename));
    }
  }
  return dir;
}

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

    const declared = new Set([...TABLES, 'schema_migrations']);
    const unexpected = [...names].filter(
      (name) => !declared.has(name) && name !== 'sqlite_sequence',
    );
    expect(unexpected, `tables in the DB but not declared in TABLES: ${unexpected}`).toEqual([]);

    expect(TABLES).toHaveLength(CONSOLIDATED_SCHEMA_TABLE_COUNT);
  });

  it('records applied versions and re-migrating is a no-op', () => {
    const db = openSharedStore(':memory:');

    const expectedVersions = MIGRATIONS.map((migration) => ({ version: migration.version }));

    const versions = db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual(expectedVersions);
    expect(runMigrations(db)).toEqual([]);
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual(expectedVersions);
  });

  it('migration 0045 adds a nullable sizing_capital_ceiling to both lot tables (#1112)', () => {
    const db = openSharedStore(':memory:');

    for (const table of ['open_positions', 'closed_trades']) {
      const column = (
        db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
        }[]
      ).find((candidate) => candidate.name === 'sizing_capital_ceiling');

      expect(column, `${table} is missing column sizing_capital_ceiling`).toBeDefined();
      expect(column?.type).toBe('REAL');
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }
  });

  it('migration 0056 adds a nullable abandon_reason to open_positions only (#1186)', () => {
    const db = openSharedStore(':memory:');

    const column = (
      db.prepare('PRAGMA table_info(open_positions)').all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    ).find((candidate) => candidate.name === 'abandon_reason');

    expect(column, 'open_positions is missing column abandon_reason').toBeDefined();
    expect(column?.type).toBe('TEXT');
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBeNull();

    const closedTradesColumn = (
      db.prepare('PRAGMA table_info(closed_trades)').all() as { name: string }[]
    ).find((candidate) => candidate.name === 'abandon_reason');
    expect(closedTradesColumn).toBeUndefined();
  });

  it('migration 0071 adds nullable book_id and instrument to v2_refusals (#1806)', () => {
    const db = openSharedStore(':memory:');

    const columns = db.prepare('PRAGMA table_info(v2_refusals)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }[];
    for (const name of ['book_id', 'instrument']) {
      const column = columns.find((candidate) => candidate.name === name);
      expect(column, `v2_refusals is missing column ${name}`).toBeDefined();
      expect(column?.type).toBe('TEXT');
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }
  });

  it('migration 0071 applies cleanly to a store with pre-existing refusal rows, which read back with a NULL scope (#1806)', () => {
    const raw = new BetterSqlite3(':memory:');
    const preCutoverVersion = 70;
    const preCutoverDir = copyMigrationsUpTo(preCutoverVersion);
    try {
      runMigrations(raw, preCutoverDir);
      raw
        .prepare(
          `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, recorded_at)
           VALUES ('2026-09-25', 'entry', 'ADV_WINDOW_COVERAGE', '#1', 'debate/primary THIN: no_adv',
             '2026-09-25T21:40:00.000Z')`,
        )
        .run();

      expect(runMigrations(raw, MIGRATIONS_DIR)).toEqual(
        MIGRATION_VERSIONS.filter((version) => version > preCutoverVersion),
      );

      expect(
        raw
          .prepare('SELECT book_id, instrument FROM v2_refusals WHERE parameter = ?')
          .get('ADV_WINDOW_COVERAGE'),
      ).toEqual({ book_id: null, instrument: null });
    } finally {
      raw.close();
      rmSync(preCutoverDir, { recursive: true, force: true });
    }
  });

  it('migration 0071 adds the journal read indexes (#1806)', () => {
    const db = openSharedStore(':memory:');
    const indexed = ({ table, column }: { table: string; column: string }): boolean => {
      const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[];
      return indexes.some((index) => {
        const columns = db.prepare(`PRAGMA index_info(${index.name})`).all() as { name: string }[];
        return columns.some((info) => info.name === column);
      });
    };
    expect(indexed({ table: 'v2_decisions', column: 'trading_date' })).toBe(true);
    expect(indexed({ table: 'v2_orders', column: 'trading_date' })).toBe(true);
    expect(indexed({ table: 'v2_orders', column: 'decision_id' })).toBe(true);
    expect(indexed({ table: 'v2_fills', column: 'client_order_id' })).toBe(true);
    expect(indexed({ table: 'v2_refusals', column: 'trading_date' })).toBe(true);
  });

  it('migration 0049 adds modelled_cost_charged to closed_trades, NOT NULL DEFAULT 1, backfilling live rows to 0 (#1121)', () => {
    const db = openSharedStore(':memory:');

    const column = (
      db.prepare('PRAGMA table_info(closed_trades)').all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    ).find((candidate) => candidate.name === 'modelled_cost_charged');

    expect(column, 'closed_trades is missing column modelled_cost_charged').toBeDefined();
    expect(column?.type).toBe('INTEGER');
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe('1');
  });

  it('migration 0049 backfills pre-existing live rows to 0 and control rows to 1 (#1121)', () => {
    const raw = new BetterSqlite3(':memory:');
    const preCutoverVersion = 48;
    const preCutoverDir = copyMigrationsUpTo(preCutoverVersion);
    try {
      runMigrations(raw, preCutoverDir);

      for (const [key, arm] of [
        ['live-pre-fix', 'live'],
        ['control-pre-fix', 'control'],
      ] as const) {
        raw
          .prepare(
            `INSERT INTO closed_trades (
               idempotency_key, debate_id, instrument, asset_class, side,
               entry, stop, filled_size, realized_pnl_net, fees_total,
               opened_at, closed_at, close_reason, arm
             ) VALUES (?, 'd1', 'AAPL', 'stocks', 'buy', 100, 90, 10, 5, 0,
               '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', 'target', ?)`,
          )
          .run(key, arm);
      }

      expect(runMigrations(raw, MIGRATIONS_DIR)).toEqual(
        MIGRATION_VERSIONS.filter((version) => version > preCutoverVersion),
      );

      expect(
        raw
          .prepare('SELECT modelled_cost_charged FROM closed_trades WHERE idempotency_key = ?')
          .get('live-pre-fix'),
      ).toEqual({ modelled_cost_charged: 0 });
      expect(
        raw
          .prepare('SELECT modelled_cost_charged FROM closed_trades WHERE idempotency_key = ?')
          .get('control-pre-fix'),
      ).toEqual({ modelled_cost_charged: 1 });
    } finally {
      raw.close();
      rmSync(preCutoverDir, { recursive: true, force: true });
    }
  });

  it('migration 0052 normalizes the pre-conversion ceiling stamp on both lot tables (#1180)', () => {
    const raw = new BetterSqlite3(':memory:');
    const preCutoverVersion = 51;
    const preCutoverDir = copyMigrationsUpTo(preCutoverVersion);
    try {
      runMigrations(raw, preCutoverDir);

      for (const [key, ceiling] of [
        ['paper-pre-conversion', 1000],
        ['other-book', 5000],
      ] as const) {
        raw
          .prepare(
            `INSERT INTO closed_trades (
               idempotency_key, debate_id, instrument, asset_class, side,
               entry, stop, filled_size, realized_pnl_net, fees_total,
               opened_at, closed_at, close_reason, arm, sizing_capital_ceiling
             ) VALUES (?, 'd1', 'AAPL', 'stocks', 'buy', 100, 90, 10, 5, 0,
               '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', 'target', 'live', ?)`,
          )
          .run(key, ceiling);
        raw
          .prepare(
            `INSERT INTO open_positions (
               idempotency_key, debate_id, instrument, asset_class, side, intent_type,
               requested_size, filled_size, avg_entry_price, stop, target,
               order_state, broker_order_ids, opened_at, decision_timestamp,
               conviction, converged, arm, sizing_capital_ceiling
             ) VALUES (?, 'd1', 'AAPL', 'stocks', 'buy', 'entry', 10, 10, 100, 90, 110,
               'filled', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
               0.7, 1, 'live', ?)`,
          )
          .run(key, ceiling);
      }

      expect(runMigrations(raw, MIGRATIONS_DIR)).toEqual(
        MIGRATION_VERSIONS.filter((version) => version > preCutoverVersion),
      );

      for (const table of ['closed_trades', 'open_positions']) {
        expect(
          raw
            .prepare(`SELECT sizing_capital_ceiling FROM ${table} WHERE idempotency_key = ?`)
            .get('paper-pre-conversion'),
          `${table} was not normalized to the converted ceiling`,
        ).toEqual({ sizing_capital_ceiling: 1270 });
        expect(
          raw
            .prepare(`SELECT sizing_capital_ceiling FROM ${table} WHERE idempotency_key = ?`)
            .get('other-book'),
          `${table}: a genuinely different declared ceiling was rewritten`,
        ).toEqual({ sizing_capital_ceiling: 5000 });
      }
    } finally {
      raw.close();
      rmSync(preCutoverDir, { recursive: true, force: true });
    }
  });

  it('migration 0055 preserves pre-existing bracket and unpriced-fill rows across the CHECK rebuild (#1459)', () => {
    const raw = new BetterSqlite3(':memory:');
    const preCutoverVersion = 54;
    const preCutoverDir = copyMigrationsUpTo(preCutoverVersion);
    try {
      runMigrations(raw, preCutoverDir);

      raw
        .prepare(
          `INSERT INTO broker_brackets (
             venue, client_order_id, phase,
             entry_order_id, stop_order_id, target_order_id,
             instrument, asset_class, side, size,
             entry_price, stop_price, target_price, time_in_force,
             armed_qty, arming_qty, arm_attempt, updated_at
           ) VALUES (
             'alpaca', 'pre-0055-bracket', 'armed',
             'e-1', 's-1', 't-1',
             'AAPL', 'stocks', 'buy', 12.5,
             101.5, 90.5, 121.5, 'day',
             8.5, 4.5, 3, '2026-09-01T00:00:00.000Z'
           )`,
        )
        .run();

      raw
        .prepare(
          `INSERT INTO broker_unpriced_fills (
             venue, client_order_id, broker_fill_id, leg, instrument, qty,
             first_seen_at, last_seen_at, alerted_at
           ) VALUES (
             'saxo', 'pre-0055-fill', 'f-1', 'stop', 'MSFT', 6.5,
             '2026-09-01T00:00:00.000Z', '2026-09-01T00:05:00.000Z', '2026-09-01T00:10:00.000Z'
           )`,
        )
        .run();

      expect(runMigrations(raw, MIGRATIONS_DIR)).toEqual(
        MIGRATION_VERSIONS.filter((version) => version > preCutoverVersion),
      );

      expect(
        raw
          .prepare('SELECT * FROM broker_brackets WHERE client_order_id = ?')
          .get('pre-0055-bracket'),
      ).toEqual({
        venue: 'alpaca',
        client_order_id: 'pre-0055-bracket',
        phase: 'armed',
        entry_order_id: 'e-1',
        stop_order_id: 's-1',
        target_order_id: 't-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'buy',
        size: 12.5,
        entry_price: 101.5,
        stop_price: 90.5,
        target_price: 121.5,
        time_in_force: 'day',
        armed_qty: 8.5,
        arming_qty: 4.5,
        arm_attempt: 3,
        updated_at: '2026-09-01T00:00:00.000Z',
      });

      expect(
        raw
          .prepare('SELECT * FROM broker_unpriced_fills WHERE client_order_id = ?')
          .get('pre-0055-fill'),
      ).toEqual({
        venue: 'saxo',
        client_order_id: 'pre-0055-fill',
        broker_fill_id: 'f-1',
        leg: 'stop',
        instrument: 'MSFT',
        qty: 6.5,
        first_seen_at: '2026-09-01T00:00:00.000Z',
        last_seen_at: '2026-09-01T00:05:00.000Z',
        alerted_at: '2026-09-01T00:10:00.000Z',
      });
    } finally {
      raw.close();
      rmSync(preCutoverDir, { recursive: true, force: true });
    }
  });

  it('migration 0079 keeps every legacy book day and reads its CFD carry as zero (#1850)', () => {
    const raw = new BetterSqlite3(':memory:');
    const preCutoverVersion = 77;
    const preCutoverDir = copyMigrationsUpTo(preCutoverVersion);
    try {
      runMigrations(raw, preCutoverDir);
      raw
        .prepare(
          `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
           VALUES ('debate/primary', 'debate', 'primary', 600, 400, '2026-09-25T07:00:00.000Z')`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp,
             ytd_loss_gbp, size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
           VALUES ('debate/primary', '2026-09-29', 600, 400, 200, 0, 1, 0, 0.01,
             '2026-09-29T21:00:00.000Z')`,
        )
        .run();

      expect(runMigrations(raw, MIGRATIONS_DIR)).toEqual(
        MIGRATION_VERSIONS.filter((version) => version > preCutoverVersion),
      );

      expect(
        raw
          .prepare(
            'SELECT equity_gbp, custody_accrual_gbp, cfd_financing_accrual_gbp, cfd_borrow_accrual_gbp FROM v2_book_days',
          )
          .all(),
      ).toEqual([
        {
          equity_gbp: 600,
          custody_accrual_gbp: 0.01,
          cfd_financing_accrual_gbp: 0,
          cfd_borrow_accrual_gbp: 0,
        },
      ]);
    } finally {
      raw.close();
      rmSync(preCutoverDir, { recursive: true, force: true });
    }
  });

  it('migration 0081 keeps the legacy decision and fill journal and makes it append-only (#1883)', () => {
    const raw = new BetterSqlite3(':memory:');
    const preCutoverVersion = 79;
    const preCutoverDir = copyMigrationsUpTo(preCutoverVersion);
    try {
      runMigrations(raw, preCutoverDir);
      raw.exec(
        `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
           VALUES ('debate/primary', 'debate', 'primary', 600, 400, '2026-09-25T07:00:00.000Z');
         INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash,
           direction, confidence, action, reason, size_shares, stop_price, payload, recorded_at)
           VALUES ('d1', 'debate/primary', '2026-09-29', 'AAPL', 'alpaca', 'h', 'bullish', 0.7,
             'enter_long', 'judge bullish', 3, 96, '{}', '2026-09-29T07:00:00.000Z');
         INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
           leg, side, dry_run, outcome, payload, recorded_at)
           VALUES ('o1', 'd1', 'debate/primary', '2026-09-29', 'AAPL', 'alpaca', 'entry', 'buy', 0,
             'submitted', '{}', '2026-09-29T07:00:00.000Z');
         INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
           side, qty, price_gbp, fee_gbp, recorded_at)
           VALUES ('alpaca:f1', 'o1', 'debate/primary', '2026-09-29', 'AAPL', 'alpaca', 'entry', 'buy',
             3, 80, 0.1, '2026-09-29T14:30:00.000Z');`,
      );

      expect(runMigrations(raw, MIGRATIONS_DIR)).toEqual(
        MIGRATION_VERSIONS.filter((version) => version > preCutoverVersion),
      );

      expect(raw.prepare('SELECT decision_id, action FROM v2_decisions').all()).toEqual([
        { decision_id: 'd1', action: 'enter_long' },
      ]);
      expect(raw.prepare('SELECT fill_id, qty FROM v2_fills').all()).toEqual([
        { fill_id: 'alpaca:f1', qty: 3 },
      ]);
      expect(() => raw.prepare("UPDATE v2_decisions SET action = 'exit'").run()).toThrow(
        'v2_decisions is append-only',
      );
      expect(() => raw.prepare('DELETE FROM v2_decisions').run()).toThrow(
        'v2_decisions is append-only',
      );
      expect(() => raw.prepare('UPDATE v2_fills SET qty = 1').run()).toThrow(
        'v2_fills is append-only',
      );
      expect(() => raw.prepare('DELETE FROM v2_fills').run()).toThrow('v2_fills is append-only');
      expect(() => raw.prepare("UPDATE v2_orders SET outcome = 'cancelled'").run()).not.toThrow();
    } finally {
      raw.close();
      rmSync(preCutoverDir, { recursive: true, force: true });
    }
  });

  it('migration 0084 leaves a legacy fill uncaptured and journals splits append-only (#1947)', () => {
    const raw = new BetterSqlite3(':memory:');
    const preCutoverVersion = 82;
    const preCutoverDir = copyMigrationsUpTo(preCutoverVersion);
    try {
      runMigrations(raw, preCutoverDir);
      raw.exec(
        `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
           leg, side, dry_run, outcome, payload, recorded_at)
           VALUES ('o1', NULL, 'debate/primary', '2026-09-29', 'AAPL', 'alpaca', 'entry', 'buy', 0,
             'submitted', '{}', '2026-09-29T07:00:00.000Z');
         INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
           side, qty, price_gbp, fee_gbp, recorded_at)
           VALUES ('alpaca:f1', 'o1', 'debate/primary', '2026-09-29', 'AAPL', 'alpaca', 'entry', 'buy',
             3, 80, 0.1, '2026-09-29T14:30:00.000Z');`,
      );

      expect(runMigrations(raw, MIGRATIONS_DIR)).toEqual(
        MIGRATION_VERSIONS.filter((version) => version > preCutoverVersion),
      );

      expect(
        raw
          .prepare(
            'SELECT currency, price_native, fee_native, fx_quote_per_gbp, fx_source, fill_date FROM v2_fills',
          )
          .all(),
      ).toEqual([
        {
          currency: null,
          price_native: null,
          fee_native: null,
          fx_quote_per_gbp: null,
          fx_source: null,
          fill_date: null,
        },
      ]);
      const split = raw.prepare(
        `INSERT INTO v2_splits (instrument, venue, split_date, ratio, trading_date, recorded_at)
         VALUES ('AAPL', 'alpaca', '2026-10-01', ?, '2026-10-02', '2026-10-02T07:00:00.000Z')`,
      );
      split.run(1.5);
      split.run(4);
      expect(raw.prepare('SELECT ratio FROM v2_splits').all()).toEqual([{ ratio: 1.5 }]);
      expect(() => raw.prepare('UPDATE v2_splits SET ratio = 2').run()).toThrow(
        'v2_splits is append-only',
      );
      expect(() => raw.prepare('DELETE FROM v2_splits').run()).toThrow('v2_splits is append-only');
      expect(() =>
        raw
          .prepare(
            `INSERT INTO v2_splits (instrument, venue, split_date, ratio, trading_date, recorded_at)
             VALUES ('MSFT', 'alpaca', '2026-10-01', 0, '2026-10-02', '2026-10-02T07:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/CHECK constraint/);
    } finally {
      raw.close();
      rmSync(preCutoverDir, { recursive: true, force: true });
    }
  });

  it('migration 0050 backfills each flatten row to its lots’ arm, falling back to live (#1124)', () => {
    const raw = new BetterSqlite3(':memory:');
    const preCutoverVersion = 49;
    const preCutoverDir = copyMigrationsUpTo(preCutoverVersion);
    try {
      runMigrations(raw, preCutoverDir);

      raw
        .prepare(
          `INSERT INTO closed_trades (
             idempotency_key, debate_id, instrument, asset_class, side,
             entry, stop, filled_size, realized_pnl_net, fees_total,
             opened_at, closed_at, close_reason, arm
           ) VALUES ('lot-closed', 'd1', 'QQQ', 'stocks', 'buy', 100, 90, 10, 5, 0,
             '2026-09-04T00:00:00.000Z', '2026-09-04T01:00:00.000Z', 'flatten', 'control')`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO open_positions (
             idempotency_key, debate_id, instrument, asset_class, side, intent_type,
             requested_size, filled_size, avg_entry_price, stop, target,
             order_state, broker_order_ids, opened_at, decision_timestamp, arm
           ) VALUES ('lot-open', 'd2', 'SPY', 'stocks', 'buy', 'entry',
             10, 10, 100, 90, 110, 'filled', '["o1"]',
             '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z', 'control')`,
        )
        .run();

      const insertFlatten = raw.prepare(
        `INSERT INTO flatten_submissions (
           idempotency_key, instrument, asset_class, side, size, status,
           submitted_at, lot_idempotency_keys
         ) VALUES (?, ?, 'stocks', 'sell', 10, 'submitted', '2026-09-04T02:00:00.000Z', ?)`,
      );
      insertFlatten.run('flatten-of-closed', 'QQQ', JSON.stringify(['lot-closed']));
      insertFlatten.run('flatten-of-open', 'SPY', JSON.stringify(['lot-open']));
      insertFlatten.run('flatten-of-aged-out', 'MARA', JSON.stringify(['lot-gone']));
      insertFlatten.run('flatten-of-nothing', 'MU', null);

      expect(runMigrations(raw, MIGRATIONS_DIR)).toEqual(
        MIGRATION_VERSIONS.filter((version) => version > preCutoverVersion),
      );

      expect(
        raw
          .prepare('SELECT idempotency_key, arm FROM flatten_submissions ORDER BY idempotency_key')
          .all(),
      ).toEqual([
        { idempotency_key: 'flatten-of-aged-out', arm: 'live' },
        { idempotency_key: 'flatten-of-closed', arm: 'control' },
        { idempotency_key: 'flatten-of-nothing', arm: 'live' },
        { idempotency_key: 'flatten-of-open', arm: 'control' },
      ]);

      expect(
        raw
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'index' AND tbl_name = 'flatten_submissions'
                AND name = 'idx_flatten_submissions_arm'`,
          )
          .get(),
      ).toEqual({ name: 'idx_flatten_submissions_arm' });
    } finally {
      raw.close();
      rmSync(preCutoverDir, { recursive: true, force: true });
    }
  });

  it('migration 0046 adds the nullable no-go detail columns to verdict_log (#1111)', () => {
    const db = openSharedStore(':memory:');

    const byName = new Map(
      (
        db.prepare('PRAGMA table_info(verdict_log)').all() as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
        }[]
      ).map((column) => [column.name, column]),
    );

    for (const name of ['no_go_detail_measured_ms', 'no_go_detail_bound_ms']) {
      const column = byName.get(name);
      expect(column, `verdict_log is missing column ${name}`).toBeDefined();
      expect(column?.type).toBe('REAL');
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }
  });

  it('migration 0024 adds the residual-protection marker columns as nullable TEXT (#549)', () => {
    const db = openSharedStore(':memory:');

    const columns = db.prepare('PRAGMA table_info(open_positions)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }[];
    const byName = new Map(columns.map((column) => [column.name, column]));

    for (const name of ['residual_unprotected_since', 'residual_rearm_alerted_at']) {
      const column = byName.get(name);
      expect(column, `open_positions is missing column ${name}`).toBeDefined();
      expect(column?.type).toBe('TEXT');
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }

    db.prepare(
      `INSERT INTO open_positions (
         idempotency_key, debate_id, instrument, asset_class, side, intent_type,
         requested_size, filled_size, avg_entry_price, stop, target,
         order_state, broker_order_ids, opened_at, decision_timestamp,
         conviction, converged
       ) VALUES ('k1', 'd1', 'AAPL', 'stocks', 'buy', 'entry',
         10, 0, 0, 95, 110, 'submitted', '[]', '2026-08-07T14:00:00.000Z',
         '2026-08-07T14:00:00.000Z', 0.7, 1)`,
    ).run();
    const fresh = db
      .prepare(
        'SELECT residual_unprotected_since, residual_rearm_alerted_at FROM open_positions ' +
          "WHERE idempotency_key = 'k1'",
      )
      .get() as { residual_unprotected_since: unknown; residual_rearm_alerted_at: unknown };
    expect(fresh).toEqual({ residual_unprotected_since: null, residual_rearm_alerted_at: null });

    db.prepare(
      `UPDATE open_positions SET residual_unprotected_since = '2026-08-07T16:00:00.000Z',
        residual_rearm_alerted_at = '2026-08-07T16:01:00.000Z' WHERE idempotency_key = 'k1'`,
    ).run();
    expect(
      db
        .prepare(
          'SELECT residual_unprotected_since, residual_rearm_alerted_at FROM open_positions ' +
            "WHERE idempotency_key = 'k1'",
        )
        .get(),
    ).toEqual({
      residual_unprotected_since: '2026-08-07T16:00:00.000Z',
      residual_rearm_alerted_at: '2026-08-07T16:01:00.000Z',
    });
  });

  it('migration 0027 adds key_scheme defaulting to 2, with existing rows at 1 (#686)', () => {
    const db = openSharedStore(':memory:');

    const column = (
      db.prepare('PRAGMA table_info(open_positions)').all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    ).find((c) => c.name === 'key_scheme');

    expect(column, 'open_positions is missing column key_scheme').toBeDefined();
    expect(column?.type).toBe('INTEGER');
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe('2');
  });

  it('migration 0025 indexes audit_log by timestamp (#619)', () => {
    const db = openSharedStore(':memory:');

    const indexes = db.prepare('PRAGMA index_list(audit_log)').all() as { name: string }[];
    expect(indexes.map((index) => index.name)).toContain('idx_audit_log_timestamp');

    const columns = db.prepare("PRAGMA index_info('idx_audit_log_timestamp')").all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toEqual(['timestamp']);
  });

  it('sets WAL mode and synchronous=FULL on a file-backed connection', () => {
    const db = openSharedStore(tempDbPath());

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
  });

  it('creates the parent directory rather than failing on a fresh checkout (#323)', () => {
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

describe('openMigratedStore', () => {
  it('opens a migrated store without migrating it, with the shared pragmas', () => {
    const path = tempDbPath();
    openSharedStore(path).close();
    const db = openMigratedStore(path, HIGHEST_KNOWN_MIGRATION_VERSION);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5_000);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('refuses a store below the version it needs and never migrates it', () => {
    const path = tempDbPath();
    const partial = new BetterSqlite3(path);
    runMigrations(partial, copyMigrationsUpTo(69));
    partial.close();
    expect(() => openMigratedStore(path, 70)).toThrow(/schema version 69, below 70/);
    const after = new BetterSqlite3(path);
    const table = after.prepare("SELECT name FROM sqlite_master WHERE name = 'v2_controls'").get();
    after.close();
    expect(table).toBeUndefined();
  });

  it('refuses a file with no migration ledger as version 0', () => {
    const path = tempDbPath();
    new BetterSqlite3(path).close();
    expect(() => openMigratedStore(path, 1)).toThrow(/schema version 0, below 1/);
  });

  it('refuses a missing file instead of creating one', () => {
    const path = tempDbPath();
    expect(() => openMigratedStore(path, 1)).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe('inMemoryCopyOf', () => {
  it('copies a WAL store read-only into a writable in-memory store and leaves the file alone', () => {
    const path = tempDbPath();
    const seed = openSharedStore(path);
    seed.exec(
      "INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at) VALUES ('pause', 'r', 's', 'k', 'now')",
    );
    seed.close();
    const source = openReadOnlyStore(path);
    const copy = inMemoryCopyOf(source);
    copy.exec('DROP TRIGGER v2_controls_no_delete');
    copy.exec('DELETE FROM v2_controls');
    expect(copy.prepare('SELECT COUNT(*) AS n FROM v2_controls').get()).toEqual({ n: 0 });
    expect(copy.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(source.prepare('SELECT COUNT(*) AS n FROM v2_controls').get()).toEqual({ n: 1 });
    copy.close();
    source.close();
  });
});

describe('openReadOnlyStore', () => {
  it('reads a store without writing to it or changing its journal mode', () => {
    const path = tempDbPath();
    const writer = new BetterSqlite3(path);
    writer.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
    writer.close();
    const db = openReadOnlyStore(path);
    expect(db.prepare('SELECT x FROM t').all()).toEqual([{ x: 1 }]);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5_000);
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(() => db.exec('INSERT INTO t VALUES (2)')).toThrow(/readonly/);
    db.close();
  });

  it('refuses a missing file instead of creating one', () => {
    const path = tempDbPath();
    expect(() => openReadOnlyStore(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe('openSharedStore busy timeout', () => {
  it('waits for a second writer instead of failing at once', () => {
    const db = openSharedStore(tempDbPath());
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5_000);
    db.close();
  });
});

describe('migrations directory (#1397)', () => {
  it('is a known, contiguous 1..N version list', () => {
    expect(MIGRATION_VERSIONS).toEqual(
      Array.from({ length: HIGHEST_KNOWN_MIGRATION_VERSION }, (_, i) => i + 1),
    );
  });
});

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
    expect(existsSync(join(root, 'data', 'samurai-production.sqlite'))).toBe(true);
    expect(existsSync(join(root, 'data', 'samurai-paper.sqlite'))).toBe(false);
  });
});
