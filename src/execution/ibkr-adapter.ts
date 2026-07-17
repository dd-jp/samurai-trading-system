/**
 * IBKR BrokerAdapter — long-term stocks path (ticket #85). See
 * docs/specs/execution-spec.md ("Module: Broker Abstraction"): "IBKR: native
 * bracket order / OCA group."
 *
 * The native counterpart to the ccxt adapter: where that one keeps the
 * atomic-bracket/OCO promise by hand, this one hands the whole bracket to the
 * venue in a single call and lets IBKR's OCA group cancel the sibling. There
 * is deliberately no state machine, no polling and no cancel logic here — the
 * exactly-once sibling cancel is the venue's problem, and duplicating it above
 * the adapter is how you get a double cancel.
 *
 * The TWS client is INJECTED — connection provisioning is an ops/setup task,
 * not this spec's logic, matching the market-data IBKR source (#66).
 * `IbkrBrokerClient` is the narrowest slice this adapter needs (native bracket
 * placement + the account execution feed); the TWS adapter implementing it
 * against the real API is ops wiring, and no behaviour beyond that slice is
 * assumed here.
 */
import type { BrokerAck, BrokerAdapter, NativeBracketRequest, NormalizedFill } from './types.js';

/** A native IBKR bracket: parent entry + two OCA-grouped protective children. */
export interface IbkrBracketRequest {
  clientOrderId: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  totalQuantity: number;
  /** Limit price of the parent entry leg. */
  limitPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  tif: string;
  /** The OCA group tying the children — the venue-side one-cancels-other. */
  ocaGroup: string;
}

/** The venue's ids for the three legs it placed. */
export interface IbkrBracketOrderIds {
  parentOrderId: string;
  stopOrderId: string;
  takeProfitOrderId: string;
}

/** An IBKR execution report (one venue-side fill). */
export interface IbkrExecution {
  execId: string;
  /** The order this execution belongs to — how a fill finds its leg. */
  orderId: string;
  price: number;
  shares: number;
  commission: number;
  /** RFC-3339 execution timestamp. */
  time: string;
}

export interface IbkrBrokerClient {
  placeBracketOrder(request: IbkrBracketRequest): Promise<IbkrBracketOrderIds>;
  fetchExecutions(since: Date): Promise<IbkrExecution[]>;
}

export class IbkrBrokerAdapter implements BrokerAdapter {
  /** Placed brackets by client order id — the venue-side dedup's local half. */
  private readonly brackets = new Map<string, IbkrBracketOrderIds>();
  /** Reverse index: venue order id → which bracket/leg it belongs to. */
  private readonly legs = new Map<string, { clientOrderId: string; leg: NormalizedFill['leg'] }>();

  constructor(private readonly client: IbkrBrokerClient) {}

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    // Broker-native dedup: the second layer behind execute()'s store check.
    // IBKR rejects a repeated client order id independently of this map.
    const existing = this.brackets.get(order.client_order_id);
    if (existing !== undefined) {
      return ack(order.client_order_id, existing);
    }

    const ids = await this.client.placeBracketOrder({
      clientOrderId: order.client_order_id,
      symbol: order.instrument,
      action: order.side === 'buy' ? 'BUY' : 'SELL',
      totalQuantity: order.size,
      limitPrice: order.entry,
      stopPrice: order.stop,
      takeProfitPrice: order.target,
      tif: order.time_in_force,
      // One bracket per lot, so the idempotency key names its OCA group.
      ocaGroup: order.client_order_id,
    });

    this.brackets.set(order.client_order_id, ids);
    this.legs.set(ids.parentOrderId, { clientOrderId: order.client_order_id, leg: 'entry' });
    this.legs.set(ids.stopOrderId, { clientOrderId: order.client_order_id, leg: 'stop' });
    this.legs.set(ids.takeProfitOrderId, { clientOrderId: order.client_order_id, leg: 'target' });

    return ack(order.client_order_id, ids);
  }

  /**
   * The fill feed #83's `ingestFills()` drains — same contract as the ccxt and
   * Simulated adapters', so the lifecycle above is exercised identically
   * whichever venue is wired in. Never returns a fill dated before `since`.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const executions = await this.client.fetchExecutions(since);

    return executions.flatMap((exec) => {
      // The execution feed is account-wide: a manual TWS trade or another
      // session's order appears here too. It belongs to no bracket of ours and
      // has no leg to claim, so it is not this adapter's to normalize.
      const leg = this.legs.get(exec.orderId);
      if (leg === undefined) return [];

      const timestamp = new Date(exec.time);
      // The client filters by `since`; re-asserting it here keeps the
      // point-in-time contract true of the adapter itself.
      if (timestamp.getTime() < since.getTime()) return [];

      return [
        {
          client_order_id: leg.clientOrderId,
          broker_fill_id: exec.execId,
          leg: leg.leg,
          price: exec.price,
          qty: exec.shares,
          fee: exec.commission,
          timestamp,
          // No `cost_breakdown`: a real venue fill has no modeled breakdown.
        },
      ];
    });
  }
}

function ack(clientOrderId: string, ids: IbkrBracketOrderIds): BrokerAck {
  return {
    client_order_id: clientOrderId,
    // Entry + both attached legs exist from the first call — that is what
    // "native bracket" buys over the ccxt emulation.
    broker_order_ids: [ids.parentOrderId, ids.stopOrderId, ids.takeProfitOrderId],
    order_state: 'submitted',
  };
}
