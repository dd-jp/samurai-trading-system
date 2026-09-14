import { TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import {
  SaxoBrokerProviderError,
  SaxoBrokerRateLimitError,
  SaxoBrokerTimeoutError,
} from './saxo-broker-errors.js';
import type { SaxoOrderRequest } from './saxo-client.js';
import { SAXO_CREDENTIAL_ENV_VARS, SaxoHttpBrokerClient } from './saxo-http-client.js';

/**
 * Most of these tests assert transport behaviour (retry, validation, error
 * mapping), not pacing (#1222's fan-out-count evidence lives in
 * saxo-per-request-pacing.test.ts) — a permissive bucket keeps every case
 * off the (fake, non-advancing) pacing clock regardless of how many requests
 * it issues on one client. The `SaxoHttpBrokerClient pacing (#1222)` describe
 * block below is the exception: it deliberately does NOT inject a permissive
 * bucket, to pin the constructor's own default (the only pacing path a real
 * call site takes today, mirroring `http-polygon-client.test.ts`'s "free-tier
 * pacing" split between an injected bucket and the constructor's own).
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
    logger: recordingLogger(),
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
    expect(() => new SaxoHttpBrokerClient({ logger: recordingLogger() })).toThrow(
      /SAXO_SIM_ACCESS_TOKEN/,
    );
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

  describe('getBalances (#1509)', () => {
    it('reads the account-currency funding figures off a single object, not a Data envelope', async () => {
      // A correctly funded live book: £1,000 in GBP, ADR-0015's 2026-08-18
      // amendment. Nothing here is measured against the live GIA.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ Currency: 'GBP', CashBalance: 1_000, TotalValue: 1_000 }),
        );
      const client = makeClient(fetchMock);

      expect(await client.getBalances()).toEqual({
        Currency: 'GBP',
        CashBalance: 1_000,
        TotalValue: 1_000,
      });
      expect(calledPath(fetchMock, 0)).toBe(
        'https://gateway.example/sim/openapi/port/v1/balances/me',
      );
      expect(calledInit(fetchMock, 0).method).toBe('GET');
    });

    it('throws rather than defaulting when a funding figure is missing', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Currency: 'GBP' }));
      const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

      await expect(client.getBalances()).rejects.toThrow(/CashBalance/);
    });

    it('throws rather than assuming a currency when the venue reports none', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ CashBalance: 1_000, TotalValue: 1_000 }));
      const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

      await expect(client.getBalances()).rejects.toThrow(/Currency/);
    });
  });

  it('reads a line quote unit off instrument details, account-free (#1302)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        Uic: 29391797,
        AssetType: 'Etn',
        Symbol: 'LQQ3:xlon',
        CurrencyCode: 'GBP',
        PriceCurrency: 'GBX',
        PriceToContractFactor: 0.01,
      }),
    );
    const client = makeClient(fetchMock);

    expect(await client.getInstrumentDetails(29391797, 'Etn')).toEqual({
      Uic: 29391797,
      AssetType: 'Etn',
      CurrencyCode: 'GBP',
      PriceCurrency: 'GBX',
      PriceToContractFactor: 0.01,
    });
    expect(calledPath(fetchMock, 0)).toBe(
      'https://gateway.example/sim/openapi/ref/v1/instruments/details/29391797/Etn',
    );
  });

  it('refuses instrument details with no usable PriceToContractFactor (#1302)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ Uic: 29391797, AssetType: 'Etn', CurrencyCode: 'GBP' }));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.getInstrumentDetails(29391797, 'Etn')).rejects.toThrow(
      /PriceToContractFactor must be a finite number/,
    );
  });

  /**
   * A non-positive factor is refused rather than clamped or defaulted: cash
   * per share is `quoted x factor`, so zero prices every share at nothing and
   * a negative one flips the sign of the book (#1302 round 1).
   */
  it('refuses instrument details whose PriceToContractFactor is zero or negative (#1302)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        Uic: 29391797,
        AssetType: 'Etn',
        CurrencyCode: 'GBP',
        PriceToContractFactor: 0,
      }),
    );
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.getInstrumentDetails(29391797, 'Etn')).rejects.toThrow(
      /PriceToContractFactor must be positive/,
    );
  });

  /**
   * The path names the instrument, so a body describing a different one is
   * the venue answering a question that was not asked — and it would hand the
   * resolver another line's factor, the same 100x error from the other side
   * (#1302 round 1).
   */
  it('refuses instrument details for an instrument other than the one requested (#1302)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        Uic: 3347273,
        AssetType: 'Etn',
        CurrencyCode: 'USD',
        PriceCurrency: 'USD',
        PriceToContractFactor: 1,
      }),
    );
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.getInstrumentDetails(29391797, 'Etn')).rejects.toThrow(
      /details for Uic 29391797\/Etn came back as 3347273\/Etn/,
    );
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
  // mutation — reverting `isRetrySafeMethod` to always `true` leaves
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

