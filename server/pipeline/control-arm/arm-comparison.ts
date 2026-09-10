/**
 * The two-arm comparison report (#753) — the artefact ADR-0017 makes the
 * benchmark non-optional for, and the one place `docs/research/12-edge-hypothesis-critique.md`
 * D4 is enforced as a TYPE rather than as a convention.
 *
 * ## D4, stated as a shape
 *
 * D4 rules out return-only comparisons against a risk-targeted stream, and
 * #753's acceptance criterion sharpens that into something checkable: *a
 * return-only comparison cannot be produced from the report — drawdown is not
 * optional in the output shape*.
 *
 * So `max_drawdown_pct` is a REQUIRED field on `ArmPerformance`, and
 * `ArmComparison` has no per-arm view that omits it. That is the whole of the
 * enforcement, and it is deliberately structural: a rule that lives in a review
 * checklist gets forgotten the first time someone adds a summary table with one
 * column per arm, which is exactly the failure D4 names and exactly how easy it
 * is to reintroduce. A caller that wants to print returns alone has to construct
 * a drawdown it then discards, in code that reads as the mistake it is.
 *
 * `builtAt`, `from` and `to` are required for the same reason at the window
 * level: doc 12 gate 4's exact-window requirement is a correctness condition,
 * not a formatting detail. Two arms measured over different windows are not a
 * comparison.
 *
 * ## Why this reads `closed_trades` and not an equity curve
 *
 * The arms do not have two account balances to difference. The live arm's equity
 * is the broker's; the control arm's is a simulation with no account behind it.
 * What they DO share is one realized record per round-trip-to-flat, in one table,
 * distinguishable by the `arm` column (migration 0033) — cost-inclusive on both
 * sides, because `realized_pnl_net` is net of fees and the simulated adapter
 * prices its fills through the same `CostModel` the backtest uses.
 *
 * So both arms' series are built the same way from the same table over the same
 * window: cumulative realized PnL per trade, in order of close. Return is the
 * end of that series; drawdown is the deepest fall from its running peak. One
 * derivation, applied twice — a second derivation for the control would be a
 * second place for the two arms' accounting to differ, which is the failure mode
 * this whole ticket exists to avoid.
 */
import type { ClosedTrade, TradingArm } from '../../shared/index.js';

/**
 * One arm's realized performance over the comparison window.
 *
 * **Every field is required.** See the module header: the non-optionality of
 * `max_drawdown_pct` IS #753's "a return-only comparison cannot be produced from
 * the report".
 */
export interface ArmPerformance {
  arm: TradingArm;
  /** Round trips to flat in the window. Zero is a real, reportable answer. */
  trade_count: number;
  /**
   * Cumulative realized PnL, net of fees, in account currency. Signed.
   *
   * Carried alongside the percentage because the percentage's denominator is a
   * choice (see `basis`) while this number is not — it is what the arm actually
   * made or lost.
   */
  realized_pnl_net: number;
  /**
   * Cumulative realized PnL as a fraction of `basis`. Signed.
   *
   * NOT annualised and not compounded: over a soak-length window an annualisation
   * would be an extrapolation from a handful of trades, and the two arms are
   * compared against each other rather than against a rate.
   */
  return_pct: number;
  /**
   * The deepest peak-to-trough fall of the cumulative realized-PnL series, as a
   * POSITIVE fraction of `basis`. Zero when the series never fell below a prior
   * peak.
   *
   * Required, and the reason is the whole point of this module. A control arm can
   * beat the live arm on return while taking a path no one would fund, and the
   * comparison that hides that is precisely the one D4 rules out.
   */
  max_drawdown_pct: number;
  /**
   * Passes in the window this arm could not attempt at all (#1099).
   *
   * REQUIRED, for the same structural reason `max_drawdown_pct` is. A stretch
   * of `control_arm_valuation_refused` skips writes `trader_log` rows and no
   * `closed_trades` row, so before this field the report could not tell "the
   * control produced no signal on these bars" from "the control could not value
   * its book on these bars" — both read as `trade_count: 0`. An optional field
   * would leave that ambiguity intact wherever a caller omitted it, which is
   * the same failure the field exists to remove.
   *
   * Only the control arm can currently be non-zero, and that is a property of
   * the writer rather than of this report: `buildBracket` (decide.ts) converts
   * a `BookValuationError` into a skip only under `arm === 'control'` and
   * rethrows on the live arm, where a valuation failure stays a tick-aborting
   * fault. Read `live: 0 refusals` as "no live-arm refusal exists as a
   * concept", not as evidence the live arm's book valued cleanly.
   *
   * NOT a denominator for `trade_count`. See
   * `SqliteArmComparisonSource.getRefusedPassCountsBetween` for why the two
   * counts survive different filters.
   */
  refused_pass_count: number;
}

