import type {
  Bar,
  BarWindow,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
} from '../market-data-service/index.js';
import {
  type CorrelationConfig,
  type CorrelationEstimateInput,
  computeCorrelationEstimate,
} from './correlation.js';

const asOf = new Date('2026-07-15T09:30:00Z');
const window: BarWindow = { timeframe: '1d', lookback: 10 };

function makeBars(instrument: string, closes: number[]): Bar[] {
  return closes.map((close, i) => ({
    instrument,
    timeframe: '1d',
    open_time: new Date(asOf.getTime() - (closes.length - i) * 86_400_000),
    close_time: new Date(asOf.getTime() - (closes.length - i - 1) * 86_400_000),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
    source: 'test',
  }));
}

function makeMarketData(barsByInstrument: Record<string, Bar[]>): MarketDataService {
  const getBars = vi.fn(
    async (instrument: string, _w: BarWindow, _a: Date): Promise<Bar[]> =>
      barsByInstrument[instrument] ?? [],
  );
  return {
    getBars,
    getIndicator: vi.fn(
      async (_i: string, _s: IndicatorSpec, _a: Date): Promise<IndicatorValue> => {
        throw new Error('not used in these tests');
      },
    ),
    getMark: vi.fn(async (_i: string, _a: Date): Promise<Mark> => {
      throw new Error('not used in these tests');
    }),
    getSpreadEstimate: vi.fn(async (_i: string, _a: Date): Promise<number | null> => null),
    getADV: vi.fn(async (_i: string, _w: BarWindow, _a: Date): Promise<number> => 0),
  };
}

function makeConfig(overrides: Partial<CorrelationConfig> = {}): CorrelationConfig {
  return {
    window,
    min_bars: 3,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CorrelationEstimateInput> = {}): CorrelationEstimateInput {
  return {
    instrument: 'AAPL',
    otherInstruments: [],
    marketData: makeMarketData({}),
    asOf,
    config: makeConfig(),
    ...overrides,
  };
}

describe('computeCorrelationEstimate — pairwise correlation', () => {
  it('assigns correlation ~1 to two instruments moving in lockstep', async () => {
    const closes = [100, 102, 101, 105, 108, 107];
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', closes),
      MSFT: makeBars(
        'MSFT',
        closes.map((c) => c * 2),
      ), // same log returns, different scale
    });
    const input = makeInput({ otherInstruments: ['MSFT'], marketData });

    const estimate = await computeCorrelationEstimate(input);

    expect(estimate.correlations.MSFT).toBeCloseTo(1, 5);
  });

  it('assigns correlation ~-1 to two instruments moving in perfect opposition', async () => {
    const closesUp = [100, 102, 101, 105, 108, 107];
    const closesDown = [100, 98, 99, 95, 92, 93];
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', closesUp),
      MSFT: makeBars('MSFT', closesDown),
    });
    const input = makeInput({ otherInstruments: ['MSFT'], marketData });

    const estimate = await computeCorrelationEstimate(input);

    expect(estimate.correlations.MSFT).toBeLessThan(-0.9);
  });

  it('computes independent correlations for multiple held instruments', async () => {
    const closes = [100, 102, 101, 105, 108, 107];
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', closes),
      MSFT: makeBars(
        'MSFT',
        closes.map((c) => c * 2),
      ),
      'BTC-USD': makeBars('BTC-USD', [100, 98, 99, 95, 92, 93]),
    });
    const input = makeInput({ otherInstruments: ['MSFT', 'BTC-USD'], marketData });

    const estimate = await computeCorrelationEstimate(input);

    expect(estimate.correlations.MSFT).toBeCloseTo(1, 5);
    expect(estimate.correlations['BTC-USD']).toBeLessThan(-0.9);
  });
});

describe('computeCorrelationEstimate — warm-up fallback', () => {
  it('omits a pair whose overlapping return history is below min_bars', async () => {
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', [100, 101, 102, 103, 104, 105]),
      MSFT: makeBars('MSFT', [50, 51]), // only 1 return — below min_bars
    });
    const input = makeInput({
      otherInstruments: ['MSFT'],
      marketData,
      config: makeConfig({ min_bars: 3 }),
    });

    const estimate = await computeCorrelationEstimate(input);

    expect(estimate.correlations.MSFT).toBeUndefined();
    expect(estimate.correlations).toEqual({});
  });

  it('omits a pair with no bar history at all (unlisted instrument)', async () => {
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', [100, 101, 102, 103, 104, 105]),
    });
    const input = makeInput({ otherInstruments: ['MSFT'], marketData });

    const estimate = await computeCorrelationEstimate(input);

    expect(estimate.correlations).toEqual({});
  });
});

describe('computeCorrelationEstimate — point-in-time reads', () => {
  it('requests bars for every instrument at the given asOf, never wall-clock', async () => {
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', [100, 101, 102, 103]),
      MSFT: makeBars('MSFT', [50, 51, 52, 53]),
    });
    const input = makeInput({ otherInstruments: ['MSFT'], marketData, asOf });

    await computeCorrelationEstimate(input);

    expect(marketData.getBars).toHaveBeenCalledWith('AAPL', window, asOf);
    expect(marketData.getBars).toHaveBeenCalledWith('MSFT', window, asOf);
  });
});
