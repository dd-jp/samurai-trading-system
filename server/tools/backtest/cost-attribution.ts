/**
 * Gross-vs-net cost decomposition for a replay run.
 *
 * Diagnostic for the Stage 2 kill verdict of 2026-08-05
 * (docs/research/archive/2026-08-05-stage2-verdict-first-real-run.md): 22 of 24
 * (config, asset class) pairs posted a negative out-of-sample Sharpe under
 * `PESSIMISTIC_COST_CONFIG`, at a turnover of 115–556 and an exposure of ~0.9,
 * with no config's profit factor above 1.14. Two very different diagnoses fit
 * that shape — a signal with no information in it, or a real-but-thin gross
 * edge churned hard enough that pessimistic costs eat it — and they point at
 * completely different fixes. This module separates them.
 *
 * ## Why the decomposition is EXACT, not an approximation
 *
 * The replay's trade path does not depend on costs at all. `ReplayDriver`
 * takes its entry decision from `proxySignal(bars, config)`, its stop and
 * target from that same signal, its exit from `exitOf(lot, bar, signal)` —
 * which reads only the bar's OHLC against those levels — and its size from
 * `capitalPerTrade / bar.close`. Every one of those is a pure function of the
 * bars and the strategy config. `CostModel.fill` is called only to PRICE the
 * two legs; nothing reads `fill_price` back into a decision, so not even the
 * √-law impact term (`sqrt(size / adv)`) can feed back through `size`.
 *
 * So the same trades, at the same timestamps, in the same sizes, would be
 * taken by a frictionless run — and adding the modeled costs back gives that
 * frictionless run's PnL exactly. This is not "costs held roughly constant";
 * it is an algebraic identity, and `cost-attribution.test.ts` proves it by
 * replaying one config twice (priced and zero-cost) and asserting the
 * reconstruction matches trade-for-trade.
 *
 * The identity itself, from `CostModelImpl.fill`
 * (`fill_price = mid + sign × (half_spread + slippage + market_impact)`) and
 * `ReplayDriver.closeLot` (`realized_pnl_net = (exit − entry) × size × dir −
 * fees_total`), for a long:
 *
 *     entry = mid_e + A_e,  exit = mid_x − A_x     where A = spread+slip+impact
 *     net   = (mid_x − mid_e) × size − (A_e + A_x) × size − fees_total
 *     gross = net + (A_e + A_x) × size + fees_total
 *
 * A short flips both signs and lands on the same add-back, which is why this
 * needs no per-side branch.
 *
 * ## The units trap
 *
 * Three of `CostBreakdown`'s four fields are PER-UNIT price offsets
 * (`spread_cost` is the half-spread, `slippage`, `market_impact`); `commission`
 * is already an absolute currency amount (`rate × size × mid`). Multiplying
 * the commission by quantity a second time is the easy error here and inflates
 * the add-back silently, so the two are summed separately below and pinned by
 * a hand-computed fixture in the test.
 */

import type { ClosedTrade, Fill } from '../../shared/index.js';
import type { ReplayTradeSource } from './eval-types.js';
import type { DateRange } from './universe.js';

/** What one round-trip paid, split by the cost model's four components. */
export interface TradeCostAttribution {
  /** Half-spread, in currency: `Σ legs qty × spread_cost`. */
  spread: number;
  /** Already absolute in `CostBreakdown` — summed, never multiplied by qty. */
  commission: number;
  slippage: number;
  market_impact: number;
  /** The full add-back: `spread + commission + slippage + market_impact`. */
  total: number;
}

const ZERO_ATTRIBUTION: TradeCostAttribution = {
  spread: 0,
  commission: 0,
  slippage: 0,
  market_impact: 0,
  total: 0,
};

/**
 * Sums every modeled cost across a lot's legs.
 *
 * Throws on a fill with no `cost_breakdown` rather than treating it as free:
 * an unpriced leg would understate the add-back and make the gross number look
 * closer to the net one than it is — biasing this diagnostic toward "costs are
 * not the problem", the exact conclusion it exists to test. Same reasoning as
 * `assertCostModelPriced`, which the eval path applies to the same fills.
 */
export function attributeTradeCost(
  fills: readonly Fill[],
  idempotency_key: string,
): TradeCostAttribution {
  let spread = 0;
  let commission = 0;
  let slippage = 0;
  let market_impact = 0;

  for (const fill of fills) {
    const breakdown = fill.cost_breakdown;
    if (breakdown === undefined) {
      throw new Error(
        `attributeTradeCost: fill ${fill.broker_fill_id} (leg ${fill.leg}) of ${idempotency_key} ` +
          'carries no cost_breakdown, so what it paid cannot be added back. A gross series ' +
          'reconstructed from partially-priced fills understates costs.',
      );
    }

    spread += fill.qty * breakdown.spread_cost;
    slippage += fill.qty * breakdown.slippage;
    market_impact += fill.qty * breakdown.market_impact;
    commission += breakdown.commission;
  }

  return {
    spread,
    commission,
    slippage,
    market_impact,
    total: spread + commission + slippage + market_impact,
  };
}

