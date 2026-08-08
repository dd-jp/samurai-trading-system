/**
 * Per-instrument asset-class routing over two `DataSource`s (#381).
 *
 * ## Why this exists
 *
 * `NormalizingDataSource` fixes `asset_class` and `calendar` at construction,
 * and `AlpacaHttpDataClient` fixes the API path root there too — equities live
 * under `/v2/stocks/...`, crypto under `/v1beta3/crypto/us/...`. One instance
 * therefore serves exactly one asset class, which was fine while the universe
 * was `SMOKE_TEST_UNIVERSE` (BTC-USD alone) and is not fine for
 * `DEFAULT_UNIVERSE` (SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD).
 *
 * Without this, widening the universe is not a config change with a wiring
 * gap behind it — it is
 * [#358](https://github.com/dd-jp/samurai-trading-system/issues/358) again.
 * That was a live outage in which every call went to the wrong endpoint root,
 * 404'd, and turned every tick into a reasonless `quorum_skip`: invisible in
 * fixtures, because a fixture source has no endpoint to get wrong. Four
 * equities pointed at the crypto root would reproduce it exactly, and would
 * look from the logs like four instruments that simply never found a setup.
 *
 * ## Fail loud on an unroutable instrument
 *
 * An instrument absent from the routing table throws rather than falling back
 * to a default class. A default is what makes the #358 failure silent: a
 * mis-typed or newly-added symbol would resolve to *some* source and return a
 * plausible-looking 404-shaped empty result. There is no safe guess about
 * which venue a symbol trades on, so there is no guess.
 *
 * ## Not a `NormalizingDataSource`
 *
 * It implements `DataSource` directly and normalizes nothing itself. Each
 * delegate has already normalized against its own calendar and asset class by
 * the time this returns — which is the whole point, since the calendar is
 * precisely what differs between the two (`AlwaysOpenCalendar` for crypto, the
 * equity session table for stocks). Re-normalizing here would need one
 * calendar for both and would undo that.
 */
import type { AssetClass } from '../../../shared/index.js';
import type { BarWindow, DataSource, Mark, Quote } from '../types.js';

export interface AssetClassRoutingSourceConfig {
  /** One source per asset class. Both are required — this class exists only for mixed universes. */
  sources: Record<AssetClass, DataSource>;
  /**
   * Which asset class each instrument belongs to. Built from the configured
   * universe by the composition root, so the routing table and the tick plan
   * cannot disagree about what is being traded.
   */
  assetClassOf: ReadonlyMap<string, AssetClass>;
}

export class AssetClassRoutingDataSource implements DataSource {
  readonly #sources: Record<AssetClass, DataSource>;
  readonly #assetClassOf: ReadonlyMap<string, AssetClass>;

  constructor(config: AssetClassRoutingSourceConfig) {
    // Both sources, checked at CONSTRUCTION rather than on first use.
    //
    // The type says `Record<AssetClass, DataSource>`, so a TypeScript caller
    // cannot omit one — but the composition root builds this object from a
    // universe at runtime, and the interesting callers are exactly the ones
    // assembling it dynamically. Without this, a missing source surfaces as
    // `undefined.fetchBars(...)` — an opaque `TypeError` thrown mid-tick, from
    // inside a stage, on whichever instrument happened to route there first.
    //
    // That is the same class of defect as a misrouted asset class: a wiring
    // error that reaches an operator as a stage failure rather than as a
    // startup failure, which is how #358 stayed invisible for a whole run. A
    // constructor guard turns it into a boot-time message naming the missing
    // class, matching how `startFromEnvironment` already refuses missing seams.
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

  /**
   * Forwarded only when the routed delegate implements it. `fetchQuote` is
   * optional on the port ("only implemented by sources that quote bid/ask"),
   * and the two classes genuinely differ — so this answers `null` (MDS's
   * documented "no observable spread") rather than throwing, which is what
   * `getSpreadEstimate` already expects from a source that cannot quote.
   */
  async fetchQuote(instrument: string, asOf: Date): Promise<Quote | null> {
    const source = this.#routeFor(instrument);
    if (source.fetchQuote === undefined) return null;
    return source.fetchQuote(instrument, asOf);
  }
}