/**
 * Refused passes per arm over one window — the second half of the #1099 read,
 * carried as its own value because it comes from a different table
 * (`trader_log`) than the trades do.
 */
export type ArmRefusedPassCounts = Readonly<Record<TradingArm, number>>;

/** Both arms, over one window, always together. */
export interface ArmComparison {
  /**
   * Half-open at the start, on BOTH reads behind this comparison:
   * `closed_at > from AND closed_at <= to` for trades, and the same bounds on
   * `trader_log.created_at` for `refused_pass_count` (#1099). Consecutive
   * windows therefore partition the timeline for refusals as well as trades —
   * no pass is counted twice, none is dropped.
   */
  from: Date;
  to: Date;
  /**
   * The denominator both arms' percentages are taken against — the SAME number
   * for both, which is what makes the two `return_pct` figures comparable at all.
   */
  basis: number;
  live: ArmPerformance;
  control: ArmPerformance;
}

/**
 * Builds the comparison from one window's closed trades.
 *
 * `trades` may be both arms' rows in any order — they are partitioned here on
 * the `arm` column rather than by the caller running two queries, so the two
 * arms are provably measured over the SAME window from the SAME read. Two
 * queries would be two windows waiting to drift apart.
 *
 * A trade with no arm recorded counts as `'live'`. That is not a fallback for
 * missing data: every row written before falsifier arm 2 existed was the live
 * arm's, and the column's own default says so (migration 0033).
 */
export function buildArmComparison(input: {
  trades: readonly (ClosedTrade & { arm?: TradingArm })[];
  /**
   * Refused passes per arm over the SAME window (#1099). Required rather than
   * defaulted to zero: a caller that cannot supply this has no refusal reading,
   * and silently publishing `0` for it is the exact "refusals read as silence"
   * result the field exists to end.
   */
  refused_passes: ArmRefusedPassCounts;
  from: Date;
  to: Date;
  /**
   * The equity the percentages are expressed against. Must be positive — a
   * zero or negative basis makes every percentage meaningless rather than
   * merely wrong, so it is refused rather than divided by.
   */
  basis: number;
}): ArmComparison {
  if (!(input.basis > 0) || !Number.isFinite(input.basis)) {
    throw new Error(
      `buildArmComparison: basis must be a positive, finite number, but it is ` +
        `${String(input.basis)}. Both arms' percentages are taken against it, so an ` +
        'unusable basis would produce a comparison that reads as a measurement.',
    );
  }

  const inWindow = input.trades.filter(
    (trade) =>
      trade.closed_at.getTime() > input.from.getTime() &&
      trade.closed_at.getTime() <= input.to.getTime(),
  );

  return {
    from: input.from,
    to: input.to,
    basis: input.basis,
    live: performanceFor('live', inWindow, input.basis, input.refused_passes.live),
    control: performanceFor('control', inWindow, input.basis, input.refused_passes.control),
  };
}

/**
 * One arm's slice of the shared derivation — return AND drawdown from the same
 * cumulative series, in one pass.
 *
 * Sorted by close time and then by key: `closed_at` is stored at second
 * resolution in some paths, so two lots closing in the same second would
 * otherwise order non-deterministically and move the drawdown between runs. The
 * tiebreak makes the series reproducible, which a measurement has to be.
 */
function performanceFor(
  arm: TradingArm,
  trades: readonly (ClosedTrade & { arm?: TradingArm })[],
  basis: number,
  refusedPassCount: number,
): ArmPerformance {
  const mine = trades
    .filter((trade) => (trade.arm ?? 'live') === arm)
    .sort(
      (a, b) =>
        a.closed_at.getTime() - b.closed_at.getTime() ||
        a.idempotency_key.localeCompare(b.idempotency_key),
    );

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of mine) {
    cumulative += trade.realized_pnl_net;
    // The peak starts at 0, so an arm that is down from its first trade has a
    // real drawdown rather than a zero one — the series' high-water mark is the
    // capital it started with, not its best trade.
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    arm,
    trade_count: mine.length,
    realized_pnl_net: cumulative,
    return_pct: cumulative / basis,
    max_drawdown_pct: maxDrawdown / basis,
    refused_pass_count: refusedPassCount,
  };
}
