/**
 * SQLite-backed `ArmComparisonSampleStore` over `arm_comparison_samples`
 * (migration 0034, #971) — FL's own record of every matched-control comparison
 * it computed, and of the ones it escalated.
 *
 * Written by the orchestrator's daily feedback cycle, read by the dashboard's
 * query store in the OTHER process. That split is the reason this is persisted
 * at all — see the migration's own comment.
 */

import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import type { CostBasisDropCount, ExitClass, ExitClassDropCounts } from '../control-arm/index.js';
import { EXIT_CLASSES } from '../control-arm/index.js';
import type {
  ArmComparisonSample,
  ArmComparisonSampleStore,
  PersistedArmComparisonSample,
} from './types.js';

/**
 * #1546, migration 0066 — the per-exit-class exclusion counts, read back as
 * `ExitClassDropCounts` or `null`.
 *
 * Degrades to `null` rather than throwing, for
 * `parseModelledCostBreakdownColumn`'s reason: this is a measurement ABOUT the
 * comparison, and a corrupted byte in it must not abort the dashboard's read of
 * the comparison itself. `null` already means "this cycle did not count", so a
 * corrupt value reads as not-counted rather than as a fabricated set of counts
 * — the conservative collapse, and the only one that cannot put a number in
 * front of an operator that no cycle produced.
 *
 * Rebuilt from individually checked non-negative integers under an explicit
 * class list, so no `as` is needed (#509) and a JSON object carrying an extra
 * or missing class is refused rather than half-read.
 */
function parseCostBasisDropsColumn(raw: string | null): ExitClassDropCounts | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).length !== EXIT_CLASSES.length) return null;

  const counts: Partial<Record<ExitClass, CostBasisDropCount>> = {};
  for (const exitClass of EXIT_CLASSES) {
    if (!(exitClass in parsed)) return null;
    const entry: unknown = Reflect.get(parsed, exitClass);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    if (!('kept' in entry) || !('dropped' in entry)) return null;
    const { kept, dropped } = entry;
    if (!isCount(kept) || !isCount(dropped)) return null;
    counts[exitClass] = { kept, dropped };
  }

  return hasEveryExitClass(counts) ? counts : null;
}

/**
 * Restates for the compiler what the loop above already guarantees — it returns
 * `null` on the first class it cannot read, so reaching here means every class
 * was written. A predicate rather than an `as`, so widening `EXIT_CLASSES`
 * keeps the guarantee instead of asserting past it (#509).
 */
function hasEveryExitClass(
  counts: Partial<Record<ExitClass, CostBasisDropCount>>,
): counts is ExitClassDropCounts {
  return EXIT_CLASSES.every((exitClass) => counts[exitClass] !== undefined);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

interface ArmComparisonSampleRow {
  computed_at: string;
  window_from: string;
  window_to: string;
  basis: number;
  live_trade_count: number;
  live_realized_pnl_net: number;
  live_return_pct: number;
  live_max_drawdown_pct: number;
  live_refused_pass_count: number | null;
  /** #1546, migration 0066 — `ExitClassDropCounts` as JSON, NULL on a pre-0066 row. */
  live_cost_basis_drops_json: string | null;
  control_trade_count: number;
  control_realized_pnl_net: number;
  control_return_pct: number;
  control_max_drawdown_pct: number;
  control_refused_pass_count: number | null;
  control_cost_basis_drops_json: string | null;
  diverged: number;
  divergence_reason: string | null;
  min_trades_per_arm: number;
}

const COLUMNS = `computed_at, window_from, window_to, basis,
                 live_trade_count, live_realized_pnl_net, live_return_pct, live_max_drawdown_pct,
                 control_trade_count, control_realized_pnl_net, control_return_pct,
                 control_max_drawdown_pct, diverged, divergence_reason, min_trades_per_arm,
                 live_refused_pass_count, control_refused_pass_count,
                 live_cost_basis_drops_json, control_cost_basis_drops_json`;

/**
 * Reads back exactly what the table holds. `refused_pass_count` (#1099) is a
 * nullable column since migration 0057 (#1483) and `cost_basis_drops` (#1546)
 * since 0065 — NULL on a row computed before its migration, a real value on
 * every row after it. See `PersistedArmPerformance`.
 */
function fromRow(row: ArmComparisonSampleRow): PersistedArmComparisonSample {
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
        refused_pass_count: row.live_refused_pass_count,
        cost_basis_drops: parseCostBasisDropsColumn(row.live_cost_basis_drops_json),
      },
      control: {
        arm: 'control',
        trade_count: row.control_trade_count,
        realized_pnl_net: row.control_realized_pnl_net,
        return_pct: row.control_return_pct,
        max_drawdown_pct: row.control_max_drawdown_pct,
        refused_pass_count: row.control_refused_pass_count,
        cost_basis_drops: parseCostBasisDropsColumn(row.control_cost_basis_drops_json),
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
      // The floor THIS verdict was tested against (#982), read back as it was
      // written — never recomputed against whatever `MIN_TRADES_PER_ARM_FOR_
      // DIVERGENCE` is today.
      min_trades_per_arm: row.min_trades_per_arm,
    },
  };
}

export class SqliteArmComparisonSampleStore implements ArmComparisonSampleStore {
  constructor(private readonly db: StoreHandle) {}

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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        divergence.min_trades_per_arm,
        comparison.live.refused_pass_count,
        comparison.control.refused_pass_count,
        JSON.stringify(comparison.live.cost_basis_drops),
        JSON.stringify(comparison.control.cost_basis_drops),
      );
  }

  /**
   * Most-recently-computed first, bounded by `asOf` like every other dashboard
   * read — a snapshot must never show a sample computed after the instant it
   * claims to describe.
   */
  getRecent(limit: number, asOf: Date): PersistedArmComparisonSample[] {
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
