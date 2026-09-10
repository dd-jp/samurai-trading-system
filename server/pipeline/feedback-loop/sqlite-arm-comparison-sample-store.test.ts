import { openSharedStore } from '../../shared/store/index.js';
import type { ArmPerformance } from '../control-arm/index.js';
import { SqliteArmComparisonSampleStore } from './sqlite-arm-comparison-sample-store.js';
import type {
  ArmComparisonSample,
  PersistedArmComparisonSample,
  PersistedArmPerformance,
} from './types.js';

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
      },
      control: {
        arm: 'control',
        trade_count: 6,
        realized_pnl_net: 4,
        return_pct: 0.004,
        max_drawdown_pct: 0.02,
        refused_pass_count: 9,
      },
    },
    divergence: { diverged: false, reason: null, min_trades_per_arm: 5 },
    ...overrides,
  };
}

/** The columns migration 0034/0035 actually define — see `PersistedArmComparisonSample`. */
function persisted(sample: ArmComparisonSample): PersistedArmComparisonSample {
  const strip = ({
    refused_pass_count: _dropped,
    ...rest
  }: ArmPerformance): PersistedArmPerformance => rest;
  return {
    ...sample,
    comparison: {
      ...sample.comparison,
      live: strip(sample.comparison.live),
      control: strip(sample.comparison.control),
    },
  };
}

describe('SqliteArmComparisonSampleStore', () => {
  it('round-trips a sample with both arms complete', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);

    store.append(makeSample());

    const [read] = store.getRecent(10, COMPUTED_AT);
    expect(read).toEqual(persisted(makeSample()));
  });

  /**
   * #1099. `arm_comparison_samples` has no `refused_pass_count` column, so a
   * read-back must not carry one — a fabricated `0` would assert "no refusals
   * in this window" on every historical row, which is exactly the silence the
   * field exists to break. Adding the column is a migration, and out of #1099's
   * scope.
   */
  it('does not read back a refusal count the table never stored', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteArmComparisonSampleStore(db);

    store.append(makeSample());

    const [read] = store.getRecent(10, COMPUTED_AT);
    expect(read?.comparison.live).not.toHaveProperty('refused_pass_count');
    expect(read?.comparison.control).not.toHaveProperty('refused_pass_count');
  });

  /**
   * #982: written with a NON-default floor and read back the same value — the
   * default (5) round-trips in the test above too, but only a non-default
   * value can prove the column is actually wired end to end rather than
   * hardcoded at some hop between `append` and `getRecent`.
   */
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

  /** One cycle instant is one measurement, never two points on the trend. */
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

  /**
   * The `diverged`/`divergence_reason` invariant is enforced by migration
   * 0034's table `CHECK`, not by caller discipline. Both directions are
   * unrepresentable: an escalation with no sentence to show the operator, and a
   * sentence claiming the control won attached to a verdict that says it did
   * not.
   */
  describe('the divergence invariant is a schema constraint', () => {
    function insertDivergence(diverged: number, reason: string | null): () => void {
      // A FRESH store per call, deliberately: every insert below uses the same
      // `computed_at`, which is the table's primary key. Hoisting this open()
      // out of the helper would make the second insert in `accepts both honest
      // pairs` fail on the PK instead of exercising the `CHECK` — a green test
      // asserting the wrong constraint.
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
