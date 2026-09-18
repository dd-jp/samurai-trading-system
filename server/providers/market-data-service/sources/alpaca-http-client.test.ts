import { TokenBucket } from '../../../shared/index.js';
import {
  AlpacaDataProviderError,
  AlpacaDataUnderfetchError,
  isRetryableAlpacaDataError,
} from './alpaca-data-errors.js';
import {
  ALPACA_DATA_FEED_ENV_VAR,
  AlpacaHttpDataClient,
  DEFAULT_ALPACA_DATA_FEED,
  resolveAlpacaDataFeed,
  toAlpacaCryptoSymbol,
  toAlpacaTimeframe,
} from './alpaca-http-client.js';

const FAKE_KEY = 'test-fake-alpaca-key';
const FAKE_SECRET = 'test-fake-alpaca-secret';

function rangeOf(call: unknown): { start: number; end: number } {
  const [url] = call as [string];
  const params = new URL(url).searchParams;
  return {
    start: Date.parse(params.get('start') as string),
    end: Date.parse(params.get('end') as string),
  };
}

function dailyBars(count: number): Array<Record<string, number | string>> {
  return Array.from({ length: count }, (_unused, i) => ({
    t: new Date(Date.parse('2026-07-02T00:00:00Z') - (count - 1 - i) * 86_400_000).toISOString(),
    o: 1,
    h: 1,
    l: 1,
    c: 1,
    v: 1,
  }));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('toAlpacaTimeframe', () => {
  it("translates this codebase's canonical timeframe vocabulary into Alpaca's own", () => {
    expect(toAlpacaTimeframe('1m')).toBe('1Min');
    expect(toAlpacaTimeframe('5m')).toBe('5Min');
    expect(toAlpacaTimeframe('1h')).toBe('1Hour');
    expect(toAlpacaTimeframe('1d')).toBe('1Day');
  });

  it('throws on an unsupported timeframe string', () => {
    expect(() => toAlpacaTimeframe('1Min')).toThrow(/unsupported timeframe/);
  });
});

describe('toAlpacaCryptoSymbol', () => {
  it('maps the universe -USD suffix to a slash', () => {
    expect(toAlpacaCryptoSymbol('BTC-USD')).toBe('BTC/USD');
    expect(toAlpacaCryptoSymbol('ETH-USD')).toBe('ETH/USD');
  });

  it('passes through a symbol with no -USD suffix unchanged', () => {
    expect(toAlpacaCryptoSymbol('BTCUSD')).toBe('BTCUSD');
  });
});

describe('AlpacaHttpDataClient — equities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('getBars hits the /v2/stocks/{symbol}/bars path root with a translated timeframe, start, and sort=asc', async () => {
    const bar = { t: '2026-07-01T00:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 100, n: 5, vw: 1.4 };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ bars: [bar], symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
    const result = await client.getBars(
      'AAPL',
      '1d',
      new Date('2026-07-02T00:00:00Z'),
      10,
      'allow',
    );

    expect(result).toEqual([{ t: bar.t, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/data\.alpaca\.markets\/v2\/stocks\/AAPL\/bars\?/);
    expect(url).toContain('timeframe=1Day');
    expect(url).toContain('sort=asc');
    expect(url).toContain('end=2026-07-02T00%3A00%3A00.000Z');
    expect(url).toMatch(/start=\d{4}-\d\d-\d\dT/);
    const headers = init.headers as Record<string, string>;
    expect(headers['APCA-API-KEY-ID']).toBe(FAKE_KEY);
    expect(headers['APCA-API-SECRET-KEY']).toBe(FAKE_SECRET);
  });

  it('getBars trims to the most recent `limit` bars when the range yields more than limit', async () => {
    const bars = [
      { t: '2026-06-01T00:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: '2026-06-02T00:00:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 },
      { t: '2026-06-03T00:00:00Z', o: 3, h: 3, l: 3, c: 3, v: 3 },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ bars, symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
    const result = await client.getBars('AAPL', '1d', new Date('2026-06-03T00:00:00Z'), 2);

    expect(result).toEqual([
      { t: bars[1]?.t, o: 2, h: 2, l: 2, c: 2, v: 2 },
      { t: bars[2]?.t, o: 3, h: 3, l: 3, c: 3, v: 3 },
    ]);
  });

  it('getBars follows next_page_token across pages within the bounded range', async () => {
    const barA = { t: '2026-07-01T00:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 };
    const barB = { t: '2026-07-02T00:00:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ bars: [barA], symbol: 'AAPL', next_page_token: 'page-2' }),
      )
      .mockResolvedValueOnce(jsonResponse({ bars: [barB], symbol: 'AAPL', next_page_token: null }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
    const result = await client.getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 2);

    expect(result).toEqual([
      { t: barA.t, o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: barB.t, o: 2, h: 2, l: 2, c: 2, v: 2 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [secondUrl] = fetchMock.mock.calls[1] as [string];
    expect(secondUrl).toContain('page_token=page-2');
  });

  it('getBars scales the page-cap guard with a large `limit` instead of tripping at the fixed 25-page default', async () => {
    const totalPages = 30;
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls++;
      const bar = { t: `2026-0${(calls % 9) + 1}-01T00:00:00Z`, o: 1, h: 1, l: 1, c: 1, v: 1 };
      const next_page_token = calls < totalPages ? `page-${calls + 1}` : null;
      return Promise.resolve(jsonResponse({ bars: [bar], symbol: 'AAPL', next_page_token }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
    const result = await client.getBars(
      'AAPL',
      '1d',
      new Date('2026-07-03T00:00:00Z'),
      5_000,
      'allow',
    );

    expect(fetchMock).toHaveBeenCalledTimes(totalPages);
    expect(result).toHaveLength(totalPages);
  });

  it('getBars still trips the pagination guard on a genuinely cyclical/malformed next_page_token', async () => {
    const bar = { t: '2026-07-01T00:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: [bar], symbol: 'AAPL', next_page_token: 'same' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(client.getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 2)).rejects.toThrow(
      AlpacaDataProviderError,
    );
  });

  it('getLatestQuote hits /v2/stocks/{symbol}/quotes/latest and unwraps the quote', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ symbol: 'AAPL', quote: { t: '2026-07-01T00:00:00Z', ap: 101, bp: 100 } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
    const result = await client.getLatestQuote('AAPL');

    expect(result).toEqual({ t: '2026-07-01T00:00:00Z', ap: 101, bp: 100 });
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      'https://data.alpaca.markets/v2/stocks/AAPL/quotes/latest',
    );
    expect(parsed.searchParams.get('feed')).toBe('iex');
  });
});

describe('AlpacaHttpDataClient — crypto', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('getBars hits the /v1beta3/crypto/us/bars path root with the slash-translated symbols= param', async () => {
    const bar = { t: '2026-07-01T00:00:00Z', o: 30000, h: 31000, l: 29000, c: 30500, v: 10 };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: { 'BTC/USD': [bar] }, next_page_token: null }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
    const result = await client.getBars(
      'BTC-USD',
      '1m',
      new Date('2026-07-02T00:00:00Z'),
      5,
      'allow',
    );

    expect(result).toEqual([{ t: bar.t, o: 30000, h: 31000, l: 29000, c: 30500, v: 10 }]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/^https:\/\/data\.alpaca\.markets\/v1beta3\/crypto\/us\/bars\?/);
    expect(url).toContain('symbols=BTC%2FUSD');
  });

  it('getBars response-key lookup falls back to the untranslated symbol if the slash form is absent', async () => {
    const bar = { t: '2026-07-01T00:00:00Z', o: 30000, h: 31000, l: 29000, c: 30500, v: 10 };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: { 'BTC-USD': [bar] }, next_page_token: null }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
    const result = await client.getBars(
      'BTC-USD',
      '1m',
      new Date('2026-07-02T00:00:00Z'),
      5,
      'allow',
    );

    expect(result).toEqual([{ t: bar.t, o: 30000, h: 31000, l: 29000, c: 30500, v: 10 }]);
  });

  it('getLatestQuote hits /v1beta3/crypto/us/latest/quotes and unwraps the slash-keyed quote', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        quotes: { 'BTC/USD': { t: '2026-07-01T00:00:00Z', ap: 30100, bp: 30000 } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
    const result = await client.getLatestQuote('BTC-USD');

    expect(result).toEqual({ t: '2026-07-01T00:00:00Z', ap: 30100, bp: 30000 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/^https:\/\/data\.alpaca\.markets\/v1beta3\/crypto\/us\/latest\/quotes\?/);
    expect(url).toContain('symbols=BTC%2FUSD');
  });

  it('throws AlpacaDataProviderError when the crypto response has no quote for the symbol at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ quotes: {} }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(client.getLatestQuote('ETH-USD')).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('does NOT serve a different symbol from a single-key crypto bars response', async () => {
    const bar = { t: '2026-07-01T00:00:00Z', o: 30000, h: 31000, l: 29000, c: 30500, v: 10 };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: { 'ETH/USD': [bar] }, next_page_token: null }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(
      client.getBars('BTC-USD', '1m', new Date('2026-07-02T00:00:00Z'), 5),
    ).rejects.toBeInstanceOf(AlpacaDataUnderfetchError);
  });

  it('does NOT serve a different symbol from a single-key crypto quotes response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        quotes: { 'ETH/USD': { t: '2026-07-01T00:00:00Z', ap: 30100, bp: 30000 } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(client.getLatestQuote('BTC-USD')).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });
});

describe('AlpacaHttpDataClient — API version segment (issue #358)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function versionSegmentOf(call: unknown): string {
    const [url] = call as [string];
    return new URL(url).pathname.split('/')[1] as string;
  }

  function clientFor(assetClass: 'crypto' | 'stocks'): AlpacaHttpDataClient {
    return new AlpacaHttpDataClient({ assetClass, apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
  }

  it('routes crypto bars through /v1beta3, never /v2', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ bars: { 'BTC/USD': dailyBars(5) }, next_page_token: null }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await clientFor('crypto').getBars('BTC-USD', '1d', new Date('2026-07-03T00:00:00Z'), 5);

    expect(versionSegmentOf(fetchMock.mock.calls[0])).toBe('v1beta3');
  });

  it('routes crypto latest quotes through /v1beta3, never /v2', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        quotes: { 'BTC/USD': { t: '2026-07-01T00:00:00Z', ap: 30100, bp: 30000 } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await clientFor('crypto').getLatestQuote('BTC-USD');

    expect(versionSegmentOf(fetchMock.mock.calls[0])).toBe('v1beta3');
  });

  it('keeps equity bars on /v2 (verified live — the equity paths were already right)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(5), next_page_token: null }));
    vi.stubGlobal('fetch', fetchMock);

    await clientFor('stocks').getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 5);

    expect(versionSegmentOf(fetchMock.mock.calls[0])).toBe('v2');
  });

  it('keeps equity latest quotes on /v2 (verified live)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ quote: { t: '2026-07-01T00:00:00Z', ap: 1, bp: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    await clientFor('stocks').getLatestQuote('AAPL');

    expect(versionSegmentOf(fetchMock.mock.calls[0])).toBe('v2');
  });
});

