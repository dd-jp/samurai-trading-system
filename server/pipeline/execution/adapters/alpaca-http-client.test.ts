import { AlpacaBrokerProviderError, AlpacaBrokerRateLimitError } from './alpaca-broker-errors.js';
import type { AlpacaBracketOrderRequest, AlpacaMarketOrderRequest } from './alpaca-client.js';
import { AlpacaHttpBrokerClient } from './alpaca-http-client.js';

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

const ORDER_REQUEST: AlpacaBracketOrderRequest = {
  symbol: 'AAPL',
  side: 'buy',
  qty: '1',
  limit_price: '100.00',
  time_in_force: 'day',
  client_order_id: 'client-123',
  order_class: 'bracket',
  take_profit: { limit_price: '110.00' },
  stop_loss: { stop_price: '95.00' },
};

const ORDER_RESPONSE = {
  id: 'alpaca-order-1',
  client_order_id: 'client-123',
  symbol: 'AAPL',
  side: 'buy',
  qty: '1',
  order_class: 'bracket',
  status: 'new',
  filled_qty: '0',
  filled_avg_price: null,
  filled_at: null,
};

/** The flatten (#429) — a plain market order, never a bracket. */
const MARKET_ORDER_REQUEST: AlpacaMarketOrderRequest = {
  symbol: 'AAPL',
  side: 'sell',
  qty: '1',
  time_in_force: 'ioc',
  client_order_id: 'flatten-123',
};

