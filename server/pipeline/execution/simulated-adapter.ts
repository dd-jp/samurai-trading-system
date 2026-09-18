import type { MarketDataService } from '../../providers/market-data-service/index.js';
import type { Clock, OrderState } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { CostModel, FillRequest, MarketState } from '../../tools/backtest/index.js';
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
  readonly prices_own_fills = true;
  private readonly fills: NormalizedFill[] = [];
  private readonly accepted = new Map<string, NativeBracketRequest>();
  private readonly protectedQty = new Map<string, number>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly input: SimulatedBrokerAdapterInput) {}

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    const { clock, costModel } = this.input;

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
      order_type: 'limit',
      limit_price: order.entry,
      idempotency_key: order.client_order_id,
    };

    const result = costModel.fill(request, marketState);

    this.accepted.set(order.client_order_id, order);
    this.fills.push({
      client_order_id: order.client_order_id,
      broker_fill_id: toBrokerFillId(`${order.client_order_id}:entry`),
      leg: 'entry',
      price: result.fill_price,
      qty: result.filled_size,
      fee: result.cost_breakdown.commission,
      timestamp: now,
      cost_breakdown: result.cost_breakdown,
    });

    return {
      client_order_id: order.client_order_id,
      broker_order_ids: this.brokerOrderIdsFor(order.client_order_id),
      order_state: 'submitted',
    };
  }

  async getOrder(clientOrderId: string, _instrument: string): Promise<NormalizedOrder | null> {
    const order = this.accepted.get(clientOrderId);
    if (order === undefined) return null;

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

  async resumeFlatten(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    return this.getOrder(clientOrderId, instrument);
  }

  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.fills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }

  async resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void> {
    this.protectedQty.set(clientOrderId, filledQty);
  }

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

  getProtectedQty(clientOrderId: string): number | null {
    return this.protectedQty.get(clientOrderId) ?? null;
  }

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

    this.accepted.set(clientOrderId, {
      instrument,
      side,
      size,
      client_order_id: clientOrderId,
    } as NativeBracketRequest);
    this.fills.push({
      client_order_id: clientOrderId,
      broker_fill_id: toBrokerFillId(`${clientOrderId}:flatten`),
      leg: 'entry',
      price: result.fill_price,
      qty: result.filled_size,
      fee: result.cost_breakdown.commission,
      timestamp: now,
      cost_breakdown: result.cost_breakdown,
    });

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [`${clientOrderId}:flatten`],
      order_state: 'submitted',
    };
  }

  async cancel(clientOrderId: string, _instrument: string): Promise<void> {
    this.protectedQty.delete(clientOrderId);
    this.cancelled.add(clientOrderId);
  }

  isCancelled(clientOrderId: string): boolean {
    return this.cancelled.has(clientOrderId);
  }

  async getOpenPositions(): Promise<NormalizedPosition[]> {
    const netByInstrument = new Map<string, number>();
    for (const fill of this.fills) {
      const order = this.accepted.get(fill.client_order_id);
      if (order === undefined) continue;
      const signed = order.side === 'buy' ? fill.qty : -fill.qty;
      netByInstrument.set(order.instrument, (netByInstrument.get(order.instrument) ?? 0) + signed);
    }

    return [...netByInstrument.entries()]
      .filter(([, qty]) => qty !== 0)
      .map(([instrument, qty]) => ({
        instrument,
        qty,
        side: qty > 0 ? ('buy' as const) : ('sell' as const),
        avg_entry_price: null,
      }));
  }

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
      ...(config.venue === undefined ? {} : { venue: config.venue }),
      timestamp: mark.observed_at,
    };
  }

  private brokerOrderIdsFor(clientOrderId: string): string[] {
    return [`${clientOrderId}:entry`, `${clientOrderId}:stop`, `${clientOrderId}:target`];
  }
}

function entryState(filledQty: number, requestedSize: number): OrderState {
  if (filledQty <= 0) return 'submitted';
  return filledQty >= requestedSize ? 'filled' : 'partially_filled';
}