describe('AlpacaHttpDataClient — equity data feed (#381)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function feedOf(call: unknown): string | null {
    const [url] = call as [string];
    return new URL(url).searchParams.get('feed');
  }

  it('sends feed=iex on equity bars by default, so a recent end does not 403', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(5), next_page_token: null }));
    vi.stubGlobal('fetch', fetchMock);

    await new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    }).getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 5);

    expect(feedOf(fetchMock.mock.calls[0])).toBe('iex');
  });

  it('sends the same feed on equity latest quotes as on bars', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ quote: { t: '2026-07-01T00:00:00Z', ap: 1, bp: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    await new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    }).getLatestQuote('AAPL');

    expect(feedOf(fetchMock.mock.calls[0])).toBe('iex');
  });

  it('never sends feed on crypto — the crypto endpoints take no such parameter', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ bars: { 'BTC/USD': dailyBars(5) }, next_page_token: null }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    }).getBars('BTC-USD', '1d', new Date('2026-07-03T00:00:00Z'), 5);

    expect(feedOf(fetchMock.mock.calls[0])).toBeNull();
  });

  it('honours an explicit sip override for an account that has the subscription', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(5), next_page_token: null }));
    vi.stubGlobal('fetch', fetchMock);

    await new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      feed: 'sip',
    }).getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 5);

    expect(feedOf(fetchMock.mock.calls[0])).toBe('sip');
  });

  describe('the feed is resolved for stocks only', () => {
    const saved = process.env[ALPACA_DATA_FEED_ENV_VAR];
    afterEach(() => {
      if (saved === undefined) delete process.env[ALPACA_DATA_FEED_ENV_VAR];
      else process.env[ALPACA_DATA_FEED_ENV_VAR] = saved;
    });

    it('does not read a malformed ALPACA_DATA_FEED for a crypto client', () => {
      process.env[ALPACA_DATA_FEED_ENV_VAR] = 'sipp';

      expect(
        () =>
          new AlpacaHttpDataClient({
            assetClass: 'crypto',
            apiKey: FAKE_KEY,
            apiSecret: FAKE_SECRET,
          }),
      ).not.toThrow();
    });

    it('still refuses a malformed ALPACA_DATA_FEED for a stocks client, at construction', () => {
      process.env[ALPACA_DATA_FEED_ENV_VAR] = 'sipp';

      expect(
        () =>
          new AlpacaHttpDataClient({
            assetClass: 'stocks',
            apiKey: FAKE_KEY,
            apiSecret: FAKE_SECRET,
          }),
      ).toThrow(ALPACA_DATA_FEED_ENV_VAR);
    });

    it('a crypto client with a malformed feed still fetches bars', async () => {
      process.env[ALPACA_DATA_FEED_ENV_VAR] = 'sipp';
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ bars: { 'BTC/USD': dailyBars(5) }, next_page_token: null }),
        );
      vi.stubGlobal('fetch', fetchMock);

      const client = new AlpacaHttpDataClient({
        assetClass: 'crypto',
        apiKey: FAKE_KEY,
        apiSecret: FAKE_SECRET,
      });
      await client.getBars('BTC-USD', '1d', new Date('2026-07-03T00:00:00Z'), 5);

      expect(feedOf(fetchMock.mock.calls[0])).toBeNull();
    });
  });

  describe('resolveAlpacaDataFeed', () => {
    it('defaults to the feed a Basic subscription can actually read', () => {
      expect(resolveAlpacaDataFeed(undefined)).toBe(DEFAULT_ALPACA_DATA_FEED);
      expect(resolveAlpacaDataFeed('')).toBe('iex');
      expect(resolveAlpacaDataFeed('   ')).toBe('iex');
      expect(DEFAULT_ALPACA_DATA_FEED).toBe('iex');
    });

    it('accepts both documented feeds', () => {
      expect(resolveAlpacaDataFeed('iex')).toBe('iex');
      expect(resolveAlpacaDataFeed('sip')).toBe('sip');
    });

    it('refuses an unrecognised value rather than forwarding it to the wire', () => {
      expect(() => resolveAlpacaDataFeed('sipp')).toThrow(ALPACA_DATA_FEED_ENV_VAR);
      expect(() => resolveAlpacaDataFeed('IEX')).toThrow(/iex/);
    });
  });
});

