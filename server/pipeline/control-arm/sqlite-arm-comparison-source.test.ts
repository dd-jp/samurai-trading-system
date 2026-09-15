import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { ClosedTrade, TradingArm } from '../../shared/index.js';
import { openSharedStore, type StoreHandle, toStoredTimestamp } from '../../shared/store/index.js';
import { listMigrations, MIGRATIONS_DIR, runMigrations } from '../../shared/store/migrate.js';
import { SqliteArmComparisonSource } from './sqlite-arm-comparison-source.js';

function makeTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    idempotency_key: 'key-1',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 90,
    filled_size: 10,
    realized_pnl_net: 200,
    fees_total: 1,
    opened_at: new Date('2026-07-18T10:00:00Z'),
    closed_at: new Date('2026-07-18T20:00:00Z'),
    close_reason: 'target',
    modelled_cost_charged: true,
    ...overrides,
  };
}

function seed(
  db: StoreHandle,
  trade: ClosedTrade,
  arm: TradingArm,
  sizingCapitalCeiling: number | null,
  // #1121 AC5: defaults to 1 (the post-fix / control-arm-always-correct
  // state) so every pre-existing call site — none of which is about this
  // ticket — keeps exercising the row shape it already did
  modelledCostCharged: 0 | 1 = 1,
): void {
  db.prepare(
    `INSERT INTO closed_trades (
       idempotency_key, debate_id, instrument, asset_class, side,
       entry, stop, filled_size, realized_pnl_net, fees_total,
       opened_at, closed_at, close_reason, arm, sizing_capital_ceiling,
       modelled_cost_charged
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    toStoredTimestamp(trade.opened_at),
    toStoredTimestamp(trade.closed_at),
    trade.close_reason,
    arm,
    sizingCapitalCeiling,
    modelledCostCharged,
  );
}

const from = new Date('2026-07-18T00:00:00Z');
const to = new Date('2026-07-19T00:00:00Z');

describe('SqliteArmComparisonSource.getClosedTradeWindowBetween — #1112 AC5 regime guard', () => {
  it('drops the pre-fix rows when a window straddles the #1112 cutover', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-1' }), 'live', 1000);
    seed(
      db,
      makeTrade({ idempotency_key: 'control-1', closed_at: new Date('2026-07-18T21:00:00Z') }),
      'control',
      null,
    );
    const source = new SqliteArmComparisonSource(db);

    const trades = source.getClosedTradeWindowBetween(from, to).trades;

    expect(trades.map((trade) => trade.idempotency_key)).toEqual(['live-1']);
  });

  it('throws when the window mixes two different declared ceilings', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-1' }), 'live', 1000);
    seed(
      db,
      makeTrade({ idempotency_key: 'control-1', closed_at: new Date('2026-07-18T21:00:00Z') }),
      'control',
      2000,
    );
    const source = new SqliteArmComparisonSource(db);

    expect(() => source.getClosedTradeWindowBetween(from, to).trades).toThrow(
      /mixes closed_trades sized under different declared ceilings \(1000, 2000\)/,
    );
  });

  it('does not throw over a window where every row predates the ceiling fix (all null)', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-1' }), 'live', null);
    seed(
      db,
      makeTrade({ idempotency_key: 'control-1', closed_at: new Date('2026-07-18T21:00:00Z') }),
      'control',
      null,
    );
    const source = new SqliteArmComparisonSource(db);

    expect(source.getClosedTradeWindowBetween(from, to).trades).toHaveLength(2);
  });

  it('does not throw over a window where every row was sized under the same declared ceiling', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-1' }), 'live', 1000);
    seed(
      db,
      makeTrade({ idempotency_key: 'control-1', closed_at: new Date('2026-07-18T21:00:00Z') }),
      'control',
      1000,
    );
    const source = new SqliteArmComparisonSource(db);

    expect(source.getClosedTradeWindowBetween(from, to).trades).toHaveLength(2);
  });

  /**
   * #1180: the conversion of the sizing inlet would otherwise have made every
   * window straddling it read as two declared ceilings — pre-conversion rows
   * at the raw GBP book, post-conversion rows at `LIVE_BOOK_SIZING_USD` —
   * and this guard would throw on a book that never moved. Migration 0052
   * normalizes the older stamp, and this asserts that through the real reader
   * rather than against the migration's own UPDATE: it is the throw here that
   * the backfill exists to prevent.
   *
   * Built on a raw DB migrated to 51 and then forward, because a store opened
   * at HEAD applies 0052 before a pre-conversion row can exist to be
   * normalized.
   */
  it('does not throw over a window straddling the #1180 conversion, once 0052 has run', () => {
    const raw = new BetterSqlite3(':memory:');
    const preCutoverVersion = 51;
    const preCutoverDir = mkdtempSync(join(tmpdir(), 'samurai-arm-comparison-pre-1180-'));
    try {
      for (const migration of listMigrations(MIGRATIONS_DIR)) {
        if (migration.version <= preCutoverVersion) {
          copyFileSync(
            join(MIGRATIONS_DIR, migration.filename),
            join(preCutoverDir, migration.filename),
          );
        }
      }
      runMigrations(raw, preCutoverDir);

      const db = raw as unknown as StoreHandle;
      seed(db, makeTrade({ idempotency_key: 'pre-conversion' }), 'live', 1000);

      runMigrations(raw, MIGRATIONS_DIR);

      seed(
        db,
        makeTrade({
          idempotency_key: 'post-conversion',
          closed_at: new Date('2026-07-18T21:00:00Z'),
        }),
        'control',
        1270,
      );

      expect(
        new SqliteArmComparisonSource(db).getClosedTradeWindowBetween(from, to).trades,
      ).toHaveLength(2);
    } finally {
      raw.close();
      rmSync(preCutoverDir, { recursive: true, force: true });
    }
  });
});

describe('SqliteArmComparisonSource.getClosedTradeWindowBetween — #1121 AC5 cost-charged guard', () => {
  it('drops an uncharged live row even when the window also has a correctly-charged control row', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-uncharged' }), 'live', null, 0);
    seed(
      db,
      makeTrade({
        idempotency_key: 'control-charged',
        closed_at: new Date('2026-07-18T21:00:00Z'),
      }),
      'control',
      null,
      1,
    );
    const source = new SqliteArmComparisonSource(db);

    const trades = source.getClosedTradeWindowBetween(from, to).trades;

    expect(trades.map((trade) => trade.idempotency_key)).toEqual(['control-charged']);
  });

  it('drops an uncharged live row from a window with NO correctly-charged rows at all (unconditional, unlike oneSizingRegime)', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-uncharged-1' }), 'live', null, 0);
    seed(
      db,
      makeTrade({
        idempotency_key: 'live-uncharged-2',
        closed_at: new Date('2026-07-18T21:00:00Z'),
      }),
      'live',
      null,
      0,
    );
    const source = new SqliteArmComparisonSource(db);

    // A PURE pre-#1121 window: every row shares the same defect, the way a
    // pure pre-#1112 window shares one wrong sizing scale — but unlike that
    // case, this one is not a benign consistent view. It must still empty,
    // not merely "not throw and pass through" the way `oneSizingRegime`
    // would for an all-null sizing window
    expect(source.getClosedTradeWindowBetween(from, to).trades).toEqual([]);
  });

  it('never throws on a mixed charged/uncharged window — the old rows are known-wrong, not ambiguous', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-uncharged' }), 'live', null, 0);
    seed(
      db,
      makeTrade({ idempotency_key: 'live-charged', closed_at: new Date('2026-07-18T21:00:00Z') }),
      'live',
      null,
      1,
    );
    const source = new SqliteArmComparisonSource(db);

    expect(() => source.getClosedTradeWindowBetween(from, to).trades).not.toThrow();
    expect(
      source.getClosedTradeWindowBetween(from, to).trades.map((trade) => trade.idempotency_key),
    ).toEqual(['live-charged']);
  });

  it('keeps a correctly-charged live row', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-charged' }), 'live', null, 1);
    const source = new SqliteArmComparisonSource(db);

    expect(
      source.getClosedTradeWindowBetween(from, to).trades.map((trade) => trade.idempotency_key),
    ).toEqual(['live-charged']);
  });
});

describe('SqliteArmComparisonSource.getClosedTradeWindowBetween — #1546 per-exit-class drop counts', () => {
  /**
   * The measurement #1546 exists for: the exclusion is not even-handed across
   * exit classes, so a single "N rows dropped" figure cannot answer whether the
   * surviving population is selected. A protective close needs one successful
   * submit-time capture and a flatten close needs two, so the flatten class is
   * expected to carry the higher rate — and only a per-class count can show it.
   */
  it('counts kept and dropped rows per arm and per exit class', () => {
    const db = openSharedStore(':memory:');
    let clock = 0;
    const at = (): Date => new Date(new Date('2026-07-18T12:00:00Z').getTime() + clock++ * 60_000);
    const add = (
      key: string,
      arm: TradingArm,
      close_reason: ClosedTrade['close_reason'],
      charged: 0 | 1,
    ): void =>
      seed(
        db,
        makeTrade({ idempotency_key: key, close_reason, closed_at: at() }),
        arm,
        null,
        charged,
      );

    add('live-stop-kept', 'live', 'stop', 1);
    add('live-target-kept', 'live', 'target', 1);
    add('live-stop-dropped', 'live', 'stop', 0);
    add('live-flatten-kept', 'live', 'flatten', 1);
    add('live-flatten-dropped-1', 'live', 'flatten', 0);
    add('live-flatten-dropped-2', 'live', 'signal_decay', 0);
    // The legacy pre-migration-0031 spelling of a flatten, which must not fall
    // into the protective bucket
    add('live-legacy-exit-dropped', 'live', 'exit', 0);
    add('control-stop-kept', 'control', 'stop', 1);
    add('control-flatten-kept', 'control', 'direction_flip', 1);

    const { trades, cost_basis_drops } = new SqliteArmComparisonSource(
      db,
    ).getClosedTradeWindowBetween(from, to);

    expect(cost_basis_drops).toEqual({
      live: {
        protective: { kept: 2, dropped: 1 },
        flatten: { kept: 1, dropped: 3 },
      },
      control: {
        protective: { kept: 1, dropped: 0 },
        flatten: { kept: 1, dropped: 0 },
      },
    });
    // The counts describe the population the trades were taken from: every kept
    // row above is one of these, and nothing dropped is
    expect(trades.map((trade) => trade.idempotency_key).sort()).toEqual([
      'control-flatten-kept',
      'control-stop-kept',
      'live-flatten-kept',
      'live-stop-kept',
      'live-target-kept',
    ]);
  });

  /**
   * The counts are taken AFTER `oneSizingRegime` and BEFORE the cost-basis
   * filter. A row from the incomparable sizing regime is not part of this
   * window's population at all, so attributing its removal to the cost-basis
   * filter would overstate the exclusion this measurement is about.
   */
  it('does not count a row the sizing-regime filter removed as a cost-basis drop', () => {
    const db = openSharedStore(':memory:');
    seed(
      db,
      makeTrade({ idempotency_key: 'pre-cutover', close_reason: 'flatten' }),
      'live',
      null,
      0,
    );
    seed(
      db,
      makeTrade({
        idempotency_key: 'sized',
        close_reason: 'stop',
        closed_at: new Date('2026-07-18T21:00:00Z'),
      }),
      'live',
      1000,
      1,
    );

    const { cost_basis_drops } = new SqliteArmComparisonSource(db).getClosedTradeWindowBetween(
      from,
      to,
    );

    expect(cost_basis_drops.live).toEqual({
      protective: { kept: 1, dropped: 0 },
      flatten: { kept: 0, dropped: 0 },
    });
  });

  it('reports zeros for a window with no rows at all, rather than omitting an arm', () => {
    const { cost_basis_drops } = new SqliteArmComparisonSource(
      openSharedStore(':memory:'),
    ).getClosedTradeWindowBetween(from, to);

    expect(cost_basis_drops).toEqual({
      live: { protective: { kept: 0, dropped: 0 }, flatten: { kept: 0, dropped: 0 } },
      control: { protective: { kept: 0, dropped: 0 }, flatten: { kept: 0, dropped: 0 } },
    });
  });
});

function seedTraderLog(
  db: StoreHandle,
  row: { trace_id: string; instrument?: string; skip_reason: string | null; created_at: Date },
): void {
  db.prepare(
    `INSERT INTO trader_log (trace_id, instrument, debate_id, intent_type, skip_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.trace_id,
    row.instrument ?? 'AAPL',
    'debate-1',
    null,
    row.skip_reason,
    toStoredTimestamp(row.created_at),
  );
}

describe('SqliteArmComparisonSource.getRefusedPassCountsBetween — #1099', () => {
  it("counts the control arm's valuation-refusal passes in the window", () => {
    const db = openSharedStore(':memory:');
    seedTraderLog(db, {
      trace_id: 'trace-1:control',
      instrument: 'AAPL',
      skip_reason: 'control_arm_valuation_refused',
      created_at: new Date('2026-07-18T10:00:00Z'),
    });
    seedTraderLog(db, {
      trace_id: 'trace-1:control',
      instrument: 'NFLX',
      skip_reason: 'control_arm_valuation_refused',
      created_at: new Date('2026-07-18T10:00:00Z'),
    });
    const source = new SqliteArmComparisonSource(db);

    expect(source.getRefusedPassCountsBetween(from, to)).toEqual({ live: 0, control: 2 });
  });

  it('ignores skips that are not refusals', () => {
    const db = openSharedStore(':memory:');
    seedTraderLog(db, {
      trace_id: 'trace-1:control',
      skip_reason: 'below_conviction_floor',
      created_at: new Date('2026-07-18T10:00:00Z'),
    });
    seedTraderLog(db, {
      trace_id: 'trace-2:control',
      skip_reason: null,
      created_at: new Date('2026-07-18T11:00:00Z'),
    });
    const source = new SqliteArmComparisonSource(db);

    expect(source.getRefusedPassCountsBetween(from, to)).toEqual({ live: 0, control: 0 });
  });

  it('excludes a refusal outside the window, on both ends, half-open at the start', () => {
    const db = openSharedStore(':memory:');
    seedTraderLog(db, {
      trace_id: 'before:control',
      skip_reason: 'control_arm_valuation_refused',
      created_at: new Date('2026-07-17T23:59:59.999Z'),
    });
    // Exactly `from`: excluded, so consecutive windows partition the timeline
    // exactly as `getClosedTradeWindowBetween` does
    seedTraderLog(db, {
      trace_id: 'at-from:control',
      skip_reason: 'control_arm_valuation_refused',
      created_at: from,
    });
    // Exactly `to`: included, same half-open rule
    seedTraderLog(db, {
      trace_id: 'at-to:control',
      skip_reason: 'control_arm_valuation_refused',
      created_at: to,
    });
    seedTraderLog(db, {
      trace_id: 'after:control',
      skip_reason: 'control_arm_valuation_refused',
      created_at: new Date('2026-07-19T00:00:00.001Z'),
    });
    const source = new SqliteArmComparisonSource(db);

    expect(source.getRefusedPassCountsBetween(from, to)).toEqual({ live: 0, control: 1 });
  });
});
