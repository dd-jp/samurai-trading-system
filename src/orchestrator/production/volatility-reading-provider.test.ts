import type {
  IndicatorSpec,
  IndicatorValue,
  MarketDataService,
} from '../../market-data-service/index.js';
import type { Logger, UniverseInstrument } from '../types.js';
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

function fakeLogger(): { logger: Logger; log: ReturnType<typeof vi.fn> } {
  const log = vi.fn();
  return { logger: { log }, log };
}

/**
 * `behaviorByInstrument` lets a test make specific instruments reject or
 * resolve with a non-finite value, to exercise the fail-closed boundary
 * handling without touching the happy-path fixture table above.
 */
function buildProvider(
  universe: readonly UniverseInstrument[] = UNIVERSE,
  behaviorByInstrument: Record<string, 'reject' | 'nan'> = {},
) {
  const getIndicator = vi.fn(async (instrument: string, _spec: IndicatorSpec, _asOf: Date) => {
    const behavior = behaviorByInstrument[instrument];
    if (behavior === 'reject') {
      throw new Error(`getIndicator failed for ${instrument}`);
    }
    if (behavior === 'nan') {
      return { ...fixtureIndicatorValue(instrument), value: Number.NaN };
    }
    return fixtureIndicatorValue(instrument);
  });
  const marketData = { getIndicator } as unknown as MarketDataService;
  const { logger, log } = fakeLogger();

  const provider = new MarketDataVolatilityReadingProvider({
    marketData,
    universe,
    volatility_indicator: VOLATILITY_INDICATOR,
    logger,
  });

  return { provider, getIndicator, log };
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

  it('warns when an asset class has no instruments in the universe, so a config slip is visible', async () => {
    const cryptoOnly: readonly UniverseInstrument[] = [{ asset: 'BTC-USD', asset_class: 'crypto' }];
    const { provider, log } = buildProvider(cryptoOnly);

    await provider.getVolatilityReading(NOW);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', payload: { asset_class: 'stocks' } }),
    );
  });

  it('fails closed (does not exclude the instrument from the max) when getIndicator rejects for one instrument', async () => {
    const { provider, log } = buildProvider(UNIVERSE, { 'ETH-USD': 'reject' });

    const reading = await provider.getVolatilityReading(NOW);

    // ETH-USD was crypto's max (40) in the happy path; a rejection must still trip the
    // class to the fail-closed sentinel, not silently fall back to the next-highest value.
    expect(reading.crypto).toBe(Number.POSITIVE_INFINITY);
    expect(reading.stocks).toBe(15);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        payload: expect.objectContaining({ instrument: 'ETH-USD', asset_class: 'crypto' }),
      }),
    );
  });

  it('fails closed (does not silently disable the breaker via NaN) when getIndicator returns a non-finite value', async () => {
    const { provider, log } = buildProvider(UNIVERSE, { TSLA: 'nan' });

    const reading = await provider.getVolatilityReading(NOW);

    // TSLA was stocks' max (15) in the happy path; a NaN reading must still trip the
    // class to the fail-closed sentinel rather than making every `>` comparison false.
    expect(reading.stocks).toBe(Number.POSITIVE_INFINITY);
    expect(reading.crypto).toBe(40);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        payload: expect.objectContaining({ instrument: 'TSLA', asset_class: 'stocks' }),
      }),
    );
  });

  it('still calls getIndicator for every instrument even when an earlier one rejects (Promise.allSettled, not Promise.all)', async () => {
    const { provider, getIndicator } = buildProvider(UNIVERSE, { 'BTC-USD': 'reject' });

    await provider.getVolatilityReading(NOW);

    expect(getIndicator).toHaveBeenCalledTimes(UNIVERSE.length);
  });
});
