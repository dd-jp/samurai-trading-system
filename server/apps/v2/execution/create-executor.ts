import type {
  BrokerBookReader,
  BrokerCashInLieuReader,
  OrderExecutor,
} from '../../../../contracts/index.js';
import type { BrokerAdapter } from '../../../shared/index.js';
import { alpacaCashInLieuReader } from './alpaca/alpaca-cash-in-lieu.js';
import { AlpacaHttpBrokerClient } from './alpaca/alpaca-http-client.js';
import type { AlpacaBrokerOptions } from './alpaca.js';
import { alpacaBroker } from './alpaca.js';
import { AlpacaBrokerBooks, NO_BROKER_BOOKS } from './broker-books.js';
import { DryRunBrokerAdapter } from './dry-run-broker.js';
import { V2OrderExecutor } from './executor.js';
import type { FillPricing } from './simulated-costs.js';

export interface OrderExecutorOptions extends AlpacaBrokerOptions {
  readonly dryRun: boolean;
  readonly pricing: FillPricing;
}

export interface BrokerAccess {
  readonly executor: OrderExecutor;
  readonly brokerBooks: BrokerBookReader;
  readonly cashInLieu?: BrokerCashInLieuReader | undefined;
}

export interface BrokerAccessParts {
  readonly dryRun: boolean;
  readonly pricing: FillPricing;
  readonly alpaca: BrokerAdapter | undefined;
  readonly brokerBooks: BrokerBookReader;
  readonly cashInLieu?: BrokerCashInLieuReader | undefined;
}

export function brokerAccessFor(parts: BrokerAccessParts): BrokerAccess {
  const executor = new V2OrderExecutor({
    brokers: parts.alpaca === undefined ? {} : { alpaca: parts.alpaca },
    simulatedBrokers: {
      alpaca: new DryRunBrokerAdapter(),
      saxo: new DryRunBrokerAdapter(),
      saxo_cfd_gbp: new DryRunBrokerAdapter(),
      saxo_cfd_usd: new DryRunBrokerAdapter(),
    },
    pricing: parts.pricing,
    dryRun: parts.dryRun,
  });
  return { executor, brokerBooks: parts.brokerBooks, cashInLieu: parts.cashInLieu };
}

export function createBrokerAccess(options: OrderExecutorOptions): BrokerAccess {
  const { dryRun, pricing } = options;
  const client = dryRun
    ? undefined
    : (options.client ??
      new AlpacaHttpBrokerClient({ environment: options.brokerMode ?? 'paper' }));
  return brokerAccessFor({
    dryRun,
    pricing,
    alpaca: client === undefined ? undefined : alpacaBroker({ ...options, client }),
    brokerBooks: client === undefined ? NO_BROKER_BOOKS : new AlpacaBrokerBooks(client),
    cashInLieu: alpacaCashInLieuReader(client),
  });
}
