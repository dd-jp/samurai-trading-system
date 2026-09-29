import type { OrderExecutor } from '../../../../contracts/index.js';
import type { AlpacaPaperBrokerOptions } from './alpaca.js';
import { alpacaPaperBroker } from './alpaca.js';
import { DryRunBrokerAdapter } from './dry-run-broker.js';
import { V2OrderExecutor } from './executor.js';
import type { FillPricing } from './simulated-costs.js';

export interface OrderExecutorOptions extends AlpacaPaperBrokerOptions {
  readonly dryRun: boolean;
  readonly pricing: FillPricing;
}

export function createOrderExecutor(options: OrderExecutorOptions): OrderExecutor {
  const { dryRun, pricing } = options;
  return new V2OrderExecutor({
    brokers: dryRun ? {} : { alpaca: alpacaPaperBroker(options) },
    simulatedBrokers: {
      alpaca: new DryRunBrokerAdapter(),
      saxo: new DryRunBrokerAdapter(),
      saxo_cfd_gbp: new DryRunBrokerAdapter(),
      saxo_cfd_usd: new DryRunBrokerAdapter(),
    },
    pricing,
    dryRun,
  });
}
