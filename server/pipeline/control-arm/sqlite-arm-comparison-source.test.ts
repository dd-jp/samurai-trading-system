import type { ClosedTrade, TradingArm } from '../../shared/index.js';
import { openSharedStore, type SharedStore } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/sqlite-utils.js';
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
  db: SharedStore,
  trade: ClosedTrade,
  arm: TradingArm,
  sizingCapitalCeiling: number | null,
  // #1121 AC5: defaults to 1 (the post-fix / control-arm-always-correct
  // state) so every pre-existing call site — none of which is about this
  // ticket — keeps exercising the row shape it already did.
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

describe('SqliteArmComparisonSource.getClosedTradesBetween — #1112 AC5 regime guard', () => {
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

    const trades = source.getClosedTradesBetween(from, to);

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

    expect(() => source.getClosedTradesBetween(from, to)).toThrow(
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

    expect(source.getClosedTradesBetween(from, to)).toHaveLength(2);
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

    expect(source.getClosedTradesBetween(from, to)).toHaveLength(2);
  });
});

describe('SqliteArmComparisonSource.getClosedTradesBetween — #1121 AC5 cost-charged guard', () => {
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

    const trades = source.getClosedTradesBetween(from, to);

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
    // would for an all-null sizing window.
    expect(source.getClosedTradesBetween(from, to)).toEqual([]);
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

    expect(() => source.getClosedTradesBetween(from, to)).not.toThrow();
    expect(source.getClosedTradesBetween(from, to).map((trade) => trade.idempotency_key)).toEqual([
      'live-charged',
    ]);
  });

  it('keeps a correctly-charged live row', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-charged' }), 'live', null, 1);
    const source = new SqliteArmComparisonSource(db);

    expect(source.getClosedTradesBetween(from, to).map((trade) => trade.idempotency_key)).toEqual([
      'live-charged',
    ]);
  });
});
