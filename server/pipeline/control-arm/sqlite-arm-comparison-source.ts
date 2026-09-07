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

    return modelledCostCharged(oneSizingRegime(rows, from, to)).map((row) => ({
      ...fromClosedTradeRow(row),
      arm: row.arm,
    }));
  }
}

/**
 * #1121 AC5, migration 0049: drops any row whose fee was never brought onto
 * the two arms' shared cost basis — unconditionally, not only when a window
 * mixes 0 and 1 rows, unlike `oneSizingRegime` just below.
 *
 * That is a deliberate divergence from the sizing-regime precedent, not an
 * oversight. `oneSizingRegime` tolerates a PURE pre-cutover window because
 * every row in it shared the same wrong scale — the ratios inside that
 * window still meant something, just not against a post-cutover window.
 * This column has no such case: a live row with `modelled_cost_charged = 0`
 * is missing a cost the matched control paid on every trade it ever wrote,
 * so a window built entirely from such rows is not "consistently scaled
 * wrong" the way an all-NULL sizing window was — it is a return_pct with the
 * exact bias #1121 exists to remove, whether or not anything newer sits next
 * to it. There is no reading of an all-0 window that is safe to keep.
 *
 * Also unlike `oneSizingRegime`, this never throws on a mix: the historic
 * rows are KNOWN wrong, not two legitimate regimes an operator chose between
 * (that guard's #949/#1180 currency case), so there is nothing to escalate —
 * dropping them is the whole remedy.
 *
 * This can gut the live arm's `trade_count` to 0, and for TWO reasons that
 * read identically from here. The historic one is migration 0049's backfill:
 * every live row closed before #1121 stamps 0. The ONGOING one is that the
 * writer derives the column per lot (`closedTrade()`, ingest-fills.ts) from
 * whether that lot's covered legs actually carry a `cost_breakdown` — the
 * submit-time snapshot is nullable, so a lot whose `captureSubmitSnapshot`
 * failed closes with 0 under the fixed code too. A window of entirely
 * post-fix live closes can therefore be gutted; this filter is not "one-armed
 * historic cleanup".
 *
 * `oneSizingRegime`'s doc claims its filter "cannot preferentially gut one
 * arm" because both arms' stores share one `capitalCeilingUsd` cutover
 * instant. That property does NOT hold here, in either regime: the backfill
 * stamps 0 by `arm`, and only the live arm reaches the nullable-snapshot path
 * at all (a Simulated fill always carries its own breakdown). The filter is
 * one-armed by construction on the historic rows and one-armed in practice on
 * the ongoing ones.
 *
 * What makes that safe is the floor, not luck: `evaluateArmDivergence`
 * (arm-comparison-cycle.ts) floors each arm's trade count at
 * `min_trades_per_arm` before calling a divergence, so a gutted arm reads as
 * NO VERDICT, not as a skewed one. The floor is doing more work than a
 * one-off cleanup would need, because the ongoing exclusion never ends. That
 * is still acceptable, but NOT because the exclusion is outcome-blind. It is
 * not, and the earlier version of this comment claiming so was wrong (#1121
 * review round 2, finding 1).
 *
 * THE EXCLUSION SELECTS ON EXIT TYPE, through the coverage rule rather than
 * through a veto. `closedTrade()`'s `modelledCostCharged` covers the entry
 * legs plus flatten (`'exit'`) legs and excludes `'stop'`/`'target'` legs
 * (ingest-fills.ts). Each covered leg needs its own successful, best-effort
 * `captureSubmitSnapshot`. So a lot that exits on a protective leg needs ONE
 * capture to stamp 1 (the entry's), while a lot that exits on a flatten needs
 * TWO independent ones. The requirement is strictly weaker for protective-leg
 * exits, so their drop rate is WEAKLY lower — equal only if capture never
 * fails — and the surviving live population is enriched in stop/target exits.
 * Those are the losers, and they are the same rows #1301 leaves under-charged
 * by one exit commission. The veto `closedTrade()` refuses is genuinely
 * refused; the selection arrives anyway, by the back door.
 *
 * No failure RATE is claimed here, only the shape. The round-2 soak read
 * (live rows, `fills.cost_breakdown_json IS NOT NULL`) found both flatten-exit
 * lots stamping 0 and the single `stop` lot stamping 1, but could not separate
 * pre-migration-0037 lots from failed captures, so it measures the asymmetry's
 * existence and not its size.
 *
 * DIRECTION, with both terms. The selection term biases live `return_pct`
 * DOWN (losers over-represented); the #1301 under-charge on those same
 * surviving rows biases it UP. They oppose, and the selection term is the
 * larger by orders of magnitude — a stop-exit round trip's whole PnL versus
 * one leg's commission at `SAXO_COMMISSION_RATE`. Net conservative, so this
 * understates the live edge rather than flattering it, which is why it is
 * tracked rather than blocking.
 *
 * Tracked on #1301, and it is the same defect that ticket already owns rather
 * than a rider on it: charge protective legs, and they enter coverage, both
 * exit types then need the same number of captures, and the differential drop
 * disappears with no change to this filter or to the coverage rule.
 *
 * The floor covers the AUTOMATED reader only. `tools/report-arm-comparison.ts`
 * has no floor — it prints `trade_count` per arm to an operator, who would
 * otherwise read a gutted `live 0` as "the live arm closed nothing". That
 * report carries a live-side note naming this filter as a cause; the two must
 * stay in step.
 */
function modelledCostCharged<Row extends { modelled_cost_charged: 0 | 1 }>(
  rows: readonly Row[],
): readonly Row[] {
  return rows.filter((row) => row.modelled_cost_charged === 1);
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
