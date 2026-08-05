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

/** `start`/`end` of the request a `fetch` mock was called with, as epoch ms. */
function rangeOf(call: unknown): { start: number; end: number } {
  const [url] = call as [string];
  const params = new URL(url).searchParams;
  return {
    start: Date.parse(params.get('start') as string),
    end: Date.parse(params.get('end') as string),
  };
}

/** `count` ascending daily bars ending the day before `2026-07-03`. */
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
    // `partial: 'allow'` because this fixture deliberately returns one bar for
    // a limit of 10 — the request SHAPE is what's under test here, not the
    // underfetch policy (which has its own describe block below).
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
    // `partial: 'allow'`: 30 one-bar pages is a deliberate short read against a
    // limit of 5_000 — the page-cap guard is what's under test, not the
    // underfetch policy, and widening would change the call count asserted here.
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
    // `?feed=` since #381 — the mark must come from the same tape as the bars
    // an indicator is computed over. Path asserted separately from the query so
    // this stays a path test.
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
    // `partial: 'allow'` — one-bar fixture against a limit of 5; the crypto
    // request shape is what's under test (see the underfetch describe below).
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
    // `partial: 'allow'` — see the sibling test above; the response-key
    // fallback is what's under test, not the underfetch policy.
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

  /**
   * Issue #358 item 3. The old `lookupCryptoKey` had a third fallback — "if the
   * response carries exactly one key, use it whatever it is" — justified as
   * making an unverified separator guess degrade gracefully. Live verification
   * (2026-08-05) killed that justification: a wrong separator is a hard
   * `400 {"message":"invalid symbol: BTC-USD does not match ^[A-Z]+x?/[A-Z]+$"}`,
   * never a body keyed differently, so the fallback could never fire for the
   * case it was written for. What it COULD do is serve one instrument's prices
   * under another instrument's name — the worst possible silent failure in a
   * system that sizes stops off these numbers.
   */
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

/**
 * Issue #358 regression pin. The client shipped crypto against `/v2/crypto/us/...`,
 * which does not exist (`404`); the working root is `/v1beta3/crypto/us/...`.
 * Nothing in the request shape hinted at it, and the failure surfaced as a quiet
 * `analysts: quorum_skip` rather than an error, so it took a live paper run to
 * find. These assertions pin the VERSION SEGMENT specifically — a future edit to
 * the path templates cannot silently move it again.
 *
 * Verified against the live Alpaca API with paper credentials on 2026-08-05:
 *   GET /v2/crypto/us/bars                -> 404
 *   GET /v1beta3/crypto/us/bars           -> 200
 *   GET /v2/crypto/us/latest/quotes       -> 404
 *   GET /v1beta3/crypto/us/latest/quotes  -> 200
 *   GET /v2/stocks/{symbol}/bars          -> 200
 *   GET /v2/stocks/{symbol}/quotes/latest -> 200
 */
describe('AlpacaHttpDataClient — API version segment (issue #358)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The path segment straight after the host — the thing that was wrong. */
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

/**
 * The equity data feed (#381) — pinned by name against live status codes, for
 * the same reason the API version segment above is.
 *
 * Verified read-only against a live paper account on 2026-08-05:
 *
 * ```
 * GET /v2/stocks/AAPL/bars?...&end=now                  -> 403 "subscription does not
 * GET /v2/stocks/AAPL/bars?...&end=T-14m                -> 403  permit querying recent
 * GET /v2/stocks/AAPL/bars?...&end=T-16m                -> 200  SIP data"
 * GET /v2/stocks/AAPL/bars?...&end=now&feed=iex         -> 200
 * GET /v2/stocks/quotes/latest?symbols=AAPL&feed=sip    -> 403
 * ```
 *
 * `MarketDataServiceImpl.getBars` always passes `asOf = clock.now()`, so
 * without the parameter every equity bars call in a paper run is the first
 * line — a 403 that reaches the tick as "the technical analyst found nothing",
 * exactly the #358 costume. No unit test could have caught the original; these
 * at least stop the parameter being dropped again.
 */
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
    // A mark from one tape and an ATR from another prices a stop against a
    // venue the mark never saw.
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
    // `AlpacaHttpDataClientOptions.feed` documents itself as "Ignored for
    // crypto", and the crypto endpoints take no such parameter. Resolving it
    // for a crypto client would let a typo'd ALPACA_DATA_FEED kill a
    // crypto-only process over a value it would never send.
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
      // The fail-fast half, and the reason laziness costs nothing: the throw
      // moves to the client that would actually use the value, so the typo is
      // caught at boot the moment equities enter the universe — never as a
      // wrong feed, since only `iex`/`sip` resolve at all.
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
      // Construction not throwing is only half the claim; the client must
      // actually work, and must still send no `feed`.
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
      // Forwarded, a typo would come back as a query error and read as a data
      // outage on every equity tick.
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
    // The retry must reach FURTHER BACK, not merely repeat the same request.
    expect(second.start).toBeLessThan(first.start);
    // `asOf` is the point-in-time boundary — widening must never move it.
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
    // Bounded: exactly one widened retry, never an unbounded widening loop.
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
    // 1m/limit=5_000 searches ~27.8 days on the first attempt; the retry
    // ceiling (MAX_PAGES * PAGE_SIZE = 25_000 rows ≈ 17.4 days at 1m) leaves no
    // room to widen, so a second full page walk would only re-read a subset —
    // at a cost of up to ~160 sequential requests against a rate-limit budget
    // shared with live order placement. It must throw on the first attempt.
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
    // Repeating an identical request cannot conjure bars that do not exist, so
    // no retry wrapper anywhere may treat this as retryable — and it must not
    // masquerade as an AlpacaDataProviderError, which would make "Alpaca is
    // broken" and "this symbol is too sparse" indistinguishable in logs and in
    // `isRetryableAlpacaDataError`'s 5xx branch.
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
    // `slice(-0)` is `slice(0)` — the whole array. A `lookback: 0` window must
    // not come back holding every bar in the buffer.
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
