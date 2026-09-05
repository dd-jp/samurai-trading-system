import { describe, expect, it } from 'vitest';
import type { TraderDecisionRecord } from '../decision-records.js';
import { openSharedStore } from './open-shared-store.js';
import { SqliteRiskLogStore, SqliteTraderLogStore } from './sqlite-decision-record-stores.js';

// #726: `risk_log.status` gained `'error'` in migration 0028 (widening a CHECK
// constraint requires a full table rebuild in SQLite — see that migration's
// doc comment). Every test exercising the new status elsewhere in this repo
// (per-subclass-deployment-cap.test.ts, direct-bind.test.ts) uses a fake
// `RiskLogStore`, so nothing actually proves the rebuilt CHECK constraint
// accepts the value, or that the column order in the migration's
// `INSERT INTO risk_log_new SELECT * FROM risk_log` rebuild survives a real
// write/read round-trip through `SqliteRiskLogStore`'s own SQL. #549's
// precedent for this exact gap: "version 24 in schema_migrations alone would
// stay green through a column-name typo in the migration file — every marker
// query would then fail only at runtime."
describe('SqliteRiskLogStore (#726)', () => {
  function makeRecord(overrides: Partial<Parameters<SqliteRiskLogStore['write']>[0]> = {}) {
    return {
      trace_id: 't1',
      instrument: '3USL',
      status: 'error' as const,
      binding_constraint: 'per_subclass_deployment_cap:no_cap_for_subclass:index_etp_3x',
      reasons: ['index_etp_3x has no cap declared'],
      original_size: null,
      final_size: null,
      stop_tightened: false,
      breakers: {
        portfolio_tripped: false,
        crypto_tripped: false,
        stocks_tripped: false,
        armed_breakers: [],
      },
      portfolio: {
        equity: 1_000,
        drawdown_pct: 0,
        gross_exposure: 0,
        consecutive_losses: 0,
        daily_pnl_portfolio_pct: null,
        daily_pnl_crypto_pct: null,
        daily_pnl_stocks_pct: null,
        daily_pnl_unknown_reason: 'not_yet_known' as const,
      },
      created_at: new Date('2026-08-16T12:00:00.000Z'),
      ...overrides,
    };
  }

  it('accepts status "error" and round-trips the binding_constraint through the rebuilt CHECK constraint', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteRiskLogStore(db);

    store.write(makeRecord());

    const row = db
      .prepare(
        'SELECT trace_id, instrument, status, binding_constraint, reasons_json FROM risk_log ' +
          "WHERE trace_id = 't1' AND instrument = '3USL'",
      )
      .get() as {
      trace_id: string;
      instrument: string;
      status: string;
      binding_constraint: string;
      reasons_json: string;
    };

    expect(row).toBeDefined();
    expect(row.status).toBe('error');
    expect(row.binding_constraint).toBe(
      'per_subclass_deployment_cap:no_cap_for_subclass:index_etp_3x',
    );
    expect(JSON.parse(row.reasons_json)).toEqual(['index_etp_3x has no cap declared']);
  });

  it('preserves "approved" and "rejected" alongside the new "error" through the same table rebuild', () => {
    // The prior test only proves the rebuild ACCEPTS 'error'; it says nothing
    // about whether the rebuild PRESERVED the two pre-existing values. A typo
    // in 0028's CHECK(status IN ('approved', 'rejcted', 'error')) would stay
    // green through every other test in this repo — nothing else writes a
    // 'rejected' row through this store to a real (non-fake) database, and
    // yarn smoke never produces a rejection either.
    const db = openSharedStore(':memory:');
    const store = new SqliteRiskLogStore(db);

    for (const status of ['approved', 'rejected', 'error'] as const) {
      store.write(makeRecord({ status, trace_id: `t-${status}` }));
    }

    for (const status of ['approved', 'rejected', 'error'] as const) {
      const row = db.prepare('SELECT status FROM risk_log WHERE trace_id = ?').get(`t-${status}`) as
        | { status: string }
        | undefined;
      expect(row?.status).toBe(status);
    }
  });

  it('still rejects a status the CHECK constraint does not carry, so the widening did not degrade to unconstrained TEXT', () => {
    const db = openSharedStore(':memory:');

    expect(() =>
      db
        .prepare(
          `INSERT INTO risk_log (
             trace_id, instrument, status, binding_constraint, reasons_json,
             original_size, final_size, stop_tightened,
             portfolio_tripped, crypto_tripped, stocks_tripped, armed_breakers_json,
             equity, drawdown_pct, gross_exposure, consecutive_losses,
             daily_pnl_portfolio_pct, daily_pnl_crypto_pct, daily_pnl_stocks_pct,
             daily_pnl_unknown_reason, created_at
           ) VALUES ('t2', 'AAPL', 'bogus_status', NULL, '[]', NULL, NULL, 0, 0, 0, 0, '[]', 1000, 0, 0, 0, NULL, NULL, NULL, NULL, '2026-08-16T12:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});

// #748: `trader_log` gained `exit_reason` in migration 0030, and the INSERT in
// `SqliteTraderLogStore` gained a column plus a bind. That pair is exactly the
// shape #549 warned about — a version row in `schema_migrations` stays green
// through a column-name typo, and every OTHER test that writes a trader record
// in this repo uses a fake `TraderLogStore`, so nothing proves the real SQL
// still binds every value to the right column, in order. A silent off-by-one
// here would land `skip_reason`'s value in `exit_reason` and shift every
// sizing scalar one place, which no type checks. (#1109 added three more
// columns — `decision_class` and the two `reason_detail_*` — to the same
// INSERT; see the round-trip test below for that pair.)
describe('SqliteTraderLogStore exit_reason (#748)', () => {
  function makeRecord(overrides: Partial<TraderDecisionRecord> = {}): TraderDecisionRecord {
    return {
      trace_id: 't1',
      instrument: '3USL',
      debate_id: 'd1',
      intent_type: 'exit',
      exit_reason: 'signal_decay',
      skip_reason: null,
      decision_class: null,
      reason_detail: null,
      sizing: null,
      cosine_precedent: null,
      atr: null,
      entry: null,
      stop: null,
      size: null,
      created_at: new Date('2026-08-16T12:00:00.000Z'),
      ...overrides,
    };
  }

  it('round-trips all three exit reasons, each landing in its own column', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteTraderLogStore(db);

    for (const exit_reason of ['flatten', 'signal_decay', 'direction_flip'] as const) {
      store.write(makeRecord({ exit_reason, trace_id: `t-${exit_reason}` }));
    }

    for (const exit_reason of ['flatten', 'signal_decay', 'direction_flip'] as const) {
      const row = db
        .prepare('SELECT intent_type, exit_reason, skip_reason FROM trader_log WHERE trace_id = ?')
        .get(`t-${exit_reason}`) as
        | { intent_type: string; exit_reason: string | null; skip_reason: string | null }
        | undefined;
      expect(row?.exit_reason).toBe(exit_reason);
      // Pinned so a bind shifted by one place cannot pass: an off-by-one would
      // put the reason in `skip_reason` and `intent_type` in `exit_reason`.
      expect(row?.intent_type).toBe('exit');
      expect(row?.skip_reason).toBeNull();
    }
  });

  it('writes NULL on a non-exit row rather than inventing a reason', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteTraderLogStore(db);

    store.write(makeRecord({ trace_id: 't-entry', intent_type: 'entry', exit_reason: null }));

    const row = db
      .prepare("SELECT exit_reason FROM trader_log WHERE trace_id = 't-entry'")
      .get() as { exit_reason: string | null };
    expect(row.exit_reason).toBeNull();
  });
});

// #1109: `trader_log` gained `decision_class` and the two `reason_detail_*`
// columns in migration 0042. This is the CURRENT behaviour the issue's
// acceptance criteria says must fail without the fix: before this ticket
// `TraderDecisionRecord` had no such fields, so a no_trade row was
// unclassified everywhere — durable record included, not only the process
// log a join back to `debate_log` was needed to explain.
describe('SqliteTraderLogStore decision_class and reason_detail (#1109)', () => {
  function makeSkipRecord(overrides: Partial<TraderDecisionRecord> = {}): TraderDecisionRecord {
    return {
      trace_id: 't-skip',
      instrument: '3USL',
      debate_id: 'd1',
      intent_type: null,
      exit_reason: null,
      skip_reason: 'below_conviction_floor',
      decision_class: 'declined_on_signal',
      reason_detail: { compared_value: 0.4, threshold: 0.55 },
      sizing: null,
      cosine_precedent: null,
      atr: null,
      entry: null,
      stop: null,
      size: null,
      created_at: new Date('2026-09-04T12:00:00.000Z'),
      ...overrides,
    };
  }

  it('persists a classified no_trade decision, non-empty and readable without joining debate_log', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteTraderLogStore(db);

    store.write(makeSkipRecord());

    const row = db
      .prepare(
        `SELECT skip_reason, decision_class, reason_detail_compared_value, reason_detail_threshold
         FROM trader_log WHERE trace_id = 't-skip'`,
      )
      .get() as {
      skip_reason: string | null;
      decision_class: string | null;
      reason_detail_compared_value: number | null;
      reason_detail_threshold: number | null;
    };

    expect(row.skip_reason).toBe('below_conviction_floor');
    expect(row.decision_class).toBe('declined_on_signal');
    expect(row.reason_detail_compared_value).toBe(0.4);
    expect(row.reason_detail_threshold).toBe(0.55);
  });

  it('distinguishes declined_on_signal from could_not_decide on the same skip_reason string', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteTraderLogStore(db);

    store.write(
      makeSkipRecord({
        trace_id: 't-signal',
        skip_reason: 'neutral_direction_while_flat',
        decision_class: 'declined_on_signal',
        reason_detail: null,
      }),
    );
    store.write(
      makeSkipRecord({
        trace_id: 't-starved',
        skip_reason: 'neutral_direction_while_flat',
        decision_class: 'could_not_decide',
        reason_detail: null,
      }),
    );

    const rows = db
      .prepare(
        'SELECT trace_id, decision_class FROM trader_log WHERE trace_id IN (?, ?) ORDER BY trace_id',
      )
      .all('t-signal', 't-starved') as { trace_id: string; decision_class: string }[];

    expect(rows).toEqual([
      { trace_id: 't-signal', decision_class: 'declined_on_signal' },
      { trace_id: 't-starved', decision_class: 'could_not_decide' },
    ]);
  });

  it('writes NULL for decision_class and both reason_detail columns when an order was produced', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteTraderLogStore(db);

    store.write(
      makeSkipRecord({
        trace_id: 't-entry',
        intent_type: 'entry',
        skip_reason: null,
        decision_class: null,
        reason_detail: null,
      }),
    );

    const row = db
      .prepare(
        `SELECT decision_class, reason_detail_compared_value, reason_detail_threshold
         FROM trader_log WHERE trace_id = 't-entry'`,
      )
      .get() as {
      decision_class: string | null;
      reason_detail_compared_value: number | null;
      reason_detail_threshold: number | null;
    };

    expect(row.decision_class).toBeNull();
    expect(row.reason_detail_compared_value).toBeNull();
    expect(row.reason_detail_threshold).toBeNull();
  });
});
