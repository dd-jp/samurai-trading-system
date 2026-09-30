import type {
  AlpacaBrokerClient,
  OcoDoubleFillAlertChannel,
  UnpricedFillAlertChannel,
} from '../../../pipeline/execution/index.js';
import {
  AlpacaBrokerAdapter,
  AlpacaHttpBrokerClient,
  SqliteBrokerStateStore,
} from '../../../pipeline/execution/index.js';
import type { BrokerAdapter, Clock, Logger } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';

export interface AlpacaPaperBrokerOptions {
  readonly client?: AlpacaBrokerClient | undefined;
  readonly db: StoreHandle;
  readonly clock: Clock;
  readonly logger: Logger;
}

type UnpricedFillAlert = Parameters<UnpricedFillAlertChannel['postUnpricedFillAlert']>[0];
type OcoDoubleFillAlert = Parameters<OcoDoubleFillAlertChannel['postOcoDoubleFillAlert']>[0];

export function unpricedFillMessage(alert: UnpricedFillAlert): string {
  const minutes = Math.round(alert.unpriced_for_ms / 60_000);
  return `${alert.instrument} ${alert.leg} fill ${alert.broker_fill_id} (order ${alert.client_order_id}, qty ${alert.qty}) unpriced for ${minutes} min`;
}

export function ocoDoubleFillMessage(alert: OcoDoubleFillAlert): string {
  return `${alert.instrument}: stop ${alert.stop_order_id} and target ${alert.target_order_id} both filled (order ${alert.client_order_id})`;
}

function logAlert(logger: Logger, event: string, message: string, alert: unknown): void {
  logger.log({ trace_id: 'v2-root', stage: 'v2', level: 'error', event, message, payload: alert });
}

export function alpacaPaperBroker(options: AlpacaPaperBrokerOptions): BrokerAdapter {
  const { logger } = options;
  return new AlpacaBrokerAdapter({
    client: options.client ?? new AlpacaHttpBrokerClient({ environment: 'paper' }),
    state: new SqliteBrokerStateStore(options.db),
    unpricedFillAlerts: {
      postUnpricedFillAlert: (alert) =>
        Promise.resolve(logAlert(logger, 'v2_unpriced_fill', unpricedFillMessage(alert), alert)),
    },
    ocoDoubleFillAlerts: {
      postOcoDoubleFillAlert: (alert) =>
        Promise.resolve(logAlert(logger, 'v2_oco_double_fill', ocoDoubleFillMessage(alert), alert)),
    },
    clock: options.clock,
    logger,
  });
}