/**
 * #1222: pacing now lives on `SaxoHttpBrokerClient` itself. These cases
 * deliberately do NOT inject a permissive bucket like every test above —
 * they pin the constructor's own default (the only pacing path a real call
 * site takes today) and per-attempt acquisition on retry, mirroring
 * `http-polygon-client.test.ts`'s "free-tier pacing" split between an
 * injected bucket and the constructor's own default.
 */
describe('SaxoHttpBrokerClient pacing (#1222)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("paces a burst of 3 background requests through the constructor's own default bucket, not just an injected one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    // No `rateLimiter` override: DEFAULT_VENUE_PACING.saxo (capacity 2,
    // refill 1/s, reserveForPriority 1) is what every real call site
    // actually gets. `listOpenOrders` is background (#1419), so each call
    // needs `1 + reserveForPriority` = 2 tokens present — one instant grant
    // from the full bucket, then one further grant per 1s refill.
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi/',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger: recordingLogger(),
    });

    await client.listOpenOrders();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const third = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(1_000);
    await third;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('wires token_bucket_wait telemetry (#1083) onto the default bucket when a logger is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = recordingLogger();
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi/',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger,
    });

    await client.listOpenOrders();
    const second = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(2_000);
    await second;

    const waits = logger.entries.filter((entry) => entry.event === 'token_bucket_wait');
    expect(waits).toHaveLength(1);
    expect(waits[0]?.payload).toMatchObject({ bucket: 'saxo', lane: 'background' });
  });

  // THE MUTATION THIS KILLS: hoist `await this.rateLimiter.acquireBackground()`
  // out of `withRetry`'s closure in saxo-http-client.ts, so a retried attempt
  // is covered by the first attempt's token instead of acquiring its own.
  // Every test above stays green under that mutation — none of them spies on
  // `acquireBackground()` and counts calls per attempt, so a missed call is
  // invisible to them regardless of bucket size. The bucket here is a
  // generous capacity 1,000 too (it never blocks, on purpose — this test is
  // not about parking) — it's the SPY on `acquireBackground()`, not the
  // bucket's size, that catches the mutation. `listOpenOrders` is the
  // background-lane call site (#1419); the priority lane's own per-attempt
  // spend has no equivalent retry test — `saxo-per-request-pacing.test.ts`
  // runs with `maxAttempts: 1` and mocks no failures, so it never issues a
  // second attempt on either lane.
  it('acquires a second token for a retried request, not just the first attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ Message: 'slow down' }, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse({ Data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const rateLimiter = new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
    const acquireSpy = vi.spyOn(rateLimiter, 'acquireBackground');
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi/',
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      rateLimiter,
      logger: recordingLogger(),
    });

    const pending = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(acquireSpy).toHaveBeenCalledTimes(2);
  });
});

/**
 * #1419: proves `DEFAULT_VENUE_PACING.saxo`'s `reserveForPriority` is now
 * load-bearing, not inert — mirrors `token-bucket.test.ts`'s "TokenBucket
 * priority reserve (#391)" block, but through the real client and its own
 * call-site classification rather than a bare bucket, since the defect this
 * closes was in the classification (every call spent `acquire()`), not in
 * `TokenBucket` itself.
 */
