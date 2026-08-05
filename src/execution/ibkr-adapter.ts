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
 * placement, the account execution feed, and since #287/#294 an order-status
 * query); the TWS adapter implementing it against the real API is ops wiring,
 * and no behaviour beyond that slice is assumed here.
 *
 * #287/#295 made the leg index durable. The `legs` reverse index is how an
 * account-wide execution report finds its bracket, and it used to live only in
 * this process — so after a restart every execution IBKR reported was silently
 * dropped as "not ours", and the lot's fills were lost.
 */
import { DEFAULT_VENUE_PACING, type OrderState, TokenBucket } from '../shared/index.js';
import { sanitizeBrokerError } from './broker-error.js';
import {
  type BrokerStateStore,
  InMemoryBrokerStateStore,
  toRequestFields,
} from './broker-state-store.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
} from './types.js';

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

/**
 * TWS's account of a bracket previously placed under one of our client order
 * ids (#294). The order-status surface `getOrder` needs and #85 left out.
 */
export interface IbkrOrderStatus {
  /** Echoed back so a caller can be sure which order answered. */
  clientOrderId: string;
  /** The parent entry leg — the order whose state `getOrder` reports. */
  parentOrderId: string;
  /**
   * The OCA children as TWS still knows them. Null where the venue reports no
   * such child (a bracket whose children were cancelled or never accepted) —
   * the adapter records what the venue says rather than assuming three legs.
   */
  stopOrderId: string | null;
  takeProfitOrderId: string | null;
  /**
   * TWS's `orderStatus` string for the PARENT leg, verbatim
   * (`'Submitted'`, `'Filled'`, `'Cancelled'`, `'Inactive'`, …). Kept as a
   * bare string, like the Alpaca slice's, so a TWS version that adds a status
   * does not need this interface changed to be reported honestly.
   */
  status: string;
  /** Cumulative filled quantity of the parent leg. */
  filledQuantity: number;
}

export interface IbkrBrokerClient {
  placeBracketOrder(request: IbkrBracketRequest): Promise<IbkrBracketOrderIds>;
  fetchExecutions(since: Date): Promise<IbkrExecution[]>;
  /**
   * TWS's account of `clientOrderId`, or `null` if the venue AUTHORITATIVELY
   * has no such order (#294).
   *
   * The null contract is the narrow one `BrokerAdapter.getOrder` defines:
   * `reconcile()` reads null as "the write-ahead never landed" and marks the
   * lot `rejected`, so an implementation that merely cannot reach TWS MUST
   * throw. Concretely that means an implementation may return null only after
   * a successful scan that found nothing — a connection error, a timeout or a
   * partial response has to propagate.
   *
   * Implementing it against the real API is ops wiring and out of scope here,
   * exactly as `placeBracketOrder` is: TWS has no single "get order by client
   * id" call, so a concrete client is expected to scan `reqOpenOrders` plus
   * `reqCompletedOrders` and match on the order ref it set at placement.
   */
  fetchOrderStatus(clientOrderId: string): Promise<IbkrOrderStatus | null>;
}

/**
 * What this adapter records for a bracket, as distinct from what
 * `placeBracketOrder` RETURNS. A fresh placement always yields all three ids,
 * which is why `IbkrBracketOrderIds` requires them; a bracket learned from
 * `fetchOrderStatus` or rebuilt from the journal may have children the venue
 * no longer reports. Modelling that as `null` rather than `''` keeps "the venue
 * has no such child" from being spelled the same way as a real id — the same
 * reason the Alpaca adapter's `legOrderIds` refuses the empty-string sentinel.
 */
interface TrackedBracketLegs {
  parentOrderId: string;
  stopOrderId: string | null;
  takeProfitOrderId: string | null;
}

export class IbkrBrokerAdapter implements BrokerAdapter {
  /** Placed brackets by client order id — the venue-side dedup's local half. */
  private readonly brackets = new Map<string, TrackedBracketLegs>();
  /** Reverse index: venue order id → which bracket/leg it belongs to. */
  private readonly legs = new Map<string, { clientOrderId: string; leg: NormalizedFill['leg'] }>();

  private readonly rateLimiter: TokenBucket;
  private readonly state: BrokerStateStore;

