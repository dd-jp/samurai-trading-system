import { openSharedStore } from '../../shared/store/index.js';
import { noCostBasisDrops } from '../control-arm/index.js';
import { InMemoryArmComparisonSampleStore } from './fixture-stores.js';
import { SqliteArmComparisonSampleStore } from './sqlite-arm-comparison-sample-store.js';
import type { ArmComparisonSample, ArmComparisonSampleStore } from './types.js';

const COMPUTED_AT = new Date('2026-09-01T12:00:00.000Z');
const WINDOW_FROM = new Date('2026-08-02T12:00:00.000Z');

function makeSample(overrides: Partial<ArmComparisonSample> = {}): ArmComparisonSample {
  return {
    computed_at: COMPUTED_AT,
    comparison: {
      from: WINDOW_FROM,
      to: COMPUTED_AT,
      basis: 1_000,
      live: {
        arm: 'live',
        trade_count: 7,
        realized_pnl_net: 21.5,
        return_pct: 0.0215,
        max_drawdown_pct: 0.04,
        refused_pass_count: 3,
        cost_basis_drops: noCostBasisDrops(),
      },
      control: {
        arm: 'control',
        trade_count: 6,
        realized_pnl_net: 4,
        return_pct: 0.004,
        max_drawdown_pct: 0.02,
        refused_pass_count: 9,
        cost_basis_drops: noCostBasisDrops(),
      },
    },
    divergence: { diverged: false, reason: null, min_trades_per_arm: 5 },
    ...overrides,
  };
}

