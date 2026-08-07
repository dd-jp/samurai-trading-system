/**
 * Simulated BrokerAdapter (ticket #82) — see docs/specs/execution-spec.md
 * ("Module: Determinism & Backtest").
 *
 * The backtest/paper end of the broker abstraction: same code path as live,
 * only the injected adapter differs. Fills are deterministic — priced by the
 * injected cost model against market context read at the injected clock's T,
 * so a replay reproduces them exactly. It models the same bracket lifecycle
 * the native adapters expose, so #83's `ingestFills()` is exercised
 * identically here and in live.
 *
 * The entry fill is modelled at submit time and parked for later ingestion
 * rather than returned from `submitBracket`: `execute()` records a
 * submission, it does not block until filled (execution-spec.md, surface 1).
 * Arming and filling the protective legs is #83's lifecycle work.
 */
import type { CostModel, FillRequest, MarketState } from '../cost-model-backtest/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import type { Clock, OrderState } from '../shared/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  SimulatedAdapterConfig,
} from './types.js';

export interface SimulatedBrokerAdapterInput {
  clock: Clock;
  costModel: CostModel;
  marketData: MarketDataService;
  config: SimulatedAdapterConfig;
}

export class SimulatedBrokerAdapter implements BrokerAdapter {
  /**
   * Modelled fills awaiting ingestion, keyed in arrival order. Stands in for
   * the venue's fill feed that live adapters poll or subscribe to.
   */
  private readonly fills: NormalizedFill[] = [];
  /**
   * Brackets the venue has accepted, by client order id — the venue-side half
   * of the dedup, and the book `getOrder` answers reconciliation from. The
   * whole request is kept, not just the id: reporting `partially_filled`
   * apart from `filled` needs the size that was asked for.
   */
  private readonly accepted = new Map<string, NativeBracketRequest>();
  /** Quantity each lot's protective legs cover, as `ingestFills()` sizes them. */
  private readonly protectedQty = new Map<string, number>();
  /** Lots `cancel` has been called for (#429) — the simulation's observable. */
  private readonly cancelled = new Set<string>();

  constructor(private readonly input: SimulatedBrokerAdapterInput) {}

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    const { clock, costModel } = this.input;

    // Broker-native dedup: the second layer behind execute()'s store check.
    // A duplicate client order id is a venue-side no-op, not a second fill.
    if (this.accepted.has(order.client_order_id)) {
      return {
        client_order_id: order.client_order_id,
        broker_order_ids: this.brokerOrderIdsFor(order.client_order_id),
        order_state: 'submitted',
      };
    }

    const now = clock.now();
    const marketState = await this.buildMarketState(order, now);

    const request: FillRequest = {
      instrument: order.instrument,
      side: order.side,
      size: order.size,
      // The bracket's entry leg is priced at OrderIntent.entry.
      order_type: 'limit',
      limit_price: order.entry,
      idempotency_key: order.client_order_id,
    };

    const result = costModel.fill(request, marketState);

    this.accepted.set(order.client_order_id, order);
    this.fills.push({
      client_order_id: order.client_order_id,
      broker_fill_id: `${order.client_order_id}:entry`,
      leg: 'entry',
      price: result.fill_price,
      qty: result.filled_size,
      // Commission is the cash fee; the other components are already
      // expressed in the adverse fill price (cost-model-backtest-spec.md).
      fee: result.cost_breakdown.commission,
      timestamp: marketState.timestamp,
      cost_breakdown: result.cost_breakdown,
    });

