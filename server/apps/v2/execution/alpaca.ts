import type { BrokerMode } from '../../../../contracts/index.js';
import type { BrokerAdapter, Clock, Logger } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { AlpacaBrokerAdapter } from './alpaca/alpaca-adapter.js';
import type { AlpacaBrokerClient } from './alpaca/alpaca-client.js';
import { AlpacaHttpBrokerClient } from './alpaca/alpaca-http-client.js';
import type { UnpricedFillAlertChannel } from './alpaca/unpriced-fill-alert.js';
import { SqliteBrokerStateStore } from './broker-state/sqlite-broker-state-store.js';

export interface AlpacaBrokerOptions {
  readonly client?: AlpacaBrokerClient | undefined;
  readonly brokerMode?: BrokerMode | undefined;
  readonly db: StoreHandle;
  readonly clock: Clock;
  readonly logger: Logger;
}

type UnpricedFillAlert = Parameters<UnpricedFillAlertChannel['postUnpricedFillAlert']>[0];

export function unpricedFillMessage(alert: UnpricedFillAlert): string {
  const minutes = Math.round(alert.unpriced_for_ms / 60_000);
  return `${alert.instrument} ${alert.leg} fill ${alert.broker_fill_id} (order ${alert.client_order_id}, qty ${alert.qty}) unpriced for ${minutes} min`;
}

function logAlert(logger: Logger, event: string, message: string, alert: unknown): void {
  logger.log({ trace_id: 'v2-root', stage: 'v2', level: 'error', event, message, payload: alert });
}

export function alpacaBroker(options: AlpacaBrokerOptions): BrokerAdapter {
  const { logger } = options;
  return new AlpacaBrokerAdapter({
    client:
      options.client ?? new AlpacaHttpBrokerClient({ environment: options.brokerMode ?? 'paper' }),
    state: new SqliteBrokerStateStore(options.db),
    unpricedFillAlerts: {
      postUnpricedFillAlert: (alert) =>
        Promise.resolve(logAlert(logger, 'v2_unpriced_fill', unpricedFillMessage(alert), alert)),
    },
    clock: options.clock,
    logger,
  });
}
