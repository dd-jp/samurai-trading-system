/**
 * Production Composition Root: `VolatilityReadingProvider` (ticket #277).
 * See docs/specs/transport-layer-spec.md ("Module: VolatilityReadingProvider"),
 * closed wayfinder map "Live Transport Layer" (#259), decision #264.
 *
 * Closes `direct-bind.ts`'s `VolatilityReadingProvider` interface
 * (`getVolatilityReading(asOf): Promise<VolatilityReading>`). Reuses the
 * already-shipped pattern at `src/execution/simulated-adapter.ts`'s
 * `buildMarketState` — `marketData.getIndicator(instrument,
 * config.volatility_indicator, now)` — no new data source.
 *
 * Aggregation is always over the full configured universe
 * (`ProductionConfig.universe`), not open positions: `getIndicator` is
 * called for every instrument, partitioned by `asset_class`, and reduced to
 * one number per class via **max** — matching `CircuitBreakers.evaluate`'s
 * conservative, worst-case-trips-it intent, not a smoothed average. Because
 * the universe is populated by config rather than by open positions, a
 * reading is always available; there is no default-instrument fallback for
 * a "no positions open" case (that describes an earlier, inconsistent
 * wayfinder resolution on #264 — superseded, see #277).
 *
 * No new caching layer: `getIndicator` calls land on `MarketDataService`'s
 * existing input-hash (Tier-1) response cache
 * (market-data-service-spec.md), so repeat calls within the same tick are
 * already deduplicated there.
 *
 * Not yet wired into `production.ts`: `ProductionConfig.volatility` stays a
 * required injected field for now (composition-root wiring is a separate
 * concern from closing this interface, and `AccountStateProvider` — the
 * other required field `computeCurrentPortfolioAndBreakers` needs alongside
 * it — has no in-repo implementation yet either).
 */
import type { IndicatorSpec, MarketDataService } from '../../market-data-service/index.js';
import type { VolatilityReading } from '../../risk-manager/index.js';
import type { AssetClass, UniverseInstrument } from '../types.js';
import type { VolatilityReadingProvider } from './direct-bind.js';

export interface VolatilityReadingProviderConfig {
  marketData: MarketDataService;
  /** The full configured universe — aggregated over unconditionally, not gated on open positions. */
  universe: readonly UniverseInstrument[];
  /** Same indicator spec `SimulatedAdapterConfig.volatility_indicator` reads for `MarketState.volatility`. */
  volatility_indicator: IndicatorSpec;
}

/**
 * No instruments of a class in the universe: no reading, so the breaker
 * never trips on an absent class. Safe even at a 0 configured baseline —
 * `CircuitBreakers.evaluate`'s volatility check is a strict `>`, so a 0
 * reading never trips regardless of baseline. This is also today's actual
 * live behavior for `stocks`, not just a corner case: `SMOKE_TEST_UNIVERSE`
 * (the default `ProductionConfig.universe`) is crypto-only, so the `stocks`
 * class reads 0 until the universe is widened.
 */
const NO_READING = 0;

export class MarketDataVolatilityReadingProvider implements VolatilityReadingProvider {
  constructor(private readonly config: VolatilityReadingProviderConfig) {}

  async getVolatilityReading(asOf: Date): Promise<VolatilityReading> {
    const { marketData, universe, volatility_indicator } = this.config;

    const readings = await Promise.all(
      universe.map(async (instrument) => ({
        asset_class: instrument.asset_class,
        value: (await marketData.getIndicator(instrument.asset, volatility_indicator, asOf)).value,
      })),
    );

    return {
      crypto: maxByClass(readings, 'crypto'),
      stocks: maxByClass(readings, 'stocks'),
    };
  }
}

function maxByClass(
  readings: readonly { asset_class: AssetClass; value: number }[],
  asset_class: AssetClass,
): number {
  const values = readings
    .filter((reading) => reading.asset_class === asset_class)
    .map((reading) => reading.value);
  return values.length === 0 ? NO_READING : Math.max(...values);
}
