/**
 * The one read behind #753's comparison report: both arms' closed trades, over
 * one window, in one query.
 *
 * **One query, not two, and that is the point.** Doc 12 gate 4's exact-window
 * requirement is a correctness condition — two arms measured over different
 * windows are not a comparison — and the cheapest way to break it is to run a
 * live query and a control query that drift apart by an edit. A single
 * `WHERE closed_at > ? AND closed_at <= ?` with the arm SELECTED rather than
 * filtered makes the shared window structural: there is no second window to get
 * wrong.
 *
 * It is also the reason this reader exists at all rather than the report reusing
 * `SqliteClosedTradeStore`. That store is the Feedback Loop's, and it is scoped
 * to `arm = 'live'` on purpose (#753) — the loop must not tune the live system on
 * the control's outcomes. A reader that returns both arms is a different question
 * with a different answer, so it is a different reader.
 */
import type { ClosedTrade, TradingArm } from '../../shared/index.js';
import {
  type ClosedTradeRow,
  fromClosedTradeRow,
  type SharedStore,
} from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/sqlite-utils.js';

/** A closed trade plus the arm that produced it (migration 0033). */
export type ArmedClosedTrade = ClosedTrade & { arm: TradingArm };

export class SqliteArmComparisonSource {
  constructor(private readonly db: SharedStore) {}

  /**
   * Every closed trade in the window, both arms, half-open at the start so
   * consecutive windows partition the timeline exactly as the Feedback Loop's
   * daily cycle does.
   */
  getClosedTradesBetween(from: Date, to: Date): ArmedClosedTrade[] {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, debate_id, instrument, asset_class, side,
                entry, stop, filled_size, realized_pnl_net, fees_total,
                opened_at, closed_at, close_reason, arm, sizing_capital_ceiling
           FROM closed_trades
          WHERE closed_at > ? AND closed_at <= ?
          ORDER BY closed_at`,
      )
      .all(toStoredTimestamp(from), toStoredTimestamp(to)) as (ClosedTradeRow & {
      arm: TradingArm;
      sizing_capital_ceiling: number | null;
    })[];

    assertSingleSizingRegime(rows, from, to);

    return rows.map((row) => ({ ...fromClosedTradeRow(row), arm: row.arm }));
  }
}

/**
 * #1112 AC5, migration 0045: the mechanism the column exists for. Without
 * this, `sizing_capital_ceiling` is written on every row and read by nobody
 * — the exact "tested mechanism nothing calls" pattern this repo keeps
 * reintroducing. Refusing (rather than excluding pre-fix rows and computing
 * an answer anyway) because the caller is `buildArmComparison`'s sole trade
 * source for BOTH the Feedback Loop's daily cycle and `yarn report:arms`:
 * silently dropping rows would change the trade counts and drawdown series
 * those consumers reason about without either one asking for it, and a
 * `min_trades_per_arm` gate elsewhere could then pass or fail on a filtered
 * count nobody chose. A thrown, descriptive error is caught one frame up in
 * both callers' composition roots (`production.ts`'s daily-cycle try/catch;
 * a CLI tool's uncaught exit) — loud, but not fatal to the process.
 *
 * `sizing_capital_ceiling` carries no currency suffix (#949): it is
 * whatever raw value `ProductionConfig.capitalCeilingUsd` held when a row
 * was written, unconverted, so "different regimes" here means "different
 * declared-ceiling VALUES", not necessarily different currencies.
 */
function assertSingleSizingRegime(
  rows: readonly { sizing_capital_ceiling: number | null }[],
  from: Date,
  to: Date,
): void {
  const regimes = new Set(rows.map((row) => row.sizing_capital_ceiling));
  if (regimes.size <= 1) return;

  const described = [...regimes]
    .sort((a, b) => (a === null ? -1 : b === null ? 1 : a - b))
    .map((value) => (value === null ? 'no declared ceiling' : `a ${value} ceiling`));

  throw new Error(
    `SqliteArmComparisonSource.getClosedTradesBetween: window ${from.toISOString()}..` +
      `${to.toISOString()} mixes closed_trades sized under different regimes ` +
      `(${described.join(', ')}) — #1112 migration 0045. Averaging them into one ` +
      'return_pct would compare incomparable notional scales; narrow the window to one regime.',
  );
}
