/**
 * Integration coverage for #66: one crypto and one stock instrument round-trip
 * from a source's native payload, through ingestion normalization, out of
 * `MarketDataServiceImpl.getBars` — the path a real consumer takes.
 */
import type { Clock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { MarketDataServiceImpl } from './service.js';
import { createDataSource, type DataSourceConfig } from './source-factory.js';
import type { AlpacaBar, AlpacaClient } from './sources/alpaca-source.js';
import type { CcxtClient, CcxtOhlcv } from './sources/ccxt-source.js';
import type { IbkrClient, IbkrHistoricalBar } from './sources/ibkr-source.js';
import { SqliteMarketDataStore } from './sqlite-market-data-store.js';

class ManualClock implements Clock {
  constructor(private readonly time: Date) {}

  now(): Date {
    return this.time;
  }
}

const ASOF = new Date('2026-07-15T18:00:00Z'); // Wednesday, 14:00 ET — mid-session

/** BTC on Kraken, including candles no equity session would allow. */
const KRAKEN_ROWS: CcxtOhlcv[] = [
  [Date.parse('2026-07-15T02:00:00Z'), 60_000, 60_500, 59_900, 60_400, 3],
  [Date.parse('2026-07-15T14:00:00Z'), 60_400, 61_000, 60_300, 60_900, 4],
  [Date.parse('2026-07-15T18:00:00Z'), 60_900, 61_200, 60_800, 61_100, 5], // forming at asOf
];

/** AAPL on Alpaca, including pre-market and after-hours bars. */
const ALPACA_ROWS: AlpacaBar[] = [
  { t: '2026-07-15T12:00:00Z', o: 190, h: 191, l: 189, c: 190.5, v: 100 }, // 08:00 ET pre-market
  { t: '2026-07-15T14:00:00Z', o: 190.5, h: 193, l: 190, c: 192, v: 900 }, // 10:00 ET in session
  { t: '2026-07-15T22:00:00Z', o: 192, h: 194, l: 191, c: 193, v: 50 }, // 18:00 ET after hours
];

const krakenClient: CcxtClient = {
  fetchOHLCV: async () => KRAKEN_ROWS,
  fetchTicker: async () => ({ last: 61_050, timestamp: Date.parse('2026-07-15T17:59:45Z') }),
};

const alpacaClient: AlpacaClient = {
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

describe('crypto round-trip: ccxt payload -> ingestion -> getBars', () => {
  const service = serviceFor({ kind: 'ccxt', client: krakenClient });

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
        source: 'kraken',
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
        source: 'kraken',
      },
    ]);
  });

  it('keeps the 02:00 UTC bar — crypto has no session to fall outside of', async () => {
    const bars = await service.getBars('BTC/USD', { timeframe: '1h', lookback: 10 }, ASOF);

    expect(bars.some((b) => b.open_time.toISOString() === '2026-07-15T02:00:00.000Z')).toBe(true);
  });

  it('derives a backtest mark from the last completed bar', async () => {
    const mark = await serviceFor(
      { kind: 'ccxt', client: krakenClient, markTimeframe: '1h' },
      'backtest',
    ).getMark('BTC/USD', ASOF);

    expect(mark.price).toBe(60_900); // not the live 61_050
    expect(mark.observed_at).toEqual(new Date('2026-07-15T15:00:00Z'));
    expect(mark.asset_class).toBe('crypto');
  });
});

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
  const ibkrClient: IbkrClient = {
    getHistoricalBars: async (): Promise<IbkrHistoricalBar[]> => [
      { time: '2026-07-15T14:00:00Z', open: 190.5, high: 193, low: 190, close: 192, volume: 900 },
    ],
    getLastTrade: async () => ({ price: 192.5, time: '2026-07-15T17:59:45Z' }),
  };

  /** The consumer: depends on the port only, and never names a source. */
  async function readCloses(service: MarketDataServiceImpl): Promise<number[]> {
    const bars = await service.getBars('AAPL', { timeframe: '1h', lookback: 10 }, ASOF);
    return bars.map((bar) => bar.close);
  }

  it('serves the same consumer result from Alpaca and IBKR configs', async () => {
    const fromAlpaca = await readCloses(
      serviceFor({ kind: 'alpaca', client: alpacaClient, asset_class: 'stocks' }),
    );
    const fromIbkr = await readCloses(serviceFor({ kind: 'ibkr', client: ibkrClient }));

    expect(fromAlpaca).toEqual([192]);
    expect(fromIbkr).toEqual(fromAlpaca);
  });

  it('builds every supported source from config alone', async () => {
    const configs: DataSourceConfig[] = [
      { kind: 'ccxt', client: krakenClient },
      { kind: 'alpaca', client: alpacaClient, asset_class: 'stocks' },
      { kind: 'ibkr', client: ibkrClient },
    ];

    for (const config of configs) {
      expect(createDataSource(config).fetchBars).toBeTypeOf('function');
    }
  });

  it('routes ccxt provenance by config, so Kraken->Coinbase is config', async () => {
    const coinbase = serviceFor({ kind: 'ccxt', client: krakenClient, source: 'coinbase' });

    const bars = await coinbase.getBars('BTC/USD', { timeframe: '1h', lookback: 1 }, ASOF);

    expect(bars[0]?.source).toBe('coinbase');
  });
});
