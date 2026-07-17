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
import type { BrokerAck, BrokerAdapter, NativeBracketRequest, NormalizedFill } from './types.js';

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
}

export class CcxtBrokerAdapter implements BrokerAdapter {
  /** Live brackets by client order id — the emulation's whole state. */
  private readonly brackets = new Map<string, EmulatedBracket>();
  /** Fills awaiting ingestion, in arrival order (#83 drains them). */
  private readonly fills: NormalizedFill[] = [];

  constructor(private readonly client: CcxtBrokerClient) {}

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

    const entry = await this.client.createOrder(
      order.instrument,
      'limit',
      order.side,
      order.size,
      order.entry,
      { clientOrderId: order.client_order_id, timeInForce: order.time_in_force },
    );

    const bracket: EmulatedBracket = {
      request: order,
      phase: 'pending_entry',
      entryOrderId: entry.id,
      stopOrderId: null,
      targetOrderId: null,
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
    for (const bracket of this.brackets.values()) {
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
    const entry = await this.client.fetchOrder(bracket.entryOrderId, request.instrument);

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

    // Protective legs cover what actually filled, never the requested size —
    // an over-sized stop protects phantom quantity.
    const filledSize = entry.filled;
    const exitSide = request.side === 'buy' ? 'sell' : 'buy';
    const [stop, target] = await Promise.all([
      this.client.createOrder(request.instrument, 'limit', exitSide, filledSize, request.stop, {
        clientOrderId: `${request.client_order_id}:stop`,
        stopLossPrice: request.stop,
        timeInForce: request.time_in_force,
      }),
      this.client.createOrder(request.instrument, 'limit', exitSide, filledSize, request.target, {
        clientOrderId: `${request.client_order_id}:target`,
        takeProfitPrice: request.target,
        timeInForce: request.time_in_force,
      }),
    ]);

    bracket.stopOrderId = stop.id;
    bracket.targetOrderId = target.id;
    bracket.phase = 'armed';
  }

  /**
   * `armed` → `resolved`: the OCO edge. When one protective leg fills, the
   * sibling must die — this is what the venue would do for us on IBKR/Alpaca.
   */
  private async advanceExits(bracket: EmulatedBracket): Promise<void> {
    const { request, stopOrderId, targetOrderId } = bracket;
    if (stopOrderId === null || targetOrderId === null) return;

    const [stop, target] = await Promise.all([
      this.client.fetchOrder(stopOrderId, request.instrument),
      this.client.fetchOrder(targetOrderId, request.instrument),
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
    await this.client.cancelOrder(filled.siblingId, request.instrument);
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