    return {
      client_order_id: order.client_order_id,
      broker_order_ids: this.brokerOrderIdsFor(order.client_order_id),
      order_state: 'submitted',
    };
  }

  /**
   * The reconciliation lookup (#86). This adapter IS the venue, so its book
   * is authoritative in both directions: an id absent from `accepted` was
   * genuinely never submitted, and returning null for it is a fact rather
   * than an admission of ignorance. That is what lets `reconcile()` settle a
   * crashed write-ahead here — and it is why this adapter never throws from
   * `getOrder` while a real one must when it cannot answer.
   *
   * `_instrument` is declared but unused: a simulated venue keys on the client
   * order id alone. Declaring it anyway is what keeps the compiler enforcing
   * the `BrokerAdapter.getOrder` contract here — TypeScript accepts a method
   * that drops trailing parameters, so omitting it silently exempted this
   * adapter from a signature every other one has to satisfy, and a future
   * widening of that parameter would fail everywhere except here.
   */
  async getOrder(clientOrderId: string, _instrument: string): Promise<NormalizedOrder | null> {
    const order = this.accepted.get(clientOrderId);
    if (order === undefined) return null;

    // Summed from the modelled fills, so the report tracks the same events
    // `fetchNewFills` publishes rather than a second, drifting tally.
    const filledQty = this.fills
      .filter((fill) => fill.client_order_id === clientOrderId && fill.leg === 'entry')
      .reduce((sum, fill) => sum + fill.qty, 0);

    return {
      client_order_id: clientOrderId,
      broker_order_ids: this.brokerOrderIdsFor(clientOrderId),
      order_state: entryState(filledQty, order.size),
      filled_qty: filledQty,
    };
  }

  /**
   * The fill feed `ingestFills()` drains. Deterministic and point-in-time:
   * never returns a fill dated before `since`, so a backtest cannot see a
   * fill ahead of simulated T.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.fills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }

  /**
   * Models the venue's leg book: there are no live orders to amend here, so
   * the protected quantity IS the state. Recording it keeps the simulation
   * honest about what a stop-out would fill, and makes the resize observable —
   * which on a real native-bracket venue only the venue could confirm.
   */
  async resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void> {
    this.protectedQty.set(clientOrderId, filledQty);
  }

  /**
   * Re-arms a residual left by a partial flatten (#525). This adapter models
   * a leg's protection purely as `protectedQty` — there is no separate
   * "cancelled vs armed" venue state to distinguish, so re-arming and
   * resizing are the same write here: `cancel()` deleted the entry above,
   * and this puts one back, sized to the residual. `_instrument`/`_side` are
   * declared but unused for `getOrder`'s reason (this adapter keys on client
   * order id alone) — keeping them in the signature is what keeps the
   * compiler enforcing `BrokerAdapter.rearmProtectiveLegs`'s full contract
   * here rather than silently exempting this adapter from a parameter every
   * other implementation needs. `stop`/`target` are accepted for the same
   * contract reason; this adapter has nowhere to record a price level for a
   * leg (see `resizeProtectiveLegs`'s own doc), so they are read by nothing.
   */
  async rearmProtectiveLegs(
    clientOrderId: string,
    _instrument: string,
    _side: 'buy' | 'sell',
    qty: number,
    _stop: number,
    _target: number,
  ): Promise<void> {
    this.protectedQty.set(clientOrderId, qty);
  }

  /** The quantity this lot's protective legs currently cover; null if unarmed. */
  getProtectedQty(clientOrderId: string): number | null {
    return this.protectedQty.get(clientOrderId) ?? null;
  }

  /**
   * The intervention path (#429), modelled the same way the entry is: priced
   * by the injected cost model against market state at the injected clock's T,
   * so a replay reproduces a flatten exactly as it reproduces an entry.
   *
   * `order_type: 'market'`, unlike `submitBracket`'s limit entry. A flatten
   * that rests unfilled is not a flatten, and the cost model prices the
   * urgency honestly — which is the point of simulating it rather than
   * assuming a clean exit at the mid.
   */
  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    if (this.accepted.has(clientOrderId)) {
      return {
        client_order_id: clientOrderId,
        broker_order_ids: [`${clientOrderId}:flatten`],
        order_state: 'submitted',
      };
    }

    const now = this.input.clock.now();
    // A flatten carries no bracket, so the market state is assembled from the
    // instrument alone — `buildMarketState` needs only `instrument` off the
    // request, and passing a synthetic one keeps the pricing path single.
    const marketState = await this.buildMarketState({ instrument } as NativeBracketRequest, now);
    const result = this.input.costModel.fill(
      {
        instrument,
        side,
        size,
        order_type: 'market',
        idempotency_key: clientOrderId,
      },
      marketState,
    );

    // Recorded in `accepted` so a repeat is deduped and `getOrder` can answer
    // for it: a flatten is an order the venue holds like any other.
    this.accepted.set(clientOrderId, {
      instrument,
      side,
      size,
      client_order_id: clientOrderId,
    } as NativeBracketRequest);
    this.fills.push({
      client_order_id: clientOrderId,
      broker_fill_id: `${clientOrderId}:flatten`,
      leg: 'entry',
      price: result.fill_price,
      qty: result.filled_size,
      fee: result.cost_breakdown.commission,
      timestamp: marketState.timestamp,
      cost_breakdown: result.cost_breakdown,
    });

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [`${clientOrderId}:flatten`],
      order_state: 'submitted',
    };
  }

  /**
   * Idempotent by contract: cancelling an unknown, already-cancelled or
   * already-filled order resolves. This adapter's fills are modelled at submit
   * time, so nothing here is ever genuinely working — cancelling forgets the
   * order's protective legs and leaves its fills alone, which is what a venue
   * does to a bracket whose entry has already filled.
   */
  async cancel(clientOrderId: string, _instrument: string): Promise<void> {
    this.protectedQty.delete(clientOrderId);
    this.cancelled.add(clientOrderId);
  }

  /** True if `cancel` has been called for this lot — the simulation's observable. */
  isCancelled(clientOrderId: string): boolean {
    return this.cancelled.has(clientOrderId);
  }

  /**
   * The venue's own account of what it holds, netted per instrument from the
   * modelled fills. This adapter IS the venue, so the answer is authoritative:
   * unlike a real one it can never be stale or partial.
   *
   * Netted, not per-lot: a venue reports a position, not the lots that built
   * it. Two entries and a partial exit on one instrument are one row here,
   * which is exactly the shape reconciliation has to compare against.
   */
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    const netByInstrument = new Map<string, number>();
    for (const fill of this.fills) {
      const order = this.accepted.get(fill.client_order_id);
      if (order === undefined) continue;
      const signed = order.side === 'buy' ? fill.qty : -fill.qty;
      netByInstrument.set(order.instrument, (netByInstrument.get(order.instrument) ?? 0) + signed);
    }

    return (
      [...netByInstrument.entries()]
        // A netted-flat instrument is not a position. Reporting it as qty 0
        // would make reconciliation see a holding where the venue has none.
        .filter(([, qty]) => qty !== 0)
        .map(([instrument, qty]) => ({
          instrument,
          qty,
          side: qty > 0 ? ('buy' as const) : ('sell' as const),
          // The simulation prices every fill individually and keeps no running
          // average; null is the honest answer rather than a fabricated one.
          avg_entry_price: null,
        }))
    );
  }

  /**
   * Assembled from the injected MDS — the adapter's whole market view, since
   * the cost model never fetches anything itself (cross-spec GAP-E).
   * `spread` stays best-effort: MDS returns null where no bid/ask exists and
   * the cost model owns the volatility fallback (OPEN-GAP-A), so a null is
   * passed through rather than fabricated into a number here.
   */
  private async buildMarketState(order: NativeBracketRequest, now: Date): Promise<MarketState> {
    const { marketData, config } = this.input;

    const [mark, volatility, spread, adv] = await Promise.all([
      marketData.getMark(order.instrument, now),
      marketData.getIndicator(order.instrument, config.volatility_indicator, now),
      marketData.getSpreadEstimate(order.instrument, now),
      marketData.getADV(order.instrument, config.adv_window, now),
    ]);

    return {
      mid: mark.price,
      spread,
      adv,
      volatility: volatility.value,
      asset_class: mark.asset_class,
      // When the price was OBSERVED, not when it was requested — already
      // <= now by MDS's point-in-time contract.
      timestamp: mark.observed_at,
    };
  }

  /** Entry + the two attached protective legs. */
  private brokerOrderIdsFor(clientOrderId: string): string[] {
    return [`${clientOrderId}:entry`, `${clientOrderId}:stop`, `${clientOrderId}:target`];
  }
}

/**
 * The ENTRY leg's state, which is what a venue reports for the bracket. Never
 * `closed`: round-trip-to-flat is our accounting concept, derived from the
 * `Fill` rows by `ingestFills()`, not something a venue says about an order.
 */
function entryState(filledQty: number, requestedSize: number): OrderState {
  if (filledQty <= 0) return 'submitted';
  return filledQty >= requestedSize ? 'filled' : 'partially_filled';
}
