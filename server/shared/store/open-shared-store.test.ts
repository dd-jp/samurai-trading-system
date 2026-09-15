import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { listMigrations, MIGRATIONS_DIR, runMigrations } from './migrate.js';
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
  // is only as good as the list, so it is added with `broker_brackets` (0007).
  // 0007's other table, `broker_observed_fills`, was dropped by 0053 (#1059).
  'account_state',
  'broker_brackets',
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
  // `risk_critic_log` (0032) — the risk critic's `debate_id`-keyed verdict
  // (#957). ADR-0003 §2's replay-from-log determinism lives in this table: a
  // `backtest` run reads what a `live`/`paper` run wrote instead of calling
  // the model again.
  'risk_critic_log',
  // `arm_comparison_samples` (0034) — the Feedback Loop's own record of every
  // matched-control comparison it computed and of the ones it escalated (#971,
  // under #636/#913). Persisted rather than recomputed because the dashboard
  // reads it from a different process, and because a trend needs a series.
  'arm_comparison_samples',
  // `outside_benchmark_samples` (0036) — the risk-adjusted OUTSIDE benchmarks,
  // SPY and 60/40, over the same window the arm comparison used (#981, under
  // #636). A separate table rather than columns on `arm_comparison_samples`: a
  // benchmark has no trade count, no realized PnL, no verdict and no arm tag,
  // so folding it in would mean four nullable columns and would make the
  // secondary reading look like a third arm.
  'outside_benchmark_samples',
  // `llm_call_log` (0039) — the prompt sent and the text that came back for
  // every metered LLM call (#1035). Separate from `llm_spend` because the
  // spend cap sums that table on the trading path and the dashboard
  // range-scans it, and neither reads the text; see the migration's header.
  'llm_call_log',
  // `alert_delivery_failures` (0043) — a Telegram alert send that exhausted
  // retries (#1108). Durable so "how many escalations went undelivered" is
  // answerable after the fact, not just visible in a log line.
  'alert_delivery_failures',
  // `feedback_cycle_schedule` (0044) — the daily feedback cycle's
  // restart-durable schedule (#1110); see production.ts's
  // `scheduleFeedbackCycle` for why.
  'feedback_cycle_schedule',
  // `llm_spend_cap` (0047) — the LLM budget the orchestrator's composition
  // root armed its spend cap with (#1140), so the dashboard's meter measures
  // against the cap being enforced rather than a copy of the number.
  'llm_spend_cap',
];

/**
 * Mirrors shared-sqlite-store-spec.md's "Consolidated Schema" count, which the
 * Non-Collision Verification section asserts it has checked every table in.
 * That prose number silently drifted twice (it read "twenty" and "twenty-one"
 * simultaneously while the schema held 22), so it is pinned here.
 */
const CONSOLIDATED_SCHEMA_TABLE_COUNT = 34;

/**
 * The migration list, derived from disk so a new `NNNN_*.sql` file changes no
 * expectation below except `HIGHEST_KNOWN_MIGRATION_VERSION` (and, if the
 * migration adds a table, `TABLES`/`CONSOLIDATED_SCHEMA_TABLE_COUNT` above —
 * that list is independently maintained and out of scope here). See the
 * `migrations directory` describe block below for why one literal survives.
 */
const MIGRATIONS = listMigrations(MIGRATIONS_DIR);
const MIGRATION_VERSIONS = MIGRATIONS.map((migration) => migration.version);
const HIGHEST_KNOWN_MIGRATION_VERSION = 63;

