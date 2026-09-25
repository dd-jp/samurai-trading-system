import type { OrderExecutor } from '../../../../contracts/index.js';
import type { AlpacaPaperBrokerOptions } from './alpaca.js';
import { alpacaPaperBroker } from './alpaca.js';
import type { DryRunBrokerDeps } from './dry-run-broker.js';
import { DryRunBrokerAdapter } from './dry-run-broker.js';
import { V2OrderExecutor } from './executor.js';

export interface OrderExecutorOptions extends AlpacaPaperBrokerOptions {
  readonly dryRun: boolean;
  readonly halfSpreadBps: DryRunBrokerDeps['halfSpreadBps'];
  readonly markPrice: DryRunBrokerDeps['markPrice'];
}

export function createOrderExecutor(options: OrderExecutorOptions): OrderExecutor {
  const { dryRun, clock } = options;
  return new V2OrderExecutor({
    brokers: dryRun ? {} : { alpaca: alpacaPaperBroker(options) },
    simulatedBroker: new DryRunBrokerAdapter({
      halfSpreadBps: options.halfSpreadBps,
      markPrice: options.markPrice,
      clock,
    }),
    dryRun,
  });
}
