import type { Bar } from '../providers/market-data-service/index.js';
import {
  bucketSampleEnd,
  CALIBRATION_WINDOW,
  INTRADAY_CALIBRATION_WINDOW,
  type QuoteSource,
  runIntradaySpreadCalibration,
  runSpreadCalibration,
  SESSION_BUCKETS,
  type SpreadCalibrationDeps,
  sampleDates,
  usEquityCloseUtc,
  usEquityOpenUtc,
} from './run-spread-calibration.js';
import {
  CALIBRATED_COST_CONFIG,
  CALIBRATED_INTRADAY_COST_CONFIG,
  costConfigFor,
  costConfigFromEnv,
  PESSIMISTIC_COST_CONFIG,
} from './run-stage2.js';
import { STAGE2_FREE_STACK_WINDOW } from './stage2-source.js';

describe('usEquityCloseUtc', () => {
  it('closes at 20:00Z under EDT', () => {
    expect(usEquityCloseUtc(new Date('2025-06-11T00:00:00Z')).toISOString()).toBe(
      '2025-06-11T20:00:00.000Z',
    );
  });

  it('closes at 21:00Z under EST', () => {
    expect(usEquityCloseUtc(new Date('2025-01-15T00:00:00Z')).toISOString()).toBe(
      '2025-01-15T21:00:00.000Z',
    );
  });
});

describe('sampleDates', () => {
  it('spreads the requested count across the window, oldest first', () => {
    const dates = sampleDates(CALIBRATION_WINDOW, 4);

    expect(dates).toHaveLength(4);
    expect(dates[0]?.getTime()).toBeGreaterThanOrEqual(CALIBRATION_WINDOW.start.getTime());
    expect(dates[3]?.getTime()).toBeLessThanOrEqual(CALIBRATION_WINDOW.end.getTime());
    for (let i = 1; i < dates.length; i++) {
      expect((dates[i] as Date).getTime()).toBeGreaterThan((dates[i - 1] as Date).getTime());
    }
  });

  it('returns UTC midnights, so the close offset is applied to a clean date', () => {
    for (const date of sampleDates(CALIBRATION_WINDOW, 6)) {
      expect(date.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });
});

describe('the intraday sampling geometry (#875)', () => {
  it('opens 6.5 hours before the close, under both DST regimes', () => {
    expect(usEquityOpenUtc(new Date('2025-06-11T00:00:00Z')).toISOString()).toBe(
      '2025-06-11T13:30:00.000Z',
    );
    expect(usEquityOpenUtc(new Date('2025-01-15T00:00:00Z')).toISOString()).toBe(
      '2025-01-15T14:30:00.000Z',
    );
  });

  it('samples strictly inside the session, excluding both auctions', () => {
    const date = new Date('2025-06-11T00:00:00Z');
    const open = usEquityOpenUtc(date).getTime();
    const close = usEquityCloseUtc(date).getTime();

    for (const bucket of SESSION_BUCKETS) {
      const end = bucketSampleEnd(date, bucket.minutesAfterOpen).getTime();
      expect(end - 60_000).toBeGreaterThan(open);
      expect(end).toBeLessThan(close);
    }
  });

  it('spreads its buckets across the session rather than sampling one moment', () => {
    const date = new Date('2025-06-11T00:00:00Z');
    const ends = SESSION_BUCKETS.map((b) => bucketSampleEnd(date, b.minutesAfterOpen).getTime());

    for (let i = 1; i < ends.length; i++) {
      expect(ends[i] as number).toBeGreaterThan(ends[i - 1] as number);
    }
    const span = (ends.at(-1) as number) - (ends[0] as number);
    expect(span).toBeGreaterThan(5 * 60 * 60_000);
  });

  it('samples the window an intraday Stage 2 run actually replays', () => {
    expect(INTRADAY_CALIBRATION_WINDOW).toBe(STAGE2_FREE_STACK_WINDOW);
    expect(INTRADAY_CALIBRATION_WINDOW.start.getTime()).toBeLessThan(
      CALIBRATION_WINDOW.start.getTime(),
    );
  });
});

describe('CALIBRATED_COST_CONFIG', () => {
  it('prices spread far below the uncalibrated fixture', () => {
    expect(CALIBRATED_COST_CONFIG.stocks.spreadVolatilityCoefficient).toBeLessThan(
      PESSIMISTIC_COST_CONFIG.stocks.spreadVolatilityCoefficient / 20,
    );
    expect(CALIBRATED_COST_CONFIG.crypto.spreadVolatilityCoefficient).toBeLessThan(
      PESSIMISTIC_COST_CONFIG.crypto.spreadVolatilityCoefficient / 15,
    );
  });

  it('raises the crypto commission to the published taker fee', () => {
    expect(CALIBRATED_COST_CONFIG.crypto.commissionRate).toBe(0.0025);
    expect(CALIBRATED_COST_CONFIG.crypto.commissionRate).toBeGreaterThan(
      PESSIMISTIC_COST_CONFIG.crypto.commissionRate,
    );
  });

  it('leaves the equity commission to the structural floor rather than inventing a rate', () => {
    expect(CALIBRATED_COST_CONFIG.stocks.commissionRate).toBe(0);
  });

  it('derives slippage from the measured spread rather than asserting a new number', () => {
    for (const assetClass of ['crypto', 'stocks'] as const) {
      expect(CALIBRATED_COST_CONFIG[assetClass].slippageCoefficient).toBeCloseTo(
        CALIBRATED_COST_CONFIG[assetClass].spreadVolatilityCoefficient / 4,
        10,
      );
    }
  });

  it('leaves market impact at the pessimistic value', () => {
    expect(CALIBRATED_COST_CONFIG.crypto.impactK).toBe(PESSIMISTIC_COST_CONFIG.crypto.impactK);
    expect(CALIBRATED_COST_CONFIG.stocks.impactK).toBe(PESSIMISTIC_COST_CONFIG.stocks.impactK);
  });
});

describe('costConfigFor — the timeframe-keyed cost config (#875)', () => {
  it('leaves a daily run on exactly the config every recorded daily result used', () => {
    expect(costConfigFor('1d')).toBe(CALIBRATED_COST_CONFIG);
    expect(costConfigFor('1d')).toEqual({
      crypto: {
        spreadVolatilityCoefficient: 0.028,
        commissionRate: 0.0025,
        slippageCoefficient: 0.007,
        impactK: 0.1,
      },
      stocks: {
        spreadVolatilityCoefficient: 0.0037,
        commissionRate: 0,
        slippageCoefficient: 0.000925,
        impactK: 0.05,
      },
    });
  });

  it('switches an intraday run onto the intraday-fitted config', () => {
    expect(costConfigFor('1m')).toBe(CALIBRATED_INTRADAY_COST_CONFIG);
    expect(costConfigFor('5m')).toBe(CALIBRATED_INTRADAY_COST_CONFIG);
  });

  it('prices the intraday spread ratio far above the daily one', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.stocks.spreadVolatilityCoefficient).toBeGreaterThan(
      CALIBRATED_COST_CONFIG.stocks.spreadVolatilityCoefficient * 10,
    );
  });

  it('derives intraday slippage by the daily config own rule rather than a new one', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.stocks.slippageCoefficient).toBeCloseTo(
      CALIBRATED_INTRADAY_COST_CONFIG.stocks.spreadVolatilityCoefficient / 4,
      10,
    );
  });

  it('leaves the unreachable crypto branch on the pessimistic fixture', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.crypto).toBe(PESSIMISTIC_COST_CONFIG.crypto);
  });

  it('carries a Saxo-keyed commission override at ADR-0015:201s 8bps rate', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.venues?.saxo?.commissionRate).toBe(0.0008);
    expect(CALIBRATED_INTRADAY_COST_CONFIG.stocks.commissionRate).toBe(0);
  });

  it('honours SAMURAI_STAGE2_COST_CONFIG=pessimistic at both resolutions', () => {
    for (const timeframe of ['1d', '1m']) {
      expect(costConfigFor(timeframe, { SAMURAI_STAGE2_COST_CONFIG: 'pessimistic' })).toBe(
        PESSIMISTIC_COST_CONFIG,
      );
    }
  });
});

