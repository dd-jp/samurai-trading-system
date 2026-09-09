import { TokenBucket } from '../../../shared/index.js';
import {
  SaxoBrokerProviderError,
  SaxoBrokerRateLimitError,
  SaxoBrokerTimeoutError,
} from './saxo-broker-errors.js';
import type { SaxoOrderRequest } from './saxo-client.js';
import { SAXO_CREDENTIAL_ENV_VARS, SaxoHttpBrokerClient } from './saxo-http-client.js';

/**
 * These tests assert transport behaviour (retry, validation, error mapping),
 * not pacing (#1222 covers per-request pacing directly, in
 * saxo-per-request-pacing.test.ts) — a permissive bucket keeps every case
 * off the (fake, non-advancing) pacing clock regardless of how many requests
 * it issues on one client.
 */
function permissiveLimiter(): TokenBucket {
  return new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
}

const FAKE_TOKEN = 'test-fake-saxo-token';
const ACCOUNTS = { Data: [{ AccountKey: 'acct-key', ClientKey: 'client-key' }] };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: async () => body,
    text: async () => text,
  } as Response;
}

const ORDER: SaxoOrderRequest = {
  Uic: 3347273,
  AssetType: 'Etn',
  BuySell: 'Buy',
  Amount: 1,
  OrderType: 'Limit',
  OrderPrice: 10,
  OrderDuration: { DurationType: 'DayOrder' },
  ManualOrder: false,
  ExternalReference: 'key-1',
};

function makeClient(
  fetchMock: ReturnType<typeof vi.fn>,
  retry = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
) {
  vi.stubGlobal('fetch', fetchMock);
  return new SaxoHttpBrokerClient({
    accessToken: FAKE_TOKEN,
    baseUrl: 'https://gateway.example/sim/openapi/',
    retry,
    rateLimiter: permissiveLimiter(),
  });
}

function calledPath(fetchMock: ReturnType<typeof vi.fn>, index: number): string {
  return String(fetchMock.mock.calls[index]?.[0]);
}

