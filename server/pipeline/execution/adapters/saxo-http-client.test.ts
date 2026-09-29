import { TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import {
  SaxoBrokerProviderError,
  SaxoBrokerRateLimitError,
  SaxoBrokerTimeoutError,
} from './saxo-broker-errors.js';
import type { SaxoOrderRequest } from './saxo-client.js';
import { SAXO_CREDENTIAL_ENV_VARS, SaxoHttpBrokerClient } from './saxo-http-client.js';

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
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
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
      'https://gateway.example/sim/openapi/port/v1/orders/me?AccountKey=acct-key&ClientKey=client-key&%24top=500',
    );
    expect(calledPath(fetchMock, 2)).toBe(
      'https://gateway.example/sim/openapi/port/v1/orders/me?$top=500&$skip=500',
    );
  });

  it('rejects an open-order row missing a required field instead of guessing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ Data: [{ OrderId: '1' }] }));
    const client = makeClient(fetchMock);

    await expect(client.listOpenOrders()).rejects.toThrow(/malformed response body/);
  });

  it('scopes listOpenOrders, listNetPositions, getBalances and listOrderActivities to the pinned account, never the other one on the login', async () => {
    const TWO_ACCOUNTS = {
      Data: [
        { AccountKey: 'acct-key', ClientKey: 'client-key' },
        { AccountKey: 'cfd-acct-key', ClientKey: 'client-key' },
      ],
    };
    interface AccountAwareRoute {
      matches: (pathname: string) => boolean;
      respond: () => Response;
    }
    const ACCOUNT_AWARE_ROUTES: readonly AccountAwareRoute[] = [
      {
        matches: (pathname) => pathname.endsWith('/port/v1/orders/me'),
        respond: () =>
          jsonResponse({
            Data: [
              {
                OrderId: '1',
                ExternalReference: 'pinned-account-order',
                Status: 'Working',
                OpenOrderType: 'Limit',
                Amount: 1,
                BuySell: 'Buy',
                Uic: 3347273,
                AssetType: 'Etn',
              },
            ],
          }),
      },
      {
        matches: (pathname) => pathname.endsWith('/port/v1/netpositions/me'),
        respond: () =>
          jsonResponse({
            Data: [
              {
                NetPositionId: '3347273__Etn',
                NetPositionBase: { Amount: 2, Uic: 3347273, AssetType: 'Etn' },
                NetPositionView: {},
              },
            ],
          }),
      },
      {
        matches: (pathname) => pathname.endsWith('/port/v1/balances/me'),
        respond: () => jsonResponse({ Currency: 'GBP', CashBalance: 1_000, TotalValue: 1_000 }),
      },
      {
        matches: (pathname) => pathname.endsWith('/cs/v1/audit/orderactivities'),
        respond: () => jsonResponse({ Data: [] }),
      },
    ];
    function accountAwareFetch(): ReturnType<typeof vi.fn> {
      return vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith('/port/v1/accounts/me')) {
          return jsonResponse(TWO_ACCOUNTS);
        }
        const accountKey = parsed.searchParams.get('AccountKey');
        if (accountKey !== 'acct-key') {
          throw new Error(`unscoped read: ${parsed.pathname} carried AccountKey=${accountKey}`);
        }
        const route = ACCOUNT_AWARE_ROUTES.find((candidate) => candidate.matches(parsed.pathname));
        if (route === undefined) {
          throw new Error(`accountAwareFetch: unmocked request ${parsed.pathname}`);
        }
        return route.respond();
      });
    }
    const fetchMock = accountAwareFetch();
    vi.stubGlobal('fetch', fetchMock);
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi/',
      accountKey: 'acct-key',
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      rateLimiter: permissiveLimiter(),
      logger: recordingLogger(),
    });

    const orders = await client.listOpenOrders();
    const positions = await client.listNetPositions();
    const balances = await client.getBalances();
    await client.listOrderActivities(new Date('2026-09-05T00:00:00Z'));

    expect(orders.map((order) => order.ExternalReference)).toEqual(['pinned-account-order']);
    expect(positions.map((position) => position.NetPositionId)).toEqual(['3347273__Etn']);
    expect(balances).toEqual({ Currency: 'GBP', CashBalance: 1_000, TotalValue: 1_000 });
    for (const path of [
      calledPath(fetchMock, 1),
      calledPath(fetchMock, 2),
      calledPath(fetchMock, 3),
      calledPath(fetchMock, 4),
    ]) {
      expect(path).toContain('AccountKey=acct-key');
      expect(path).not.toContain('cfd-acct-key');
    }
  });

  it('refuses listOpenOrders, listNetPositions, getBalances and listOrderActivities when the login has two accounts and none is pinned', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        Data: [
          { AccountKey: 'a', ClientKey: 'c' },
          { AccountKey: 'b', ClientKey: 'c' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const buildUnpinnedClient = () =>
      new SaxoHttpBrokerClient({
        accessToken: FAKE_TOKEN,
        baseUrl: 'https://gateway.example/sim/openapi/',
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
        rateLimiter: permissiveLimiter(),
        logger: recordingLogger(),
      });

    await expect(buildUnpinnedClient().listOpenOrders()).rejects.toThrow(/accountKey/);
    await expect(buildUnpinnedClient().listNetPositions()).rejects.toThrow(/accountKey/);
    await expect(buildUnpinnedClient().getBalances()).rejects.toThrow(/accountKey/);
    await expect(
      buildUnpinnedClient().listOrderActivities(new Date('2026-09-05T00:00:00Z')),
    ).rejects.toThrow(/accountKey/);

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('/port/v1/accounts/me');
    }
  });

  it('queries order activities by AccountKey, ClientKey and FromDateTime', async () => {
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
      'https://gateway.example/sim/openapi/cs/v1/audit/orderactivities?AccountKey=acct-key&ClientKey=client-key&FromDateTime=2026-09-05T00%3A00%3A00.000Z&%24top=500',
    );
  });

  it('validates net positions down to NetPositionBase.Amount and Uic', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
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
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockResolvedValueOnce(
          jsonResponse({ Currency: 'GBP', CashBalance: 1_000, TotalValue: 1_000 }),
        );
      const client = makeClient(fetchMock);

      expect(await client.getBalances()).toEqual({
        Currency: 'GBP',
        CashBalance: 1_000,
        TotalValue: 1_000,
      });
      expect(calledPath(fetchMock, 1)).toBe(
        'https://gateway.example/sim/openapi/port/v1/balances/me?AccountKey=acct-key&ClientKey=client-key',
      );
      expect(calledInit(fetchMock, 1).method).toBe('GET');
    });

    it('throws rather than defaulting when a funding figure is missing', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockResolvedValue(jsonResponse({ Currency: 'GBP' }));
      const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

      await expect(client.getBalances()).rejects.toThrow(/CashBalance/);
    });

    it('throws rather than assuming a currency when the venue reports none', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
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
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ Message: 'slow down' }, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse({ Data: [] }));
    const client = makeClient(fetchMock);

    const pending = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  describe('status-less transport failures (#1223)', () => {
    it('retries a transport failure on a safe read (listOpenOrders is a GET)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockRejectedValueOnce(new Error('read ECONNRESET'))
        .mockResolvedValueOnce(jsonResponse({ Data: [] }));
      const client = makeClient(fetchMock);

      const pending = client.listOpenOrders();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await pending).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
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

    it('does NOT retry a transport failure on placeOrder (a POST), even with attempts to spare', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockRejectedValue(new Error('socket hang up'));
      const client = makeClient(fetchMock, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 });

      await expect(client.placeOrder(ORDER, 'key-1')).rejects.toBeInstanceOf(
        SaxoBrokerProviderError,
      );
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
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

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
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi/',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger: recordingLogger(),
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(ACCOUNTS));
    const warmup = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(1_000);
    await warmup;
    await vi.advanceTimersByTimeAsync(1_000);
    fetchMock.mockClear();

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

    fetchMock.mockResolvedValueOnce(jsonResponse(ACCOUNTS));
    await client.cancelOrder('warmup');
    await vi.advanceTimersByTimeAsync(2_000);
    fetchMock.mockClear();

    await client.listOpenOrders();
    const second = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(2_000);
    await second;

    const waits = logger.entries.filter((entry) => entry.event === 'token_bucket_wait');
    expect(waits).toHaveLength(1);
    expect(waits[0]?.payload).toMatchObject({ bucket: 'saxo', lane: 'background' });
  });

  it('acquires a second token for a retried request, not just the first attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(acquireSpy).toHaveBeenCalledTimes(2);
  });
});

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

  interface RoutedFetchRoute {
    method: string;
    matches: (parsed: URL) => boolean;
    respond: (parsed: URL) => Response;
  }

  function routedFetch(): ReturnType<typeof vi.fn> {
    const routes: readonly RoutedFetchRoute[] = [
      {
        method: 'GET',
        matches: (parsed) => parsed.pathname.endsWith('/port/v1/accounts/me'),
        respond: () => jsonResponse(ACCOUNTS),
      },
      {
        method: 'GET',
        matches: (parsed) => parsed.pathname.endsWith('/port/v1/orders/me'),
        respond: (parsed) =>
          parsed.searchParams.has('$skip')
            ? jsonResponse({ Data: [] })
            : jsonResponse({
                Data: [OPEN_ORDER_ROW],
                __next: `${parsed.origin}${parsed.pathname}?$top=500&$skip=500`,
              }),
      },
      {
        method: 'GET',
        matches: (parsed) => parsed.pathname.endsWith('/cs/v1/audit/orderactivities'),
        respond: () => jsonResponse({ Data: [] }),
      },
      {
        method: 'DELETE',
        matches: (parsed) => parsed.pathname.includes('/trade/v2/orders/'),
        respond: () => jsonResponse(undefined),
      },
    ];

    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      const route = routes.find((r) => r.method === method && r.matches(parsed));
      if (route === undefined) {
        throw new Error(`saxo priority lane test: unmocked request ${method} ${parsed.pathname}`);
      }
      return route.respond(parsed);
    });
  }

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

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireBackgroundSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets cancelOrder through immediately behind a multi-page listOpenOrders sweep that has drained the bucket to the reserve', async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal('fetch', fetchMock);
    const rateLimiter = new TokenBucket({ capacity: 2, refillPerSecond: 1, reserveForPriority: 1 });
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      rateLimiter,
      logger: recordingLogger(),
    });

    const warmup = client.listOrderActivities(new Date('2026-01-01T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(1_000);
    await warmup;
    await vi.advanceTimersByTimeAsync(1_000);
    fetchMock.mockClear();

    const sweep = client.listOpenOrders();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let cancelled = false;
    const cancel = client.cancelOrder('protective-leg').then(() => {
      cancelled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
    await cancel;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await sweep;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
