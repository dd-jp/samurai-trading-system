import type { ClosedTrade, Fill } from '../../shared/index.js';
import type { DateRange } from './universe.js';
import type { ReturnSeries, TradeSeries } from './validation-types.js';

export interface SeriesOptions {
  window: DateRange;
  averageCapital: number;
}

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

  const pnlPerBar = Array.from({ length: bars.length }, () => 0);

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
