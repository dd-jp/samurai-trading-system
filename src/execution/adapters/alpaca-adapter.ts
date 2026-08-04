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
 *
 * #287/#295 made the bracket index durable. Alpaca is the one venue where
 * that index is a CACHE rather than the truth — `getOrder` asks the venue
 * directly and the native bracket is the state machine — but the cache is
 * still load-bearing for `fetchNewFills`, which polls only what is in it. See
 * `state` on the input below for why the cache had to be persisted anyway.
 */
import { type OrderState, TokenBucket } from '../../shared/index.js';
import { sanitizeBrokerError } from '../broker-error.js';
import {
  type BrokerStateStore,
  InMemoryBrokerStateStore,
  toRequestFields,
} from '../broker-state-store.js';
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
   * Optional so existing wiring (src/orchestrator/production.ts) keeps
   * working; when absent the adapter still paces itself rather than running
   * unlimited — see the default below.
   */
  rateLimiter?: TokenBucket;
  /**
   * Durable home for the bracket index (#287). Optional for the same
   * compatibility reason as `rateLimiter`, but the two defaults are not
   * equivalent: that one is merely conservative, whereas the in-memory default
   * here IS the #295 bug. src/orchestrator/production.ts injects
   * `SqliteBrokerStateStore`.
   *
   * Alpaca's index is a cache of a venue-authoritative lookup, so persisting
   * it is a WARM-UP rather than a source of truth — unlike ccxt, where the
   * persisted phase IS the truth. It is persisted anyway because the warm-up
   * is what `fetchNewFills` iterates: `getOrder` repopulates the cache, but
   * `reconcile()` only calls `getOrder` for lots that are still in-flight
   * (`pending`/`submitted`), so a `partially_filled` lot whose exit legs have
   * not filled yet is never re-cached and its fills are never polled again.
   *
   * The alternative considered and rejected: derive `fetchNewFills`' worklist
   * from `open_positions`, which already carries `idempotency_key` and
   * `broker_order_ids` and is arguably the more correct source. It would give
   * this adapter a dependency on the `SharedStore` seam it currently has no
   * business knowing about, and it changes MVP-path behaviour on a ticket
   * whose own priority note says the Alpaca path is not the one it is fixing.
   */
  state?: BrokerStateStore;
}

export class AlpacaBrokerAdapter implements BrokerAdapter {
  /** client_order_id -> the bracket parent's Alpaca order id. */
  private readonly brackets = new Map<string, string>();
  /**
   * Alpaca's documented ceiling is 200 requests/minute per key — 3.33/second —
   * so the sustained rate is set BELOW it at 3/second, with a burst of 5 for
   * the short flurry a bracket submit or a reconcile sweep issues back-to-back.
   * A placeholder default pending tuning against the real account's tier
   * (#299), not a transcription of the venue's limit; it errs under the ceiling
   * because the cost of being wrong is a throttled key mid-sweep.
   */
  private readonly rateLimiter: TokenBucket;
  private readonly state: BrokerStateStore;

  constructor(private readonly input: AlpacaBrokerAdapterInput) {
    this.rateLimiter = input.rateLimiter ?? new TokenBucket({ capacity: 5, refillPerSecond: 3 });
    this.state = input.state ?? new InMemoryBrokerStateStore();

    // Synchronous, in the constructor: the first `fetchNewFills` sweep after a
    // restart iterates this map, and an empty one reports "no new fills" —
    // indistinguishable, above the adapter, from a quiet market.
    for (const record of this.state.loadBrackets('alpaca')) {
      if (record.entry_order_id === null) continue;
      this.brackets.set(record.client_order_id, record.entry_order_id);
    }
  }

