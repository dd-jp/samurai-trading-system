import type { AlpacaBrokerClient, BrokerAdapter } from '../../../pipeline/execution/index.js';
import {
  AlpacaBrokerAdapter,
  AlpacaHttpBrokerClient,
  SqliteBrokerStateStore,
} from '../../../pipeline/execution/index.js';
import type { Clock, Logger } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';

export interface AlpacaPaperBrokerOptions {
  readonly client?: AlpacaBrokerClient | undefined;
  readonly db: StoreHandle;
  readonly clock: Clock;
  readonly logger: Logger;
}

function logAlert(logger: Logger, event: string, alert: unknown): void {
  logger.log({
    trace_id: 'v2-root',
    stage: 'v2',
    level: 'error',
    event,
    message: event,
    payload: alert,
  });
}

export function alpacaPaperBroker(options: AlpacaPaperBrokerOptions): BrokerAdapter {
  const { logger } = options;
  return new AlpacaBrokerAdapter({
    client: options.client ?? new AlpacaHttpBrokerClient({ environment: 'paper' }),
    state: new SqliteBrokerStateStore(options.db),
    unpricedFillAlerts: {
      postUnpricedFillAlert: (alert) =>
        Promise.resolve(logAlert(logger, 'v2_unpriced_fill', alert)),
    },
    ocoDoubleFillAlerts: {
      postOcoDoubleFillAlert: (alert) =>
        Promise.resolve(logAlert(logger, 'v2_oco_double_fill', alert)),
    },
    clock: options.clock,
    logger,
  });
}
