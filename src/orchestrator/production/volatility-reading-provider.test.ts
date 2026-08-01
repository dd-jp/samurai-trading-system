import type {
  IndicatorSpec,
  IndicatorValue,
  MarketDataService,
} from '../../market-data-service/index.js';
import type { UniverseInstrument } from '../types.js';
import { MarketDataVolatilityReadingProvider } from './volatility-reading-provider.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const VOLATILITY_INDICATOR: IndicatorSpec = {
  indicator: 'atr',
  params: { period: 14 },
  lookback: 20,
};

/** Fixture universe deliberately shaped so max, average, and first value all disagree per class. */
const UNIVERSE: readonly UniverseInstrument[] = [
  { asset: 'BTC-USD', asset_class: 'crypto' },
  { asset: 'ETH-USD', asset_class: 'crypto' },
  { asset: 'SOL-USD', asset_class: 'crypto' },
  { asset: 'AAPL', asset_class: 'stocks' },
  { asset: 'TSLA', asset_class: 'stocks' },
];

/** instrument -> indicator value, so the fixture reads like a small table. */
const READING_BY_INSTRUMENT: Record<string, number> = {
  'BTC-USD': 10,
  'ETH-USD': 40, // crypto max; not first (BTC-USD) nor average (~23.33)
  'SOL-USD': 20,
  AAPL: 5,
  TSLA: 15, // stocks max; not first (AAPL) nor average (10)
};

function fixtureIndicatorValue(instrument: string): IndicatorValue {
  return {
    indicator: VOLATILITY_INDICATOR.indicator,
    value: READING_BY_INSTRUMENT[instrument],
    as_of_bar_close: NOW,
  };
}

function buildProvider(universe: readonly UniverseInstrument[] = UNIVERSE) {
  const getIndicator = vi.fn(async (instrument: string, _spec: IndicatorSpec, _asOf: Date) =>
    fixtureIndicatorValue(instrument),
  );
  const marketData = { getIndicator } as unknown as MarketDataService;

  const provider = new MarketDataVolatilityReadingProvider({
    marketData,
    universe,
    volatility_indicator: VOLATILITY_INDICATOR,
  });

  return { provider, getIndicator };
}

describe('MarketDataVolatilityReadingProvider', () => {
  it('aggregates by max per asset class, not average or first value', async () => {
    const { provider } = buildProvider();

    const reading = await provider.getVolatilityReading(NOW);

    expect(reading).toEqual({ crypto: 40, stocks: 15 });
  });

  it('calls getIndicator for every universe instrument with the configured spec and asOf — unconditionally universe-wide, with no positions-gated fallback (nothing about open positions is ever passed in)', async () => {
    const { provider, getIndicator } = buildProvider();

    await provider.getVolatilityReading(NOW);

    expect(getIndicator).toHaveBeenCalledTimes(UNIVERSE.length);
    for (const instrument of UNIVERSE) {
      expect(getIndicator).toHaveBeenCalledWith(instrument.asset, VOLATILITY_INDICATOR, NOW);
    }
  });

  it('returns 0 for an asset class with no instruments in the universe, rather than a default-instrument fallback', async () => {
    const cryptoOnly: readonly UniverseInstrument[] = [{ asset: 'BTC-USD', asset_class: 'crypto' }];
    const { provider } = buildProvider(cryptoOnly);

    const reading = await provider.getVolatilityReading(NOW);

    expect(reading).toEqual({ crypto: 10, stocks: 0 });
  });
});
