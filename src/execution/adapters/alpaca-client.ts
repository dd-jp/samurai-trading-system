/**
 * Injected Alpaca trading-API client (ticket #84) — mirrors the injected
 * `AlpacaClient` pattern in src/market-data-service/sources/alpaca-source.ts:
 * connection/auth is an ops concern (execution-spec.md Dependencies — trade-
 * only key, withdrawals disabled, IP-whitelisted); this file only shapes the
 * wire contract the adapter needs.
 *
 * Alpaca's bracket order (`order_class: 'bracket'`) returns the parent
 * (entry) order with its `take_profit`/`stop_loss` legs nested under `legs`.
 * Only the parent order carries the `client_order_id` we set — Alpaca
 * server-generates ids for the child legs — so leg identity is recovered from
 * each leg's own `id` plus its `type` ('limit' = target, 'stop' = stop),
 * not from client_order_id suffixes.
 */

export interface AlpacaOrderLeg {
  id: string;
  /** 'limit' = the take-profit (target) leg; 'stop' = the stop-loss leg. */
  type: 'limit' | 'stop';
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
}

/** Alpaca's order payload, as returned by both submit and get-order. */
export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  order_class: string;
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
  /** Present on the bracket parent: [take_profit_leg, stop_loss_leg]. */
  legs?: AlpacaOrderLeg[];
}

export interface AlpacaBracketOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  /** Entry limit price. */
  limit_price: string;
  time_in_force: string;
  client_order_id: string;
  order_class: 'bracket';
  take_profit: { limit_price: string };
  stop_loss: { stop_price: string };
}

export interface AlpacaClient {
  submitOrder(request: AlpacaBracketOrderRequest): Promise<AlpacaOrder>;
  /** Reconciliation/poll lookup — current broker-side state of a prior order. */
  getOrder(alpacaOrderId: string): Promise<AlpacaOrder>;
}
