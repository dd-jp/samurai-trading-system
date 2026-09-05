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

    return oneSizingRegime(rows, from, to).map((row) => ({
      ...fromClosedTradeRow(row),
      arm: row.arm,
    }));
  }
}

/**
 * #1112 AC5, migration 0045: the mechanism the column exists for. Without
 * this, `sizing_capital_ceiling` is written on every row and read by nobody
 * — the exact "tested mechanism nothing calls" pattern this repo keeps
 * reintroducing.
 *
 * Two mixes, two answers, because they are not the same event.
 *
 * **NULL alongside a ceiling is the #1112 cutover, and it is dropped, not
 * refused.** Every row written before migration 0045 was sized against the
 * paper broker's funded equity (~$100,000) rather than the declared book, so
 * a NULL row is not an unknown scale — it is a KNOWN-WRONG one, ~100x. The
 * daily cycle (production.ts) and `yarn report:arms` both window backwards
 * from now on a fixed `window_ms`, so the first window after this migration
 * ships necessarily straddles the cutover; refusing it would produce no
 * comparison at all for a full window, exactly when #1112's corrected sizing
 * first becomes observable, and "narrow the window" is not an instruction an
 * automated caller can act on. Averaging a known-wrong scale into
 * `return_pct` is worse than excluding it, and the drop is visible downstream:
 * it lands in each arm's `trade_count`, which `evaluateArmDivergence`
 * (arm-comparison-cycle.ts) floors PER ARM at `min_trades_per_arm` before it
 * will call a divergence — so a window gutted by this filter yields no
 * verdict and no alert rather than a confident one off two rows. The sample
 * itself is still computed and persisted every cycle; a reader wanting the
 * dropped count must diff it against the raw table.
 *
 * The filter cannot preferentially gut one arm: both arms'
 * `SqliteExecutionStore`s are constructed in the same composition root from
 * the same `config.capitalCeilingUsd`, so the cutover boundary falls at one
 * instant across both.
 *
 * **Two distinct non-null ceilings still throw.** That is an operator moving
 * `LIVE_BOOK_GBP` or `SAMURAI_LIVE_MAX_CAPITAL_USD` mid-window — no row in
 * the window is known-wrong, so there is nothing to drop, and picking a
 * winner between two legitimately-declared books is a judgement this reader
 * has no basis to make. The throw is caught one frame up in both callers'
 * composition roots (production.ts's daily-cycle try/catch; a CLI tool's
 * uncaught exit) — loud, but not fatal to the process.
 *
 * `sizing_capital_ceiling` carries no currency suffix (#949): it is whatever
 * raw value `ProductionConfig.capitalCeilingUsd` held when a row was written,
 * unconverted, so "different regimes" here means "different declared-ceiling
 * VALUES", not necessarily different currencies. When #1180 adds FX
 * conversion, today's `1000` rows and that change's converted rows become a
 * THIRD case — two distinct non-null ceilings, so this throws — even though
 * the book never moved. #1180 owns backfilling the stamp; this guard cannot
 * tell that apart from a real mid-window book change.
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
      `SqliteArmComparisonSource.getClosedTradesBetween: window ${from.toISOString()}..` +
        `${to.toISOString()} mixes closed_trades sized under different declared ceilings ` +
        `(${[...declared].sort((a, b) => a - b).join(', ')}) — #1112 migration 0045. ` +
        'Averaging them into one return_pct would compare incomparable notional scales; ' +
        'narrow the window to one ceiling.',
    );
  }

  if (declared.size === 0) return rows;
  return rows.filter((row) => row.sizing_capital_ceiling !== null);
}
