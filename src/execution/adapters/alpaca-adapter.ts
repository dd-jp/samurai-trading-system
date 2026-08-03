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
import type { OrderState, RateLimiter } from '../../shared/index.js';
import { rateLimited } from '../../shared/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
} from '../types.js';
import type { AlpacaClient, AlpacaOrder, AlpacaOrderLeg } from './alpaca-client.js';

export interface AlpacaBrokerAdapterInput {
  client: AlpacaClient;
  /**
   * Paces every Alpaca call (execution-spec.md story 16 — Alpaca throttles at
   * 200 req/min and a mid-position throttle means no stops/cancels). Omitted
   * = unpaced, for tests; the production composition root passes a
   * `TokenBucket` sized to the venue.
   */
  rateLimiter?: RateLimiter;
}

export class AlpacaBrokerAdapter implements BrokerAdapter {
  /** client_order_id -> the bracket parent's Alpaca order id. */
  private readonly brackets = new Map<string, string>();
  private readonly client: AlpacaClient;

  constructor(input: AlpacaBrokerAdapterInput) {
    this.client =
      input.rateLimiter === undefined ? input.client : rateLimited(input.client, input.rateLimiter);
  }

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    const response = await this.client.submitOrder({
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
   * The reconciliation lookup (#86), by OUR client order id — deliberately
   * NOT via the `brackets` map. That map is populated only by `submitBracket`
   * in this process, so after the crash-restart this method exists to serve
   * it is empty; answering from it would report every live order as absent
   * and let `reconcile()` mark real positions `rejected`. The venue is asked
   * directly instead.
   *
   * A null here is therefore Alpaca's own answer, not this adapter's
   * ignorance, which is what the `BrokerAdapter.getOrder` contract requires
   * before reconcile may treat it as "never placed". A transport failure
   * throws out of the client and is left to propagate, exactly as that
   * contract wants.
   */
  async getOrder(clientOrderId: string): Promise<NormalizedOrder | null> {
    const order = await this.client.getOrderByClientOrderId(clientOrderId);
    if (order === null) return null;

    // Re-populating the map lets a post-restart `fetchNewFills` find this
    // bracket again — the reconciliation sweep is the only thing that knows
    // these orders still exist.
    this.brackets.set(clientOrderId, order.id);

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [order.id, ...(order.legs ?? []).map((leg) => leg.id)],
      order_state: mapOrderState(order.status),
      filled_qty: Number.parseFloat(order.filled_qty),
    };
  }

  /**
   * A no-op: Alpaca's native bracket attaches the protective legs to the
   * parent entry, so the venue keeps their quantity in step as the parent
   * fills. Re-sizing from here would fight the venue over leg quantity — the
   * same reason this adapter does no OCO emulation of its own. The seam is
   * still honoured; a native bracket meets it by having already met it.
   */
  async resizeProtectiveLegs(): Promise<void> {
    // Intentionally empty — see above.
  }

  /**
   * The fill feed `ingestFills()` drains, in the same shape
   * `SimulatedBrokerAdapter.fetchNewFills` already produces. Point-in-time:
   * never returns a fill dated before `since`.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const fills: NormalizedFill[] = [];

    // Snapshot, as in CcxtBrokerAdapter.syncBrackets: `getOrder` awaits inside
    // this loop, and a Map iterator visits entries inserted mid-iteration — so
    // a bracket submitted during the poll would be drained by a pass whose
    // `since` window predates it. The snapshot keeps each poll's worklist
    // fixed at entry (PR #290 review, deepseek).
    for (const [clientOrderId, entryOrderId] of [...this.brackets]) {
      const entry = await this.client.getOrder(entryOrderId);

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
  // `filled_avg_price === null` alongside a positive filled_qty is an Alpaca
  // data race/edge — recording it as price 0 would drag the lot's weighted
  // avg toward zero and feed phantom PnL to the Feedback Loop. Skipping is
  // safe: the feed is poll-based and inclusive-of-`since`, so the fill is
  // re-offered on the next poll, priced. A *permanently* unpriced fill would
  // instead leave the lot stuck with nothing escalating — recovery belongs to
  // reconciliation, not to this adapter inventing a price: see #298.
  if (filledQty <= 0 || order.filled_at === null || order.filled_avg_price === null) {
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
    price: Number.parseFloat(order.filled_avg_price),
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
