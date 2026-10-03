import type { MarketDataService } from '../../providers/market-data-service/index.js';
import type { Clock } from '../../shared/index.js';
import type { CostModel, MarketState } from '../../tools/backtest/index.js';
import { SimulatedBrokerAdapter } from './simulated-adapter.js';
import type { NativeBracketRequest, SimulatedAdapterConfig } from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const OBSERVED_AT = new Date('2026-07-15T13:59:00Z');
const fixedClock: Clock = { now: () => NOW };

const CONFIG: SimulatedAdapterConfig = {
  volatility_indicator: { indicator: 'atr', params: { period: 14 }, timeframe: '1h', lookback: 15 },
  adv_window: { timeframe: '1d', lookback: 20 },
};

const fullFillCostModel: CostModel = {
  fill: (request, marketState) => ({
    fill_price: request.limit_price ?? marketState.mid,
    filled_size: request.size,
    cost_breakdown: { spread_cost: 0, commission: 1, slippage: 0, market_impact: 0 },
  }),
};

function makeMarketData(overrides: Partial<MarketDataService> = {}): MarketDataService {
  return {
    getBars: vi.fn(),
    getMark: vi.fn().mockResolvedValue({
      price: 100,
      observed_at: OBSERVED_AT,
      source: 'fixture',
      asset_class: 'stocks',
    }),
    getIndicator: vi
      .fn()
      .mockResolvedValue({ indicator: 'atr', value: 2, as_of_bar_close: OBSERVED_AT }),
    getSpreadEstimate: vi.fn().mockResolvedValue(0.04),
    getADV: vi.fn().mockResolvedValue(1_000_000),
    ...overrides,
  } as MarketDataService;
}

function makeBracket(overrides: Partial<NativeBracketRequest> = {}): NativeBracketRequest {
  return {
    client_order_id: 'key-aapl-1355',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    ...overrides,
  };
}

function makeAdapter(
  marketData: MarketDataService = makeMarketData(),
  costModel: CostModel = fullFillCostModel,
) {
  return new SimulatedBrokerAdapter({ clock: fixedClock, costModel, marketData, config: CONFIG });
}