  /**
   * Optional so existing wiring keeps working, but the default is deliberately
   * not "unlimited" — an unpaced adapter is the C2 finding. TWS pacing
   * violations are answered with a DISCONNECT, which for this adapter means
   * the venue holding a live bracket stops taking calls.
   *
   * #299 moved the NUMBER out of this file into `DEFAULT_VENUE_PACING.ibkr`
   * (shared/http/venue-pacing.ts), overridable per deployment via
   * `SAMURAI_PACING_IBKR_*`. That module cites IBKR's documented 50 msg/s
   * ceiling — which `resolveVenuePacing` now enforces as an upper bound on any
   * override — and is explicit that the 5/s we actually run at is a
   * conservative 10% of it, untuned against a real TWS gateway (whose pacing
   * varies by account, connection and request kind) rather than a figure IBKR
   * publishes.
   *
   * `state` is optional for the same compatibility reason, but the two
   * defaults are not equivalent: the rate-limit default is merely
   * conservative, whereas the in-memory state default IS the #287/#295 bug.
   * Any wiring that means to survive a restart must inject
   * `SqliteBrokerStateStore`.
   */
  constructor(
    private readonly client: IbkrBrokerClient,
    rateLimiter: TokenBucket = new TokenBucket(DEFAULT_VENUE_PACING.ibkr),
    state: BrokerStateStore = new InMemoryBrokerStateStore(),
  ) {
    this.rateLimiter = rateLimiter;
    this.state = state;
    this.rehydrate();
  }

  /**
   * Rebuild both indexes from the durable journal (#287). Synchronous and in
   * the constructor: the first `fetchExecutions` sweep after a restart must
   * already be able to claim its own executions, or they are dropped as
   * another account's and never offered again.
   */
  private rehydrate(): void {
    for (const record of this.state.loadBrackets('ibkr')) {
      if (record.entry_order_id === null) continue;

      this.track(record.client_order_id, {
        parentOrderId: record.entry_order_id,
        stopOrderId: record.stop_order_id,
        takeProfitOrderId: record.target_order_id,
      });
    }
  }

  /** Both indexes, always written together — they must never disagree. */
  private track(clientOrderId: string, ids: TrackedBracketLegs): void {
    this.brackets.set(clientOrderId, ids);
    this.legs.set(ids.parentOrderId, { clientOrderId, leg: 'entry' });
    if (ids.stopOrderId !== null) {
      this.legs.set(ids.stopOrderId, { clientOrderId, leg: 'stop' });
    }
    if (ids.takeProfitOrderId !== null) {
      this.legs.set(ids.takeProfitOrderId, { clientOrderId, leg: 'target' });
    }
  }

