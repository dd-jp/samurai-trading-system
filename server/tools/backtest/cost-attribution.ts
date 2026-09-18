
import type { ClosedTrade, Fill } from '../../shared/index.js';
import type { ReplayTradeSource } from './eval-types.js';
import type { DateRange } from './universe.js';

export interface TradeCostAttribution {
  spread: number;
  commission: number;
  slippage: number;
  market_impact: number;
  total: number;
}

const ZERO_ATTRIBUTION: TradeCostAttribution = {
  spread: 0,
  commission: 0,
  slippage: 0,
  market_impact: 0,
  total: 0,
};

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

export interface RunCostAttribution extends TradeCostAttribution {
  trades: number;
  notional: number;
  bps_of_notional: number;
  mean_adverse_move_in_atr?: number;
}

function sumAdverseMoveInAtr(
  fills: readonly Fill[],
  slippageCoefficient: number,
): { adverseInAtr: number; pricedFills: number } {
  let adverseInAtr = 0;
  let pricedFills = 0;

  for (const fill of fills) {
    const b = fill.cost_breakdown;
    if (b === undefined) continue;
    const atr = b.slippage / slippageCoefficient;
    if (atr <= 0) continue;
    adverseInAtr += (b.spread_cost + b.slippage + b.market_impact) / atr;
    pricedFills += 1;
  }

  return { adverseInAtr, pricedFills };
}

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
    notional += trade.entry * trade.filled_size * 2;

    if (slippageCoefficient !== undefined && slippageCoefficient > 0) {
      const atrSum = sumAdverseMoveInAtr(fills, slippageCoefficient);
      adverseInAtr += atrSum.adverseInAtr;
      pricedFills += atrSum.pricedFills;
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
          fees_total: 0,
        };
      }),
    );
  }

  fills(idempotency_key: string): Promise<readonly Fill[]> {
    return this.inner.fills(idempotency_key);
  }
}