describe('costConfigFromEnv', () => {
  it('defaults to the calibrated config', () => {
    expect(costConfigFromEnv({})).toBe(CALIBRATED_COST_CONFIG);
  });

  it('re-runs against the old fixture on request, for comparison', () => {
    expect(costConfigFromEnv({ SAMURAI_STAGE2_COST_CONFIG: 'pessimistic' })).toBe(
      PESSIMISTIC_COST_CONFIG,
    );
  });

  it('treats an unrecognised value as the default rather than silently picking one', () => {
    expect(costConfigFromEnv({ SAMURAI_STAGE2_COST_CONFIG: 'cheap' })).toBe(CALIBRATED_COST_CONFIG);
  });
});

const KEYS = { ALPACA_API_KEY: 'key', ALPACA_API_SECRET: 'secret' };
const DAY_MS = 86_400_000;

function quote(bp: number, ap: number) {
  return { bp, ap, t: '2025-06-01T00:00:00Z' };
}

function dailyBars(symbol: string, from: Date, days: number): Bar[] {
  return Array.from({ length: days }, (_, i) => {
    const open_time = new Date(from.getTime() + i * DAY_MS);
    return {
      instrument: symbol,
      source: 'test',
      timeframe: '1d',
      open_time,
      close_time: new Date(open_time.getTime() + DAY_MS),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    };
  });
}

