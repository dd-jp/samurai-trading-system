import { parseJsonColumnAsObject } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import type { CostBasisDropCount, ExitClass, ExitClassDropCounts } from '../control-arm/index.js';
import { EXIT_CLASSES } from '../control-arm/index.js';
import type {
  ArmComparisonSample,
  ArmComparisonSampleStore,
  PersistedArmComparisonSample,
} from './types.js';

function parseExitClassEntry(parsed: object, exitClass: ExitClass): CostBasisDropCount | null {
  if (!(exitClass in parsed)) return null;
  const entry: unknown = Reflect.get(parsed, exitClass);
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  if (!('kept' in entry) || !('dropped' in entry)) return null;
  const { kept, dropped } = entry;
  if (!isCount(kept) || !isCount(dropped)) return null;
  return { kept, dropped };
}

function parseCostBasisDropsColumn(raw: string | null): ExitClassDropCounts | null {
  const parsed = parseJsonColumnAsObject(raw);
  if (parsed === null) return null;
  if (Object.keys(parsed).length !== EXIT_CLASSES.length) return null;

  const counts: Partial<Record<ExitClass, CostBasisDropCount>> = {};
  for (const exitClass of EXIT_CLASSES) {
    const entry = parseExitClassEntry(parsed, exitClass);
    if (entry === null) return null;
    counts[exitClass] = entry;
  }

  return hasEveryExitClass(counts) ? counts : null;
}

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
      reason: row.diverged === 1 ? row.divergence_reason : null,
      min_trades_per_arm: row.min_trades_per_arm,
    },
  };
}

export class SqliteArmComparisonSampleStore implements ArmComparisonSampleStore {
  constructor(private readonly db: StoreHandle) {}

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
