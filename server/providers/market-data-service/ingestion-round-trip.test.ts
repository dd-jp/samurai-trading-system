/**
 * Integration coverage for #66: an instrument round-trips from a source's
 * native payload, through ingestion normalization, out of
 * `MarketDataServiceImpl.getBars` — the path a real consumer takes.
 */
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { formingCandleClient } from './forming-candle-client.js';
import { InsufficientBarsError } from './indicators.js';
import { MarketDataServiceImpl } from './service.js';
import { createDataSource, type DataSourceConfig } from './source-factory.js';
import {
  type AlpacaBar,
  AlpacaDataSource,
  type AlpacaMarketDataClient,
} from './sources/alpaca-source.js';
import type { LseMarkClient } from './sources/lse-mark-source.js';
import { SqliteMarketDataStore } from './sqlite-market-data-store.js';

class ManualClock implements Clock {
  constructor(private readonly time: Date) {}

  now(): Date {
    return this.time;
  }
}

const ASOF = new Date('2026-07-15T18:00:00Z'); // Wednesday, 14:00 ET — mid-session

/** AAPL on Alpaca, including pre-market and after-hours bars. */
const ALPACA_ROWS: AlpacaBar[] = [
  { t: '2026-07-15T12:00:00Z', o: 190, h: 191, l: 189, c: 190.5, v: 100 }, // 08:00 ET pre-market
  { t: '2026-07-15T14:00:00Z', o: 190.5, h: 193, l: 190, c: 192, v: 900 }, // 10:00 ET in session
  { t: '2026-07-15T22:00:00Z', o: 192, h: 194, l: 191, c: 193, v: 50 }, // 18:00 ET after hours
];

const alpacaClient: AlpacaMarketDataClient = {
  getBars: async () => ALPACA_ROWS,
  getLatestQuote: async () => ({ t: '2026-07-15T17:59:45Z', ap: 192.6, bp: 192.4 }),
};

function serviceFor(config: DataSourceConfig, mode: 'live' | 'backtest' = 'backtest') {
  return new MarketDataServiceImpl(
    createDataSource(config),
    new ManualClock(ASOF),
    mode,
    new SqliteMarketDataStore(openSharedStore(':memory:')),
  );
}

describe('stock round-trip: Alpaca payload -> ingestion -> getBars', () => {
  const service = serviceFor({ kind: 'alpaca', client: alpacaClient, asset_class: 'stocks' });

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
      { kind: 'alpaca', client: alpacaClient, asset_class: 'stocks' },
      'live',
    );

    const mark = await liveService.getMark('AAPL', ASOF);

    expect(mark.price).toBe(192.5);
    expect(mark.observed_at).toEqual(new Date('2026-07-15T17:59:45Z'));
    expect(mark.observed_at).not.toEqual(ASOF);
  });
});

describe('swapping DataSource is a config change, not a code change', () => {
  /**
   * The same AAPL session bar as `ALPACA_ROWS`, quoted in GBX so the LSE
   * source's pence conversion has something to do — 19_200 GBX is 192 GBP,
   * which is what a consumer must see whichever arm served it.
   */
  const lseClient: LseMarkClient = {
    vendor: 'fake-lse-vendor',
    getBars: async () => ({
      currency: 'GBX',
      candles: [
        {
          open_time: new Date('2026-07-15T14:00:00Z'),
          open: 19_050,
          high: 19_300,
          low: 19_000,
          close: 19_200,
          volume: 900,
        },
      ],
    }),
    getLatestQuote: async () => ({
      price: 19_250,
      currency: 'GBX',
      observed_at: new Date('2026-07-15T15:59:45Z'),
    }),
  };

  const LSE_CONFIG: DataSourceConfig = {
    kind: 'lse',
    client: lseClient,
    tradeable: new Set(['LQQ3']),
  };

  /** The consumer: depends on the port only, and never names a source. */
  async function readCloses(service: MarketDataServiceImpl, instrument: string): Promise<number[]> {
    const bars = await service.getBars(instrument, { timeframe: '1h', lookback: 10 }, ASOF);
    return bars.map((bar) => bar.close);
  }

  it('serves the same consumer result from the Alpaca and LSE configs', async () => {
    const fromAlpaca = await readCloses(
      serviceFor({ kind: 'alpaca', client: alpacaClient, asset_class: 'stocks' }),
      'AAPL',
    );
    const fromLse = await readCloses(serviceFor(LSE_CONFIG), 'LQQ3');

    expect(fromAlpaca).toEqual([192]);
    expect(fromLse).toEqual(fromAlpaca);
  });

  it('builds every supported source from config alone', async () => {
    const configs: DataSourceConfig[] = [
      { kind: 'alpaca', client: alpacaClient, asset_class: 'stocks' },
      LSE_CONFIG,
    ];

    for (const config of configs) {
      expect(createDataSource(config).fetchBars).toBeTypeOf('function');
    }
  });

  it('stamps provenance with the vendor the config named, so swapping vendor is config', async () => {
    const service = serviceFor({
      ...LSE_CONFIG,
      client: { ...lseClient, vendor: 'another-lse-vendor' },
    });

    const bars = await service.getBars('LQQ3', { timeframe: '1h', lookback: 1 }, ASOF);

    expect(bars[0]?.source).toBe('another-lse-vendor');
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
    const sparseClient: AlpacaMarketDataClient = {
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
