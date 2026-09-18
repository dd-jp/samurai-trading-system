import type { ClosedTrade, TradingArm } from '../../shared/index.js';
import {
  type ClosedTradeRow,
  fromClosedTradeRow,
  type StoreHandle,
  toStoredTimestamp,
} from '../../shared/store/index.js';
import type {
  ArmCostBasisDrops,
  ArmRefusedPassCounts,
  CostBasisDropCount,
  ExitClass,
} from './arm-comparison.js';
import { exitClassOf, noCostBasisDrops } from './arm-comparison.js';

export type ArmedClosedTrade = ClosedTrade & { arm: TradingArm };

export interface ClosedTradeWindow {
  trades: ArmedClosedTrade[];
  cost_basis_drops: ArmCostBasisDrops;
}

const REFUSED_PASS_SKIP_REASONS: Readonly<Record<TradingArm, readonly string[]>> = {
  live: [],
  control: ['control_arm_valuation_refused'],
};

const REFUSED_PASS_ARM_BY_SKIP_REASON = new Map<string, TradingArm>(
  Object.entries(REFUSED_PASS_SKIP_REASONS).flatMap(([arm, reasons]) =>
    reasons.map((reason) => [reason, arm as TradingArm] as const),
  ),
);

export class SqliteArmComparisonSource {
  constructor(private readonly db: StoreHandle) {}

  getClosedTradeWindowBetween(from: Date, to: Date): ClosedTradeWindow {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, debate_id, instrument, asset_class, side,
                entry, stop, filled_size, realized_pnl_net, fees_total,
                opened_at, closed_at, close_reason, arm, sizing_capital_ceiling,
                modelled_cost_charged
           FROM closed_trades
          WHERE closed_at > ? AND closed_at <= ?
          ORDER BY closed_at`,
      )
      .all(toStoredTimestamp(from), toStoredTimestamp(to)) as (ClosedTradeRow & {
      arm: TradingArm;
      sizing_capital_ceiling: number | null;
      modelled_cost_charged: 0 | 1;
    })[];

    const sized = oneSizingRegime(rows, from, to);
    return {
      trades: modelledCostCharged(sized).map((row) => ({
        ...fromClosedTradeRow(row),
        arm: row.arm,
      })),
      cost_basis_drops: countCostBasisDrops(sized),
    };
  }

  getRefusedPassCountsBetween(from: Date, to: Date): ArmRefusedPassCounts {
    const reasons = [...REFUSED_PASS_ARM_BY_SKIP_REASON.keys()];
    const counts: Record<TradingArm, number> = { live: 0, control: 0 };
    if (reasons.length === 0) return counts;

    const rows = this.db
      .prepare(
        `SELECT skip_reason, COUNT(*) AS refused_pass_count
           FROM trader_log
          WHERE skip_reason IN (${reasons.map(() => '?').join(', ')})
            AND created_at > ? AND created_at <= ?
          GROUP BY skip_reason`,
      )
      .all(...reasons, toStoredTimestamp(from), toStoredTimestamp(to)) as {
      skip_reason: string;
      refused_pass_count: number;
    }[];

    for (const row of rows) {
      const arm = REFUSED_PASS_ARM_BY_SKIP_REASON.get(row.skip_reason);
      if (arm !== undefined) counts[arm] += row.refused_pass_count;
    }
    return counts;
  }
}

function modelledCostCharged<Row extends { modelled_cost_charged: 0 | 1 }>(
  rows: readonly Row[],
): readonly Row[] {
  return rows.filter((row) => row.modelled_cost_charged === 1);
}

function countCostBasisDrops(
  rows: readonly {
    arm: TradingArm | null;
    close_reason: ClosedTrade['close_reason'];
    modelled_cost_charged: 0 | 1;
  }[],
): ArmCostBasisDrops {
  const counts: Record<TradingArm, Record<ExitClass, CostBasisDropCount>> = {
    live: noCostBasisDrops(),
    control: noCostBasisDrops(),
  };

  for (const row of rows) {
    const bucket = counts[row.arm ?? 'live'][exitClassOf(row.close_reason)];
    if (row.modelled_cost_charged === 1) bucket.kept += 1;
    else bucket.dropped += 1;
  }

  return counts;
}

function oneSizingRegime<Row extends { sizing_capital_ceiling: number | null }>(
  rows: readonly Row[],
  from: Date,
  to: Date,
): readonly Row[] {
  const declared = new Set(
    rows
      .map((row) => row.sizing_capital_ceiling)
      .filter((ceiling): ceiling is number => ceiling !== null),
  );

  if (declared.size > 1) {
    throw new Error(
      `SqliteArmComparisonSource.getClosedTradeWindowBetween: window ${from.toISOString()}..` +
        `${to.toISOString()} mixes closed_trades sized under different declared ceilings ` +
        `(${[...declared].sort((a, b) => a - b).join(', ')}) — #1112 migration 0045. ` +
        'Averaging them into one return_pct would compare incomparable notional scales; ' +
        'narrow the window to one ceiling.',
    );
  }

  if (declared.size === 0) return rows;
  return rows.filter((row) => row.sizing_capital_ceiling !== null);
}
