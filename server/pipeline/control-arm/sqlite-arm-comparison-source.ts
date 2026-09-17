/**
 * The one read behind the comparison report: both arms' closed trades,
 * over one window, in one query — not two, since a live query and a
 * control query risk drifting into different windows by an edit. The arm
 * is SELECTED rather than filtered, so there is no second window to get
 * wrong.
 *
 * Exists separately from `SqliteClosedTradeStore` because that store is
 * scoped to `arm = 'live'` on purpose — the Feedback Loop must not tune
 * the live system on the control's outcomes.
 */
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

/** A closed trade plus the arm that produced it */
export type ArmedClosedTrade = ClosedTrade & { arm: TradingArm };

/**
 * One window's read, whole: the rows that survived the filters below AND
 * what the cost-basis filter removed on the way. Returned together, from
 * ONE query, for the module header's reason — a second method taking its
 * own `from`/`to` would be a second window to get wrong.
 */
export interface ClosedTradeWindow {
  trades: ArmedClosedTrade[];
  cost_basis_drops: ArmCostBasisDrops;
}

/**
 * The `trader_log.skip_reason` values that mean "this arm could not even
 * attempt the pass", by the arm that can produce them. `trader_log`
 * carries no `arm` column, so attribution runs through the reason itself:
 * `buildBracket` (decide.ts) converts a `BookValuationError` into
 * `control_arm_valuation_refused` only under `arm === 'control'` and
 * rethrows on the live arm, so the string identifies the arm by
 * construction. The live arm's empty list is the true count, not a
 * placeholder — a live-arm valuation failure aborts the tick instead of
 * reaching `trader_log` as a skip.
 */
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

  /**
   * Every closed trade in the window, both arms, half-open at the start so
   * consecutive windows partition the timeline exactly as the Feedback
   * Loop's daily cycle does — plus what the cost-basis filter dropped per
   * arm and exit class. Counts are taken after `oneSizingRegime` and
   * before `modelledCostCharged`: rows from an incomparable sizing regime
   * are not part of this window's population, so counting them as
   * "dropped by the cost-basis filter" would misattribute one filter's
   * removals to another.
   */
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

  /**
   * Passes each arm REFUSED in the same window — one instrument-pass per
   * row, not one per tick, since `trader_log`'s primary key is
   * `(trace_id, instrument)` and the decision path writes unconditionally.
   * Same half-open window as `getClosedTradeWindowBetween`, so consecutive
   * windows partition refusals the same way.
   *
   * NOT commensurable with `ArmPerformance.trade_count` as a ratio: the
   * filters above drop closed trades this query has no analogue for. This
   * answers "was the arm able to act", not "what fraction of its passes
   * traded".
   */
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

/**
 * Drops any row whose fee was never brought onto the two arms' shared cost
 * basis — unconditionally, unlike `oneSizingRegime` below, because a live
 * row missing this cost is not "consistently scaled wrong" the way an
 * all-NULL sizing window is; it's a `return_pct` carrying the exact bias
 * this filter exists to remove, so there is no reading of an all-dropped
 * window that is safe to keep.
 *
 * This filter is NOT outcome-blind. A protective-leg exit needs only its
 * entry submission's capture, while a flatten exit needs that same
 * capture AND the flatten's — so the surviving live population is
 * enriched in protective-leg exits relative to flattens, direction and
 * size unestablished (it depends on the flatten capture's failure rate
 * and the return split between exit types). It can also gut the live
 * arm's `trade_count` to 0, both from the historic backfill and from an
 * ongoing failed `captureSubmitSnapshot`.
 *
 * Tracked rather than blocked: `countCostBasisDrops` below measures the
 * per-arm, per-exit-class kept/dropped counts every window
 * (`ArmPerformance.cost_basis_drops`), and `evaluateArmDivergence` floors
 * each arm's trade count so a heavily-gutted arm reads as no verdict
 * rather than a confident one off a skewed sample — a coupling, not a
 * bound on the bias.
 *
 * The floor covers the automated reader only —
 * `tools/report-arm-comparison.ts` has no floor and carries its own note
 * on this filter, which must stay in step with this one.
 */
function modelledCostCharged<Row extends { modelled_cost_charged: 0 | 1 }>(
  rows: readonly Row[],
): readonly Row[] {
  return rows.filter((row) => row.modelled_cost_charged === 1);
}

/**
 * What `modelledCostCharged` above kept and removed, per arm and per exit
 * class, over the rows it is about to run on. Counted from the SAME
 * array rather than a second `GROUP BY` query, so the counts and the
 * trades cannot describe different windows, and so they see exactly what
 * the filter sees, including the `oneSizingRegime` removals that happened
 * first.
 *
 * A NULL `arm` counts as `'live'`, matching `buildArmComparison`'s own
 * reading of the column — every row written before the control arm
 * existed was the live arm's. A control row can only ever land in `kept`;
 * the zero in `control.*.dropped` is a true count, not a placeholder.
 */
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

/**
 * The mechanism `sizing_capital_ceiling` exists for — without this filter
 * the column is written on every row and read by nobody.
 *
 * NULL alongside a declared ceiling is a cutover, not an unknown: every
 * row written before the ceiling column existed was sized against the
 * paper broker's funded equity, a KNOWN-WRONG scale (~100x), so those
 * rows are dropped rather than refused — refusing would produce no
 * comparison at all for the first window after the cutover, since both
 * callers window backwards from now on a fixed `window_ms`. The drop is
 * visible downstream: `evaluateArmDivergence` floors `trade_count` per
 * arm, so a window gutted by this drop yields no verdict rather than a
 * confident one off a handful of rows. The filter cannot preferentially
 * gut one arm — both arms' stores are constructed from the same
 * `config.capitalCeilingUsd` in one composition root.
 *
 * Two distinct NON-NULL ceilings still throw: that means an operator
 * moved the declared book mid-window, no row is known-wrong, and picking
 * a winner between two legitimately-declared books is not this reader's
 * call to make.
 */
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
