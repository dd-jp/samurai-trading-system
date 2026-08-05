import type {
  Bar,
  IndicatorSpec,
  IndicatorValue,
  MarketDataService,
  TradingCalendar,
} from '../../market-data-service/index.js';
import {
  AlwaysOpenCalendar,
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
  UsEquityRegularHoursCalendar,
} from '../../market-data-service/index.js';
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { AssetClass, Logger, UniverseInstrument } from '../types.js';
import { MarketDataVolatilityReadingProvider } from './volatility-reading-provider.js';

/** Tuesday 10:00 ET — the US equity session is open, so the gate admits both classes. */
const NOW = new Date('2026-07-28T14:00:00Z');
/** Sunday night — the US equity session is shut, crypto is not. */
const SESSION_SHUT = new Date('2026-07-19T23:00:00Z');
/**
 * Tuesday 03:00 ET — a TRADING DAY, but hours before the open. Most of the
 * overnight error volume #386 measured came from weekday nights, not
 * weekends, so this pins the gate to `isOpen` and not `isTradingDay`.
 */
const WEEKDAY_OVERNIGHT = new Date('2026-07-28T07:00:00Z');

const CALENDARS: Record<AssetClass, TradingCalendar> = {
  crypto: new AlwaysOpenCalendar(),
  stocks: new UsEquityRegularHoursCalendar(),
};
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
    calendars: CALENDARS,
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

  it('fails closed against the REAL MarketDataService when an instrument is short of bars (#319)', async () => {
    // The other fail-closed tests above drive a stubbed `getIndicator`. This
    // one wires the real `MarketDataServiceImpl` over a real SQLite store, so
    // it pins the actual production path #319 changed: a cold instrument now
    // makes `computeIndicator` THROW rather than answer an ATR(14) computed
    // from 5 true ranges. That throw lands on the already-shipped rejected
    // branch and aggregates as `FAILURE_READING`, so the volatility breaker
    // trips conservatively instead of comparing against a fabricated number
    // — which is why throwing is consistent with this module's posture
    // rather than a new failure mode it has to learn about.
    const asOf = new Date('2026-07-28T14:00:00Z');
    const warmInstrument = 'BTC-USD';
    const coldInstrument = 'ETH-USD';
    const universe: readonly UniverseInstrument[] = [
      { asset: warmInstrument, asset_class: 'crypto' },
      { asset: coldInstrument, asset_class: 'crypto' },
    ];

    const bar = (instrument: string, index: number, count: number): Bar => {
      const closeTime = new Date(asOf.getTime() - (count - 1 - index) * 60 * 60 * 1000);
      const close = 100 + Math.sin(index / 3) * 4;
      return {
        instrument,
        timeframe: '1h',
        open_time: new Date(closeTime.getTime() - 60 * 60 * 1000),
        close_time: closeTime,
        open: close,
        high: close + 2,
        low: close - 2,
        close,
        volume: 1,
        source: 'fixture',
      };
    };

    const bars: Bar[] = [
      // Warm: 20 bars, comfortably past the ATR(14) width.
      ...Array.from({ length: 20 }, (_, i) => bar(warmInstrument, i, 20)),
      // Cold: 6 bars — enough that no source call was short, not enough for ATR(14).
      ...Array.from({ length: 6 }, (_, i) => bar(coldInstrument, i, 6)),
    ];

    const clock: Clock = { now: () => asOf };
    const marketData = new MarketDataServiceImpl(
      new FixtureDataSource(bars, { price: 100, observed_at: asOf, source: 'fixture' }, 'crypto'),
      clock,
      'backtest',
      new SqliteMarketDataStore(openSharedStore(':memory:')),
    );
    const { logger, log } = fakeLogger();

    const provider = new MarketDataVolatilityReadingProvider({
      marketData,
      universe,
      volatility_indicator: { indicator: 'atr', params: { period: 14 }, lookback: 15 },
      calendars: CALENDARS,
      logger,
    });

    const reading = await provider.getVolatilityReading(asOf);

    expect(reading.crypto).toBe(Number.POSITIVE_INFINITY);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        payload: expect.objectContaining({ instrument: coldInstrument }),
      }),
    );
  });

  it('still calls getIndicator for every instrument even when an earlier one rejects (Promise.allSettled, not Promise.all)', async () => {
    const { provider, getIndicator } = buildProvider(UNIVERSE, { 'BTC-USD': 'reject' });

    await provider.getVolatilityReading(NOW);

    expect(getIndicator).toHaveBeenCalledTimes(UNIVERSE.length);
  });

  it('warns for an empty asset class once at construction, not on every getVolatilityReading call', async () => {
    const cryptoOnly: readonly UniverseInstrument[] = [{ asset: 'BTC-USD', asset_class: 'crypto' }];
    const { provider, log } = buildProvider(cryptoOnly);
    log.mockClear();

    await provider.getVolatilityReading(NOW);
    await provider.getVolatilityReading(NOW);

    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  it('bounds in-flight getIndicator calls to the concurrency cap on a large universe', async () => {
    const bigUniverse: readonly UniverseInstrument[] = Array.from({ length: 40 }, (_, i) => ({
      asset: `INST-${i}`,
      asset_class: i % 2 === 0 ? 'crypto' : 'stocks',
    }));

    let inFlight = 0;
    let maxInFlight = 0;
    const getIndicator = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { indicator: VOLATILITY_INDICATOR.indicator, value: 1, as_of_bar_close: NOW };
    });
    const marketData = { getIndicator } as unknown as MarketDataService;
    const { logger } = fakeLogger();

    const provider = new MarketDataVolatilityReadingProvider({
      marketData,
      universe: bigUniverse,
      volatility_indicator: VOLATILITY_INDICATOR,
      calendars: CALENDARS,
      logger,
    });

    await provider.getVolatilityReading(NOW);

    expect(getIndicator).toHaveBeenCalledTimes(bigUniverse.length);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  describe('does not read a class whose venue is shut (#386)', () => {
    it('calls getIndicator only for the instruments that are in session', async () => {
      const { provider, getIndicator } = buildProvider();

      await provider.getVolatilityReading(SESSION_SHUT);

      expect(getIndicator).toHaveBeenCalledTimes(3); // the three crypto pairs
      for (const asset of ['BTC-USD', 'ETH-USD', 'SOL-USD']) {
        expect(getIndicator).toHaveBeenCalledWith(asset, VOLATILITY_INDICATOR, SESSION_SHUT);
      }
      for (const asset of ['AAPL', 'TSLA']) {
        expect(getIndicator).not.toHaveBeenCalledWith(asset, VOLATILITY_INDICATOR, SESSION_SHUT);
      }
    });

    it('reads the shut class as 0 (inert), not as the fail-closed Infinity sentinel', async () => {
      // Pre-fix every equity threw `atr(14) needs 15 bars but received 12` and
      // folded in as `FAILURE_READING`, arming `volatility_halt:stocks` for ~16
      // hours a weekday and all weekend on a bar-count artifact.
      const { provider } = buildProvider();

      const reading = await provider.getVolatilityReading(SESSION_SHUT);

      expect(reading).toEqual({ crypto: 40, stocks: 0 });
    });

    it('logs no per-instrument error line while the venue is shut', async () => {
      // ~5,700 `error` lines a day on a 14-day soak, all of them expected —
      // the alert-fatigue failure mode #383 and #362 fixed elsewhere.
      const { provider, log } = buildProvider(UNIVERSE, { AAPL: 'reject', TSLA: 'reject' });

      await provider.getVolatilityReading(SESSION_SHUT);

      expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
    });

    it('gates on the SESSION, not the trading day — a weekday night is shut too', async () => {
      // `isTradingDay` is true all Tuesday, including 03:00 ET. Gating on it
      // would leave the weekday-overnight hours reading equities, which is
      // where most of #386's ~5,700 error lines a day actually came from.
      const { provider, getIndicator } = buildProvider();

      const reading = await provider.getVolatilityReading(WEEKDAY_OVERNIGHT);

      expect(getIndicator).toHaveBeenCalledTimes(3); // the three crypto pairs
      expect(reading.stocks).toBe(0);
    });

    it('reads the class again on the very next in-session tick, so the gate never latches', async () => {
      const { provider, getIndicator } = buildProvider();

      await provider.getVolatilityReading(SESSION_SHUT);
      const reading = await provider.getVolatilityReading(NOW);

      expect(getIndicator).toHaveBeenCalledWith('AAPL', VOLATILITY_INDICATOR, NOW);
      expect(reading).toEqual({ crypto: 40, stocks: 15 });
    });

    it('still fails closed for an in-session instrument that cannot be read', async () => {
      // The gate must not become a way for a genuine equity failure to go quiet.
      const { provider, log } = buildProvider(UNIVERSE, { TSLA: 'reject' });

      const reading = await provider.getVolatilityReading(NOW);

      expect(reading.stocks).toBe(Number.POSITIVE_INFINITY);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
    });
  });

  it('redacts query-string-shaped substrings from a rejected getIndicator error before logging', async () => {
    const getIndicator = vi.fn(async (instrument: string) => {
      throw new Error(
        `request to https://market-data.example/v1/quote?api_key=SECRET123&x=1 failed for ${instrument}`,
      );
    });
    const marketData = { getIndicator } as unknown as MarketDataService;
    const { logger, log } = fakeLogger();

    const provider = new MarketDataVolatilityReadingProvider({
      marketData,
      universe: [{ asset: 'BTC-USD', asset_class: 'crypto' }],
      volatility_indicator: VOLATILITY_INDICATOR,
      calendars: CALENDARS,
      logger,
    });

    await provider.getVolatilityReading(NOW);

    const errorCall = log.mock.calls.find((call) => call[0].level === 'error');
    expect(errorCall?.[0].payload.error).not.toContain('SECRET123');
    expect(errorCall?.[0].payload.error).toContain('api_key=[redacted]');
  });
});