describe('AlpacaHttpDataClient — shared behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('throws if no API key is available', () => {
    const previousKey = process.env.ALPACA_API_KEY;
    const previousSecret = process.env.ALPACA_API_SECRET;
    delete process.env.ALPACA_API_KEY;
    process.env.ALPACA_API_SECRET = FAKE_SECRET;
    try {
      expect(() => new AlpacaHttpDataClient({ assetClass: 'stocks' })).toThrow(/ALPACA_API_KEY/);
    } finally {
      if (previousKey !== undefined) process.env.ALPACA_API_KEY = previousKey;
      else delete process.env.ALPACA_API_KEY;
      if (previousSecret !== undefined) process.env.ALPACA_API_SECRET = previousSecret;
      else delete process.env.ALPACA_API_SECRET;
    }
  });

  it('does not retry a 400 (non-5xx ProviderError)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'bad request' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    });

    await expect(client.getLatestQuote('AAPL')).rejects.toBeInstanceOf(AlpacaDataProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 502 and eventually succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'bad gateway' }, 502))
      .mockResolvedValueOnce(
        jsonResponse({ symbol: 'AAPL', quote: { t: '2026-07-01T00:00:00Z', ap: 101, bp: 100 } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    });

    const promise = client.getLatestQuote('AAPL');
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result).toEqual({ t: '2026-07-01T00:00:00Z', ap: 101, bp: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies a fetchWithTimeout abort as AlpacaDataTimeoutError and retries it', async () => {
    let attempt = 0;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      attempt++;
      if (attempt === 1) {
        const signal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      }
      return Promise.resolve(
        jsonResponse({ symbol: 'AAPL', quote: { t: '2026-07-01T00:00:00Z', ap: 101, bp: 100 } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      timeoutMs: 500,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 },
    });

    const promise = client.getLatestQuote('AAPL');
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result).toEqual({ t: '2026-07-01T00:00:00Z', ap: 101, bp: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AlpacaHttpDataClient — sparse-symbol underfetch (#292)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const ASOF = new Date('2026-07-03T00:00:00Z');

  function stocksClient(): AlpacaHttpDataClient {
    return new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
  }

  it('widens the window once and retries when the first range yields fewer than `limit` bars', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ bars: dailyBars(2), symbol: 'AAPL' }))
      .mockResolvedValueOnce(jsonResponse({ bars: dailyBars(5), symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await stocksClient().getBars('AAPL', '1d', ASOF, 5);

    expect(result).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = rangeOf(fetchMock.mock.calls[0]);
    const second = rangeOf(fetchMock.mock.calls[1]);
    expect(second.start).toBeLessThan(first.start);
    expect(second.end).toBe(first.end);
    expect(second.end).toBe(ASOF.getTime());
  });

  it('throws AlpacaDataUnderfetchError when even the widened range cannot produce `limit` bars', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(2), symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await stocksClient()
      .getBars('AAPL', '1d', ASOF, 5)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AlpacaDataUnderfetchError);
    const underfetch = error as AlpacaDataUnderfetchError;
    expect(underfetch.symbol).toBe('AAPL');
    expect(underfetch.timeframe).toBe('1d');
    expect(underfetch.requested).toBe(5);
    expect(underfetch.received).toBe(2);
    expect(underfetch.message).toContain('AAPL');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the short read unwidened when the caller opts in with partial: 'allow'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(2), symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await stocksClient().getBars('AAPL', '1d', ASOF, 5, 'allow');

    expect(result).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not widen or throw when the first range already satisfies `limit`', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(5), symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await stocksClient().getBars('AAPL', '1d', ASOF, 5);

    expect(result).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the retry entirely when the first window already exceeds the retry row ceiling', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(1), symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(stocksClient().getBars('AAPL', '1m', ASOF, 5_000)).rejects.toBeInstanceOf(
      AlpacaDataUnderfetchError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies an underfetch as non-retryable, and not as a provider fault', () => {
    const error = new AlpacaDataUnderfetchError({
      symbol: 'AAPL',
      timeframe: '1d',
      requested: 5,
      received: 2,
      searchedFrom: '2026-06-03T00:00:00.000Z',
      searchedTo: '2026-07-03T00:00:00.000Z',
    });

    expect(isRetryableAlpacaDataError(error)).toBe(false);
    expect(error).not.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('returns no bars, and makes no request, for a zero-length window', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(5), symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await stocksClient().getBars('AAPL', '1d', ASOF, 0)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies the same widen-then-throw path on the crypto endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ bars: { 'BTC/USD': dailyBars(1) }, next_page_token: null }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(client.getBars('BTC-USD', '1d', ASOF, 4)).rejects.toBeInstanceOf(
      AlpacaDataUnderfetchError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = rangeOf(fetchMock.mock.calls[0]);
    const second = rangeOf(fetchMock.mock.calls[1]);
    expect(second.start).toBeLessThan(first.start);
  });
});

