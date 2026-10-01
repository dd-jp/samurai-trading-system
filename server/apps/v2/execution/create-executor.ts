import type { BrokerBookReader, OrderExecutor } from '../../../../contracts/index.js';
import { AlpacaHttpBrokerClient } from '../../../pipeline/execution/index.js';
import type { BrokerAdapter } from '../../../shared/index.js';
import type { AlpacaPaperBrokerOptions } from './alpaca.js';
import { alpacaPaperBroker } from './alpaca.js';
import { AlpacaBrokerBooks, NO_BROKER_BOOKS } from './broker-books.js';
import { DryRunBrokerAdapter } from './dry-run-broker.js';
import { V2OrderExecutor } from './executor.js';
import type { FillPricing } from './simulated-costs.js';

export interface OrderExecutorOptions extends AlpacaPaperBrokerOptions {
  readonly dryRun: boolean;
  readonly pricing: FillPricing;
}

export interface BrokerAccess {
  readonly executor: OrderExecutor;
  readonly brokerBooks: BrokerBookReader;
}

export interface BrokerAccessParts {
  readonly dryRun: boolean;
  readonly pricing: FillPricing;
  readonly alpaca: BrokerAdapter | undefined;
  readonly brokerBooks: BrokerBookReader;
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
  return { executor, brokerBooks: parts.brokerBooks };
}

export function createBrokerAccess(options: OrderExecutorOptions): BrokerAccess {
  const { dryRun, pricing } = options;
  const client = dryRun
    ? undefined
    : (options.client ?? new AlpacaHttpBrokerClient({ environment: 'paper' }));
  return brokerAccessFor({
    dryRun,
    pricing,
    alpaca: client === undefined ? undefined : alpacaPaperBroker({ ...options, client }),
    brokerBooks: client === undefined ? NO_BROKER_BOOKS : new AlpacaBrokerBooks(client),
  });
}
