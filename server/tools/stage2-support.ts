/**
 * Shared scaffolding for the Stage-2 research scripts (review 2026-08-06 E) —
 * previously duplicated verbatim in `run-stage2.ts` and
 * `run-stage2-cost-decomposition.ts`, each carrying its own copy of the #420
 * per-asset-class timeline rationale
 */
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

/** Everything a per-asset-class replay needs, however the calling script assembled it */
export interface Stage2ReplayContext {
  store: Stage2HistoricalStore;
  costModel: CostModelImpl;
  window: DateRange;
  capitalPerTrade: number;
}

/**
 * Which venue calendar an asset class replays against (#664).
 *
 * The equity calendar's holiday and early-close tables are HAND-ENTERED and
 * cover 2026-2027 only, so an intraday replay of an earlier half-day will trip
 * `ReplayDriver`'s flat-by-close assertion rather than silently carrying
 * overnight. That is the intended behaviour; #684 replaces both tables with
 * Alpaca's own `GET /v2/calendar`.
 *
 * Crypto gets `AlwaysOpenCalendar`, whose `sessionEnd` is `null` — no flatten,
 * no assertion, and therefore no new crypto behaviour, which is what ADR-0015's
 * 2026-08-16 amendment (crypto out of scope) requires.
 */
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
        // Scoped to this asset class's symbols, not the whole store (#420)
        // The store's own `barTimestamps` is the union across every ingested
        // instrument, and stock/crypto daily bars close at different UTC
        // times — so an unscoped timeline steps a stock replay through every
        // crypto bar too, padding the return series with zeros and understating
        // the per-period Sharpe by roughly sqrt(n_real / n_union)
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
        // The store's own timeframe, not a literal (#664): the driver and the
        // bars it replays cannot disagree if only one of them decides
        timeframe: ctx.store.timeframe,
        sessionCalendar: calendarFor(asset_class),
      }),
  };
}
