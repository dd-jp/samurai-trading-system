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
