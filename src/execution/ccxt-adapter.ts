/**
 * ccxt BrokerAdapter — Kraken/Coinbase (ticket #85). See
 * docs/specs/execution-spec.md ("Module: Broker Abstraction"): "ccxt
 * (Kraken/Coinbase): native attached-close/OCO is limited → Execution-managed
 * emulation — place the entry, arm stop + target on fill, cancel the sibling
 * when one fills. The emulation logic lives in the adapter; the guarantee is
 * identical above it."
 *
 * So this file is where the atomic-bracket/OCO promise is *kept by hand*
 * rather than by the venue. Nothing above the adapter can tell: `execute()`
 * calls `submitBracket` and gets the same `BrokerAck` it gets from a native
 * bracket venue.
 *
 * The ccxt exchange is INJECTED, not constructed here — connection
 * provisioning (API keys, permissions) is an ops/setup task, not this spec's
 * logic, matching the market-data ccxt source (#66). `CcxtBrokerClient` is the
 * narrow slice of ccxt's *order* surface this adapter uses (that source's
 * `CcxtClient` is OHLCV/ticker only), so a real ccxt Exchange satisfies it
 * structurally.
 */
import { type OrderState, TokenBucket } from '../shared/index.js';
import { sanitizeBrokerError } from './broker-error.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
} from './types.js';

/** The subset of ccxt's unified order status this adapter reasons about. */
export type CcxtOrderStatus = 'open' | 'closed' | 'canceled' | 'expired' | 'rejected';

/** The ccxt unified order fields this adapter reads. */
export interface CcxtOrder {
  id: string;
  /** 'closed' is ccxt's terminal *filled* state; 'canceled' etc. are dead. */
  status: CcxtOrderStatus;
  /** Cumulative filled base quantity. */
  filled: number;
  /** Volume-weighted fill price; undefined until something fills. */
  average: number | undefined;
  /** Milliseconds since the epoch. */
  timestamp: number | undefined;
  fee: { cost: number } | undefined;
}

export interface CcxtBrokerClient {
  createOrder(
    symbol: string,
    type: string,
    side: 'buy' | 'sell',
    amount: number,
    price?: number,
    params?: Record<string, unknown>,
  ): Promise<CcxtOrder>;
  cancelOrder(id: string, symbol: string): Promise<unknown>;
  fetchOrder(id: string, symbol: string): Promise<CcxtOrder>;
}

/**
 * Where a bracket is in the emulated lifecycle. This is the whole of the OCO
 * guarantee: the sibling cancel fires on the `armed` → `resolved` edge, and
 * that edge is taken exactly once because the transition is claimed
 * synchronously (see `advanceExits`).
 *
 * `arming` is not cosmetic — placing the two legs is an await, and without a
 * phase to claim first, two overlapping polls would both place them.
 */
type BracketPhase = 'pending_entry' | 'arming' | 'armed' | 'resolved';

interface EmulatedBracket {
  request: NativeBracketRequest;
  phase: BracketPhase;
  entryOrderId: string;
  stopOrderId: string | null;
  targetOrderId: string | null;
  /**
   * The quantity the live legs currently protect, so a resize can tell a
   * no-op from real work. Null until they are armed.
   */
  armedQty: number | null;
  /**
   * How many times the legs have been placed — keeps a re-armed leg's client
   * order id unique against the venue, which rejects a repeated one.
   */
  armAttempt: number;
}

export class CcxtBrokerAdapter implements BrokerAdapter {
  /** Live brackets by client order id — the emulation's whole state. */
  private readonly brackets = new Map<string, EmulatedBracket>();
  /** Fills awaiting ingestion, in arrival order (#83 drains them). */
  private readonly fills: NormalizedFill[] = [];

  private readonly rateLimiter: TokenBucket;

