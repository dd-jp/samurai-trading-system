import type { OrderExecutor } from '../../../../contracts/index.js';
import type { AlpacaPaperBrokerOptions } from './alpaca.js';
import { alpacaPaperBroker } from './alpaca.js';
import type { DryRunBrokerDeps } from './dry-run-broker.js';
import { DryRunBrokerAdapter } from './dry-run-broker.js';
import { V2OrderExecutor } from './executor.js';
import type { FillPricing } from './simulated-costs.js';

export interface OrderExecutorOptions extends AlpacaPaperBrokerOptions {
  readonly dryRun: boolean;
  readonly pricing: FillPricing;
  readonly markPrice: DryRunBrokerDeps['markPrice'];
}

export function createOrderExecutor(options: OrderExecutorOptions): OrderExecutor {
  const { dryRun, clock, pricing, markPrice } = options;
  return new V2OrderExecutor({
    brokers: dryRun ? {} : { alpaca: alpacaPaperBroker(options) },
    simulatedBrokers: {
      alpaca: new DryRunBrokerAdapter({ venue: 'alpaca', pricing, markPrice, clock }),
      saxo: new DryRunBrokerAdapter({ venue: 'saxo', pricing, markPrice, clock }),
    },
    pricing,
    dryRun,
  });
}
