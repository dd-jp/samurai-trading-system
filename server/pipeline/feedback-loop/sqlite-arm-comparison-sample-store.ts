/**
 * SQLite-backed `ArmComparisonSampleStore` over `arm_comparison_samples`
 * (migration 0034, #971) — FL's own record of every matched-control comparison
 * it computed, and of the ones it escalated.
 *
 * Written by the orchestrator's daily feedback cycle, read by the dashboard's
 * query store in the OTHER process. That split is the reason this is persisted
 * at all — see the migration's own comment.
 */
import type { SharedStore } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/sqlite-utils.js';
import type { ArmComparisonSample, ArmComparisonSampleStore } from './types.js';

interface ArmComparisonSampleRow {
  computed_at: string;
  window_from: string;
  window_to: string;
  basis: number;
  live_trade_count: number;
  live_realized_pnl_net: number;
  live_return_pct: number;
  live_max_drawdown_pct: number;
  control_trade_count: number;
  control_realized_pnl_net: number;
  control_return_pct: number;
  control_max_drawdown_pct: number;
  diverged: number;
  divergence_reason: string | null;
}

const COLUMNS = `computed_at, window_from, window_to, basis,
                 live_trade_count, live_realized_pnl_net, live_return_pct, live_max_drawdown_pct,
                 control_trade_count, control_realized_pnl_net, control_return_pct,
                 control_max_drawdown_pct, diverged, divergence_reason`;

function fromRow(row: ArmComparisonSampleRow): ArmComparisonSample {
  return {
    computed_at: fromStoredTimestamp(row.computed_at),
    comparison: {
      from: fromStoredTimestamp(row.window_from),
      to: fromStoredTimestamp(row.window_to),
      basis: row.basis,
      live: {
        arm: 'live',
        trade_count: row.live_trade_count,
        realized_pnl_net: row.live_realized_pnl_net,
        return_pct: row.live_return_pct,
        max_drawdown_pct: row.live_max_drawdown_pct,
      },
      control: {
        arm: 'control',
        trade_count: row.control_trade_count,
        realized_pnl_net: row.control_realized_pnl_net,
        return_pct: row.control_return_pct,
        max_drawdown_pct: row.control_max_drawdown_pct,
      },
    },
    divergence: {
      diverged: row.diverged === 1,
      // `divergence_reason` is non-NULL if and only if `diverged = 1` — a table
      // `CHECK` in migration 0034, not a convention this mapper upholds. The
      // ternary is therefore not a guard and is not claimed to be one: it is
      // the `string | null` narrowing the row type needs, and both of the pairs
      // it could otherwise produce are unrepresentable in the table.
      reason: row.diverged === 1 ? row.divergence_reason : null,
    },
  };
}

export class SqliteArmComparisonSampleStore implements ArmComparisonSampleStore {
  constructor(private readonly db: SharedStore) {}

  /**
   * One row per cycle. `INSERT OR REPLACE` rather than a plain insert: a
   * restart that re-runs the same cycle instant is re-measuring the same
   * window, and the newer computation is the truthful row — but it must not
   * become a SECOND point in the trend, which is what the `computed_at`
   * primary key prevents.
   */
  append(sample: ArmComparisonSample): void {
    const { comparison, divergence } = sample;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO arm_comparison_samples (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        toStoredTimestamp(sample.computed_at),
        toStoredTimestamp(comparison.from),
        toStoredTimestamp(comparison.to),
        comparison.basis,
        comparison.live.trade_count,
        comparison.live.realized_pnl_net,
        comparison.live.return_pct,
        comparison.live.max_drawdown_pct,
        comparison.control.trade_count,
        comparison.control.realized_pnl_net,
        comparison.control.return_pct,
        comparison.control.max_drawdown_pct,
        divergence.diverged ? 1 : 0,
        divergence.reason,
      );
  }

  /**
   * Most-recently-computed first, bounded by `asOf` like every other dashboard
   * read — a snapshot must never show a sample computed after the instant it
   * claims to describe.
   */
  getRecent(limit: number, asOf: Date): ArmComparisonSample[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS}
           FROM arm_comparison_samples
          WHERE computed_at <= ?
          ORDER BY computed_at DESC
          LIMIT ?`,
      )
      .all(toStoredTimestamp(asOf), limit) as ArmComparisonSampleRow[];

    return rows.map(fromRow);
  }
}
