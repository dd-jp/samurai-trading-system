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

/**
 * A protective-legs-only pair with no entry (#525) — Alpaca's `order_class:
 * 'oco'`, submitted against a position this process already holds rather
 * than one it is opening. Distinct from `AlpacaBracketOrderRequest`: a
 * bracket's `limit_price` is the ENTRY; here `limit_price` is the
 * take-profit leg (Alpaca's own OCO shape — `type: 'limit'` + `limit_price`
 * for the profit side, `stop_loss.stop_price` for the loss side, no separate
 * entry order at all) closing a residual left by a partially-filled flatten
 * (#525's decision: re-arm on the resize path, never re-derive from the
 * original intent's sizing).
 *
 * `side` is the CLOSING side — mirrors `AlpacaMarketOrderRequest`'s flatten,
 * not `AlpacaBracketOrderRequest`'s opening one, since this order's whole
 * purpose is to reduce a position already held.
 */
export interface AlpacaOcoOrderRequest {
  symbol: string;
  /** The CLOSING side, same convention as the flatten. */
  side: 'buy' | 'sell';
  qty: string;
  /** The take-profit leg's limit price. */
  limit_price: string;
  time_in_force: string;
  client_order_id: string;
  order_class: 'oco';
  stop_loss: { stop_price: string };
}

/**
 * A plain market order (#429) — the flatten. No `order_class`, no legs: a
 * flatten reaches zero and stops, and attaching protective legs to it would
 * leave a resting stop behind after the position was gone.
 */
export interface AlpacaMarketOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  time_in_force: string;
  client_order_id: string;
}

/**
 * One row of `GET /v2/positions` (#429). Alpaca reports decimal STRINGS, kept
 * as strings here for `AlpacaOrder.filled_qty`'s reason: parsing belongs to
 * the consumer, which can decide what an unparseable value means rather than
 * silently receiving a NaN the wire shape claimed was a number.
 */
export interface AlpacaPosition {
  symbol: string;
  /** Signed: negative for a short. */
  qty: string;
  side: 'long' | 'short';
  avg_entry_price: string;
}

export interface AlpacaClient {
  submitOrder(request: AlpacaBracketOrderRequest): Promise<AlpacaOrder>;
  /** The flatten (#429) — a plain market order, no bracket. */
  submitMarketOrder(request: AlpacaMarketOrderRequest): Promise<AlpacaOrder>;
  /** Re-arm on a residual (#525) — protective legs only, no entry. */
  submitOcoOrder(request: AlpacaOcoOrderRequest): Promise<AlpacaOrder>;
  /**
   * `DELETE /v2/orders/{id}` (#429). Resolves rather than throwing when the
   * order is already gone — cancelled, filled, or unknown — because the caller
   * cannot know the venue's state at the instant it calls, and a cancel that
   * throws on "too late" is unusable exactly when it is needed.
   */
  cancelOrder(alpacaOrderId: string): Promise<void>;
  /** `GET /v2/positions` (#429) — everything the venue believes it holds. */
  getPositions(): Promise<AlpacaPosition[]>;
  /** Reconciliation/poll lookup — current broker-side state of a prior order. */
  getOrder(alpacaOrderId: string): Promise<AlpacaOrder>;
  /**
   * Lookup by OUR id rather than Alpaca's (`GET /v2/orders:by_client_order_id`),
   * returning null where Alpaca knows no such order.
   *
   * This is what makes crash-restart reconciliation (#86) possible at all.
   * After a restart the adapter's `client_order_id -> Alpaca order id` map is
   * empty — it is only ever populated by `submitOrder` in this process — so
   * `getOrder` above has no id to look up, and the one identifier that
   * survives a crash is the one we chose ourselves and wrote ahead to the
   * store.
   */
  getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null>;
  /**
   * The account ledger (`GET /v2/account`) — Alpaca's own authoritative view
   * of cash and equity, which `AccountStateProvider` reads rather than
   * reimplementing (transport-layer-spec.md story 23).
   *
   * On the `AlpacaClient` (broker) interface rather than a separate account
   * client because it is the same Trading API, same host, same credentials:
   * a second client would duplicate the auth/retry/error plumbing to reach
   * one more path on the service this one already talks to.
   */
  getAccount(): Promise<AlpacaAccount>;
}

/**
 * The subset of `GET /v2/account` this system reads. Alpaca returns these as
 * decimal STRINGS, and they are kept as strings here for the same reason
 * `AlpacaOrder.filled_qty` is: parsing belongs to the consumer, which can
 * then decide what an unparseable value means rather than silently receiving
 * a `NaN` the wire shape claimed was a number.
 */
export interface AlpacaAccount {
  /** Settled cash. */
  cash: string;
  /** Total account value including open positions — the high-water mark's input. */
  equity: string;
  /**
   * DISPLAY ONLY — the operator dashboard's balance tile, never a sizing input.
   *
   * Optional because nothing in the trading path may depend on it: position
   * size comes from the Risk Manager's own equity model, and letting a broker-
   * reported buying-power figure reach sizing would silently import Alpaca's
   * margin multiplier (2x or 4x on a PDT account) into decisions this system
   * is supposed to make from its own capital base. Marked optional so a client
   * that does not surface it still satisfies the interface, and so its absence
   * on the dashboard degrades to "—" rather than a crash.
   */
  buying_power?: string;
  /**
   * NOT READ, and typed so that reading it cannot compile (#332).
   *
   * Alpaca still sends this on the wire; the parse is a generic cast over
   * `res.json()`, so the field arrives at runtime and is simply ignored. What
   * `?: never` buys is the compile-time half: `never` has no values, so any
   * attempt to use it as the `string` it actually is fails to typecheck, and an
   * object literal supplying it fails too. A bare comment saying "do not
   * reintroduce this" is documentation, not enforcement — the same reasoning
   * that made `DailyPnl` a tagged union rather than `number | null`.
   *
   * Why it must not be read: one blended `last_equity` carries ONE reset
   * boundary for a portfolio that has two, and per #260 that boundary was never
   * verified against a live account. The daily figure is derived locally from
   * `session_equity` snapshots instead (GAP-8, resolved).
   */
  last_equity?: never;
}
