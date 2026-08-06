/**
 * The broker seam (#308): what a venue is asked to do and what it reports
 * back, normalised across Alpaca / ccxt / IBKR / Simulated.
 *
 * Split out of the single `execution/types.ts` so that adding a venue does not
 * dirty the file every consumer of `Execution` imports. `types.ts` remains a
 * re-export barrel, so no import site changed.
 */
import type { OrderState } from '../../shared/index.js';

/**
 * The normalized abstract bracket Execution hands the adapter: entry +
 * attached stop + attached target, with one-cancels-other exit semantics
 * guaranteed at this boundary. How that guarantee is met is the adapter's
 * business and invisible above it — native bracket/OCA on Alpaca/IBKR (#84),
 * Execution-managed emulation on ccxt (#85), modelled deterministically by
 * the Simulated adapter.
 */
export interface NativeBracketRequest {
  /**
   * The broker-native idempotency handle: the venue itself rejects a
   * duplicate, which is the second of the two dedup layers (the local store
   * check in `execute()` is the first). Set to the OrderIntent's
   * `idempotency_key`.
   */
  client_order_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  size: number;
  /** Limit/entry price of the entry leg. */
  entry: number;
  stop: number;
  target: number;
  time_in_force: string;
}

/** The adapter's acknowledgement of an accepted bracket. */
export interface BrokerAck {
  client_order_id: string;
  /** Entry + attached legs (or the adapter's emulated ids). */
  broker_order_ids: string[];
  /** State as the venue reports it post-ack — normally 'submitted'. */
  order_state: OrderState;
}

/**
 * A fill normalized out of broker-native shape. #82 produces these in the
 * Simulated adapter but does not consume them: advancing the state machine
 * and persisting `Fill` rows is #83's `ingestFills()`.
 */
export interface NormalizedFill {
  client_order_id: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: Date;
  /**
   * Populated only by the Simulated adapter, mapped from `CostModel.fill`'s
   * `CostModelResult` (cross-spec GAP-F). Real broker fills have no modeled
   * breakdown, so it is absent there.
   */
  cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
}

/**
 * The venue's own account of an order, normalized — reconciliation's unit of
 * truth (#86). Deliberately thinner than `NormalizedFill`: reconcile settles
 * whether the bracket LANDED and in what state, never what it paid. Prices
 * and fees stay `ingestFills()`'s business, reconstructed from `Fill` rows.
 */
export interface NormalizedOrder {
  client_order_id: string;
  /** Entry + attached legs, as the venue reports them now. */
  broker_order_ids: string[];
  order_state: OrderState;
  /** Cumulative filled quantity per the venue. */
  filled_qty: number;
}

/**
 * One position as the VENUE reports it (execution-spec.md's
 * `NormalizedPosition`, #429). Deliberately thin: this is the venue's own
 * account of what it holds, and it carries none of the system's context —
 * no `debate_id`, no bracket, no conviction — because the venue has none of
 * that. A row here that the store does not know about cannot be turned into
 * an `OpenPosition` without inventing all of it.
 */
export interface NormalizedPosition {
  instrument: string;
  /** Signed by direction: a short shows as a negative quantity, as venues report it. */
  qty: number;
  side: 'buy' | 'sell';
  /** Venue's average entry price, or null where the venue does not report one. */
  avg_entry_price: number | null;
}

/**
 * The broker boundary — nothing above it knows which venue, or whether the
 * mode is live, paper or backtest. #83 added the two methods its lifecycle
 * calls, #86 the reconciliation lookup, and #429 the last three the spec has
 * always listed.
 *
 * #429 is why those three stopped being "arrive with the tickets that call
 * them": [ADR-0007](../../docs/adr/0007-fully-automatic-execution.md) removed
 * the human approval gate, so an operator watching a position they dislike had
 * no way to cancel a working order or flatten a lot, and the only remaining
 * stop was a set of circuit breakers three of which could not fire.
 */
export interface BrokerAdapter {
  submitBracket(order: NativeBracketRequest): Promise<BrokerAck>;
  /**
   * The venue's current account of a prior order, or `null` if the venue
   * AUTHORITATIVELY has no such order — which is what lets `reconcile()`
   * settle a write-ahead record whose broker call never landed.
   *
   * The null contract is load-bearing and narrow. An adapter that merely
   * cannot determine the answer MUST throw, never return null: reconcile
   * reads null as "never placed" and marks the lot `rejected`, so an adapter
   * that returns null on ignorance would bury a live position — the exact
   * divergence this surface exists to catch, inverted.
   *
   * `instrument` is passed because a symbol-keyed venue (ccxt) cannot look an
   * order up without it, and after a restart the adapter's in-memory state is
   * gone while the store record — which reconcile reads — still carries it.
   * The spec sketches this as `getOrder(clientOrderId)`; the instrument is a
   * refinement of that shape, in the same way the rest of this file narrows
   * the spec's.
   */
  getOrder(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null>;
  /**
   * The venue's fill feed. Inclusive of `since` and never dated before it,
   * so a backtest cannot see a fill ahead of simulated T. Re-offering an
   * already-returned fill is expected — `ingestFills()` dedups on
   * `broker_fill_id`.
   */
  fetchNewFills(since: Date): Promise<NormalizedFill[]>;
  /**
   * Size the protective legs to the entry's CUMULATIVE filled quantity — an
   * over-sized stop protects phantom quantity, an under-sized one leaves part
   * of the lot naked (execution-spec.md story 13).
   *
   * On this seam because `OpenPosition` carries no leg-quantity field:
   * resizing is a venue-side act, not a persistence one. Adapters whose venue
   * keeps attached legs in step with the entry itself (Alpaca/IBKR native
   * brackets) satisfy it by doing nothing.
   */
  resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void>;
  /**
   * Flattens exposure with a plain market order — the intervention path
   * (#429). `side` is the CLOSING side, so a long is flattened with `sell`.
   *
   * Deliberately not a bracket: a flatten has no stop and no target, and
   * arming protective legs on an order whose whole purpose is to reach zero
   * would leave a resting stop behind after the position was gone.
   *
   * `clientOrderId` is the caller's idempotency key, so a retried flatten is a
   * venue-side no-op rather than a double exit — the property that makes this
   * safe to call from a crash-restart path.
   */
  submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck>;
  /**
   * Cancels a working order and every leg attached to it.
   *
   * Idempotent by contract: cancelling an order that is already cancelled,
   * filled or unknown to the venue resolves rather than throwing. An operator
   * reaching for cancel is already in a bad situation, and a throw on
   * "too late" would make the tool unusable exactly when it is needed —
   * the caller cannot know the venue's state at the instant it calls.
   *
   * `instrument` is passed for `getOrder`'s reason: a symbol-keyed venue
   * (ccxt) cannot address an order without it.
   */
  cancel(clientOrderId: string, instrument: string): Promise<void>;
  /**
   * Everything the venue believes it holds.
   *
   * The other direction of reconciliation, and the one that had no surface:
   * `reconcile()` walks the STORE's open lots and asks the venue about each,
   * which cannot see a position the venue holds and the store never recorded —
   * a write-ahead that died before persisting, or an order placed by hand.
   * Such a lot is invisible to Risk's exposure caps indefinitely
   * (execution-spec.md "Idempotency & Crash-Restart": store shows a position
   * the broker doesn't, *or vice-versa*).
   */
  getOpenPositions(): Promise<NormalizedPosition[]>;
}