describe('SimulatedBrokerAdapter.submitBracket', () => {
  it('acks the bracket with entry + attached protective legs', async () => {
    const ack = await makeAdapter().submitBracket(makeBracket());

    expect(ack.client_order_id).toBe('key-aapl-1355');
    expect(ack.order_state).toBe('submitted');
    expect(ack.broker_order_ids).toEqual([
      'key-aapl-1355:entry',
      'key-aapl-1355:stop',
      'key-aapl-1355:target',
    ]);
  });

  it('builds MarketState from the injected MDS before pricing the fill', async () => {
    const marketData = makeMarketData();
    const costModel: CostModel = {
      fill: vi.fn().mockReturnValue({
        fill_price: 100.5,
        filled_size: 100,
        cost_breakdown: { spread_cost: 0.02, commission: 5, slippage: 0.04, market_impact: 0.01 },
      }),
    };

    await makeAdapter(marketData, costModel).submitBracket(makeBracket());

    expect(marketData.getMark).toHaveBeenCalledWith('AAPL', NOW);
    expect(marketData.getIndicator).toHaveBeenCalledWith('AAPL', CONFIG.volatility_indicator, NOW);
    expect(marketData.getSpreadEstimate).toHaveBeenCalledWith('AAPL', NOW);
    expect(marketData.getADV).toHaveBeenCalledWith('AAPL', CONFIG.adv_window, NOW);

    const marketState = vi.mocked(costModel.fill).mock.calls[0]?.[1] as MarketState;
    expect(marketState).toEqual({
      mid: 100,
      spread: 0.04,
      adv: 1_000_000,
      volatility: 2,
      asset_class: 'stocks',
      timestamp: OBSERVED_AT,
    });
  });

  it('stamps MarketState.venue from config so a venue-keyed cost override binds', async () => {
    const costModel: CostModel = {
      fill: vi.fn().mockReturnValue({
        fill_price: 100.5,
        filled_size: 100,
        cost_breakdown: { spread_cost: 0.02, commission: 5, slippage: 0.04, market_impact: 0.01 },
      }),
    };
    const adapter = new SimulatedBrokerAdapter({
      clock: fixedClock,
      costModel,
      marketData: makeMarketData(),
      config: { ...CONFIG, venue: 'saxo' },
    });

    await adapter.submitBracket(makeBracket());

    const marketState = vi.mocked(costModel.fill).mock.calls[0]?.[1] as MarketState;
    expect(marketState.venue).toBe('saxo');
  });

  it('prices the entry leg against the bracket entry as a limit', async () => {
    const costModel: CostModel = {
      fill: vi.fn().mockReturnValue({
        fill_price: 100.5,
        filled_size: 100,
        cost_breakdown: { spread_cost: 0.02, commission: 5, slippage: 0.04, market_impact: 0.01 },
      }),
    };

    await makeAdapter(makeMarketData(), costModel).submitBracket(makeBracket());

    expect(vi.mocked(costModel.fill).mock.calls[0]?.[0]).toEqual({
      instrument: 'AAPL',
      side: 'buy',
      size: 100,
      order_type: 'limit',
      limit_price: 100,
      idempotency_key: 'key-aapl-1355',
    });
  });

  it('passes a null spread estimate through to the cost model', async () => {
    const marketData = makeMarketData({ getSpreadEstimate: vi.fn().mockResolvedValue(null) });
    const costModel: CostModel = {
      fill: vi.fn().mockReturnValue({
        fill_price: 100.5,
        filled_size: 100,
        cost_breakdown: { spread_cost: 0.02, commission: 5, slippage: 0.04, market_impact: 0.01 },
      }),
    };

    await makeAdapter(marketData, costModel).submitBracket(makeBracket());

    const marketState = vi.mocked(costModel.fill).mock.calls[0]?.[1] as MarketState;
    expect(marketState.spread).toBeNull();
  });

  it('models an entry fill carrying the cost breakdown', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills('1970-01-01T00:00:00.000Z');
    expect(fills).toEqual([
      {
        client_order_id: 'key-aapl-1355',
        broker_fill_id: 'key-aapl-1355:entry',
        leg: 'entry',
        price: 100,
        qty: 100,
        fee: 1,
        timestamp: NOW.toISOString(),
        cost_breakdown: { spread_cost: 0, commission: 1, slippage: 0, market_impact: 0 },
      },
    ]);
  });

  it('yields exactly one fill when the same client order id is submitted N times', async () => {
    const adapter = makeAdapter();

    for (let i = 0; i < 5; i++) {
      await adapter.submitBracket(makeBracket());
    }

    expect(await adapter.fetchNewFills('1970-01-01T00:00:00.000Z')).toHaveLength(1);
  });

  it('acks a duplicate submit idempotently rather than erroring', async () => {
    const adapter = makeAdapter();

    const first = await adapter.submitBracket(makeBracket());
    const second = await adapter.submitBracket(makeBracket());

    expect(second).toEqual(first);
  });

  it('fills deterministically: same bracket + same market state => same fill', async () => {
    const priceOf = async () => {
      const adapter = makeAdapter();
      await adapter.submitBracket(makeBracket());
      return (await adapter.fetchNewFills('1970-01-01T00:00:00.000Z'))[0]?.price;
    };

    expect(await priceOf()).toBe(await priceOf());
  });

  it('stamps the fill as the millisecond UTC instant of simulated T and filters on it exactly', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket());

    const [fill] = await adapter.fetchNewFills(NOW.toISOString());

    expect(fill?.timestamp).toBe(NOW.toISOString());
    expect(await adapter.fetchNewFills(new Date(NOW.getTime() + 1).toISOString())).toEqual([]);
  });

  it.each(['2026-01-01', '2026-01-01T00:00:00Z', 'not a date'])(
    'rejects a non-canonical `since` %j',
    async (since) => {
      const adapter = makeAdapter();
      await adapter.submitBracket(makeBracket());

      await expect(adapter.fetchNewFills(since)).rejects.toThrow(RangeError);
    },
  );

  it('stamps the fill at or before simulated T', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills('1970-01-01T00:00:00.000Z');
    expect(Date.parse(fills[0]?.timestamp ?? '')).toBeLessThanOrEqual(NOW.getTime());
  });

  it("never stamps a fill earlier than the order's own submit time, even when the priced mark lags", async () => {
    const laggyObservedAt = new Date(NOW.getTime() - 5 * 60_000);
    const marketData = makeMarketData({
      getMark: vi.fn().mockResolvedValue({
        price: 100,
        observed_at: laggyObservedAt,
        source: 'fixture',
        asset_class: 'stocks',
      }),
    });

    const adapter = makeAdapter(marketData);
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills('1970-01-01T00:00:00.000Z');
    expect(Date.parse(fills[0]?.timestamp ?? '')).toBeGreaterThanOrEqual(NOW.getTime());
    expect(await adapter.fetchNewFills(NOW.toISOString())).toHaveLength(1);
  });

  it('serves fills from the poll cursor forward', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket());

    expect(await adapter.fetchNewFills(NOW.toISOString())).toHaveLength(1);
    expect(await adapter.fetchNewFills(new Date(NOW.getTime() + 1).toISOString())).toHaveLength(0);
  });
});

