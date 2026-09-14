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
  type StoreHandle,
  toStoredTimestamp,
} from '../../shared/store/index.js';
import type { ArmRefusedPassCounts } from './arm-comparison.js';

/** A closed trade plus the arm that produced it (migration 0033). */
export type ArmedClosedTrade = ClosedTrade & { arm: TradingArm };

/**
 * The `trader_log.skip_reason` values that mean "this arm could not even
 * attempt the pass", by the arm that can produce them (#1099).
 *
 * `trader_log` carries no `arm` column — migration 0033 added one to
 * `closed_trades`, `open_positions` and (0050) `flatten_submissions`, never
 * here — so attribution runs through the reason itself. That is sound rather
 * than a workaround: `buildBracket` (decide.ts) converts a `BookValuationError`
 * into `control_arm_valuation_refused` only under `arm === 'control'` and
 * rethrows on the live arm, so the string identifies the arm by construction.
 *
 * The live arm's list is empty and that is the true count, not a placeholder: a
 * live-arm valuation failure stays a fault that aborts the tick (decide.ts's
 * `throw error`), so it never reaches `trader_log` as a skip at all. If that
 * ever stops being true, adding the reason here is all this module needs — the
 * count is per-arm end to end — but nothing enforces that the entry is made.
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

  /**
   * Passes each arm REFUSED in the same window — one instrument-pass per row,
   * not one per tick (#1099).
   *
   * `trader_log`'s primary key is `(trace_id, instrument)` and the decision
   * path writes unconditionally with `ON CONFLICT DO NOTHING`
   * (sqlite-decision-record-stores.ts), so a tick that refused six instruments
   * contributes six — which is the granularity #1089's six dead passes were
   * counted at.
   *
   * The same half-open window as `getClosedTradesBetween`, over a column
   * written through the same `toStoredTimestamp`, so consecutive windows
   * partition refusals exactly as they partition trades.
   *
   * These counts are NOT commensurable with `ArmPerformance.trade_count` as a
   * ratio: `modelledCostCharged` and `oneSizingRegime` above drop closed trades
   * this query has no analogue for, so a window can report refusals against a
   * `trade_count` those filters gutted. They answer "was the arm able to act",
   * not "what fraction of its passes traded".
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
 * THE EXCLUSION SELECTS ON EXIT TYPE, through the SUBMISSION count rather than
 * through a veto — and #1301's fix does not remove that. `closedTrade()`'s
 * `modelledCostCharged` now covers every leg (#1301 widened it once a
 * protective leg had a modelled estimate at all), but coverage was never the
 * operative term: each covered leg needs a successful, best-effort
 * `captureSubmitSnapshot`, and a protective leg's estimate comes from the
 * ENTRY submission's capture, the same one its entry legs already needed. So a
 * lot that exits on a protective leg still stamps 1 on the entry capture
 * alone, while a lot that exits on a flatten needs that SAME capture AND the
 * flatten's. The requirement is strictly weaker for protective-leg exits, so
 * their drop rate is WEAKLY lower — equal exactly when the FLATTEN capture
 * never fails, which is the condition that matters: an entry capture that
 * fails hits both exit types identically and does not equalize anything. The
 * surviving live population is therefore enriched in protective-leg exits. The
 * veto `closedTrade()` refuses is genuinely refused; the selection arrives
 * anyway, by the back door.
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
 * - The #1301 UNDER-CHARGE term is CLOSED for lots opened after migration
 *   0061. A protective leg now carries its own submit-time modelled estimate
 *   (`open_positions.modelled_protective_exit_cost_breakdown_json`) and
 *   `chargeTopUpTo` has something to top the adapter's report up to, so the
 *   whole-exit-commission bias under an adapter reporting `fee: 0` is gone.
 *   It still applies to every row written BEFORE that migration, which is
 *   every live row the soak this filter runs over produced.
 *
 * "Net conservative" still cannot be claimed, on either side of that
 * migration. Below it, the reasoning is unchanged: if the flatten capture
 * never fails, the selection term is exactly zero while the under-charge is a
 * whole commission, so the net bias is UP — flattering the live edge. Above
 * it, the under-charge term is zero and the selection term is whatever it is,
 * sign unestablished, so the net is simply the selection term with no
 * counterweight. Ordering anything still needs the two numbers this comment
 * does not have: the flatten capture's failure rate (`flatten_submissions`
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
 * HOW #1301 LANDED. David ruled on 2026-09-14 for Option 1 — price the
 * protective legs at submit, off the entry's own `MarketState`, keeping one
 * derivation per priced event (#1121 AC6) — over giving the control arm a
 * bracket-exit path. That removes the under-charge outright and leaves the
 * drop differential exactly as it was, for the reason this comment anticipated:
 * a charge priced off the ENTRY snapshot needs no capture of its own, so
 * protective exits still need the entry captures alone and flattens still need
 * one more. The differential is a deliberate residual of the chosen option,
 * not an open question.
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
 * value `ProductionConfig.capitalCeilingUsd` held when a row was written, so
 * "different regimes" here means "different declared-ceiling VALUES", not
 * necessarily different currencies. #1180's FX conversion would have been
 * exactly that third case — pre-conversion `1000` rows against converted
 * `1270` rows, throwing on every straddling window even though the book never
 * moved — so it shipped migration 0052 to normalize the stamp instead. This
 * guard could not have told that apart from a real mid-window book change;
 * the fix belongs in the writer's history, not in a special case here.
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