describe('AlpacaHttpBrokerClient', () => {
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
      expect(() => new AlpacaHttpBrokerClient()).toThrow(/ALPACA_API_KEY/);
    } finally {
      if (previousKey !== undefined) process.env.ALPACA_API_KEY = previousKey;
      else delete process.env.ALPACA_API_KEY;
      if (previousSecret !== undefined) process.env.ALPACA_API_SECRET = previousSecret;
      else delete process.env.ALPACA_API_SECRET;
    }
  });

  it('throws if no API secret is available', () => {
    const previousKey = process.env.ALPACA_API_KEY;
    const previousSecret = process.env.ALPACA_API_SECRET;
    process.env.ALPACA_API_KEY = FAKE_KEY;
    delete process.env.ALPACA_API_SECRET;
    try {
      expect(() => new AlpacaHttpBrokerClient()).toThrow(/ALPACA_API_SECRET/);
    } finally {
      if (previousKey !== undefined) process.env.ALPACA_API_KEY = previousKey;
      else delete process.env.ALPACA_API_KEY;
      if (previousSecret !== undefined) process.env.ALPACA_API_SECRET = previousSecret;
      else delete process.env.ALPACA_API_SECRET;
    }
  });

  describe('environment-keyed credentials (#511)', () => {
    // Alpaca issues a different key pair per account, so `environment` selects
    // which variables the defaults read. Every value here is a stub.
    const NAMES = [
      'ALPACA_API_KEY',
      'ALPACA_API_SECRET',
      'ALPACA_LIVE_API_KEY',
      'ALPACA_LIVE_API_SECRET',
    ];
    const saved = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const name of NAMES) {
        saved.set(name, process.env[name]);
        delete process.env[name];
      }
    });

    afterEach(() => {
      for (const name of NAMES) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it('reads the LIVE pair for a live client, never the paper pair', () => {
      process.env.ALPACA_API_KEY = FAKE_KEY;
      process.env.ALPACA_API_SECRET = FAKE_SECRET;

      // The paper pair is fully set, so a fallback would construct silently and
      // authenticate the wrong account.
      expect(() => new AlpacaHttpBrokerClient({ environment: 'live' })).toThrow(
        /ALPACA_LIVE_API_KEY/,
      );
    });

    it('names the live SECRET when only that half is missing', () => {
      process.env.ALPACA_LIVE_API_KEY = FAKE_KEY;

      expect(() => new AlpacaHttpBrokerClient({ environment: 'live' })).toThrow(
        /ALPACA_LIVE_API_SECRET/,
      );
    });

    it('reads the PAPER pair for a paper client, and never looks at the live pair', () => {
      process.env.ALPACA_API_KEY = FAKE_KEY;
      process.env.ALPACA_API_SECRET = FAKE_SECRET;
      process.env.ALPACA_LIVE_API_KEY = '';

      // A blank live-only variable must not be able to fail a paper boot.
      expect(() => new AlpacaHttpBrokerClient({ environment: 'paper' })).not.toThrow();
      expect(() => new AlpacaHttpBrokerClient()).not.toThrow();
    });

    it.each(['', '   '])('treats an env value of %j as absent', (value) => {
      process.env.ALPACA_LIVE_API_KEY = value;
      process.env.ALPACA_LIVE_API_SECRET = FAKE_SECRET;

      // `--env-file` turns a placeholder `ALPACA_LIVE_API_KEY=` into `''`, which
      // is "not configured" — not a credential of length zero.
      expect(() => new AlpacaHttpBrokerClient({ environment: 'live' })).toThrow(
        /ALPACA_LIVE_API_KEY/,
      );
    });

    it('constructs a live client on the live pair alone, with no paper pair set', () => {
      process.env.ALPACA_LIVE_API_KEY = FAKE_KEY;
      process.env.ALPACA_LIVE_API_SECRET = FAKE_SECRET;

      const client = new AlpacaHttpBrokerClient({ environment: 'live' });

      expect(client.baseUrl).toBe('https://api.alpaca.markets');
    });

    it('never puts a credential value in the refusal', () => {
      process.env.ALPACA_API_KEY = 'paper-key-value';
      process.env.ALPACA_API_SECRET = 'paper-secret-value';

      try {
        new AlpacaHttpBrokerClient({ environment: 'live' });
        expect.unreachable('expected a refusal');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('paper-key-value');
        expect(message).not.toContain('paper-secret-value');
      }
    });
  });

  it('submitOrder POSTs to /v2/orders with the APCA auth headers and returns the parsed order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ORDER_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const result = await client.submitOrder(ORDER_REQUEST);

    expect(result).toEqual(ORDER_RESPONSE);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://paper-api.alpaca.markets/v2/orders');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['APCA-API-KEY-ID']).toBe(FAKE_KEY);
    expect(headers['APCA-API-SECRET-KEY']).toBe(FAKE_SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ ...ORDER_REQUEST, type: 'limit' });
    expect(headers['content-type']).toBe('application/json');
  });

  it('submitOrder passes through a full bracket response (nested take-profit/stop-loss legs) unmodified', async () => {
    // The client sends `type: 'limit'` on every request regardless of
    // order_class (#260) but never inspects or narrows the response shape —
    // this proves a bracket order's nested `legs` survive untouched, not
    // just the flat fields the other fixture happens to cover.
    const bracketResponse = {
      ...ORDER_RESPONSE,
      legs: [
        { id: 'leg-take-profit', type: 'limit', limit_price: '110.00', status: 'held' },
        { id: 'leg-stop-loss', type: 'stop', stop_price: '95.00', status: 'held' },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(bracketResponse));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const result = await client.submitOrder(ORDER_REQUEST);

    expect(result).toEqual(bracketResponse);
  });

  it('submitMarketOrder (the flatten, #429) POSTs to /v2/orders and returns the parsed order', async () => {
    const marketResponse = {
      id: 'alpaca-order-2',
      client_order_id: 'flatten-123',
      symbol: 'AAPL',
      side: 'sell',
      qty: '1',
      order_class: 'simple',
      status: 'new',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(marketResponse));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const result = await client.submitMarketOrder(MARKET_ORDER_REQUEST);

    expect(result).toEqual(marketResponse);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://paper-api.alpaca.markets/v2/orders');
    expect(JSON.parse(init.body as string)).toEqual({ ...MARKET_ORDER_REQUEST, type: 'market' });
  });

  it('submitLimitOrder (#586) POSTs a plain limit body — type on the wire, no order_class', async () => {
    const limitResponse = {
      id: 'alpaca-order-3',
      client_order_id: 'key-btc-1',
      symbol: 'BTC/USD',
      side: 'buy',
      qty: '0.5',
      status: 'accepted',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(limitResponse));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const request = {
      symbol: 'BTC/USD',
      side: 'buy' as const,
      qty: '0.5',
      limit_price: '60000',
      time_in_force: 'gtc',
      client_order_id: 'key-btc-1',
    };
    const result = await client.submitLimitOrder(request);

    expect(result).toEqual(limitResponse);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://paper-api.alpaca.markets/v2/orders');
    // Exact body: `type` is the wire-only addition, and NO `order_class`
    // rides along — crypto rejects every advanced order class (#550).
    expect(JSON.parse(init.body as string)).toEqual({ ...request, type: 'limit' });
  });

  it('submitStopLimitOrder (#586) POSTs type stop_limit with both the trigger and the limit', async () => {
    const stopLimitResponse = {
      id: 'alpaca-order-4',
      client_order_id: 'key-btc-1:stop',
      symbol: 'BTC/USD',
      side: 'sell',
      qty: '0.5',
      status: 'accepted',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(stopLimitResponse));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const request = {
      symbol: 'BTC/USD',
      side: 'sell' as const,
      qty: '0.5',
      stop_price: '57000',
      limit_price: '57000',
      time_in_force: 'gtc',
      client_order_id: 'key-btc-1:stop',
    };
    const result = await client.submitStopLimitOrder(request);

    expect(result).toEqual(stopLimitResponse);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ ...request, type: 'stop_limit' });
  });

  it('submitOcoOrder (#586) sends the VERIFIED nested take_profit shape, type limit on the wire', async () => {
    const ocoResponse = {
      id: 'alpaca-order-5',
      client_order_id: 'key-1:rearm',
      symbol: 'AAPL',
      side: 'sell',
      qty: '6',
      order_class: 'oco',
      status: 'accepted',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ocoResponse));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const request = {
      symbol: 'AAPL',
      side: 'sell' as const,
      qty: '6',
      time_in_force: 'gtc',
      client_order_id: 'key-1:rearm',
      order_class: 'oco' as const,
      // #550's verified requirement: 422 code 40010001 "oco orders require
      // take_profit.limit_price" for any shape that puts this top-level.
      take_profit: { limit_price: '110' },
      stop_loss: { stop_price: '95' },
    };
    const result = await client.submitOcoOrder(request);

    expect(result).toEqual(ocoResponse);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody).toEqual({ ...request, type: 'limit' });
    expect(sentBody.limit_price).toBeUndefined();
  });

  it('omits content-type on bodyless (GET) requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ORDER_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    await client.getOrder('order-id');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(headers['APCA-API-KEY-ID']).toBe(FAKE_KEY);
  });

  it('submitOrder always sends type: "limit" on the wire body (required by Alpaca, not part of the interface)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ORDER_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    await client.submitOrder(ORDER_REQUEST);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody.type).toBe('limit');
  });

  it('getOrder GETs /v2/orders/{id}', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ORDER_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const result = await client.getOrder('alpaca-order-1');

    expect(result).toEqual(ORDER_RESPONSE);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://paper-api.alpaca.markets/v2/orders/alpaca-order-1');
  });

  it('getOrderByClientOrderId GETs the by_client_order_id endpoint and returns the parsed order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ORDER_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const result = await client.getOrderByClientOrderId('client-123');

    expect(result).toEqual(ORDER_RESPONSE);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://paper-api.alpaca.markets/v2/orders:by_client_order_id?client_order_id=client-123',
    );
  });

  it('getOrderByClientOrderId maps a 404 to null rather than throwing (crash-restart reconciliation, #86)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'order not found' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const result = await client.getOrderByClientOrderId('unknown-client-id');

    expect(result).toBeNull();
    // 404 is not retryable, so the null-mapping must not have masked retries either.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getOrder rethrows a non-404 error rather than mapping it to null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'server error' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

    await expect(client.getOrder('alpaca-order-1')).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('classifies a 429 as AlpacaBrokerRateLimitError and retries, honoring Retry-After', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse(ORDER_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 },
    });

    const promise = client.getOrder('alpaca-order-1');
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result).toEqual(ORDER_RESPONSE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400 (non-5xx ProviderError)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'bad request' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    });

    await expect(client.submitOrder(ORDER_REQUEST)).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 up to maxAttempts and eventually succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse(ORDER_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    });

    const promise = client.getOrder('alpaca-order-1');
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result).toEqual(ORDER_RESPONSE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * Was "respects a custom baseUrl (e.g. the live trading host)" — a bare
   * `baseUrl: 'https://api.alpaca.markets'` used to be honoured, which is the
   * accident #293 closes. A custom host is still respected; reaching the LIVE
   * one now also takes `environment: 'live'`. See the environment-guard
   * describe block below for the refusal cases.
   */
  it('respects a custom baseUrl when the environment agrees', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ORDER_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      environment: 'live',
      baseUrl: 'https://api.alpaca.markets',
    });
    await client.getOrder('alpaca-order-1');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.alpaca.markets/v2/orders/alpaca-order-1');
  });

  it('surfaces a rejected rate-limit error as AlpacaBrokerRateLimitError when retries are exhausted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'still rate limited' }, 429));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 },
    });

    const promise = client.getOrder('alpaca-order-1');
    const assertion = expect(promise).rejects.toBeInstanceOf(AlpacaBrokerRateLimitError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('classifies a fetchWithTimeout abort as AlpacaBrokerTimeoutError and retries it', async () => {
    let attempt = 0;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      attempt++;
      if (attempt === 1) {
        const signal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      }
      return Promise.resolve(jsonResponse(ORDER_RESPONSE));
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      timeoutMs: 500,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 },
    });

    const promise = client.getOrder('alpaca-order-1');
    await vi.advanceTimersByTimeAsync(500); // trips the fetchWithTimeout abort on attempt 1
    await vi.advanceTimersByTimeAsync(1_000); // clears the retry backoff before attempt 2
    const result = await promise;

    expect(result).toEqual(ORDER_RESPONSE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies a generic network failure (e.g. DNS resolution TypeError) as a non-retryable AlpacaBrokerProviderError', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    });

    await expect(client.getOrder('alpaca-order-1')).rejects.toMatchObject({
      name: 'AlpacaBrokerProviderError',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The paper/live environment guard (#293).
 *
 * Every test here passes `apiKey`/`apiSecret` explicitly. That is not
 * boilerplate: the constructor validates credentials FIRST, so a guard test
 * that omitted them would throw `ALPACA_API_KEY is not set` and pass with the
 * guard deleted. Same reason the assertions match on the message rather than
 * calling a bare `toThrow()`.
 */
describe('AlpacaHttpBrokerClient — paper/live environment guard (#293)', () => {
  const PAPER_HOST = 'https://paper-api.alpaca.markets';
  const LIVE_HOST = 'https://api.alpaca.markets';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function hostOf(fetchMock: ReturnType<typeof vi.fn>): string {
    const [url] = fetchMock.mock.calls[0] as [string];
    return new URL(url).origin;
  }

  async function contactedHost(options: {
    environment?: 'paper' | 'live';
    baseUrl?: string;
  }): Promise<string> {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ORDER_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);
    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      ...options,
    });
    await client.getOrder('alpaca-order-1');
    return hostOf(fetchMock);
  }

  it('reaches the paper host when neither environment nor baseUrl is given', async () => {
    expect(await contactedHost({})).toBe(PAPER_HOST);
  });

  it('reaches the paper host for an explicit paper environment', async () => {
    expect(await contactedHost({ environment: 'paper' })).toBe(PAPER_HOST);
  });

  // The one word that makes a process spend real money. Reachable only by
  // typing it — never by defaulting, never by omission.
  it('reaches the live host only for an explicit live environment', async () => {
    expect(await contactedHost({ environment: 'live' })).toBe(LIVE_HOST);
  });

  it('allows the live host when the environment says live', async () => {
    expect(await contactedHost({ environment: 'live', baseUrl: LIVE_HOST })).toBe(LIVE_HOST);
  });

  // THE key test: a live baseUrl with no environment stated. Before #293 this
  // silently traded real money; the default must refuse, not accommodate.
  it('refuses a live baseUrl when the environment is omitted (defaults to paper)', () => {
    expect(
      () =>
        new AlpacaHttpBrokerClient({
          apiKey: FAKE_KEY,
          apiSecret: FAKE_SECRET,
          baseUrl: LIVE_HOST,
        }),
    ).toThrow(/environment/);
  });

  it('refuses a live baseUrl when the environment says paper', () => {
    expect(
      () =>
        new AlpacaHttpBrokerClient({
          apiKey: FAKE_KEY,
          apiSecret: FAKE_SECRET,
          environment: 'paper',
          baseUrl: LIVE_HOST,
        }),
    ).toThrow(/environment/);
  });

  // The "or vice versa" half: an operator who believes they are live but is
  // silently filling paper orders has a broken risk model too.
  it('refuses the paper host when the environment says live', () => {
    expect(
      () =>
        new AlpacaHttpBrokerClient({
          apiKey: FAKE_KEY,
          apiSecret: FAKE_SECRET,
          environment: 'live',
          baseUrl: PAPER_HOST,
        }),
    ).toThrow(/environment/);
  });

  // A string-prefix check would let every one of these through to real money.
  it.each([
    'https://API.ALPACA.MARKETS',
    'https://Api.Alpaca.Markets/',
    ' https://api.alpaca.markets',
    'https://api.alpaca.markets/v2',
    'https://api.alpaca.markets:443',
  ])('refuses the live host spelled as %s from a paper client', (baseUrl) => {
    expect(
      () =>
        new AlpacaHttpBrokerClient({
          apiKey: FAKE_KEY,
          apiSecret: FAKE_SECRET,
          environment: 'paper',
          baseUrl,
        }),
    ).toThrow(/environment/);
  });

  it('refuses an empty baseUrl rather than silently resolving one', () => {
    expect(
      () => new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET, baseUrl: '' }),
    ).toThrow(/baseUrl/);
  });

  it('refuses an unparseable baseUrl', () => {
    expect(
      () =>
        new AlpacaHttpBrokerClient({
          apiKey: FAKE_KEY,
          apiSecret: FAKE_SECRET,
          baseUrl: 'paper-api.alpaca.markets',
        }),
    ).toThrow(/baseUrl/);
  });

  it('allows a non-Alpaca host (staging/mock) in either environment', async () => {
    expect(await contactedHost({ baseUrl: 'http://localhost:9999' })).toBe('http://localhost:9999');
    expect(await contactedHost({ environment: 'live', baseUrl: 'http://localhost:9999' })).toBe(
      'http://localhost:9999',
    );
  });

  it('never puts the credentials in the mismatch message', () => {
    try {
      new AlpacaHttpBrokerClient({
        apiKey: FAKE_KEY,
        apiSecret: FAKE_SECRET,
        environment: 'paper',
        baseUrl: LIVE_HOST,
      });
      expect.unreachable('constructor should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(FAKE_KEY);
      expect(message).not.toContain(FAKE_SECRET);
    }
  });
});

