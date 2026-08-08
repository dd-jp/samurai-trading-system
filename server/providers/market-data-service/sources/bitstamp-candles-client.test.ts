import { TokenBucket } from '../../../shared/index.js';
import { BitstampCandlesClient, toBitstampPair } from './bitstamp-candles-client.js';

const SYMBOL = 'BTC-USD';
const ASOF = new Date('2026-08-07T12:00:00Z');

/** Bitstamp's real wire shape: every OHLCV field a STRING (PROBED, module doc). */
function candle(isoOpenTime: string, o: number, h: number, l: number, c: number, v = 10) {
  return {
    timestamp: String(Math.floor(new Date(isoOpenTime).getTime() / 1000)),
    open: String(o),
    high: String(h),
    low: String(l),
    close: String(c),
    volume: String(v),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ohlcResponse(ohlc: unknown[]) {
  return jsonResponse({ data: { pair: 'BTC/USD', ohlc } });
}

describe('BitstampCandlesClient.getBars', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a raw string-typed candle to a Bar stamped source: bitstamp', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(ohlcResponse([candle('2026-08-07T11:00:00Z', 100, 105, 99, 104, 7)])),
    );

    const bars = await new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 1);

    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      instrument: SYMBOL,
      timeframe: '1h',
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 7,
      source: 'bitstamp',
    });
    expect(bars[0]?.open_time.toISOString()).toBe('2026-08-07T11:00:00.000Z');
    expect(bars[0]?.close_time.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  it('maps BTC-USD -> btcusd and ETH-USD -> ethusd', () => {
    expect(toBitstampPair('BTC-USD')).toBe('btcusd');
    expect(toBitstampPair('ETH-USD')).toBe('ethusd');
  });

  it('requests the lowercase, dashless pair in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ohlcResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 1);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/ohlc/btcusd/');
  });

  it('sorts ascending even though the venue already returns ascending order (belt and braces)', async () => {
    // Real Bitstamp order is ascending (PROBED, module doc) — unlike Coinbase's
    // newest-first. Feed it out of order to prove this client does not trust
    // wire order either way.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          ohlcResponse([
            candle('2026-08-07T11:00:00Z', 100, 105, 99, 104),
            candle('2026-08-07T10:00:00Z', 90, 95, 91, 94),
          ]),
        ),
    );

    const bars = await new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 2);

    expect(bars.map((b) => b.close_time.toISOString())).toEqual([
      '2026-08-07T11:00:00.000Z',
      '2026-08-07T12:00:00.000Z',
    ]);
  });

  it('dedups an overlapping boundary bar by close_time rather than double-counting it', async () => {
    // Simulates the research doc's documented overlap: the same candle
    // present twice in one response (e.g. a future caller's own pagination
    // stitching two pages together upstream of this client).
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ohlcResponse([
          candle('2026-08-07T10:00:00Z', 90, 95, 91, 94),
          candle('2026-08-07T10:00:00Z', 90, 95, 91, 94), // duplicate boundary bar
          candle('2026-08-07T11:00:00Z', 100, 105, 99, 104),
        ]),
      ),
    );

    const bars = await new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 10);

    expect(bars).toHaveLength(2);
    expect(bars.map((b) => b.close_time.toISOString())).toEqual([
      '2026-08-07T11:00:00.000Z',
      '2026-08-07T12:00:00.000Z',
    ]);
  });

  it('excludes a forming candle whose close_time is after asOf', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ohlcResponse([
          candle('2026-08-07T11:00:00Z', 100, 105, 99, 104), // closes exactly at ASOF
          candle('2026-08-07T12:00:00Z', 104, 110, 104, 108), // closes after ASOF — forming
        ]),
      ),
    );

    const bars = await new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 5);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.close_time.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  it('trims to the most recent `limit` bars', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          ohlcResponse([
            candle('2026-08-07T09:00:00Z', 80, 85, 81, 84),
            candle('2026-08-07T10:00:00Z', 90, 95, 91, 94),
            candle('2026-08-07T11:00:00Z', 99, 105, 100, 104),
          ]),
        ),
    );

    const bars = await new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 2);

    expect(bars.map((b) => b.close_time.toISOString())).toEqual([
      '2026-08-07T11:00:00.000Z',
      '2026-08-07T12:00:00.000Z',
    ]);
  });

  it('returns [] for limit <= 0 without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const bars = await new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 0);

    expect(bars).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on an unsupported timeframe rather than sending a step Bitstamp cannot serve', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // 7h = 25200s is not one of Bitstamp's documented `step` values.
    await expect(new BitstampCandlesClient().getBars(SYMBOL, '7h', ASOF, 1)).rejects.toThrow(
      /unsupported timeframe/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws naming the symbol/timeframe on a non-OK response, without echoing a response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

    await expect(new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 5)).rejects.toThrow(
      /BTC-USD 1h.*HTTP 503/,
    );
  });

  it('throws on a malformed response missing data.ohlc', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: {} })));

    await expect(new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 1)).rejects.toThrow(
      /data\.ohlc/,
    );
  });

  it('throws on a candle field that is not a numeric string', async () => {
    const malformed = candle('2026-08-07T11:00:00Z', 100, 105, 99, 104);
    (malformed as { close: unknown }).close = 'not-a-number';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ohlcResponse([malformed])));

    await expect(new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 1)).rejects.toThrow(
      /malformed candle for BTC-USD/,
    );
  });

  it('throws on a candle field that is not a string at all (a vendor sending a raw number)', async () => {
    const malformed = candle('2026-08-07T11:00:00Z', 100, 105, 99, 104);
    (malformed as { close: unknown }).close = 104; // number, not the documented string
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ohlcResponse([malformed])));

    await expect(new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 1)).rejects.toThrow(
      /malformed candle for BTC-USD/,
    );
  });

  it('acquires from the injected rate limiter before each request — no bespoke sleep', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ohlcResponse([])));
    const rateLimiter = new TokenBucket({ capacity: 5, refillPerSecond: 5 });
    const acquireSpy = vi.spyOn(rateLimiter, 'acquireBackground');

    await new BitstampCandlesClient({ rateLimiter }).getBars(SYMBOL, '1h', ASOF, 1);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it('requests step=3600 for 1h and step=86400 for 1d', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ohlcResponse([])));
    vi.stubGlobal('fetch', fetchMock);

    await new BitstampCandlesClient().getBars(SYMBOL, '1h', ASOF, 1);
    await new BitstampCandlesClient().getBars(SYMBOL, '1d', ASOF, 1);

    const urls = fetchMock.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls[0]?.searchParams.get('step')).toBe('3600');
    expect(urls[1]?.searchParams.get('step')).toBe('86400');
  });
});
