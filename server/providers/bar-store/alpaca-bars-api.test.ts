import { describe, expect, it } from 'vitest';
import type { FetchResult, RawDailyBar } from './index.js';
import {
  AlpacaBarsApi,
  authHeaders,
  barsUrl,
  credentialsFromEnv,
  endOfDayUtc,
  parseBarsPage,
} from './index.js';

describe('alpaca bars api', () => {
  const rawBar = (t: string, c: number): RawDailyBar => ({ t, o: c, h: c, l: c, c, v: 1 });

  it('reads credentials from the environment and builds auth headers', () => {
    expect(() => credentialsFromEnv({})).toThrow(/ALPACA_API_KEY/);
    const credentials = credentialsFromEnv({ ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's' });
    expect(authHeaders(credentials)).toEqual({
      'APCA-API-KEY-ID': 'k',
      'APCA-API-SECRET-KEY': 's',
      accept: 'application/json',
    });
  });

  it('builds a SIP daily-bars URL with an end-of-day UTC end so a date-only end is never in the future', () => {
    expect(endOfDayUtc('2026-09-23')).toBe('2026-09-23T23:59:59Z');
    const url = new URL(
      barsUrl({ symbol: 'SPY', start: '2016-01-04', end: '2026-09-23', adjustment: 'all' }, 'tok'),
    );
    expect(url.pathname).toBe('/v2/stocks/bars');
    expect(url.searchParams.get('feed')).toBe('sip');
    expect(url.searchParams.get('timeframe')).toBe('1Day');
    expect(url.searchParams.get('end')).toBe('2026-09-23T23:59:59Z');
    expect(url.searchParams.get('page_token')).toBe('tok');
    expect(url.searchParams.get('adjustment')).toBe('all');
  });

  it('parses a page and tolerates a symbol with no bars', () => {
    const page = parseBarsPage(
      { bars: { SPY: [rawBar('2016-01-04T05:00:00Z', 1)] }, next_page_token: 'n' },
      'SPY',
    );
    expect(page.bars.length).toBe(1);
    expect(page.nextPageToken).toBe('n');
    expect(parseBarsPage({ bars: {} }, 'SPY')).toEqual({ bars: [], nextPageToken: undefined });
    expect(() => parseBarsPage('x', 'SPY')).toThrow(/non-object/);
    expect(() => parseBarsPage({ bars: { SPY: 'x' } }, 'SPY')).toThrow(/not an array/);
    expect(() => parseBarsPage({ bars: { SPY: [{ t: 1 }] } }, 'SPY')).toThrow(/malformed bar/);
  });

  it('paginates, paces requests and backs off on 429', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let attempt = 0;
    const fetcher = async (url: string): Promise<FetchResult> => {
      calls.push(url);
      attempt++;
      if (attempt === 1) return { status: 429, body: 'slow down' };
      if (url.includes('page_token=p2')) {
        return { status: 200, body: { bars: { SPY: [rawBar('2016-01-05T05:00:00Z', 2)] } } };
      }
      return {
        status: 200,
        body: { bars: { SPY: [rawBar('2016-01-04T05:00:00Z', 1)] }, next_page_token: 'p2' },
      };
    };
    const api = new AlpacaBarsApi(
      { apiKey: 'k', apiSecret: 's' },
      fetcher,
      async (ms) => {
        sleeps.push(ms);
      },
      0,
    );
    const bars = await api.dailyBars({
      symbol: 'SPY',
      start: '2016-01-04',
      end: '2016-01-05',
      adjustment: 'all',
    });
    expect(bars.map((bar) => bar.c)).toEqual([1, 2]);
    expect(calls.length).toBe(3);
    expect(sleeps).toContain(20_000);
  });

  it('throws on a non-retryable status and after repeated 429s', async () => {
    const forbidden = new AlpacaBarsApi(
      { apiKey: 'k', apiSecret: 's' },
      async () => ({ status: 403, body: { message: 'no' } }),
      async () => {},
      0,
    );
    await expect(forbidden.getWithRetry('u')).rejects.toThrow(/Alpaca 403/);
    const throttled = new AlpacaBarsApi(
      { apiKey: 'k', apiSecret: 's' },
      async () => ({ status: 429, body: '' }),
      async () => {},
      0,
    );
    await expect(throttled.getWithRetry('u')).rejects.toThrow(/rate-limited 5 times/);
  });
});
