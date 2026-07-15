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
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
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
  /** Client order ids already accepted — the venue-side half of the dedup. */
  private readonly accepted = new Set<string>();

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

    this.accepted.add(order.client_order_id);
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
   * The fill feed #83's `ingestFills()` drains. Deterministic and
   * point-in-time: never returns a fill dated before `since`, so a backtest
   * cannot see a fill ahead of simulated T.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.fills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
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
