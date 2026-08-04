import { AlpacaBrokerProviderError, AlpacaBrokerRateLimitError } from './alpaca-broker-errors.js';
import type { AlpacaBracketOrderRequest } from './alpaca-client.js';
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
