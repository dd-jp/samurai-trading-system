import type { OrderState } from '../../../shared/index.js';
import { toBrokerFillId } from '../../../shared/index.js';
import type { UnpricedFillObservation } from '../broker-state-store.js';
import type { NormalizedFill } from '../types.js';
import type { AlpacaOrder, AlpacaOrderLeg } from './alpaca-client.js';

export class UnpricedFillError extends Error {
  readonly observation: UnpricedFillObservation;

  constructor(message: string, observation: UnpricedFillObservation) {
    super(message);
    this.name = 'UnpricedFillError';
    this.observation = observation;
  }
}

export function resolveFilledAt(order: AlpacaOrder | AlpacaOrderLeg, observedAt: Date): Date {
  const reported = typeof order.filled_at === 'string' ? new Date(order.filled_at) : null;
  return reported !== null && Number.isFinite(reported.getTime()) ? reported : observedAt;
}

export function collectFill(
  order: AlpacaOrder | AlpacaOrderLeg,
  leg: NormalizedFill['leg'],
  clientOrderId: string,
  instrument: string,
  since: Date,
  observedAt: Date,
  fills: NormalizedFill[],
): void {
  const filledQty = Number.parseFloat(order.filled_qty);

  if (!Number.isFinite(filledQty)) {
    throw new Error(
      `Alpaca order ${order.id} (${leg} leg of '${clientOrderId}') reports an unparseable ` +
        `filled_qty '${order.filled_qty}'`,
    );
  }

  if (filledQty <= 0) {
    return;
  }

  const filledAt = resolveFilledAt(order, observedAt);
  if (filledAt.getTime() < since.getTime()) {
    return;
  }

  if (order.filled_avg_price === null) {
    throw new UnpricedFillError(
      `Alpaca order ${order.id} (${leg} leg of '${clientOrderId}') reports filled_qty ` +
        `${order.filled_qty} but no filled_avg_price to record`,
      {
        client_order_id: clientOrderId,
        broker_fill_id: order.id,
        leg,
        instrument,
        qty: filledQty,
      },
    );
  }

  fills.push({
    client_order_id: clientOrderId,
    broker_fill_id: toBrokerFillId(order.id),
    leg,
    price: Number.parseFloat(order.filled_avg_price),
    qty: filledQty,
    fee: 0,
    timestamp: filledAt,
    qty_is_cumulative: true,
  });
}

export function mapOrderState(status: string): OrderState {
  switch (status) {
    case 'filled':
      return 'filled';
    case 'partially_filled':
      return 'partially_filled';
    case 'canceled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    default:
      return 'submitted';
  }
}
