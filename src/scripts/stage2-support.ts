/**
 * Shared scaffolding for the Stage-2 research scripts (review 2026-08-06 E) —
 * previously duplicated verbatim in `run-stage2.ts` and
 * `run-stage2-cost-decomposition.ts`, each carrying its own copy of the #420
 * per-asset-class timeline rationale.
 */
import type {
  CostModelImpl,
  DateRange,
  Stage2HistoricalStore,
  TrialGridAssetClass,
} from '../cost-model-backtest/index.js';
import { ReplayDriver } from '../cost-model-backtest/index.js';
import { SimulatedClock } from '../shared/index.js';

/** Everything a per-asset-class replay needs, however the calling script assembled it. */
export interface Stage2ReplayContext {
  store: Stage2HistoricalStore;
  costModel: CostModelImpl;
  window: DateRange;
  capitalPerTrade: number;
}

export function makeAssetClass(
  ctx: Stage2ReplayContext,
  asset_class: 'stocks' | 'crypto',
  symbols: readonly string[],
  periodsPerYear: number,
): TrialGridAssetClass {
  return {
    asset_class,
    periodsPerYear,
    makeRunner: () =>
      new ReplayDriver({
        barSource: ctx.store,
        // Scoped to this asset class's symbols, not the whole store (#420).
        // The store's own `barTimestamps` is the union across every ingested
        // instrument, and stock/crypto daily bars close at different UTC
        // times — so an unscoped timeline steps a stock replay through every
        // crypto bar too, padding the return series with zeros and understating
        // the per-period Sharpe by roughly sqrt(n_real / n_union).
        timeline: ctx.store.timelineFor(symbols),
        registry: ctx.store,
        costModel: ctx.costModel,
        clock: new SimulatedClock(ctx.window.start),
        universe: symbols.map((symbol) => ({ symbol, asset_class })),
        capitalPerTrade: ctx.capitalPerTrade,
      }),
  };
}
