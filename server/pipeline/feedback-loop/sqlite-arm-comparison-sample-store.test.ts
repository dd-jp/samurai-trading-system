import { openSharedStore } from '../../shared/store/index.js';
import { SqliteArmComparisonSampleStore } from './sqlite-arm-comparison-sample-store.js';
import type { ArmComparisonSample } from './types.js';

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
      },
      control: {
        arm: 'control',
        trade_count: 6,
        realized_pnl_net: 4,
        return_pct: 0.004,
        max_drawdown_pct: 0.02,
      },
    },
    divergence: { diverged: false, reason: null },
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

  it('round-trips a diverged sample with its reason', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);
    const sample = makeSample({
      divergence: { diverged: true, reason: 'the control arm is ahead by 1.20% of the book' },
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

  /** One cycle instant is one measurement, never two points on the trend. */
  it('replaces a re-run of the same cycle instant rather than duplicating it', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);

    store.append(makeSample());
    store.append(
      makeSample({
        divergence: { diverged: true, reason: 'recomputed after a restart' },
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
});