describe('SaxoHttpBrokerClient priority lane (#1419)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const OPEN_ORDER_ROW = {
    OrderId: '1',
    Status: 'Working',
    OpenOrderType: 'Limit',
    Amount: 1,
    BuySell: 'Buy',
    Uic: 1,
    AssetType: 'Etn',
  };

  function routedFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      if (method === 'GET' && parsed.pathname.endsWith('/port/v1/accounts/me')) {
        return jsonResponse(ACCOUNTS);
      }
      if (method === 'GET' && parsed.pathname.endsWith('/port/v1/orders/me')) {
        // First page (no $skip) hands back a `__next` cursor; the second
        // page (the pagination loop re-requesting with it) ends the sweep.
        return parsed.searchParams.has('$skip')
          ? jsonResponse({ Data: [] })
          : jsonResponse({
              Data: [OPEN_ORDER_ROW],
              __next: `${parsed.origin}${parsed.pathname}?$top=500&$skip=500`,
            });
      }
      if (method === 'GET' && parsed.pathname.endsWith('/cs/v1/audit/orderactivities')) {
        return jsonResponse({ Data: [] });
      }
      if (method === 'DELETE' && parsed.pathname.includes('/trade/v2/orders/')) {
        return jsonResponse(undefined);
      }
      throw new Error(`saxo priority lane test: unmocked request ${method} ${parsed.pathname}`);
    });
  }

  // Regression test for round-2 review finding on #1419: `resolveIdentity()`
  // memoises a shared PROMISE (`this.identity ??= ...`), so whichever caller
  // triggers it first is the one whose request actually goes over the
  // wire — and in the real wired adapter that's usually a BACKGROUND caller
  // (`placeIdempotently` awaits `lookup()`, which resolves identity via
  // `listOrderActivities`, before ever calling `placeOrder`). If identity
  // inherited its triggering caller's own lane, that one-time bootstrap
  // would be gated by the background reserve threshold instead of the
  // priority one — reopening the exact stall #1419 exists to prevent, one
  // layer removed. `resolveIdentity()` hard-codes `'priority'` regardless of
  // caller specifically to close this; pinned here independent of timing.
  it('resolves account identity on the priority lane even when a background caller (listOrderActivities) triggers it first', async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal('fetch', fetchMock);
    const rateLimiter = new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
    const acquireSpy = vi.spyOn(rateLimiter, 'acquire');
    const acquireBackgroundSpy = vi.spyOn(rateLimiter, 'acquireBackground');
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      rateLimiter,
      logger: recordingLogger(),
    });

    await client.listOrderActivities(new Date('2026-01-01T00:00:00Z'));

    // accounts/me (identity) always spends `acquire()`; the activities page
    // itself is the only `acquireBackground()` spend.
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireBackgroundSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets cancelOrder through immediately behind a multi-page listOpenOrders sweep that has drained the bucket to the reserve', async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal('fetch', fetchMock);
    // Mirrors DEFAULT_VENUE_PACING.saxo (capacity 2, refill 1/s,
    // reserveForPriority 1), pinned explicitly so this test does not silently
    // stop meaning anything if that config is later re-derived.
    const rateLimiter = new TokenBucket({ capacity: 2, refillPerSecond: 1, reserveForPriority: 1 });
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      rateLimiter,
      logger: recordingLogger(),
    });

    // Warm account-identity resolution (memoised) via a BACKGROUND caller —
    // matching the real wired ordering (`placeIdempotently` -> `lookup()` ->
    // `listOrderActivities` before `placeOrder`/`cancelOrder`) rather than
    // the favourable case of warming it from a priority call. Because
    // `resolveIdentity()` always spends `acquire()` regardless of caller,
    // this still costs only 1 priority token; the page's own
    // `acquireBackground()` spend needs the bucket at full capacity (2) and
    // so waits out one refill.
    const warmup = client.listOrderActivities(new Date('2026-01-01T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(1_000);
    await warmup;
    // Let the bucket refill to full before the real race so the warmup's
    // spend isn't what the assertions below are measuring.
    await vi.advanceTimersByTimeAsync(1_000);
    fetchMock.mockClear();

    // Background sweep: page 1 needs `1 + reserve` = 2 tokens, present from
    // the full bucket, and spends 1 — leaving exactly the reserve (1) behind.
    const sweep = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(0);
    // Page 1 landed; the loop's page-2 request is now parked (background
    // needs 2 tokens present and only the 1-token reserve remains).
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The protective-leg cancel cuts in: identity is already warm, so this
    // spends exactly the 1 reserved token — and gets it with NO timer
    // advance, even though the read sweep is still mid-drain.
    let cancelled = false;
    const cancel = client.cancelOrder('protective-leg').then(() => {
      cancelled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
    await cancel;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The sweep's second page was still waiting on a refill throughout — the
    // reserve protected the cancel without needing to wait behind it.
    await vi.advanceTimersByTimeAsync(2_000);
    await sweep;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
