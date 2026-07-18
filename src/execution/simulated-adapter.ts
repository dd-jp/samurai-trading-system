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
import type { CostModel, FillRequest, MarketState } from '../cost-model-backtest/types.js';
import type { MarketDataService } from '../market-data-service/types.js';
import type { Clock } from '../shared/clock.js';
import type { OrderState } from '../shared/types.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
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
   * `instrument` is unused: a simulated venue keys on the client order id
   * alone, so the parameter is simply not declared (as the no-op
   * `resizeProtectiveLegs` overrides elsewhere do).
   */
  async getOrder(clientOrderId: string): Promise<NormalizedOrder | null> {
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

  /** The quantity this lot's protective legs currently cover; null if unarmed. */
  getProtectedQty(clientOrderId: string): number | null {
    return this.protectedQty.get(clientOrderId) ?? null;
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
