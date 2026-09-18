import {
  AlwaysOpenCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../providers/market-data-service/index.js';
import { SimulatedClock } from '../shared/index.js';
import type {
  CostModelImpl,
  CostVenue,
  DateRange,
  Stage2HistoricalStore,
  TrialGridAssetClass,
} from './backtest/index.js';
import { ReplayDriver } from './backtest/index.js';

export interface Stage2ReplayContext {
  store: Stage2HistoricalStore;
  costModel: CostModelImpl;
  window: DateRange;
  capitalPerTrade: number;
}

function calendarFor(asset_class: 'stocks' | 'crypto'): TradingCalendar {
  return asset_class === 'stocks' ? new UsEquityRegularHoursCalendar() : new AlwaysOpenCalendar();
}

export function makeAssetClass(
  ctx: Stage2ReplayContext,
  asset_class: 'stocks' | 'crypto',
  symbols: readonly string[],
  periodsPerYear: number,
  venue?: CostVenue,
): TrialGridAssetClass {
  return {
    asset_class,
    periodsPerYear,
    makeRunner: () =>
      new ReplayDriver({
        barSource: ctx.store,
        timeline: ctx.store.timelineFor(symbols),
        registry: ctx.store,
        costModel: ctx.costModel,
        clock: new SimulatedClock(ctx.window.start),
        universe: symbols.map((symbol) => ({
          symbol,
          asset_class,
          ...(venue === undefined ? {} : { venue }),
        })),
        capitalPerTrade: ctx.capitalPerTrade,
        timeframe: ctx.store.timeframe,
        sessionCalendar: calendarFor(asset_class),
      }),
  };
}
