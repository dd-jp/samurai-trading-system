/**
 * DataSource factory (ticket #66) — the single place a source name resolves to
 * an implementation.
 *
 * This is what makes "swapping DataSource is a config change, not a code
 * change" true for consumers (#66 AC; spec user story 12). Consumers depend on
 * the `DataSource` port and are handed one of these; they never name a source.
 * Keeping the switch here also keeps the port's doctrine intact — sources are
 * the ONLY place that knows a vendor's specifics.
 *
 * The union carries VENDOR sources only. Composites that take a `DataSource`
 * and return one — `AssetClassRoutingDataSource`, `FailoverDataSource` — are
 * not arms: they resolve no vendor name, so giving them a `kind` would add
 * discriminant surface without adding a resolution this switch performs.
 *
 * Transport clients are injected rather than constructed from credentials
 * here: connection provisioning is an ops/setup task, not this spec's logic
 * (spec Dependencies).
 */
import {
  AlpacaDataSource,
  type AlpacaMarketDataClient,
  type AlpacaSourceOptions,
} from './sources/alpaca-source.js';
import {
  type LseMarkClient,
  LseMarkDataSource,
  type LseMarkSourceOptions,
} from './sources/lse-mark-source.js';
import type { DataSource } from './types.js';

export type DataSourceConfig =
  | ({ kind: 'alpaca'; client: AlpacaMarketDataClient } & AlpacaSourceOptions)
  // #734 — the LSE leveraged-ETP mark source. `client` is the vendor seam and
  // stays injected: which vendor may lawfully serve a live LSE quote is an
  // open owner decision (docs/research/34-lse-mark-source-options.md), so this
  // arm is UNREACHABLE in production until one is provisioned — Refs #895
  // (choose and provision the real-time L1 vendor), Refs #1034 (register for
  // LSEG Delayed Market Data). `buildAlpacaDataSource` reaches it only when a caller
  // supplies `ProductionConfig.lseMarkClient`, and refuses to boot an LSE
  // universe without one rather than substituting another venue's price.
  | ({ kind: 'lse'; client: LseMarkClient } & LseMarkSourceOptions);

export function createDataSource(config: DataSourceConfig): DataSource {
  switch (config.kind) {
    case 'alpaca':
      return new AlpacaDataSource(config.client, config);
    case 'lse':
      return new LseMarkDataSource(config.client, config);
    default: {
      const unreachable: never = config;
      throw new Error(`Unknown data source kind: ${JSON.stringify(unreachable)}`);
    }
  }
}
