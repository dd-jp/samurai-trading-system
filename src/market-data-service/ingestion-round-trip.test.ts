/**
 * Integration coverage for #66: crypto and stock instruments round-trip from
 * Alpaca's native payload, through ingestion normalization, out of
 * `MarketDataServiceImpl.getBars` — the path a real consumer takes. (The
 * ccxt/ibkr legs left with those sources' deletion — review 2026-08-06 C:
 * unconstructed from any composition root; restore from git history when a
 * second venue is actually wired.)
 */
import type { Clock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { formingCandleClient } from './forming-candle-client.js';
import { InsufficientBarsError } from './indicators.js';
import { MarketDataServiceImpl } from './service.js';
import { type AlpacaBar, type AlpacaClient, AlpacaDataSource } from './sources/alpaca-source.js';
import { SqliteMarketDataStore } from './sqlite-market-data-store.js';

class ManualClock implements Clock {
  constructor(private readonly time: Date) {}

  now(): Date {
    return this.time;
  }
}

const ASOF = new Date('2026-07-15T18:00:00Z'); // Wednesday, 14:00 ET — mid-session

/** BTC on Alpaca's crypto feed, including candles no equity session would allow. */
const CRYPTO_ROWS: AlpacaBar[] = [
  { t: '2026-07-15T02:00:00Z', o: 60_000, h: 60_500, l: 59_900, c: 60_400, v: 3 },
  { t: '2026-07-15T14:00:00Z', o: 60_400, h: 61_000, l: 60_300, c: 60_900, v: 4 },
  { t: '2026-07-15T18:00:00Z', o: 60_900, h: 61_200, l: 60_800, c: 61_100, v: 5 }, // forming at asOf
];

/** AAPL on Alpaca, including pre-market and after-hours bars. */
const ALPACA_ROWS: AlpacaBar[] = [
  { t: '2026-07-15T12:00:00Z', o: 190, h: 191, l: 189, c: 190.5, v: 100 }, // 08:00 ET pre-market
  { t: '2026-07-15T14:00:00Z', o: 190.5, h: 193, l: 190, c: 192, v: 900 }, // 10:00 ET in session
  { t: '2026-07-15T22:00:00Z', o: 192, h: 194, l: 191, c: 193, v: 50 }, // 18:00 ET after hours
];

const cryptoClient: AlpacaClient = {
  getBars: async () => CRYPTO_ROWS,
  getLatestQuote: async () => ({ t: '2026-07-15T17:59:45Z', ap: 61_055, bp: 61_045 }),
};

const alpacaClient: AlpacaClient = {
  getBars: async () => ALPACA_ROWS,
  getLatestQuote: async () => ({ t: '2026-07-15T17:59:45Z', ap: 192.6, bp: 192.4 }),
};

function serviceFor(source: AlpacaDataSource, mode: 'live' | 'backtest' = 'backtest') {
  return new MarketDataServiceImpl(
    source,
    new ManualClock(ASOF),
    mode,
    new SqliteMarketDataStore(openSharedStore(':memory:')),
  );
}

describe('crypto round-trip: source payload -> ingestion -> getBars', () => {
  const service = serviceFor(new AlpacaDataSource(cryptoClient, { asset_class: 'crypto' }));

  it('serves normalized 24/7 bars, excluding only the forming candle', async () => {
    const bars = await service.getBars('BTC/USD', { timeframe: '1h', lookback: 10 }, ASOF);

    expect(bars).toEqual([
      {
        instrument: 'BTC/USD',
        timeframe: '1h',
        open_time: new Date('2026-07-15T02:00:00Z'),
        close_time: new Date('2026-07-15T03:00:00Z'),
        open: 60_000,
        high: 60_500,
        low: 59_900,
        close: 60_400,
        volume: 3,
        source: 'alpaca',
      },
      {
        instrument: 'BTC/USD',
        timeframe: '1h',
        open_time: new Date('2026-07-15T14:00:00Z'),
        close_time: new Date('2026-07-15T15:00:00Z'),
        open: 60_400,
        high: 61_000,
        low: 60_300,
        close: 60_900,
        volume: 4,
        source: 'alpaca',
      },
    ]);
  });

  it('keeps the 02:00 UTC bar — crypto has no session to fall outside of', async () => {
    const bars = await service.getBars('BTC/USD', { timeframe: '1h', lookback: 10 }, ASOF);

    expect(bars.some((b) => b.open_time.toISOString() === '2026-07-15T02:00:00.000Z')).toBe(true);
  });

  it('derives a backtest mark from the last completed bar', async () => {
    const mark = await serviceFor(
      new AlpacaDataSource(cryptoClient, { asset_class: 'crypto', markTimeframe: '1h' }),
      'backtest',
    ).getMark('BTC/USD', ASOF);

    expect(mark.price).toBe(60_900); // not the live 61_050
    expect(mark.observed_at).toEqual(new Date('2026-07-15T15:00:00Z'));
    expect(mark.asset_class).toBe('crypto');
  });
});

describe('stock round-trip: Alpaca payload -> ingestion -> getBars', () => {
  const service = serviceFor(new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' }));

  it('serves only the in-session bar, dropping pre-market and after-hours', async () => {
    const bars = await service.getBars('AAPL', { timeframe: '1h', lookback: 10 }, ASOF);

    expect(bars).toEqual([
      {
        instrument: 'AAPL',
        timeframe: '1h',
        open_time: new Date('2026-07-15T14:00:00Z'),
        close_time: new Date('2026-07-15T15:00:00Z'),
        open: 190.5,
        high: 193,
        low: 190,
        close: 192,
        volume: 900,
        source: 'alpaca',
      },
    ]);
  });

  it('serves a live mark whose observed_at is the quote time, not the request time', async () => {
    const liveService = serviceFor(
      new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' }),
      'live',
    );

    const mark = await liveService.getMark('AAPL', ASOF);

    expect(mark.price).toBe(192.5);
    expect(mark.observed_at).toEqual(new Date('2026-07-15T17:59:45Z'));
    expect(mark.observed_at).not.toEqual(ASOF);
  });
});

describe('cold start: first tick with an empty store (#362)', () => {
  const COLD_ASOF = new Date('2026-07-15T18:30:00Z'); // mid-hour: current candle is forming

  it('produces a usable sma(14) on the very first tick, no "needs 14 but received 13"', async () => {
    // formingCandleClient: a cold, empty store has nothing else to fall back
    // on, so a fetch that lands one bar short surfaces immediately as
    // `InsufficientBarsError` instead of self-healing on a later tick.
    const service = new MarketDataServiceImpl(
      new AlpacaDataSource(formingCandleClient(COLD_ASOF), { asset_class: 'crypto' }),
      new ManualClock(COLD_ASOF),
      'live',
      new SqliteMarketDataStore(openSharedStore(':memory:')), // empty store: genuine cold start
    );

    const sma = await service.getIndicator(
      'BTC-USD',
      { indicator: 'sma', params: {}, timeframe: '1h', lookback: 14 },
      COLD_ASOF,
    );

    expect(Number.isFinite(sma.value)).toBe(true);
  });

  it('still refuses a window that is genuinely short, not just short by the forming bar', async () => {
    // A source that always returns exactly 5 bars, whatever `limit` asked
    // for — a genuinely sparse instrument, not a forming-candle artifact.
    // The #319 guard must still throw here: the fetch-width fix must not
    // paper over a real shortfall.
    const sparseClient: AlpacaClient = {
      getBars: async (): Promise<AlpacaBar[]> =>
        Array.from({ length: 5 }, (_, i) => ({
          t: new Date(COLD_ASOF.getTime() - (5 - i) * 3_600_000).toISOString(),
          o: 100,
          h: 101,
          l: 99,
          c: 100,
          v: 10,
        })),
      getLatestQuote: async () => ({ t: COLD_ASOF.toISOString(), ap: 100, bp: 100 }),
    };
    const service = new MarketDataServiceImpl(
      new AlpacaDataSource(sparseClient, { asset_class: 'crypto' }),
      new ManualClock(COLD_ASOF),
      'live',
      new SqliteMarketDataStore(openSharedStore(':memory:')),
    );

    await expect(
      service.getIndicator(
        'BTC-USD',
        { indicator: 'sma', params: {}, timeframe: '1h', lookback: 14 },
        COLD_ASOF,
      ),
    ).rejects.toThrow(InsufficientBarsError);
  });
});
