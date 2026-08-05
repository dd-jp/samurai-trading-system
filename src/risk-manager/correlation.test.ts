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

/**
 * #303: an omitted pair used to be indistinguishable from a genuinely
 * uncorrelated one — the concentration check reads both as "not correlated".
 * `insufficient_history` names the omitted pairs so the caller can tell the
 * two apart. It changes no limit; it only removes the conflation.
 */
describe('computeCorrelationEstimate — insufficient_history (#303)', () => {
  it('names an omitted pair in insufficient_history rather than only dropping it', async () => {
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

    expect(estimate.correlations).toEqual({});
    expect(estimate.insufficient_history).toEqual(['MSFT']);
  });

  it('names an instrument with no bars at all in insufficient_history', async () => {
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', [100, 101, 102, 103, 104, 105]),
    });
    const input = makeInput({ otherInstruments: ['MSFT'], marketData });

    const estimate = await computeCorrelationEstimate(input);

    expect(estimate.insufficient_history).toEqual(['MSFT']);
  });

  it('leaves insufficient_history empty when every pair has enough overlap', async () => {
    const closes = [100, 102, 101, 105, 108, 107];
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', closes),
      MSFT: makeBars('MSFT', closes),
    });
    const input = makeInput({ otherInstruments: ['MSFT'], marketData });

    const estimate = await computeCorrelationEstimate(input);

    expect(estimate.correlations.MSFT).toBeCloseTo(1, 5);
    expect(estimate.insufficient_history).toEqual([]);
  });

  it('separates the covered pairs from the uncovered ones in a mixed portfolio', async () => {
    const closes = [100, 102, 101, 105, 108, 107];
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', closes),
      MSFT: makeBars('MSFT', closes),
      TSLA: makeBars('TSLA', [50, 51]), // thin — below min_bars
      'ETH-USD': [], // newly listed — no bars at all
    });
    const input = makeInput({
      otherInstruments: ['MSFT', 'TSLA', 'ETH-USD'],
      marketData,
      config: makeConfig({ min_bars: 3 }),
    });

    const estimate = await computeCorrelationEstimate(input);

    expect(Object.keys(estimate.correlations)).toEqual(['MSFT']);
    expect(estimate.insufficient_history).toEqual(['TSLA', 'ETH-USD']);
  });

  /**
   * The #381 widening scenario: the ADR-0001 universe on day 1 of a soak.
   * Every pair is under `min_bars`, so `correlations` is empty and the
   * concentration check cannot bind. Without `insufficient_history` that is
   * byte-for-byte identical to a genuinely diversified portfolio.
   */
  it('reports all five peers of a six-instrument day-1 portfolio as uncovered', async () => {
    const universe = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'BTC-USD', 'ETH-USD'];
    const marketData = makeMarketData(
      Object.fromEntries(universe.map((i) => [i, makeBars(i, [100, 101])])), // 1 return each
    );
    const input = makeInput({
      instrument: 'SPY',
      otherInstruments: universe.slice(1),
      marketData,
      config: makeConfig({ min_bars: 20 }),
    });

    const estimate = await computeCorrelationEstimate(input);

    expect(estimate.correlations).toEqual({});
    expect(estimate.insufficient_history).toEqual(['QQQ', 'AAPL', 'TSLA', 'BTC-USD', 'ETH-USD']);
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

    expect(marketData.getBars).toHaveBeenCalledWith('AAPL', { ...window, partial: 'allow' }, asOf);
    expect(marketData.getBars).toHaveBeenCalledWith('MSFT', { ...window, partial: 'allow' }, asOf);
  });

  /**
   * #292: a short bar window is degraded-but-valid HERE and nowhere else —
   * `min_bars` already omits an under-covered pair. Without the opt-in, a
   * single thin peer would reject the whole `Promise.all` and take every
   * instrument's correlation read (and the tick) down with it.
   */
  it('opts into a partial read, since min_bars already handles a short window', async () => {
    const marketData = makeMarketData({
      AAPL: makeBars('AAPL', [100, 101, 102, 103]),
      MSFT: makeBars('MSFT', [50, 51, 52, 53]),
    });
    const input = makeInput({ otherInstruments: ['MSFT'], marketData, asOf });

    await computeCorrelationEstimate(input);

    for (const call of (marketData.getBars as ReturnType<typeof vi.fn>).mock.calls) {
      expect((call[1] as BarWindow).partial).toBe('allow');
    }
  });
});