  /**
   * The single door to the injected client: pacing before the call (C2),
   * credential-safe error conversion after it (H1). Alpaca's REST errors quote
   * the failed request — including the `APCA-API-KEY-ID` header on an auth
   * failure — and `execute()` copies a thrown message straight into a logged
   * `ExecutionResult.reason`.
   */
  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    await this.rateLimiter.acquire();
    try {
      return await fn();
    } catch (cause) {
      throw sanitizeBrokerError('alpaca', operation, cause);
    }
  }

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    const response = await this.call('submitBracket', () =>
      this.input.client.submitOrder({
        symbol: order.instrument,
        side: order.side,
        qty: String(order.size),
        limit_price: String(order.entry),
        time_in_force: order.time_in_force,
        client_order_id: order.client_order_id,
        order_class: 'bracket',
        take_profit: { limit_price: String(order.target) },
        stop_loss: { stop_price: String(order.stop) },
      }),
    );

    this.brackets.set(order.client_order_id, response.id);

    const legIds = (response.legs ?? []).map((leg) => leg.id);

    // `phase: 'armed'` — on a native-bracket venue there is no local state
    // machine to be partway through; the bracket is live from this call.
    this.state.saveBracket({
      venue: 'alpaca',
      client_order_id: order.client_order_id,
      phase: 'armed',
      entry_order_id: response.id,
      ...legOrderIds(response.legs),
      request: toRequestFields(order),
      armed_qty: null,
      arming_qty: null,
      arm_attempt: 0,
    });

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
    const order = await this.call('getOrder', () =>
      this.input.client.getOrderByClientOrderId(clientOrderId),
    );
    if (order === null) return null;

    // Re-populating the map lets a post-restart `fetchNewFills` find this
    // bracket again — the reconciliation sweep is the only thing that knows
    // these orders still exist. Journalled too, via the partial-upsert path:
    // this call knows the venue's order ids but NOT the request that produced
    // them, and writing invented request values would be worse than none.
    this.brackets.set(clientOrderId, order.id);
    this.state.recordBracketOrderIds('alpaca', clientOrderId, {
      entry_order_id: order.id,
      ...legOrderIds(order.legs),
    });

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
   *
   * Each bracket is isolated. `ingestFills()` awaits this as ONE call before
   * advancing ANY lot, and `brackets` iterates in insertion order, so an
   * unhandled throw here does not just lose one order's fills — it aborts the
   * whole account's ingestion cycle, and a bracket that Alpaca persistently
   * reports malformed would starve every bracket submitted after it, stop-outs
   * included. Refusing to book one bad fill must not cost the sweep.
   *
   * The isolation is per BRACKET, not per `collectFill`: a bracket whose entry
   * price cannot be recorded must not have its exit legs booked either, or the
   * lot's accounting is built on a fill that was rejected.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const fills: NormalizedFill[] = [];
    const failures: unknown[] = [];

    // Snapshot, as #297 already did for `CcxtBrokerAdapter.syncBrackets` (M3):
    // the `getOrder` below awaits inside this loop, and a Map iterator DOES
    // visit entries inserted mid-iteration — so a bracket submitted during the
    // sweep would be drained by a pass whose `since` window predates it, and
    // its fills silently dropped. The snapshot fixes each pass's worklist at
    // entry (PR #290 review, deepseek).
    for (const [clientOrderId, entryOrderId] of [...this.brackets]) {
      try {
        const entry = await this.call('fetchNewFills', () =>
          this.input.client.getOrder(entryOrderId),
        );

        collectFill(entry, 'entry', clientOrderId, since, fills);
        for (const leg of entry.legs ?? []) {
          collectFill(leg, legName(leg), clientOrderId, since, fills);
        }
      } catch (error) {
        // Skipped, not swallowed: this bracket contributes nothing to THIS
        // sweep and is retried on the next one. That is the same shape as an
        // order the venue has not reported yet, and `ingestFills()` dedups on
        // `broker_fill_id`, so re-polling costs nothing.
        failures.push(error);
      }
    }

    // Progress wins when there is any: dropping good fills to report a bad
    // bracket would re-create the account-wide stall this isolation removes.
    // A wholly-failed sweep is the one case where throwing costs nothing — and
    // it must not be reported as the "no new fills" that an empty array means.
    if (fills.length === 0 && failures.length > 0) {
      throw new AggregateError(
        failures,
        `Alpaca fetchNewFills: all ${failures.length} bracket(s) failed; no fills could be read`,
      );
    }

    return fills;
  }
}

/**
 * The bracket's protective children, split by kind for the journal. Null where
 * Alpaca reports no such leg — which it legitimately does once a leg has been
 * cancelled — rather than an empty string standing in for "don't know".
 */
function legOrderIds(legs: AlpacaOrderLeg[] | undefined): {
  stop_order_id: string | null;
  target_order_id: string | null;
} {
  const all = legs ?? [];
  return {
    stop_order_id: all.find((leg) => legName(leg) === 'stop')?.id ?? null,
    target_order_id: all.find((leg) => legName(leg) === 'target')?.id ?? null,
  };
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

  // `NaN <= 0` is FALSE, so an unparseable quantity ('', 'N/A', anything
  // non-numeric) would sail past the guard below and be booked as `qty: NaN` —
  // which then silently propagates through weighted-average pricing, realized
  // PnL and the R-multiple, poisoning every figure it touches without ever
  // failing. Checked before the ordering guard for exactly that reason.
  if (!Number.isFinite(filledQty)) {
    throw new Error(
      `Alpaca order ${order.id} (${leg} leg of '${clientOrderId}') reports an unparseable ` +
        `filled_qty '${order.filled_qty}'`,
    );
  }

  if (filledQty <= 0 || order.filled_at === null) {
    return;
  }

  const filledAt = new Date(order.filled_at);
  if (filledAt.getTime() < since.getTime()) {
    return;
  }

  // A positive filled quantity with no average price is Alpaca contradicting
  // itself, and there is no safe way to record it: a zero price is not a
  // conservative guess but a fabricated one, and it flows straight into
  // realized PnL, the R-multiple and the feedback loop's weighting — a lot
  // booked at 0 reads as a total loss or an infinite gain depending on side.
  // Same posture the ccxt adapter takes in `toFill`: refuse rather than
  // silently degrade, and let the poll retry once the venue is coherent.
  if (order.filled_avg_price === null) {
    throw new Error(
      `Alpaca order ${order.id} (${leg} leg of '${clientOrderId}') reports filled_qty ` +
        `${order.filled_qty} but no filled_avg_price to record`,
    );
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
