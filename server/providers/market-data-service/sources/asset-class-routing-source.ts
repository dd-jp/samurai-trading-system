import type { AssetClass } from '../../../shared/index.js';
import type { BarWindow, DataSource, Mark, Quote } from '../types.js';

export interface AssetClassRoutingSourceConfig {
  sources: Record<AssetClass, DataSource>;
  assetClassOf: ReadonlyMap<string, AssetClass>;
}

export class AssetClassRoutingDataSource implements DataSource {
  readonly #sources: Record<AssetClass, DataSource>;
  readonly #assetClassOf: ReadonlyMap<string, AssetClass>;

  constructor(config: AssetClassRoutingSourceConfig) {
    const missing = (['crypto', 'stocks'] as const).filter(
      (assetClass) => config.sources[assetClass] === undefined,
    );
    if (missing.length > 0) {
      throw new Error(
        `AssetClassRoutingDataSource: no data source supplied for ${missing.join(' and ')}. ` +
          'This class exists only to serve a universe spanning BOTH asset classes, and it routes ' +
          'per instrument — so a missing source is not a narrower router, it is an instrument ' +
          'that will throw mid-tick when something first asks for its bars. Supply both, or use ' +
          'a single AlpacaDataSource directly if the universe really holds one asset class.',
      );
    }

    this.#sources = config.sources;
    this.#assetClassOf = config.assetClassOf;
  }

  #routeFor(instrument: string): DataSource {
    const assetClass = this.#assetClassOf.get(instrument);
    if (assetClass === undefined) {
      throw new Error(
        `AssetClassRoutingDataSource: no asset class configured for instrument '${instrument}' ` +
          `(known: ${[...this.#assetClassOf.keys()].join(', ') || 'none'}). Market-data endpoints ` +
          'are per asset class — Alpaca serves equities from /v2/stocks and crypto from ' +
          '/v1beta3/crypto/us — so routing this to a default would send it to the wrong API root ' +
          'and 404 silently (#358). Add the instrument to ProductionConfig.universe.',
      );
    }
    return this.#sources[assetClass];
  }

  async fetchBars(instrument: string, window: BarWindow, asOf: Date) {
    return this.#routeFor(instrument).fetchBars(instrument, window, asOf);
  }

  async fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
    return this.#routeFor(instrument).fetchMark(instrument, asOf, mode);
  }

  async fetchQuote(instrument: string, asOf: Date): Promise<Quote | null> {
    const source = this.#routeFor(instrument);
    if (source.fetchQuote === undefined) return null;
    return source.fetchQuote(instrument, asOf);
  }
}