  /**
   * The single door to the injected client: pacing before the call (C2),
   * credential-safe error conversion after it (H1). A TWS client's errors
   * carry connection and request context, and `execute()` copies a thrown
   * message into a logged `ExecutionResult.reason`.
   */
  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    await this.rateLimiter.acquire();
    try {
      return await fn();
    } catch (cause) {
      throw sanitizeBrokerError('ibkr', operation, cause);
    }
  }

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    // Broker-native dedup: the second layer behind execute()'s store check.
    // Rehydrated on construction since #287, so it survives a restart rather
    // than waving a second bracket through against a live lot. IBKR rejects a
    // repeated client order id independently of this map.
    const existing = this.brackets.get(order.client_order_id);
    if (existing !== undefined) {
      return ack(order.client_order_id, existing);
    }

    const ids = await this.call('submitBracket', () =>
      this.client.placeBracketOrder({
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
      }),
    );

    this.track(order.client_order_id, ids);
    // `phase: 'armed'` because on a native-bracket venue there is no local
    // state machine to be partway through — the OCA group is live from this
    // call, which is exactly what "armed" means everywhere else in this store.
    this.state.saveBracket({
      venue: 'ibkr',
      client_order_id: order.client_order_id,
      phase: 'armed',
      entry_order_id: ids.parentOrderId,
      stop_order_id: ids.stopOrderId,
      target_order_id: ids.takeProfitOrderId,
      request: toRequestFields(order),
      armed_qty: null,
      arming_qty: null,
      arm_attempt: 0,
    });

    return ack(order.client_order_id, ids);
  }

  /**
   * The reconciliation lookup (#86), served against the client slice's
   * order-status query (#294).
   *
   * This used to throw unconditionally, which meant every IBKR lot came out of
   * `reconcile()` as `undetermined` — execution-spec.md stories 8–11 could
   * never settle a single IBKR position without a manual-recovery event, and
   * the long-term stocks path of ADR-0001 was blocked on it.
   *
   * The venue is asked DIRECTLY, by our client order id, rather than answered
   * from `brackets`: the map is this adapter's own bookkeeping, and even
   * rehydrated it is a record of what we placed, not of what IBKR did with it.
   * A null here is therefore TWS's own answer — which is what the
   * `BrokerAdapter.getOrder` contract requires before reconcile may treat it
   * as "never placed" — and a transport failure throws out of `call()` and is
   * left to propagate, which reconcile records as `undetermined`.
   */
  async getOrder(clientOrderId: string): Promise<NormalizedOrder | null> {
    const status = await this.call('getOrder', () => this.client.fetchOrderStatus(clientOrderId));
    if (status === null) return null;

    // Re-populating both indexes (and the journal) lets a post-restart
    // `fetchNewFills` claim this bracket's executions even if it was placed by
    // a process whose journal row predates this one — the reconciliation sweep
    // is the only thing that knows these orders still exist.
    this.track(clientOrderId, {
      parentOrderId: status.parentOrderId,
      stopOrderId: status.stopOrderId,
      takeProfitOrderId: status.takeProfitOrderId,
    });
    this.state.recordBracketOrderIds('ibkr', clientOrderId, {
      entry_order_id: status.parentOrderId,
      stop_order_id: status.stopOrderId,
      target_order_id: status.takeProfitOrderId,
    });

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [status.parentOrderId, status.stopOrderId, status.takeProfitOrderId].filter(
        (id): id is string => id !== null,
      ),
      order_state: mapOrderState(status.status, status.filledQuantity),
      filled_qty: status.filledQuantity,
    };
  }

  /**
   * A no-op, and deliberately so: the protective children are attached to the
   * parent entry, so IBKR itself keeps their quantity in step as the parent
   * fills. Re-sizing them from here would be this adapter growing exactly the
   * duplicate-the-venue state machine the file header refuses — and racing
   * TWS over leg quantity is how a lot ends up unprotected.
   *
   * The seam is still honoured: `ingestFills()` states the requirement and
   * each venue meets it however it can, which for a native bracket is by
   * having already met it.
   */
  async resizeProtectiveLegs(): Promise<void> {
    // Intentionally empty — see above.
  }

  /**
   * The fill feed `ingestFills()` drains — same contract as the ccxt and
   * Simulated adapters', so the lifecycle above is exercised identically
   * whichever venue is wired in. Never returns a fill dated before `since`.
   *
   * Fills are DERIVED from the venue on every call rather than journalled, so
   * this adapter needs no observed-fill table of its own: a durable `legs`
   * index is enough to make the whole feed whole again after a restart (#295).
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const executions = await this.call('fetchNewFills', () => this.client.fetchExecutions(since));

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

function ack(clientOrderId: string, ids: TrackedBracketLegs): BrokerAck {
  return {
    client_order_id: clientOrderId,
    // Entry + both attached legs exist from the first call — that is what
    // "native bracket" buys over the ccxt emulation. The filter only bites on
    // the dedup path, where `ids` came from the journal or a venue lookup and
    // a child the venue no longer reports is genuinely absent.
    broker_order_ids: [ids.parentOrderId, ids.stopOrderId, ids.takeProfitOrderId].filter(
      (id): id is string => id !== null,
    ),
    order_state: 'submitted',
  };
}

/**
 * TWS `orderStatus` → our `OrderState`, for the reconciliation lookup.
 *
 * `'Inactive'` is the one that needs an argument. IBKR uses it both for an
 * order the system rejected AND for one that is merely not working right now
 * (outside market hours, an attribute the venue will not accept yet), and the
 * status alone does not say which. It maps to `submitted`, NOT `rejected`,
 * because the two mistakes are not symmetric: calling a live pending order
 * `rejected` has `reconcile()` write the lot off while it can still fill,
 * leaving a real position nobody is watching — whereas calling a dead order
 * `submitted` merely leaves the store where it already was, changing nothing
 * and diverging on the next sweep. Between burying a live position and
 * deferring a dead one, defer.
 *
 * Never `closed`: that is our round-trip-to-flat accounting concept derived
 * from `Fill` rows, not a state a venue reports.
 */
function mapOrderState(status: string, filledQuantity: number): OrderState {
  switch (status) {
    case 'Filled':
      return 'filled';
    case 'Cancelled':
    case 'ApiCancelled':
      return 'cancelled';
    // 'PendingSubmit' | 'PreSubmitted' | 'Submitted' | 'PendingCancel' |
    // 'ApiPending' | 'Inactive' and anything a future TWS adds: the venue has
    // the order and has not finished it. Whether anything has filled is what
    // separates an acknowledged order from a partially filled one.
    default:
      return filledQuantity > 0 ? 'partially_filled' : 'submitted';
  }
}