/**
 * Wire validation (issue #509). Before this ticket `request<T>` was a bare
 * `(await response.json()) as T` — every field of every response shape rode
 * along unvalidated through the ONE client whose fields feed money math
 * directly. Every case here asserts the classified `AlpacaBrokerProviderError`,
 * never a structurally-wrong object reaching `alpaca-adapter.ts`.
 */
describe('AlpacaHttpBrokerClient — wire validation (#509)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('submitOrder rejects a truncated order missing required fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'alpaca-order-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('submitOrder rejects an order whose filled_qty is the wrong type (out-of-type body)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...ORDER_RESPONSE, filled_qty: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('submitOrder rejects an order whose filled_qty does not parse to a finite number', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...ORDER_RESPONSE, filled_qty: 'N/A' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('submitOrder rejects a response body that is not an object at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('submitOrder accepts an order missing client_order_id/qty/side/order_class (unread-off-a-response fields)', async () => {
    // `submitBracket` reads these four off its own REQUEST object, never off
    // the response (grepped: no `response.client_order_id`/`.qty`/`.side`/
    // `.order_class` in alpaca-adapter.ts) — and `submitMarketOrder` (the
    // flatten, #429) has no verified live sample confirming Alpaca always
    // echoes `order_class` on a plain market order. Requiring them here would
    // be an unverified-shape guess on the live-order path with no consumer to
    // justify it, so the validator must accept their absence.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'alpaca-order-1',
        status: 'new',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).resolves.toEqual({
      id: 'alpaca-order-1',
      status: 'new',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
    });
  });

  it('accepts legs: null — the shape live Alpaca returns on every flatten (#921)', async () => {
    // The exact body a filled paper market sell returned on 2026-08-26, fields
    // trimmed to the ones the validator reads. Before the fix, `legs: null`
    // failed the `Array.isArray` check and threw an
    // `AlpacaBrokerProviderError` AFTER the venue had already filled the
    // order — so the store kept the lot open against a flat account, and
    // `resumeFlatten` threw identically, leaving reconcile unable to repair
    // it. No flatten could ever complete against live Alpaca.
    const liveFlattenResponse = {
      id: '296d7b03-d6ab-46d0-8eb3-3b045415a688',
      client_order_id: 'flatten-key',
      symbol: 'SPY',
      side: 'sell',
      qty: '1',
      order_class: '',
      status: 'filled',
      filled_qty: '1',
      filled_avg_price: '766.23',
      filled_at: '2026-08-26T19:56:40.033801055Z',
      legs: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(liveFlattenResponse));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitMarketOrder(MARKET_ORDER_REQUEST)).resolves.toEqual(
      liveFlattenResponse,
    );
  });

  it('getOrderByClientOrderId accepts legs: null too — the reconcile half of #921', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'alpaca-order-1',
        status: 'filled',
        filled_qty: '1',
        filled_avg_price: '766.23',
        filled_at: '2026-08-26T19:56:40.033801055Z',
        legs: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getOrderByClientOrderId('flatten-key')).resolves.toMatchObject({
      id: 'alpaca-order-1',
      status: 'filled',
    });
  });

  it('still rejects legs when it is present and a non-array, non-null value', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...ORDER_RESPONSE, legs: 'two' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('submitOrder still rejects client_order_id/qty/side/order_class when present but the wrong type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...ORDER_RESPONSE, side: 'up' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('submitOrder rejects a bracket leg missing its required id/type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ...ORDER_RESPONSE,
        legs: [{ status: 'held' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('submitOrder still accepts a bracket leg that omits fill fields entirely (unverified-shape leniency)', async () => {
    // Deliberately the SAME fixture shape as the passthrough test above
    // (`limit_price`/`stop_price`, no `filled_qty`/`filled_avg_price`/
    // `filled_at`) — proves the leniency documented on `validateAlpacaOrderLeg`
    // doesn't regress into rejecting a legitimate not-yet-filled leg.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ...ORDER_RESPONSE,
        legs: [{ id: 'leg-take-profit', type: 'limit', limit_price: '110.00', status: 'held' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).resolves.toMatchObject({
      legs: [{ id: 'leg-take-profit', type: 'limit' }],
    });
  });

  it('submitOrder rejects a bracket leg whose present filled_qty does not parse (garbage while present)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ...ORDER_RESPONSE,
        legs: [
          {
            id: 'leg-stop',
            type: 'stop',
            status: 'new',
            filled_qty: 'garbage',
            filled_avg_price: null,
            filled_at: null,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.submitOrder(ORDER_REQUEST)).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('getOrder rejects a truncated order (getOrder shares the same validator as submitOrder)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'alpaca-order-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getOrder('alpaca-order-1')).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('getOrderByClientOrderId rethrows a validation failure rather than mapping it to null', async () => {
    // A malformed 200 body must not be mistaken for the 404 "no such order"
    // case — `failValidation` never sets `.status`, so the 404-only null
    // mapping must not fire here.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'alpaca-order-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getOrderByClientOrderId('client-123')).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
  });

  it('getPositions rejects a truncated position missing required fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ symbol: 'AAPL' }]));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getPositions()).rejects.toBeInstanceOf(AlpacaBrokerProviderError);
  });

  it('getPositions rejects a position whose qty is the wrong type (out-of-type body)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([{ symbol: 'AAPL', qty: 1, side: 'long', avg_entry_price: '150.00' }]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getPositions()).rejects.toBeInstanceOf(AlpacaBrokerProviderError);
  });

  it('getPositions rejects a response body that is not an array at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ not: 'an array' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getPositions()).rejects.toBeInstanceOf(AlpacaBrokerProviderError);
  });

  it('getAccount rejects a truncated account missing required fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ cash: '1000' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getAccount()).rejects.toBeInstanceOf(AlpacaBrokerProviderError);
  });

  it('getAccount rejects an account whose equity is the wrong type (out-of-type body)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ cash: '1000', equity: 5000 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getAccount()).rejects.toBeInstanceOf(AlpacaBrokerProviderError);
  });

  it('getAccount rejects a present but unparseable buying_power', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ cash: '1000', equity: '1000', buying_power: 'unlimited' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getAccount()).rejects.toBeInstanceOf(AlpacaBrokerProviderError);
  });

  it('getAccount accepts a body with no buying_power at all (optional field)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ cash: '1000', equity: '2000' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.getAccount()).resolves.toEqual({ cash: '1000', equity: '2000' });
  });

  it('a malformed body is retried like any other attempt failure, not treated as a special case', async () => {
    // Parse failures have no HTTP status, so `isRetryableAlpacaBrokerError`
    // classifies them non-retryable — this pins that a validation failure on
    // attempt 1 does NOT get retried, matching the documented intent for a
    // shape failure (issue #509's design note).
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'alpaca-order-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpBrokerClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    });

    await expect(client.getOrder('alpaca-order-1')).rejects.toBeInstanceOf(
      AlpacaBrokerProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
