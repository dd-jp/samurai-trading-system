/**
 * `ClosedTrade` → `TradeSeries` / `ReturnSeries` derivation (ticket #90).
 *
 * This is the wiring #89 could not do. `index.ts` recorded why: the validation
 * library shipped callable but unwired because `TickOutcome` carries only a
 * trace, a final stage, a verdict and an optional `ExecutionResult` — no fill
 * records, so nothing to derive returns from. Execution's `ClosedTrade`
 * emission (#83) is what changed; these functions are the join.
 *
 * They are deliberately separate from `eval-executor.ts`: the derivation is
 * where the arithmetic that can silently lie lives (which trade lands in which
 * bar, what counts as traded notional), so it is unit-tested against
 * hand-computed fixtures on its own rather than only through the executor.
 */

import type { ClosedTrade, Fill } from '../../shared/index.js';
import type { DateRange } from './universe.js';
import type { ReturnSeries, TradeSeries } from './validation-types.js';

/** Sample-scoping parameters shared by both derivations. See `EvalOptions`. */
export interface SeriesOptions {
  window: DateRange;
  averageCapital: number;
}

/**
 * Acceptance criterion 1 — the eval path reads fills our cost model priced,
 * never a foreign fill model's.
 *
 * `Fill.cost_breakdown` is "populated only for fills produced by the Simulated
 * adapter, mapped from `CostModel.fill`'s `CostModelResult`" (shared/types.ts).
 * So its presence on every fill of a replay is the evidence, and its absence
 * means some other fill model priced the lot — which for a backtest is the
 * √-law market-impact requirement (Principle 2) quietly not applied. That is
 * unrecoverable rather than degraded: metrics computed off optimistic fills
 * are the flattering lie this whole component exists to prevent, so it throws.
 *
 * Note the check is deliberately *not* "is this the Simulated adapter" — the
 * live path's real broker fills legitimately carry no breakdown. It is scoped
 * to the eval path, whose fills are modeled by construction.
 */
export function assertCostModelPriced(trade: ClosedTrade, fills: readonly Fill[]): void {
  if (fills.length === 0) {
    throw new Error(
      `Eval path: closed trade ${trade.idempotency_key} (${trade.instrument}) has no fills — ` +
        'its PnL cannot be attributed to CostModel.fill.',
    );
  }

  for (const fill of fills) {
    if (fill.cost_breakdown === undefined) {
      throw new Error(
        `Eval path: fill ${fill.broker_fill_id} (leg ${fill.leg}) of closed trade ` +
          `${trade.idempotency_key} carries no cost_breakdown, so it was not priced by ` +
          'CostModel.fill. A backtest scored on unmodeled fills understates market impact.',
      );
    }
  }
}

/**
 * The trade-derived half of the suite: profit factor, expectancy, turnover,
 * exposure.
 *
 * `pnl` maps from `realized_pnl_net`, which is already "net of fees across
 * every leg" — matching `Trade.pnl`'s "net of costs" contract exactly, so
 * expectancy is net by construction rather than by a subtraction here.
 *
 * `notional` is `entry × filled_size × 2`: `Trade.notional` wants the
 * round-trip (entry + exit), and `ClosedTrade` records the average entry price
 * but **not** the exit price. Pricing the exit leg at the entry price is the
 * only approximation the available record supports; it is stated here rather
 * than hidden because it biases turnover by however far the exit drifted from
 * the entry. Recovering the true exit notional needs the per-leg fills, which
 * would make turnover depend on a second query the metric does not otherwise
 * need — a trade worth revisiting if turnover ever becomes a kill criterion.
 */
export function toTradeSeries(trades: readonly ClosedTrade[], options: SeriesOptions): TradeSeries {
  return {
    trades: trades.map((trade) => ({
      instrument: trade.instrument,
      pnl: trade.realized_pnl_net,
      notional: trade.entry * trade.filled_size * 2,
      opened_at: trade.opened_at,
      closed_at: trade.closed_at,
    })),
    averageCapital: options.averageCapital,
    window: options.window,
  };
}

/**
 * Periodic returns: each bar's realized PnL over deployed capital.
 *
 * Realized rather than mark-to-market, because realized is all the record
 * holds — a `ClosedTrade` exists only once the round-trip is flat, so an open
 * position contributes nothing until it closes. The series is therefore lumpy
 * relative to a true equity curve, which matters for the Lo autocorrelation
 * adjustment `computeMetrics` applies; it is the honest series available from
 * `ClosedTrade` alone, and no smoother substitute is invented here.
 *
 * A trade is attributed to the **first bar at or after** its `closed_at`: the
 * bar on which the PnL became knowable. Attributing it to the preceding bar
 * would date realized PnL earlier than the close that produced it — a
 * lookahead of exactly the kind `LookaheadAuditor` exists to catch, reintroduced
 * downstream of the audit.
 */
/**
 * Index of the first bar at or after `closedAtMs`, or `-1` if there is none.
 *
 * Binary search rather than `findIndex` (#289 M12). `bars` is a bar TIMELINE —
 * ascending by construction everywhere it is produced — so the two are exactly
 * equivalent, and the linear scan made `toReturnSeries` O(trades x bars).
 *
 * Worth doing without a profile, unlike the rest of #289, because the cost is
 * structural rather than suspected: Stage 2 evaluates 7 configs x 2 asset
 * classes x 5 folds, twice over (the CSCV pass), against ~700 bars. The
 * quadratic term is multiplied by all of that, and it grows with every year of
 * history bought — which is the single change the Stage 2 verdict recommends.
 *
 * Standard lower-bound: the loop narrows to the leftmost index whose bar is not
 * before the target, so ties resolve to the FIRST matching bar, exactly as
 * `findIndex` did. That matters — attributing a trade to a later bar with the
 * same timestamp would move realized PnL off the bar on which it became
 * knowable.
 */
function firstBarAtOrAfter(bars: readonly Date[], closedAtMs: number): number {
  let low = 0;
  let high = bars.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((bars[mid] as Date).getTime() >= closedAtMs) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low === bars.length ? -1 : low;
}

export function toReturnSeries(
  trades: readonly ClosedTrade[],
  bars: readonly Date[],
  options: SeriesOptions & { periodsPerYear: number },
): ReturnSeries {
  if (options.averageCapital <= 0) {
    throw new Error(
      `toReturnSeries: averageCapital must be > 0 (got ${options.averageCapital}) — it is the ` +
        'return denominator.',
    );
  }
  if (bars.length === 0) {
    throw new Error('toReturnSeries: no bars in the sample — there is no series to compute over.');
  }

  const pnlPerBar = new Array<number>(bars.length).fill(0);

  for (const trade of trades) {
    const index = firstBarAtOrAfter(bars, trade.closed_at.getTime());

    if (index === -1) {
      throw new Error(
        `toReturnSeries: closed trade ${trade.idempotency_key} closed at ` +
          `${trade.closed_at.toISOString()}, after the last bar ` +
          `${(bars[bars.length - 1] as Date).toISOString()} of the sample it was drawn from.`,
      );
    }

    pnlPerBar[index] = (pnlPerBar[index] as number) + trade.realized_pnl_net;
  }

  return {
    returns: pnlPerBar.map((pnl) => pnl / options.averageCapital),
    periodsPerYear: options.periodsPerYear,
  };
}