/** Per-run cost totals, alongside the notional they were charged against. */
export interface RunCostAttribution extends TradeCostAttribution {
  trades: number;
  /** Round-trip traded notional, `Σ entry × filled_size × 2` — matches `toTradeSeries`. */
  notional: number;
  /** `total / notional`, in basis points: the all-in round-trip cost rate. */
  bps_of_notional: number;
  /**
   * Mean per-fill adverse price move as a multiple of the volatility input the
   * cost model priced it from, or `undefined` when it cannot be recovered.
   *
   * The cost model sets `slippage = volatility × slippageCoefficient`, so the
   * ATR it saw is `slippage / slippageCoefficient` — exact, given the same
   * coefficient the run was priced with. Reported because a cost expressed in
   * currency hides whether it is plausible, while a cost expressed against the
   * ATR the strategy sets its 3–4 ATR targets from does not: an adverse move
   * approaching an ATR per fill is a miscalibrated cost fixture, not a market.
   */
  mean_adverse_move_in_atr?: number;
}

/**
 * Totals one run's costs. `slippageCoefficient` is optional and used only to
 * recover the ATR multiple; omit it and that field is simply absent rather
 * than guessed.
 */
export async function attributeRunCosts(
  source: ReplayTradeSource,
  window: DateRange,
  slippageCoefficient?: number,
): Promise<RunCostAttribution> {
  const trades = await source.closedTrades(window);

  let totals = { ...ZERO_ATTRIBUTION };
  let notional = 0;
  let adverseInAtr = 0;
  let pricedFills = 0;

  for (const trade of trades) {
    const fills = await source.fills(trade.idempotency_key);
    const cost = attributeTradeCost(fills, trade.idempotency_key);

    totals = {
      spread: totals.spread + cost.spread,
      commission: totals.commission + cost.commission,
      slippage: totals.slippage + cost.slippage,
      market_impact: totals.market_impact + cost.market_impact,
      total: totals.total + cost.total,
    };
    // Round-trip notional approximated as entry × size × 2, i.e. exit notional
    // is assumed equal to entry notional. `ClosedTrade` carries no exit price
    // (`server/shared/types.ts` — entry, stop, filled_size, realized_pnl_net, but
    // no exit), so the exact `entry × size + exit × size` is not derivable
    // here. This only feeds `bps_of_notional`, a denominator for presenting
    // cost magnitude, and the error is second-order: it is the trade's own
    // return on one of two legs. Trades that moved far enough for that to
    // matter are exactly the ones whose cost-in-bps is least load-bearing.
    notional += trade.entry * trade.filled_size * 2;

    if (slippageCoefficient !== undefined && slippageCoefficient > 0) {
      for (const fill of fills) {
        const b = fill.cost_breakdown;
        if (b === undefined) continue;
        const atr = b.slippage / slippageCoefficient;
        if (atr <= 0) continue;
        adverseInAtr += (b.spread_cost + b.slippage + b.market_impact) / atr;
        pricedFills += 1;
      }
    }
  }

  return {
    ...totals,
    trades: trades.length,
    notional,
    bps_of_notional: notional > 0 ? (totals.total / notional) * 10_000 : 0,
    ...(pricedFills > 0 ? { mean_adverse_move_in_atr: adverseInAtr / pricedFills } : {}),
  };
}

/**
 * The same replay, re-presented with every trade's PnL gross of modeled costs.
 *
 * A wrapper rather than a second replay or a new metrics path, so the gross
 * numbers come out of the SAME `EvalExecutorImpl` — same walk-forward
 * boundaries, same embargo, same Lo annualization, same fold Sharpes. That is
 * what makes a gross out-of-sample Sharpe comparable to the 0.5 kill line the
 * Stage 2 verdict is defined on; a window-level gross Sharpe computed off to
 * one side would not be.
 *
 * `fills` is passed straight through, un-zeroed. The eval path runs
 * `assertCostModelPriced` over them, and that attestation must keep meaning
 * what it says — these ARE cost-model-priced fills, and the run they came from
 * really did pay these costs. The gross view is a subtraction applied to the
 * PnL, not a claim that the fills were free.
 */
export class GrossOfCostsTradeSource implements ReplayTradeSource {
  constructor(private readonly inner: ReplayTradeSource) {}

  async closedTrades(window: DateRange): Promise<readonly ClosedTrade[]> {
    const trades = await this.inner.closedTrades(window);

    return Promise.all(
      trades.map(async (trade) => {
        const cost = attributeTradeCost(
          await this.inner.fills(trade.idempotency_key),
          trade.idempotency_key,
        );
        return {
          ...trade,
          realized_pnl_net: trade.realized_pnl_net + cost.total,
          // Gross of costs means gross of fees too — leaving `fees_total`
          // populated would describe a trade whose PnL ignores fees while its
          // own record still reports them.
          fees_total: 0,
        };
      }),
    );
  }

  fills(idempotency_key: string): Promise<readonly Fill[]> {
    return this.inner.fills(idempotency_key);
  }
}
