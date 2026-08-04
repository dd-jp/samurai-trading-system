import type { CostConfig, CostModel, MarketState } from '../cost-model-backtest/index.js';
import { CostModelImpl } from '../cost-model-backtest/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import type { Clock } from '../shared/index.js';
import { SimulatedBrokerAdapter } from './simulated-adapter.js';
import type { NativeBracketRequest, SimulatedAdapterConfig } from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
/** Earlier than NOW: a mark is dated when OBSERVED, not when requested. */
const OBSERVED_AT = new Date('2026-07-15T13:59:00Z');
const fixedClock: Clock = { now: () => NOW };

const CONFIG: SimulatedAdapterConfig = {
  volatility_indicator: { indicator: 'atr', params: { period: 14 }, lookback: 15 },
  adv_window: { timeframe: '1d', lookback: 20 },
};

const COST_CONFIG: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0.1,
    commissionRate: 0.0026,
    slippageCoefficient: 0.05,
    impactK: 0.5,
  },
  stocks: {
    spreadVolatilityCoefficient: 0.05,
    commissionRate: 0.0005,
    slippageCoefficient: 0.02,
    impactK: 0.3,
  },
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
  costModel: CostModel = new CostModelImpl(COST_CONFIG),
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

  // AC: "Simulated adapter builds MarketState from injected MarketDataService
  // before calling CostModel.fill."
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

  // MDS returns null where no bid/ask exists (historical stock bars); the
  // cost model owns the volatility fallback, so null must reach it intact
  // rather than being fabricated into a number by the adapter.
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

    const fills = await adapter.fetchNewFills(new Date(0));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      client_order_id: 'key-aapl-1355',
      leg: 'entry',
      qty: 100,
      timestamp: OBSERVED_AT,
    });
    // Buy fills adversely above mid; commission is the cash fee.
    expect(fills[0]?.price).toBeGreaterThan(100);
    expect(fills[0]?.fee).toBeCloseTo(5, 10);
    expect(fills[0]?.cost_breakdown).toBeDefined();
  });

  // AC: "submit-N-times yields exactly one fill" — the venue-side half of the
  // dedup, proven independently of execute()'s store check.
  it('yields exactly one fill when the same client order id is submitted N times', async () => {
    const adapter = makeAdapter();

    for (let i = 0; i < 5; i++) {
      await adapter.submitBracket(makeBracket());
    }

    expect(await adapter.fetchNewFills(new Date(0))).toHaveLength(1);
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
      return (await adapter.fetchNewFills(new Date(0)))[0]?.price;
    };

    expect(await priceOf()).toBe(await priceOf());
  });

  it('fills a sell adversely below mid', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket({ side: 'sell' }));

    const fills = await adapter.fetchNewFills(new Date(0));
    expect(fills[0]?.price).toBeLessThan(100);
  });

  // No lookahead: the fill is stamped at the mark's observation time, which
  // is at/before simulated T — never ahead of it.
  it('stamps the fill at or before simulated T', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));
    expect(fills[0]?.timestamp.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('serves fills from the poll cursor forward', async () => {
    const adapter = makeAdapter();
    await adapter.submitBracket(makeBracket());

    expect(await adapter.fetchNewFills(OBSERVED_AT)).toHaveLength(1);
    // Already drained as of a later cursor.
    expect(await adapter.fetchNewFills(new Date(OBSERVED_AT.getTime() + 1))).toHaveLength(0);
  });
});

describe('SimulatedBrokerAdapter.getOrder', () => {
  // The instrument is declared but unused here. The assertion that matters is
  // structural: this adapter must accept the same arguments `reconcile()`
  // passes every other adapter, which is only compiler-enforced while the
  // parameter is declared.
  it('answers the BrokerAdapter lookup by client order id, ignoring the instrument', async () => {
    const adapter = makeAdapter();
    const bracket = makeBracket();
    await adapter.submitBracket(bracket);

    const order = await adapter.getOrder(bracket.client_order_id, bracket.instrument);

    expect(order?.client_order_id).toBe(bracket.client_order_id);
    // A simulated venue is authoritative in both directions: absent means
    // never submitted, not "we cannot tell".
    expect(await adapter.getOrder('never-submitted', bracket.instrument)).toBeNull();
  });
});