describe('AlpacaHttpDataClient — outbound pacing (#391)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function client(rateLimiter: TokenBucket): AlpacaHttpDataClient {
    return new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      rateLimiter,
    });
  }

  it('takes a token per request, and leaves the priority reserve for the order path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(1), symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, reserveForPriority: 2 });
    const subject = client(bucket);

    await subject.getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 1, 'allow');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let second = false;
    const pending = subject
      .getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 1, 'allow')
      .then(() => {
        second = true;
      });

    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(second).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is unpaced when no bucket is supplied — every existing caller is unaffected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: dailyBars(1), symbol: 'AAPL' }));
    vi.stubGlobal('fetch', fetchMock);

    const subject = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await subject.getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 1, 'allow');
    await subject.getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 1, 'allow');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AlpacaHttpDataClient — wire validation (#509)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('getBars (equities) rejects a truncated bar missing required fields', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: [{ t: '2026-07-01T00:00:00Z', o: 1, h: 2 }] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(
      client.getBars('AAPL', '1d', new Date('2026-07-02T00:00:00Z'), 1, 'allow'),
    ).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('getBars (equities) rejects a bar whose OHLCV field is the wrong type (out-of-type body)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        bars: [{ t: '2026-07-01T00:00:00Z', o: '1', h: 2, l: 0.5, c: 1.5, v: 100 }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(
      client.getBars('AAPL', '1d', new Date('2026-07-02T00:00:00Z'), 1, 'allow'),
    ).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('getBars (equities) rejects a bar carrying a non-finite OHLCV field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        bars: [{ t: '2026-07-01T00:00:00Z', o: Number.NaN, h: 2, l: 0.5, c: 1.5, v: 100 }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(
      client.getBars('AAPL', '1d', new Date('2026-07-02T00:00:00Z'), 1, 'allow'),
    ).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('getBars (equities) rejects a response body that is not an object at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(
      client.getBars('AAPL', '1d', new Date('2026-07-02T00:00:00Z'), 1, 'allow'),
    ).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('getBars (crypto) rejects a truncated bar in the keyed response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: { 'BTC/USD': [{ t: '2026-07-01T00:00:00Z' }] } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(
      client.getBars('BTC-USD', '1m', new Date('2026-07-02T00:00:00Z'), 1, 'allow'),
    ).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('getBars (crypto) rejects a keyed bars value that is not an array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ bars: { 'BTC/USD': { not: 'an array' } } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(
      client.getBars('BTC-USD', '1m', new Date('2026-07-02T00:00:00Z'), 1, 'allow'),
    ).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('getLatestQuote (equities) rejects a quote missing required fields (truncated body)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ quote: { t: '2026-07-01T00:00:00Z' } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(client.getLatestQuote('AAPL')).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('getLatestQuote (equities) rejects a quote whose ap/bp are the wrong type (out-of-type body)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        quote: { t: '2026-07-01T00:00:00Z', ap: '101', bp: 100 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'stocks',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(client.getLatestQuote('AAPL')).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });

  it('getLatestQuote (crypto) rejects a malformed quote for the requested symbol', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        quotes: {
          'BTC/USD': { t: '2026-07-01T00:00:00Z', ap: Number.POSITIVE_INFINITY, bp: 30000 },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpDataClient({
      assetClass: 'crypto',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });

    await expect(client.getLatestQuote('BTC-USD')).rejects.toBeInstanceOf(AlpacaDataProviderError);
  });
});