describe('runSpreadCalibration', () => {
  const window = {
    start: new Date('2025-06-01T00:00:00Z'),
    end: new Date('2025-06-05T00:00:00Z'),
  };

  it('refuses to run without Alpaca credentials', async () => {
    await expect(runSpreadCalibration({ env: {}, print: () => {} })).rejects.toThrow(
      'runSpreadCalibration: ALPACA_API_KEY and ALPACA_API_SECRET are required.',
    );
  });

  it('measures spread in bps and over ATR, skipping failed, empty and ATR-less days', async () => {
    const store: NonNullable<SpreadCalibrationDeps['store']> = {
      ingest: vi.fn(async () => {}),
      bars: vi.fn((symbol: string) =>
        symbol === 'TSLA' ? [] : dailyBars(symbol, new Date('2025-04-01T00:00:00Z'), 60),
      ),
    };
    const quotes: QuoteSource = {
      stockQuotes: vi.fn(async (symbol: string) =>
        symbol === 'QQQ' ? [] : [quote(99.9, 100.1), quote(0, 100.1), quote(100, 100)],
      ),
      cryptoQuotes: vi.fn(async (symbol: string) => {
        if (symbol === 'ETH-USD') throw new Error('quotes down');
        return [quote(99.9, 100.1)];
      }),
    };
    const lines: string[] = [];

    const result = await runSpreadCalibration({
      env: KEYS,
      window,
      sampleDays: 2,
      store,
      quotes,
      print: (line) => lines.push(line),
    });

    const bySymbol = new Map(result.symbols.map((s) => [s.symbol, s]));
    expect(bySymbol.get('SPY')).toMatchObject({
      asset_class: 'stocks',
      days_sampled: 2,
      quotes_sampled: 2,
      days_with_atr: 2,
    });
    expect(bySymbol.get('SPY')?.median_spread_bps).toBeCloseTo(20);
    expect(bySymbol.get('SPY')?.median_spread_over_atr).toBeCloseTo(0.1);
    expect(bySymbol.get('QQQ')?.days_sampled).toBe(0);
    expect(bySymbol.get('TSLA')).toMatchObject({ days_sampled: 2, days_with_atr: 0 });
    expect(bySymbol.get('BTC-USD')?.asset_class).toBe('crypto');
    expect(bySymbol.get('ETH-USD')?.days_sampled).toBe(0);
    expect(result.fitted.stocks).toBeCloseTo(0.1);
    expect(result.fitted.crypto).toBeCloseTo(0.1);

    const cryptoEnd = vi.mocked(quotes.cryptoQuotes).mock.calls[0]?.[2];
    expect(cryptoEnd?.toISOString()).toMatch(/T23:59:00\.000Z$/);
    expect(lines.some((line) => line.includes('ETH-USD') && line.includes('quotes down'))).toBe(
      true,
    );
    expect(lines).toContain('=== Fitted spreadVolatilityCoefficient (from medians) ===');
  });
});

describe('runIntradaySpreadCalibration', () => {
  const window = {
    start: new Date('2025-06-02T00:00:00Z'),
    end: new Date('2025-06-06T00:00:00Z'),
  };

  function minuteAggregates(range: { start: Date; end: Date }) {
    const out = [];
    for (let t = range.start.getTime(); t < range.end.getTime(); t += 60_000) {
      out.push({ t, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 });
    }
    return out;
  }

  it('refuses to run without Alpaca credentials', async () => {
    await expect(
      runIntradaySpreadCalibration({ env: { ALPACA_API_KEY: 'key' }, print: () => {} }),
    ).rejects.toThrow(
      'runIntradaySpreadCalibration: ALPACA_API_KEY and ALPACA_API_SECRET are required.',
    );
  });

  it('pools per-bucket spread over minute ATR and skips failed or empty sessions', async () => {
    const bars = {
      fetchAggregates: vi.fn(async (symbol: string, range: { start: Date; end: Date }) => {
        if (symbol === 'QQQ') throw new Error('bars down');
        return symbol === 'AAPL' ? [] : minuteAggregates(range);
      }),
    };
    const quotes: QuoteSource = {
      stockQuotes: vi.fn(async (symbol: string) => {
        if (symbol === 'TSLA') throw new Error('quotes down');
        return [quote(99.9, 100.1)];
      }),
      cryptoQuotes: vi.fn(async () => []),
    };
    const lines: string[] = [];

    const result = await runIntradaySpreadCalibration({
      env: KEYS,
      window,
      sampleDays: 2,
      bars,
      quotes,
      print: (line) => lines.push(line),
    });

    const spy = result.symbols.find((s) => s.symbol === 'SPY');
    expect(spy?.samples).toBe(2 * SESSION_BUCKETS.length);
    expect(spy?.median_spread_over_atr).toBeCloseTo(0.2);
    expect(spy?.median_spread_bps).toBeCloseTo(20);
    expect(spy?.buckets.map((b) => b.quotes_sampled)).toEqual([2, 2, 2]);
    expect(result.symbols.find((s) => s.symbol === 'QQQ')?.samples).toBe(0);
    expect(result.symbols.find((s) => s.symbol === 'AAPL')?.samples).toBe(0);
    expect(result.symbols.find((s) => s.symbol === 'TSLA')?.samples).toBe(0);
    expect(result.fitted_stocks).toBeCloseTo(0.2);
    expect(result.timeframe).toBe('1m');
    expect(lines.some((line) => line.includes('QQQ') && line.includes('bars down'))).toBe(true);
    expect(lines.some((line) => line.includes('TSLA') && line.includes('quotes down'))).toBe(true);
  });
});