function calledInit(fetchMock: ReturnType<typeof vi.fn>, index: number): RequestInit {
  return (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
}

describe('SaxoHttpBrokerClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refuses to construct without a token, naming the env var', () => {
    vi.stubEnv(SAXO_CREDENTIAL_ENV_VARS.sim.token, '   ');
    expect(() => new SaxoHttpBrokerClient()).toThrow(/SAXO_OPENAPI_TOKEN/);
    vi.unstubAllEnvs();
  });

  it('resolves the account once, then POSTs with AccountKey, bearer and x-request-id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ OrderId: '1', ExternalReference: 'key-1', Orders: [] }))
      .mockResolvedValueOnce(jsonResponse({ OrderId: '2' }));
    const client = makeClient(fetchMock);

    const first = await client.placeOrder(ORDER, 'key-1');
    await client.placeOrder({ ...ORDER, ExternalReference: 'key-2' }, 'key-2');

    expect(first).toEqual({ OrderId: '1', ExternalReference: 'key-1', Orders: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(calledPath(fetchMock, 0)).toBe(
      'https://gateway.example/sim/openapi/port/v1/accounts/me',
    );
    expect(calledPath(fetchMock, 1)).toBe('https://gateway.example/sim/openapi/trade/v2/orders');
    const init = calledInit(fetchMock, 1);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ AccountKey: 'acct-key', Uic: 3347273 });
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${FAKE_TOKEN}`,
      'x-request-id': 'key-1',
      'content-type': 'application/json',
    });
  });

  it('does not retry a placement on a 503 — the adapter adopts instead', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValue(jsonResponse({ Message: 'unavailable' }, 503));
    const client = makeClient(fetchMock);

    await expect(client.placeOrder(ORDER, 'key-1')).rejects.toBeInstanceOf(SaxoBrokerProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the empty-bodied 409 as a ProviderError with status 409', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse(undefined, 409));
    const client = makeClient(fetchMock);

    await expect(client.placeOrder(ORDER, 'key-1')).rejects.toMatchObject({ status: 409 });
  });

  it("lifts ErrorInfo.ErrorCode from a rejected placement's envelope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ErrorInfo: { ErrorCode: 'OrderTypeNotSupported', Message: 'Order type not supported' },
            ExternalReference: 'key-1',
            Orders: [],
          },
          400,
        ),
      );
    const client = makeClient(fetchMock);

    await expect(client.placeOrder(ORDER, 'key-1')).rejects.toMatchObject({
      status: 400,
      code: 'OrderTypeNotSupported',
      venueMessage: 'Order type not supported',
    });
  });

  it('reads a leg-level ErrorInfo when the top level carries none', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
        jsonResponse(
          { Orders: [{ ErrorInfo: { ErrorCode: 'InvalidPrice', Message: 'tick' } }] },
          400,
        ),
      );
    const client = makeClient(fetchMock);

    await expect(client.placeOrder(ORDER, 'key-1')).rejects.toMatchObject({ code: 'InvalidPrice' });
  });

  it('DELETEs by OrderId with the AccountKey and maps OrderNotFound', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ Orders: [{ OrderId: '77' }] }))
      .mockResolvedValueOnce(
        jsonResponse(
          { Orders: [{ ErrorInfo: { ErrorCode: 'OrderNotFound', Message: 'x' } }] },
          404,
        ),
      );
    const client = makeClient(fetchMock);

    await client.cancelOrder('77');
    await expect(client.cancelOrder('77')).rejects.toMatchObject({
      status: 404,
      code: 'OrderNotFound',
    });
    expect(calledPath(fetchMock, 1)).toBe(
      'https://gateway.example/sim/openapi/trade/v2/orders/77?AccountKey=acct-key',
    );
    expect(calledInit(fetchMock, 1).method).toBe('DELETE');
  });

  it('follows __next across open-order pages and validates each row', async () => {
    const row = {
      OrderId: '1',
      ExternalReference: 'key-1',
      Status: 'Working',
      OpenOrderType: 'Limit',
      OrderRelation: 'IfDoneMaster',
      Price: 10,
      Amount: 1,
      BuySell: 'Buy',
      Uic: 3347273,
      AssetType: 'Etn',
      RelatedOpenOrders: [
        {
          OrderId: '2',
          OpenOrderType: 'StopIfTraded',
          OrderPrice: 9,
          Amount: 1,
          Status: 'NotWorking',
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          __count: 2,
          __next: 'https://gateway.example/sim/openapi/port/v1/orders/me?$top=500&$skip=500',
          Data: [row],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ __count: 2, Data: [{ ...row, OrderId: '3' }] }));
    const client = makeClient(fetchMock);

    const orders = await client.listOpenOrders();

    expect(orders.map((order) => order.OrderId)).toEqual(['1', '3']);
    expect(orders[0]?.RelatedOpenOrders?.[0]?.OpenOrderType).toBe('StopIfTraded');
    expect(calledPath(fetchMock, 1)).toBe(
      'https://gateway.example/sim/openapi/port/v1/orders/me?$top=500&$skip=500',
    );
  });

  it('rejects an open-order row missing a required field instead of guessing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ Data: [{ OrderId: '1' }] }));
    const client = makeClient(fetchMock);

    await expect(client.listOpenOrders()).rejects.toThrow(/malformed response body/);
  });

  it('queries order activities by ClientKey and FromDateTime', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
        jsonResponse({
          Data: [
            {
              ActivityTime: '2026-09-05T08:30:00Z',
              LogId: 'log-1',
              OrderId: '1',
              ExternalReference: 'key-1',
              Status: 'Placed',
              SubStatus: 'Rejected',
              Amount: 1,
              Price: 10,
              BuySell: 'Buy',
              Uic: 3347273,
              AssetType: 'Etn',
            },
          ],
        }),
      );
    const client = makeClient(fetchMock);

    const activities = await client.listOrderActivities(new Date('2026-09-05T00:00:00Z'));

    expect(activities).toEqual([
      expect.objectContaining({ LogId: 'log-1', SubStatus: 'Rejected' }),
    ]);
    expect(calledPath(fetchMock, 1)).toBe(
      'https://gateway.example/sim/openapi/cs/v1/audit/orderactivities?ClientKey=client-key&FromDateTime=2026-09-05T00%3A00%3A00.000Z&%24top=500',
    );
  });

  it('validates net positions down to NetPositionBase.Amount and Uic', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        Data: [
          {
            NetPositionId: '3347273__Etn',
            NetPositionBase: { Amount: 2, Uic: 3347273, AssetType: 'Etn' },
            NetPositionView: { AverageOpenPrice: 10.5 },
            DisplayAndFormat: { Symbol: '3USL:xlon' },
          },
        ],
      }),
    );
    const client = makeClient(fetchMock);

    expect(await client.listNetPositions()).toEqual([
      {
        NetPositionId: '3347273__Etn',
        NetPositionBase: { Amount: 2, Uic: 3347273, AssetType: 'Etn' },
        NetPositionView: { AverageOpenPrice: 10.5 },
        DisplayAndFormat: { Symbol: '3USL:xlon' },
      },
    ]);
  });

  it('retries a read on 429 honouring Retry-After', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ Message: 'slow down' }, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse({ Data: [] }));
    const client = makeClient(fetchMock);

    const pending = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies a 429 that never clears as SaxoBrokerRateLimitError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Message: 'slow down' }, 429));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOpenOrders()).rejects.toBeInstanceOf(SaxoBrokerRateLimitError);
  });

  it('refuses to pick between several accounts silently', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        Data: [
          { AccountKey: 'a', ClientKey: 'c' },
          { AccountKey: 'b', ClientKey: 'c' },
        ],
      }),
    );
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.placeOrder(ORDER, 'key-1')).rejects.toThrow(/accountKey/);
  });

  it('never embeds the token in an error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Message: 'nope' }, 401));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOpenOrders()).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && !error.message.includes(FAKE_TOKEN),
    );
  });

  // #1223: a status-less transport failure (ECONNRESET/DNS failure/socket
  // hangup — `fetch` rejecting rather than resolving) was never retried,
  // including on safe, side-effect-free reads.
  describe('status-less transport failures (#1223)', () => {
    it('retries a transport failure on a safe read (listOpenOrders is a GET)', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('read ECONNRESET'))
        .mockResolvedValueOnce(jsonResponse({ Data: [] }));
      const client = makeClient(fetchMock);

      const pending = client.listOpenOrders();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await pending).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a transport failure on listOrderActivities (also a GET)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND gateway.saxobank.com'))
        .mockResolvedValueOnce(jsonResponse({ Data: [] }));
      const client = makeClient(fetchMock);

      const pending = client.listOrderActivities(new Date('2026-09-01T00:00:00Z'));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await pending).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    // The money-safety guarantee: a blind retry of a placement whose response
    // was lost can produce a second live order (doc 43, PR #1212). This test
    // pins the end-to-end behavior with a generous retry budget, but the
    // budget alone does not isolate which guard is holding the line: PR
    // #1212's pre-existing `maxAttempts: 1` override on `placeOrder` already
    // forces exactly one attempt regardless of what `isRetryableSaxoBrokerError`
    // answers (confirmed by mutation — flipping the POST classification to
    // retryable does not fail this test). The classification-level guarantee
    // this ticket adds — that a status-less POST error is itself classified
    // non-retryable — is proven in isolation by `saxo-broker-errors.test.ts`'s
    // "is NOT retryable when the failing request was a POST" unit test, which
    // DOES fail under that same mutation.
    it('does NOT retry a transport failure on placeOrder (a POST), even with attempts to spare', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockRejectedValue(new Error('socket hang up'));
      const client = makeClient(fetchMock, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 });

      await expect(client.placeOrder(ORDER, 'key-1')).rejects.toBeInstanceOf(
        SaxoBrokerProviderError,
      );
      // 1 for resolveIdentity + exactly 1 placement attempt — no retry.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a transport failure on cancelOrder (a DELETE — not a safe read)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockRejectedValue(new Error('socket hang up'));
      const client = makeClient(fetchMock, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 });

      await expect(client.cancelOrder('order-1')).rejects.toBeInstanceOf(SaxoBrokerProviderError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // #1273: a timeout abort was retried unconditionally regardless of verb —
  // the sole guard against retrying a lost placement response was
  // `placeOrder`'s `maxAttempts: 1` below. This end-to-end pair pins the
  // fix, but — same caveat as "does NOT retry a transport failure on
  // placeOrder" above — the placeOrder test below does NOT by itself catch a
  // classifier regression: `maxAttempts: 1` pins it to one attempt
  // regardless of what `isRetryableSaxoBrokerError` answers (confirmed by
  // mutation — reverting `isRetrySafeSaxoMethod` to always `true` leaves
  // this file's 21 tests green). The classification-level guarantee is
  // proven in isolation by `saxo-broker-errors.test.ts`'s
  // "timeout/rate-limit/5xx retryability is verb-aware" suite, four cases of
  // which DO fail under that same mutation.
  describe('timeout retryability is verb-aware (#1273)', () => {
    it('does NOT retry a timeout on placeOrder (a POST), even with attempts to spare', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
      const client = makeClient(fetchMock, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 });

      await expect(client.placeOrder(ORDER, 'key-1')).rejects.toBeInstanceOf(
        SaxoBrokerTimeoutError,
      );
      // 1 for resolveIdentity + exactly 1 placement attempt — no retry.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // The preserved behavior: doc 43:33 measured a repeat order-cancel as
    // venue-idempotent (`404 OrderNotFound`).
    it('DOES retry a timeout on cancelOrder (a DELETE)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))
        .mockResolvedValueOnce(jsonResponse(undefined));
      const client = makeClient(fetchMock, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });

      const pending = client.cancelOrder('order-1');
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
