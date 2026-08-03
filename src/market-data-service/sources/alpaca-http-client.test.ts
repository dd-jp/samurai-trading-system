import { AlpacaDataProviderError } from './alpaca-data-errors.js';
import {
  AlpacaHttpDataClient,
  toAlpacaCryptoSymbol,
  toAlpacaTimeframe,
} from './alpaca-http-client.js';

const FAKE_KEY = 'test-fake-alpaca-key';
const FAKE_SECRET = 'test-fake-alpaca-secret';

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
    const result = await client.getBars('AAPL', '1d', new Date('2026-07-02T00:00:00Z'), 10);

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
    // BUFFER_MULTIPLIER=8, PAGE_SIZE=1_000 → a limit of 5_000 needs up to
    // ceil(5_000*8/1_000)+2 = 42 pages of headroom, well past the old fixed
    // cap of 25. 30 legitimate pages must not trip the pagination guard.
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
    const result = await client.getBars('AAPL', '1d', new Date('2026-07-03T00:00:00Z'), 5_000);

    expect(fetchMock).toHaveBeenCalledTimes(totalPages);
    expect(result).toHaveLength(totalPages);
  });

  it('getBars still trips the pagination guard on a genuinely cyclical/malformed next_page_token', async () => {
    // Small `limit` keeps the scaled cap at its MAX_PAGES=25 floor — a token
    // that never terminates must still be caught.
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
    expect(url).toBe('https://data.alpaca.markets/v2/stocks/AAPL/quotes/latest');
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

  it('getBars hits the /v2/crypto/us/bars path root with the slash-translated symbols= param', async () => {
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
    const result = await client.getBars('BTC-USD', '1m', new Date('2026-07-02T00:00:00Z'), 5);

    expect(result).toEqual([{ t: bar.t, o: 30000, h: 31000, l: 29000, c: 30500, v: 10 }]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/^https:\/\/data\.alpaca\.markets\/v2\/crypto\/us\/bars\?/);
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
    const result = await client.getBars('BTC-USD', '1m', new Date('2026-07-02T00:00:00Z'), 5);

    expect(result).toEqual([{ t: bar.t, o: 30000, h: 31000, l: 29000, c: 30500, v: 10 }]);
  });

  it('getLatestQuote hits /v2/crypto/us/latest/quotes and unwraps the slash-keyed quote', async () => {
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
    expect(url).toMatch(/^https:\/\/data\.alpaca\.markets\/v2\/crypto\/us\/latest\/quotes\?/);
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
