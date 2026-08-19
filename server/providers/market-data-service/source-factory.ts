/**
 * DataSource factory (ticket #66) — the single place a source name resolves to
 * an implementation.
 *
 * This is what makes "swapping DataSource is a config change, not a code
 * change" true for consumers (#66 AC; spec user story 12: Kraken->Coinbase, or
 * Alpaca->ccxt/IBKR long-term, is config). Consumers depend on the `DataSource`
 * port and are handed one of these; they never name a source. Keeping the
 * switch here also keeps the port's doctrine intact — sources are the ONLY
 * place that knows ccxt/IBKR/Alpaca specifics.
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
import { type CcxtClient, CcxtDataSource, type CcxtSourceOptions } from './sources/ccxt-source.js';
import { type IbkrClient, IbkrDataSource, type IbkrSourceOptions } from './sources/ibkr-source.js';
import {
  type LseMarkClient,
  LseMarkDataSource,
  type LseMarkSourceOptions,
} from './sources/lse-mark-source.js';
import type { DataSource } from './types.js';

export type DataSourceConfig =
  | ({ kind: 'ccxt'; client: CcxtClient } & CcxtSourceOptions)
  | ({ kind: 'alpaca'; client: AlpacaMarketDataClient } & AlpacaSourceOptions)
  | ({ kind: 'ibkr'; client: IbkrClient } & IbkrSourceOptions)
  // #734 — the LSE leveraged-ETP mark source. `client` is the vendor seam and
  // stays injected for the same reason the other three are: which vendor may
  // lawfully serve a live LSE quote is an open owner decision
  // (docs/research/34-lse-mark-source-options.md), and keeping it here means
  // answering it is a config change rather than a rewrite.
  | ({ kind: 'lse'; client: LseMarkClient } & LseMarkSourceOptions);

export function createDataSource(config: DataSourceConfig): DataSource {
  switch (config.kind) {
    case 'ccxt':
      return new CcxtDataSource(config.client, config);
    case 'alpaca':
      return new AlpacaDataSource(config.client, config);
    case 'ibkr':
      return new IbkrDataSource(config.client, config);
    case 'lse':
      return new LseMarkDataSource(config.client, config);
    default: {
      const unreachable: never = config;
      throw new Error(`Unknown data source kind: ${JSON.stringify(unreachable)}`);
    }
  }
}
