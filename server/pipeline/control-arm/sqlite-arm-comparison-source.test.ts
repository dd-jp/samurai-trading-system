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
    ...overrides,
  };
}

function seed(
  db: SharedStore,
  trade: ClosedTrade,
  arm: TradingArm,
  sizingCapitalCeiling: number | null,
): void {
  db.prepare(
    `INSERT INTO closed_trades (
       idempotency_key, debate_id, instrument, asset_class, side,
       entry, stop, filled_size, realized_pnl_net, fees_total,
       opened_at, closed_at, close_reason, arm, sizing_capital_ceiling
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
}

const from = new Date('2026-07-18T00:00:00Z');
const to = new Date('2026-07-19T00:00:00Z');

describe('SqliteArmComparisonSource.getClosedTradesBetween — #1112 AC5 regime guard', () => {
  it('throws when the window mixes a declared-ceiling row with a no-ceiling row', () => {
    const db = openSharedStore(':memory:');
    seed(db, makeTrade({ idempotency_key: 'live-1' }), 'live', 1000);
    seed(
      db,
      makeTrade({ idempotency_key: 'control-1', closed_at: new Date('2026-07-18T21:00:00Z') }),
      'control',
      null,
    );
    const source = new SqliteArmComparisonSource(db);

    expect(() => source.getClosedTradesBetween(from, to)).toThrow(
      /mixes closed_trades sized under different regimes.*no declared ceiling.*a 1000 ceiling/,
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
