/**
 * Alpaca BrokerAdapter (ticket #84) — see docs/specs/execution-spec.md
 * ("Module: Broker Abstraction"): the MVP paper/live-equities path. Alpaca's
 * native bracket order (`order_class: 'bracket'`) gives the atomic
 * entry + one-cancels-other stop/target guarantee natively, so this adapter
 * does no OCO emulation of its own — unlike the ccxt adapter (#85).
 *
 * The Alpaca trading client is injected (`AlpacaClient`), mirroring the
 * injected-client pattern already used for market data
 * (src/market-data-service/sources/alpaca-source.ts): connection/auth is an
 * ops concern (trade-only key, withdrawals disabled, IP-whitelisted per
 * CONTEXT.md invariant 3), not something this adapter constructs.
 *
 * `fetchNewFills` is not yet part of the `BrokerAdapter` interface (only
 * `submitBracket` is — see types.ts) but is exposed the same way
 * `SimulatedBrokerAdapter` exposes it: #83's `ingestFills()` is the future
 * caller. Alpaca's `getOrder` reports cumulative `filled_qty` /
 * `filled_avg_price` per order, not one event per partial fill, so a leg
 * that fills in two tranches between polls is normalized here as a single
 * fill carrying the cumulative filled quantity as of the poll that first
 * observes it — finer-grained partial-fill history requires Alpaca's trade
 * updates/activities stream, which is out of scope for this ticket.
 */
import type { OrderState } from '../../shared/types.js';
import type { BrokerAck, BrokerAdapter, NativeBracketRequest, NormalizedFill } from '../types.js';
import type { AlpacaClient, AlpacaOrder, AlpacaOrderLeg } from './alpaca-client.js';

export interface AlpacaBrokerAdapterInput {
  client: AlpacaClient;
}

export class AlpacaBrokerAdapter implements BrokerAdapter {
  /** client_order_id -> the bracket parent's Alpaca order id. */
  private readonly brackets = new Map<string, string>();

  constructor(private readonly input: AlpacaBrokerAdapterInput) {}

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    const response = await this.input.client.submitOrder({
      symbol: order.instrument,
      side: order.side,
      qty: String(order.size),
      limit_price: String(order.entry),
      time_in_force: order.time_in_force,
      client_order_id: order.client_order_id,
      order_class: 'bracket',
      take_profit: { limit_price: String(order.target) },
      stop_loss: { stop_price: String(order.stop) },
    });

    this.brackets.set(order.client_order_id, response.id);

    const legIds = (response.legs ?? []).map((leg) => leg.id);

    return {
      client_order_id: order.client_order_id,
      broker_order_ids: [response.id, ...legIds],
      order_state: mapOrderState(response.status),
    };
  }

  /**
   * The fill feed #83's `ingestFills()` will drain, in the same shape
   * `SimulatedBrokerAdapter.fetchNewFills` already produces. Point-in-time:
   * never returns a fill dated before `since`.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const fills: NormalizedFill[] = [];

    for (const [clientOrderId, entryOrderId] of this.brackets) {
      const entry = await this.input.client.getOrder(entryOrderId);

      collectFill(entry, 'entry', clientOrderId, since, fills);
      for (const leg of entry.legs ?? []) {
        collectFill(leg, legName(leg), clientOrderId, since, fills);
      }
    }

    return fills;
  }
}

function legName(leg: AlpacaOrderLeg): 'target' | 'stop' {
  // The take-profit leg is a limit order; the stop-loss leg is a stop order.
  return leg.type === 'limit' ? 'target' : 'stop';
}

function collectFill(
  order: AlpacaOrder | AlpacaOrderLeg,
  leg: NormalizedFill['leg'],
  clientOrderId: string,
  since: Date,
  fills: NormalizedFill[],
): void {
  const filledQty = Number.parseFloat(order.filled_qty);
  if (filledQty <= 0 || order.filled_at === null) {
    return;
  }

  const filledAt = new Date(order.filled_at);
  if (filledAt.getTime() < since.getTime()) {
    return;
  }

  fills.push({
    client_order_id: clientOrderId,
    broker_fill_id: order.id,
    leg,
    price: order.filled_avg_price === null ? 0 : Number.parseFloat(order.filled_avg_price),
    qty: filledQty,
    // Alpaca is commission-free on US equities; crypto fee attribution is
    // deferred (out of scope for this ticket's entry/stop-out equities path).
    fee: 0,
    timestamp: filledAt,
  });
}

function mapOrderState(status: string): OrderState {
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
    // 'new' | 'accepted' | 'pending_new' | 'accepted_for_bidding' and any
    // other acknowledgement status: the bracket has landed at the venue but
    // nothing has filled yet, which is 'submitted' in our state machine.
    default:
      return 'submitted';
  }
}