describe('SqliteArmComparisonSampleStore', () => {
  it('round-trips a sample with both arms complete', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);

    store.append(makeSample());

    const [read] = store.getRecent(10, COMPUTED_AT);
    expect(read).toEqual(makeSample());
  });

  it('round-trips each arm refused_pass_count independently', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);

    store.append(makeSample());

    const [read] = store.getRecent(10, COMPUTED_AT);
    expect(read?.comparison.live.refused_pass_count).toBe(3);
    expect(read?.comparison.control.refused_pass_count).toBe(9);
  });

  it('reads back null, not 0, for a pre-migration row that never stored the count', () => {
    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO arm_comparison_samples (
         computed_at, window_from, window_to, basis,
         live_trade_count, live_realized_pnl_net, live_return_pct, live_max_drawdown_pct,
         control_trade_count, control_realized_pnl_net, control_return_pct,
         control_max_drawdown_pct, diverged, divergence_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
    ).run(
      COMPUTED_AT.toISOString(),
      WINDOW_FROM.toISOString(),
      COMPUTED_AT.toISOString(),
      1_000,
      7,
      21.5,
      0.0215,
      0.04,
      6,
      4,
      0.004,
      0.02,
    );
    const store = new SqliteArmComparisonSampleStore(db);

    const [read] = store.getRecent(10, COMPUTED_AT);
    expect(read?.comparison.live.refused_pass_count).toBeNull();
    expect(read?.comparison.control.refused_pass_count).toBeNull();
  });

  it('round-trips each arm per-exit-class cost_basis_drops independently', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);
    const sample = makeSample();
    sample.comparison.live.cost_basis_drops = {
      protective: { kept: 11, dropped: 2 },
      flatten: { kept: 3, dropped: 7 },
    };
    sample.comparison.control.cost_basis_drops = {
      protective: { kept: 5, dropped: 0 },
      flatten: { kept: 13, dropped: 1 },
    };

    store.append(sample);

    const [read] = store.getRecent(10, COMPUTED_AT);
    expect(read?.comparison.live.cost_basis_drops).toEqual({
      protective: { kept: 11, dropped: 2 },
      flatten: { kept: 3, dropped: 7 },
    });
    expect(read?.comparison.control.cost_basis_drops).toEqual({
      protective: { kept: 5, dropped: 0 },
      flatten: { kept: 13, dropped: 1 },
    });
  });

  it('reads back null cost_basis_drops for a pre-migration-0065 row', () => {
    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO arm_comparison_samples (
         computed_at, window_from, window_to, basis,
         live_trade_count, live_realized_pnl_net, live_return_pct, live_max_drawdown_pct,
         control_trade_count, control_realized_pnl_net, control_return_pct,
         control_max_drawdown_pct, diverged, divergence_reason,
         live_refused_pass_count, control_refused_pass_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 3, 9)`,
    ).run(
      COMPUTED_AT.toISOString(),
      WINDOW_FROM.toISOString(),
      COMPUTED_AT.toISOString(),
      1_000,
      7,
      21.5,
      0.0215,
      0.04,
      6,
      4,
      0.004,
      0.02,
    );
    const store = new SqliteArmComparisonSampleStore(db);

    const [read] = store.getRecent(10, COMPUTED_AT);
    expect(read?.comparison.live.cost_basis_drops).toBeNull();
    expect(read?.comparison.control.cost_basis_drops).toBeNull();
    expect(read?.comparison.live.refused_pass_count).toBe(3);
  });

  it.each([
    ['unparseable JSON', '{not json'],
    ['a class missing', '{"protective":{"kept":1,"dropped":0}}'],
    ['a negative count', '{"protective":{"kept":-1,"dropped":0},"flatten":{"kept":0,"dropped":0}}'],
    [
      'a fractional count',
      '{"protective":{"kept":1.5,"dropped":0},"flatten":{"kept":0,"dropped":0}}',
    ],
    [
      'an unknown extra class',
      '{"protective":{"kept":1,"dropped":0},"flatten":{"kept":0,"dropped":0},"decay":{"kept":0,"dropped":0}}',
    ],
  ])('degrades cost_basis_drops to null on %s, keeping the rest of the sample', (_case, raw) => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);
    store.append(makeSample());
    db.prepare(`UPDATE arm_comparison_samples SET live_cost_basis_drops_json = ?`).run(raw);

    const [read] = store.getRecent(10, COMPUTED_AT);
    expect(read?.comparison.live.cost_basis_drops).toBeNull();
    expect(read?.comparison.live.realized_pnl_net).toBe(21.5);
    expect(read?.comparison.control.cost_basis_drops).toEqual(noCostBasisDrops());
  });

  it('round-trips a non-default min_trades_per_arm rather than the module default', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);
    const sample = makeSample({
      divergence: { diverged: false, reason: null, min_trades_per_arm: 8 },
    });

    store.append(sample);

    expect(store.getRecent(10, COMPUTED_AT)[0]?.divergence.min_trades_per_arm).toBe(8);
  });

  it('round-trips a diverged sample with its reason', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);
    const sample = makeSample({
      divergence: {
        diverged: true,
        reason: 'the control arm is ahead by 1.20% of the book',
        min_trades_per_arm: 5,
      },
    });

    store.append(sample);

    expect(store.getRecent(10, COMPUTED_AT)[0]?.divergence).toEqual(sample.divergence);
  });

  it('returns most-recently-computed first, bounded by asOf and limit', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 3; i += 1) {
      store.append(makeSample({ computed_at: new Date(COMPUTED_AT.getTime() + i * day) }));
    }

    const bounded = store.getRecent(10, new Date(COMPUTED_AT.getTime() + day));
    expect(bounded.map((sample) => sample.computed_at.toISOString())).toEqual([
      new Date(COMPUTED_AT.getTime() + day).toISOString(),
      COMPUTED_AT.toISOString(),
    ]);

    expect(store.getRecent(1, new Date(COMPUTED_AT.getTime() + 5 * day))).toHaveLength(1);
  });

  it('replaces a re-run of the same cycle instant rather than duplicating it', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);

    store.append(makeSample());
    store.append(
      makeSample({
        divergence: { diverged: true, reason: 'recomputed after a restart', min_trades_per_arm: 5 },
      }),
    );

    const all = store.getRecent(10, COMPUTED_AT);
    expect(all).toHaveLength(1);
    expect(all[0]?.divergence.diverged).toBe(true);
  });

  it('never reads back a drawdown-less arm — the column is NOT NULL', () => {
    const db = openSharedStore(':memory:');
    expect(() =>
      db
        .prepare(
          `INSERT INTO arm_comparison_samples (
             computed_at, window_from, window_to, basis,
             live_trade_count, live_realized_pnl_net, live_return_pct, live_max_drawdown_pct,
             control_trade_count, control_realized_pnl_net, control_return_pct,
             control_max_drawdown_pct, diverged, divergence_reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL)`,
        )
        .run(
          COMPUTED_AT.toISOString(),
          WINDOW_FROM.toISOString(),
          COMPUTED_AT.toISOString(),
          1_000,
          1,
          1,
          0.001,
          1,
          1,
          0.001,
          0.01,
        ),
    ).toThrow(/NOT NULL/i);
  });

  describe('the divergence invariant is a schema constraint', () => {
    function insertDivergence(diverged: number, reason: string | null): () => void {
      const db = openSharedStore(':memory:');
      return () =>
        db
          .prepare(
            `INSERT INTO arm_comparison_samples (
               computed_at, window_from, window_to, basis,
               live_trade_count, live_realized_pnl_net, live_return_pct, live_max_drawdown_pct,
               control_trade_count, control_realized_pnl_net, control_return_pct,
               control_max_drawdown_pct, diverged, divergence_reason
             ) VALUES (?, ?, ?, 1000, 1, 1, 0.001, 0.01, 1, 1, 0.001, 0.01, ?, ?)`,
          )
          .run(
            COMPUTED_AT.toISOString(),
            WINDOW_FROM.toISOString(),
            COMPUTED_AT.toISOString(),
            diverged,
            reason,
          );
    }

    it('rejects a divergence with no reason', () => {
      expect(insertDivergence(1, null)).toThrow(/CHECK constraint/i);
    });

    it('rejects a reason on a non-divergence', () => {
      expect(insertDivergence(0, 'the control arm is ahead')).toThrow(/CHECK constraint/i);
    });

    it('accepts both honest pairs', () => {
      expect(insertDivergence(0, null)).not.toThrow();
      expect(insertDivergence(1, 'the control arm is ahead')).not.toThrow();
    });
  });
});

describe.each<[string, () => ArmComparisonSampleStore]>([
  [
    'SqliteArmComparisonSampleStore',
    () => new SqliteArmComparisonSampleStore(openSharedStore(':memory:')),
  ],
  ['InMemoryArmComparisonSampleStore', () => new InMemoryArmComparisonSampleStore()],
])('%s (substitutability, #1483)', (_name, makeStore) => {
  it('round-trips both arms refused_pass_count as real numbers', () => {
    const store = makeStore();

    store.append(makeSample());

    const [read] = store.getRecent(10, COMPUTED_AT);
    expect(read?.comparison.live.refused_pass_count).toBe(3);
    expect(read?.comparison.control.refused_pass_count).toBe(9);
  });

  it('returns most-recently-computed first, bounded by asOf and limit', () => {
    const store = makeStore();
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 3; i += 1) {
      store.append(makeSample({ computed_at: new Date(COMPUTED_AT.getTime() + i * day) }));
    }

    const bounded = store.getRecent(10, new Date(COMPUTED_AT.getTime() + day));
    expect(bounded.map((sample) => sample.computed_at.toISOString())).toEqual([
      new Date(COMPUTED_AT.getTime() + day).toISOString(),
      COMPUTED_AT.toISOString(),
    ]);

    expect(store.getRecent(1, new Date(COMPUTED_AT.getTime() + 5 * day))).toHaveLength(1);
  });
});