  /**
   * `rateLimiter` is optional so existing wiring keeps working, but the
   * default is NOT "unlimited" — an adapter with no pacing is the C2 finding.
   * 1 order/second is the free-tier order rate Kraken/Coinbase publish for the
   * cheapest tier, so it is the conservative floor that cannot be wrong in the
   * dangerous direction. A placeholder pending real per-venue tuning (#299):
   * an exchange-specific limit belongs with the exchange's credentials, i.e.
   * in ops wiring, not hard-coded here. #299 also records this default's known
   * cost — at 1/second the two protective legs in `armLegs` serialize, placing
   * them ≥1s apart and widening the unprotected-lot window.
   */
  constructor(
    private readonly client: CcxtBrokerClient,
    rateLimiter: TokenBucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }),
  ) {
    this.rateLimiter = rateLimiter;
  }

  /**
   * The single door to the injected client, so the two things every outbound
   * call needs cannot be forgotten on a new one: pacing before (C2) and
   * credential-safe error conversion after (H1). ccxt errors embed the failed
   * HTTP exchange — signed URL, headers, sometimes the key itself — and
   * `execute()` copies a thrown message into a logged `ExecutionResult.reason`.
   *
   * Wrapping at the LEAF, not around the `Promise.all`s: a combinator wrap
   * would double-convert and lose which leg failed.
   */
  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    await this.rateLimiter.acquire();
    try {
      return await fn();
    } catch (cause) {
      throw sanitizeBrokerError('ccxt', operation, cause);
    }
  }

  /**
   * Places the ENTRY ONLY. The protective legs cannot be placed yet: they must
   * be sized to the entry's filled quantity, which does not exist until it
   * fills (execution-spec.md user story 13). `syncBrackets` arms them.
   */
  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    // Broker-native dedup: the second layer behind execute()'s store check. A
    // duplicate client order id is a no-op, not a second entry. ccxt's
    // `clientOrderId` param carries the same key to the venue, which rejects
    // the duplicate independently of this map.
    const existing = this.brackets.get(order.client_order_id);
    if (existing !== undefined) {
      return this.ackFor(existing);
    }

    const entry = await this.call('submitBracket', () =>
      this.client.createOrder(order.instrument, 'limit', order.side, order.size, order.entry, {
        clientOrderId: order.client_order_id,
        timeInForce: order.time_in_force,
      }),
    );

    const bracket: EmulatedBracket = {
      request: order,
      phase: 'pending_entry',
      entryOrderId: entry.id,
      stopOrderId: null,
      targetOrderId: null,
      armedQty: null,
      armAttempt: 0,
    };
    this.brackets.set(order.client_order_id, bracket);

    return this.ackFor(bracket);
  }

  /**
   * Drives the emulation one transition per bracket: arm the legs once the
   * entry fills, then cancel the sibling once an exit leg fills.
   *
   * Deliberately NOT on `BrokerAdapter` — nothing above the adapter should
   * know that this venue needs hand-holding, and the interface stays the one
   * `execute()` calls. Whoever polls this in production is #83's lifecycle
   * work; today its caller is the test suite.
   */
  async syncBrackets(): Promise<void> {
    // Snapshot first: the loop awaits per bracket, and a `submitBracket`
    // landing in one of those gaps mutates the Map mid-iteration — so whether
    // the new bracket is swept this pass or next is decided by timing. A lot's
    // protective legs must not be armed (or not) by a coin flip; the array
    // makes each sweep act on the set that existed when it started.
    for (const bracket of [...this.brackets.values()]) {
      if (bracket.phase === 'pending_entry') {
        await this.advanceEntry(bracket);
        continue;
      }
      if (bracket.phase === 'armed') {
        await this.advanceExits(bracket);
      }
    }
  }

  /**
   * The reconciliation lookup (#86), to the extent this venue can serve it.
   *
   * ccxt fetches an order by the VENUE's id and symbol, so the client order
   * id has to be resolved through `brackets` — and `brackets` is this
   * adapter's live emulation state, built only by `submitBracket` in this
   * process. After the crash-restart reconcile exists to handle, it is empty,
   * along with every leg id and phase the emulation depends on.
   *
   * So this THROWS rather than returning null for an unknown bracket. Null is
   * reserved by the `BrokerAdapter.getOrder` contract for "the venue
   * authoritatively has no such order"; an empty map is ignorance, and
   * reporting it as absence would have `reconcile()` mark live Kraken/
   * Coinbase positions `rejected`. Reconcile reads the throw as
   * `undetermined` and leaves the record untouched for an operator.
   *
   * Rehydrating the emulation across a restart is real work this ticket does
   * not scope: it means rebuilding phases and leg ids from the venue's open
   * orders, and inventing it here would go beyond what #86 asks for.
   */
  async getOrder(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) {
      throw new Error(
        `ccxt adapter cannot resolve client_order_id '${clientOrderId}' (${instrument}) to a venue ` +
          "order id: the bracket is not in this process's emulation state. Cross-restart " +
          'reconciliation needs the emulation rehydrated from the venue first.',
      );
    }

    const entry = await this.call('getOrder', () =>
      this.client.fetchOrder(bracket.entryOrderId, instrument),
    );

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [bracket.entryOrderId, bracket.stopOrderId, bracket.targetOrderId].filter(
        (id): id is string => id !== null,
      ),
      order_state: mapOrderState(entry),
      filled_qty: entry.filled,
    };
  }

  /**
   * The fill feed #83's `ingestFills()` drains — same contract as the
   * Simulated adapter's, so the lifecycle above is exercised identically in
   * live and backtest. Never returns a fill dated before `since`.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.fills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }

  /** `pending_entry` → `arming` → `armed`, or → `resolved` if the entry died. */
  private async advanceEntry(bracket: EmulatedBracket): Promise<void> {
    const { request } = bracket;
    const entry = await this.call('fetchEntryStatus', () =>
      this.client.fetchOrder(bracket.entryOrderId, request.instrument),
    );

    // Claim the transition before any further await, so an overlapping poll
    // cannot place a second pair of legs.
    if (bracket.phase !== 'pending_entry') return;
    if (entry.status === 'open') return;

    if (entry.status !== 'closed' || entry.filled <= 0) {
      // Cancelled/expired/rejected with nothing filled: no lot exists, so
      // there is nothing to protect and no sibling to cancel.
      //
      // A partially-filled-then-cancelled entry DOES leave an unprotected lot.
      // It is not armed here: that is the partial-fill lifecycle (#83) and
      // reconciliation against broker truth (#86), and half-building it here
      // would arm legs against a quantity this adapter cannot yet keep current.
      bracket.phase = 'resolved';
      return;
    }

    // Normalized BEFORE the phase moves: if the venue reported a fill it
    // cannot price, the bracket stays claimable rather than stranded mid-arm.
    // Still synchronous, so the claim below remains atomic.
    const entryFill = this.toFill(entry, 'entry', request.client_order_id);
    bracket.phase = 'arming';
    this.fills.push(entryFill);

    await this.armLegs(bracket, entry.filled);
  }

  /**
   * Places the protective pair sized to `filledSize` — never the requested
   * size, because an over-sized stop protects phantom quantity. The caller
   * owns claiming the phase (`arming`); this owns the placement and lands the
   * bracket back on `armed`.
   */
  private async armLegs(bracket: EmulatedBracket, filledSize: number): Promise<void> {
    const { request } = bracket;
    const exitSide = request.side === 'buy' ? 'sell' : 'buy';
    // A re-arm cannot reuse the cancelled legs' client order ids — the venue
    // rejects a repeated one, which would leave the lot with no legs at all.
    const suffix = bracket.armAttempt === 0 ? '' : `:r${bracket.armAttempt}`;
    bracket.armAttempt += 1;

    const [stop, target] = await Promise.all([
      this.call('armStopLeg', () =>
        this.client.createOrder(request.instrument, 'limit', exitSide, filledSize, request.stop, {
          clientOrderId: `${request.client_order_id}:stop${suffix}`,
          stopLossPrice: request.stop,
          timeInForce: request.time_in_force,
        }),
      ),
      this.call('armTargetLeg', () =>
        this.client.createOrder(request.instrument, 'limit', exitSide, filledSize, request.target, {
          clientOrderId: `${request.client_order_id}:target${suffix}`,
          takeProfitPrice: request.target,
          timeInForce: request.time_in_force,
        }),
      ),
    ]);

    bracket.stopOrderId = stop.id;
    bracket.targetOrderId = target.id;
    bracket.armedQty = filledSize;
    bracket.phase = 'armed';
  }

  /**
   * Re-size the live legs to the entry's cumulative filled quantity — the
   * emulation's half of execution-spec.md story 13. First placement is NOT
   * done here: `advanceEntry` already arms at `entry.filled`, and two owners
   * of leg placement is how a lot gets two stops. This only corrects legs
   * already armed against a quantity that has since grown.
   *
   * Cancel-then-replace, because the injected client slice exposes no amend:
   * the lot is briefly unprotected in the gap. That is a real (and venue-
   * inherent) exposure, narrower than leaving the stop sized to a quantity
   * that no longer exists.
   */
  async resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void> {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) return;

    // `pending_entry`/`arming` → another transition owns this bracket;
    // `resolved` → the lot is done and its legs are already dead.
    if (bracket.phase !== 'armed') return;
    if (bracket.armedQty === filledQty) return;

    // Claim before the first await, exactly as `advanceEntry`/`advanceExits`
    // do: while re-arming, this bracket is not a candidate for the OCO edge,
    // so a concurrent poll cannot cancel a sibling out from under the replace.
    const { request, stopOrderId, targetOrderId } = bracket;
    bracket.phase = 'arming';

    await Promise.all([
      stopOrderId === null
        ? undefined
        : this.call('cancelStopLeg', () =>
            this.client.cancelOrder(stopOrderId, request.instrument),
          ),
      targetOrderId === null
        ? undefined
        : this.call('cancelTargetLeg', () =>
            this.client.cancelOrder(targetOrderId, request.instrument),
          ),
    ]);

    await this.armLegs(bracket, filledQty);
  }

  /**
   * `armed` → `resolved`: the OCO edge. When one protective leg fills, the
   * sibling must die — this is what the venue would do for us on IBKR/Alpaca.
   */
  private async advanceExits(bracket: EmulatedBracket): Promise<void> {
    const { request, stopOrderId, targetOrderId } = bracket;
    if (stopOrderId === null || targetOrderId === null) return;

    const [stop, target] = await Promise.all([
      this.call('fetchStopStatus', () => this.client.fetchOrder(stopOrderId, request.instrument)),
      this.call('fetchTargetStatus', () =>
        this.client.fetchOrder(targetOrderId, request.instrument),
      ),
    ]);

    // Everything from here to the phase write is synchronous, which is what
    // makes the cancel exactly-once: a concurrent poll that resolved first has
    // already moved the phase, and a re-observed fill finds `resolved`.
    if (bracket.phase !== 'armed') return;

    const filled = isFilled(stop)
      ? { leg: 'stop' as const, order: stop, siblingId: targetOrderId }
      : isFilled(target)
        ? { leg: 'target' as const, order: target, siblingId: stopOrderId }
        : null;
    if (filled === null) return;

    // Normalized before the phase moves (as in `advanceEntry`): a fill the
    // venue cannot price must not resolve the bracket, or the sibling is never
    // cancelled and the lot is left unprotected. Synchronous, so the claim
    // below stays atomic against a concurrent poll.
    const exitFill = this.toFill(filled.order, filled.leg, request.client_order_id);
    bracket.phase = 'resolved';
    this.fills.push(exitFill);

    // If this throws, the bracket stays `resolved` and the sibling outlives
    // its lot — an orphan for #86 to reconcile against broker truth. Retrying
    // here instead would risk the one thing the emulation must never do:
    // cancel twice.
    await this.call('cancelSibling', () =>
      this.client.cancelOrder(filled.siblingId, request.instrument),
    );
  }

  /**
   * Under emulation only the entry exists at ack time; the leg ids appear when
   * `syncBrackets` arms them. Reporting three ids up front would be inventing
   * two the venue has never heard of.
   */
  private ackFor(bracket: EmulatedBracket): BrokerAck {
    const ids = [bracket.entryOrderId, bracket.stopOrderId, bracket.targetOrderId];
    return {
      client_order_id: bracket.request.client_order_id,
      broker_order_ids: ids.filter((id): id is string => id !== null),
      order_state: 'submitted',
    };
  }

  /**
   * Polling reports the order's *aggregate* fill, so one NormalizedFill per
   * leg rather than one per venue trade. `cost_breakdown` is absent by
   * contract: a real venue fill has no modeled breakdown.
   */
  private toFill(
    order: CcxtOrder,
    leg: NormalizedFill['leg'],
    clientOrderId: string,
  ): NormalizedFill {
    if (order.average === undefined) {
      throw new Error(
        `ccxt order ${order.id} reports filled ${order.filled} but no average fill price to record`,
      );
    }
    if (order.timestamp === undefined) {
      throw new Error(`ccxt order ${order.id} has no timestamp to date its fill`);
    }

    return {
      client_order_id: clientOrderId,
      broker_fill_id: order.id,
      leg,
      price: order.average,
      qty: order.filled,
      // ccxt reports no fee where the venue returned none; a missing fee is
      // zero cash paid, not an unknown.
      fee: order.fee?.cost ?? 0,
      timestamp: new Date(order.timestamp),
    };
  }
}

function isFilled(order: CcxtOrder): boolean {
  return order.status === 'closed' && order.filled > 0;
}

/**
 * ccxt's unified order status → our `OrderState`, for the reconciliation
 * lookup. Never `closed`: that is our round-trip-to-flat accounting concept
 * derived from `Fill` rows, not a thing a venue says about an order — ccxt's
 * confusingly-named `'closed'` means the order finished filling.
 */
function mapOrderState(order: CcxtOrder): OrderState {
  switch (order.status) {
    case 'closed':
      return 'filled';
    case 'canceled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'rejected':
      return 'rejected';
    // Still working: whether anything has filled is what separates an
    // acknowledged order from a partially filled one.
    default:
      return order.filled > 0 ? 'partially_filled' : 'submitted';
  }
}
