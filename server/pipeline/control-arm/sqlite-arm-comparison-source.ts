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
 * What stops a GUTTED arm reading as a skewed one is the floor, not luck:
 * `evaluateArmDivergence` (arm-comparison-cycle.ts) floors each arm's trade
 * count at `min_trades_per_arm` before calling a divergence, so a gutted arm
 * reads as NO VERDICT. The floor is doing more work than a one-off cleanup
 * would need, because the ongoing exclusion never ends. It is NOT a bound on
 * the bias in an arm that clears it — see "WHY IT IS TRACKED RATHER THAN
 * BLOCKING" below — and it is certainly not a claim that the exclusion is
 * outcome-blind. It is not, and the earlier version of this comment claiming
 * so was wrong (#1121 review round 2, finding 1).
 *
 * THE EXCLUSION SELECTS ON EXIT TYPE, through the coverage rule rather than
 * through a veto. `closedTrade()`'s `modelledCostCharged` covers the entry
 * legs plus flatten (`'exit'`) legs and excludes `'stop'`/`'target'` legs
 * (ingest-fills.ts). Each covered leg needs its own successful, best-effort
 * `captureSubmitSnapshot`. So a lot that exits on a protective leg stamps 1
 * on its entry legs' captures alone, while a lot that exits on a flatten
 * needs those SAME captures AND the flatten's. The requirement is strictly
 * weaker for protective-leg exits, so their drop rate is WEAKLY lower — equal
 * exactly when the FLATTEN capture never fails, which is the condition that
 * matters: an entry capture that fails hits both exit types identically and
 * does not equalize anything. The surviving live population is therefore
 * enriched in protective-leg exits. The veto `closedTrade()` refuses is
 * genuinely refused; the selection arrives anyway, by the back door.
 *
 * No failure RATE is claimed here, only the shape. The round-2 soak read
 * (live rows, `fills.cost_breakdown_json IS NOT NULL`) found both flatten-exit
 * lots stamping 0 and the single `stop` lot stamping 1, but could not separate
 * pre-migration-0037 lots from failed captures, so it measures the asymmetry's
 * existence and not its size.
 *
 * DIRECTION IS NOT ESTABLISHED. Two terms act on the surviving live rows, and
 * neither their net sign nor their ordering by size follows from anything
 * here — not even that they oppose, which needs both signs (#1121 review
 * round 5, finding 1; the earlier version of this paragraph claimed all
 * three).
 *
 * - The SELECTION term has no established sign. Coverage excludes `'stop'`
 *   AND `'target'`, so what survives is enriched in bracket exits of both
 *   kinds — the losses and the wins together, not the losses alone. Whether
 *   that raises or lowers the surviving mean against the flatten population's
 *   is unmeasured. The earlier "those are the losers" was
 *   `modelledCostCharged`'s narrow claim about STOPS — true there, where the
 *   subject is a veto on stops — carried unchanged onto a referent widened to
 *   stop/target, where it is false.
 * - The #1301 term is ADAPTER-DEPENDENT. No modelled cost exists for a
 *   protective leg, so a surviving protective-leg exit is charged whatever
 *   its adapter reports and `chargeTopUpTo` has nothing to top it up to.
 *   Under `alpaca-order-normalization.ts` (`fee: 0`) that is a whole exit
 *   commission unpaid, biasing live `return_pct` UP — the case that holds for
 *   the soak this filter runs over. Under `saxo-adapter.ts`, which reports
 *   `price * qty * SAXO_COMMISSION_RATE` on every leg, it collapses to an
 *   unsigned price-basis difference. See `toFill`'s "What this still does not
 *   cover" (ingest-fills.ts) for both readings.
 *
 * The limit settles that "net conservative" cannot be claimed. If the flatten
 * capture never fails, the selection term is exactly zero while the #1301
 * under-charge on the soak's adapter is a whole commission, and the net bias
 * is UP — flattering the live edge, not understating it. Nothing measured
 * here excludes that limit, and the selection term is weighted by the very
 * failure rate the paragraph above declines to claim. Ordering the two needs
 * the two numbers this comment does not have: that rate (`flatten_submissions`
 * rows with a null `modelled_cost_breakdown_json`, restricted to
 * post-migration-0037 rows so a failed capture is separable from a
 * pre-migration one) and the surviving bracket population's mean return split
 * by stop versus target.
 *
 * WHY IT IS TRACKED RATHER THAN BLOCKING — two statements, neither leaning on
 * the other, and neither a bound on the bias:
 *
 * - #1121 does not create this residual. The missing modelled cost for a
 *   protective leg predates this column and is #1301's; what #1121 adds is
 *   the filter that makes the resulting selection VISIBLE, which is why it is
 *   tracked there rather than hidden here.
 * - The floor stops a GUTTED live arm from producing a verdict at all, and
 *   the drop rate that would make the selection term large is the same drop
 *   rate that empties the live arm toward `min_trades_per_arm`
 *   (`MIN_TRADES_PER_ARM_FOR_DIVERGENCE = 5`, arm-comparison-cycle.ts — the
 *   value the cycle actually passes; migration 0035 is where the recorded
 *   COLUMN came from, not where the operative number lives). At high trade
 *   volume those come apart — an arm can clear
 *   the floor on a heavily selected population. So this is a coupling, not a
 *   bound, and no bound is claimed.
 *
 * Tracked on #1301, and it is the same defect that ticket already owns rather
 * than a rider on it: both terms come from the one missing piece, a modelled
 * cost for a protective leg. Charging it removes the under-charge outright
 * and MAY close the drop differential too — but only if the charge needs its
 * own capture on the protective leg. AC6 forbids a second derivation and
 * `captureSubmitSnapshot` prices the entry and the flatten only (`toFill`'s
 * "What this still does not cover"), so a fix that prices a protective leg
 * off the ENTRY snapshot leaves protective exits needing the entry captures
 * alone and flattens needing one more, and the differential survives. Which
 * way it lands is #1301's design, not decided here.
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