describe('SimulatedBrokerAdapter.getOrder', () => {
  it('answers the BrokerAdapter lookup by client order id, ignoring the instrument', async () => {
    const adapter = makeAdapter();
    const bracket = makeBracket();
    await adapter.submitBracket(bracket);

    const order = await adapter.getOrder(bracket.client_order_id, bracket.instrument);

    expect(order?.client_order_id).toBe(bracket.client_order_id);
    expect(await adapter.getOrder('never-submitted', bracket.instrument)).toBeNull();
  });
});

describe('SimulatedBrokerAdapter — intervention path (#429)', () => {
  it('models a flatten fill and publishes it to the fill feed', async () => {
    const adapter = makeAdapter();

    const ack = await adapter.submitFlatten('AAPL', 'sell', 40, 'flatten-1');
    const fills = await adapter.fetchNewFills('1970-01-01T00:00:00.000Z');

    expect(ack.client_order_id).toBe('flatten-1');
    expect(fills.map((fill) => fill.broker_fill_id)).toContain('flatten-1:flatten');
  });

  it('dedups a repeated flatten under the same client order id', async () => {
    const adapter = makeAdapter();

    await adapter.submitFlatten('AAPL', 'sell', 40, 'flatten-1');
    await adapter.submitFlatten('AAPL', 'sell', 40, 'flatten-1');

    expect(await adapter.fetchNewFills('1970-01-01T00:00:00.000Z')).toHaveLength(1);
  });

  it('nets positions per instrument rather than reporting one row per lot', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket({ client_order_id: 'a', size: 100 }));
    await adapter.submitBracket(makeBracket({ client_order_id: 'b', size: 50 }));

    expect(await adapter.getOpenPositions()).toEqual([
      { instrument: 'AAPL', qty: 150, side: 'buy', avg_entry_price: null },
    ]);
  });

  it('reports nothing for an instrument that has netted flat', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket({ client_order_id: 'a', size: 100 }));
    await adapter.submitFlatten('AAPL', 'sell', 100, 'flatten-1');

    expect(await adapter.getOpenPositions()).toEqual([]);
  });

  it('cancel is idempotent and forgets the lot protective legs', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket());
    await adapter.resizeProtectiveLegs('key-aapl-1355', 100);

    await adapter.cancel('key-aapl-1355', 'AAPL');
    await expect(adapter.cancel('key-aapl-1355', 'AAPL')).resolves.toBeUndefined();
    await expect(adapter.cancel('never-submitted', 'AAPL')).resolves.toBeUndefined();

    expect(adapter.getProtectedQty('key-aapl-1355')).toBeNull();
  });
});