/** A temp copy of `MIGRATIONS_DIR` holding every migration through `throughVersion`, inclusive. */
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

    const expectedVersions = MIGRATIONS.map((migration) => ({ version: migration.version }));

    const versions = db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual(expectedVersions);
    expect(runMigrations(db)).toEqual([]);
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual(expectedVersions);
  });

  // #1112 review: version 45 in `schema_migrations` proves only that
  // migration 0045 did not throw — a column added to one table, or to the
  // wrong one, would pass that check and fail at runtime on the other's
  // INSERT. Asserted against the schema both tables actually carry.
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
      // Nullable with no default: NULL is the historically-true "no declared
      // ceiling was in effect" for every pre-#1112 row, and
      // `oneSizingRegime` (sqlite-arm-comparison-source.ts) reads it as
      // exactly that.
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }
  });

  // #1186: unlike 0045, this column belongs on `open_positions` only — an
  // abandoned (wedged-zero-fill) lot never produces a `ClosedTrade` row, so
  // `closed_trades` has no matching column to miss.
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
    // NOT NULL DEFAULT 1: every row this build writes states its own value
    // explicitly (`SqliteExecutionStore.insertClosedTrade`), so the default
    // only ever fires for a row this migration itself backfills — and it is
    // right for the control arm (always correctly charged) and wrong for the
    // live arm, which the migration's own UPDATE corrects to 0 below.
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe('1');
  });

  // A schema-only check (above) cannot exercise the migration's own backfill
  // UPDATE — a fresh `:memory:` DB runs every migration, including 0049,
  // before any row exists to backfill, so an INSERT made afterwards only
  // ever proves the DEFAULT fires, not that pre-existing live rows were
  // corrected. This test instead reproduces the real cutover: migrate to
  // 0048 (a checkout mid-#1121), write one row per arm the way they looked
  // before this ticket, THEN apply 0049 from the real migrations directory
  // and check the UPDATE it runs.
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

  // Same cutover shape as the 0049 test above, and for the same reason: 0052's
  // whole content is an UPDATE over rows that must already exist when it runs,
  // so a fresh `:memory:` DB — which applies 0052 before any row is written —
  // proves nothing about it.
  //
  // The pre-conversion value is the GBP book (1000) that `paperStartingProfile`
  // stamped through `sizing_capital_ceiling` before #1180 converted the sizing
  // inlet; the post value is `LIVE_BOOK_SIZING_USD`. Both tables, because
  // migration 0045 added the column to both and a one-table UPDATE would leave
  // `open_positions` mixed. The unrelated-ceiling row is what stops the UPDATE
  // being written as an unconditional rewrite of the column: a genuinely
  // different declared ceiling must survive untouched, or the backfill would
  // erase the real mid-window book change `oneSizingRegime` exists to refuse.
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

  // 0055's `broker_brackets`/`broker_unpriced_fills` rebuild copies rows with a
  // positional `INSERT ... SELECT *`, so it depends on the new table's column
  // order matching the pre-migration table's exactly — a schema-shape check
  // against an empty fresh `:memory:` DB (spec-schema-drift.test.ts) cannot
  // catch a transposition because no row ever moves through it. This seeds one
  // row per table before 0055 with a distinct, non-default value in every
  // column so a shift shows up as a wrong value rather than a silent pass.
  // `broker_unpriced_fills` in particular has two adjacent TEXT NOT NULL
  // timestamp columns (`first_seen_at`/`last_seen_at`) a transposition made
  // consistently in both the migration and the spec fence would pass every
  // other gate on — the row-level check here is what would actually catch it.
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

  // Same cutover shape as the 0049 test above, for the same reason: 0050's
  // `arm` backfill is an UPDATE over rows that must ALREADY exist when the
  // migration runs, and on a fresh `:memory:` DB none do. It is not a
  // hypothetical — the paper soak DB was at `schema_migrations` max 48 when
  // #1124 was fixed, holding 13 `flatten_submissions` rows of which 11 were
  // the control arm's; `DEFAULT 'live'` alone would have mislabelled all 11
  // into the live arm's newly-filtered `getUnresolvedFlattens()` scan.
  //
  // The four seeded rows are the four answers the backfill can give: the
  // closed-trade arm, the open-position arm (the second COALESCE branch —
  // both seeded lots are the CONTROL arm precisely so a branch that silently
  // returned nothing would be caught by the `'live'` DEFAULT rather than
  // masked by it), a lot present in
  // NEITHER table — `sweepTerminalPositions` deletes from `open_positions`,
  // so an aged-out lot is underivable and must fall back rather than throw —
  // and a NULL `lot_idempotency_keys`. The last two reach `'live'` by
  // DIFFERENT routes, which is why both are seeded: the aged-out row passes
  // the `UPDATE`'s `WHERE` and lands on COALESCE's third branch, while the
  // NULL row is excluded by that `WHERE` twice over (`IS NOT NULL`, and
  // `json_valid(NULL)` is itself NULL) and so never runs the UPDATE at all,
  // keeping the column's DEFAULT. `json_each(NULL)` does not raise — it
  // yields zero rows; only a malformed value raises.
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

      // The index is what keeps the newly-filtered scan from degrading into a
      // full-table read as the journal grows, and nothing else in the suite
      // asserts it exists — the store test covers the COLUMN end to end, but a
      // dropped `CREATE INDEX` line would stay green everywhere.
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
      // Nullable with no default: NULL is "this gate does not compare a number
      // to a bound", which is the truth for every pre-#1111 row and for every
      // `go` and non-staleness refusal written since.
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }
  });

  // #549 review: version 24 in `schema_migrations` alone would stay green
  // through a column-name typo in the migration file — every marker query
  // would then fail only at runtime. Asserted against the SCHEMA the
  // migration actually produced, plus a write/read round-trip through the
  // exact column names the store's SQL uses.
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
      // Nullable with no default: NULL IS the "no open episode" state
      // (migration 0024's own doc), for pre-migration rows and fresh ones
      // alike.
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }

    // Round-trip through the exact column names the store's marker SQL uses.
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

  // Same reasoning as the 0024 assertion above.
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
    // NOT NULL with DEFAULT 2 is the whole mechanism: every row this build
    // writes is post-#686 without any code naming the column, and the
    // migration's own UPDATE is what marks the pre-cutover rows as 1. A
    // nullable column, or a DEFAULT of 1, would make the guard fire on lots it
    // should pass — or, worse, pass lots it should block.
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe('2');
  });

  // Same reasoning as the 0024 assertion above: a recorded version alone would
  // stay green through a typo'd index name or column. The dashboard's 3-second
  // poll range-scans `audit_log.timestamp` twice, and without this index that
  // is two full table scans of a table that grows forever (#619).
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

// Separate from `describe('openSharedStore', ...)` above: this asserts on the
// migrations directory itself, not on `openSharedStore`, so it does not
// belong under that name. It also stands as its own test rather than folding
// into another one, because every other migration-version expectation in this
// file is derived FROM `MIGRATION_VERSIONS` via `listMigrations` as its own
// oracle — none of them can catch a migration deleted from disk. Only a
// literal can, so `HIGHEST_KNOWN_MIGRATION_VERSION` is checked here against a
// full 1..N contiguity assertion (not just the tail, so a deleted middle file
// reds too) — and folded into an unrelated test, deleting or skipping that
// test would have silently dropped this guarantee with the suite still green.
describe('migrations directory (#1397)', () => {
  it('is a known, contiguous 1..N version list', () => {
    expect(MIGRATION_VERSIONS).toEqual(
      Array.from({ length: HIGHEST_KNOWN_MIGRATION_VERSION }, (_, i) => i + 1),
    );
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
