import { TokenBucket } from '../../../../shared/index.js';
import { recordingLogger } from '../../../../shared/recording-logger.js';
import {
  SaxoBrokerProviderError,
  SaxoBrokerRateLimitError,
  SaxoBrokerTimeoutError,
} from './saxo-broker-errors.js';
import type { SaxoOrderRequest } from './saxo-client.js';
import { saxoAccountKeyEnvVar } from './saxo-environment.js';
import { SAXO_CREDENTIAL_ENV_VARS, SaxoHttpBrokerClient } from './saxo-http-client.js';

beforeEach(() => {
  vi.stubEnv('SAXO_SIM_ACCOUNT_KEY', '');
  vi.stubEnv('SAXO_LIVE_ACCOUNT_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

function rawTextResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => JSON.parse(text),
    text: async () => text,
  } as Response;
}

function brokenBodyResponse(readError: Error): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: (): Promise<unknown> => Promise.reject(readError),
    text: (): Promise<string> => Promise.reject(readError),
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

  it('refuses to construct without a token, naming the env var and the full guidance message', () => {
    vi.stubEnv(SAXO_CREDENTIAL_ENV_VARS.sim.token, '   ');
    let caught: unknown;
    try {
      new SaxoHttpBrokerClient({ logger: recordingLogger() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('SAXO_SIM_ACCESS_TOKEN');
    expect(message).toContain('.env.local');
    expect(message).toContain('saxo:login');
    expect(message).toContain("sim gateway's bearer");
    vi.unstubAllEnvs();
  });

  it('treats a genuinely unset token env var as absent, not throwing on read', () => {
    const key = SAXO_CREDENTIAL_ENV_VARS.sim.token;
    const original = process.env[key];
    delete process.env[key];
    try {
      expect(() => new SaxoHttpBrokerClient({ logger: recordingLogger() })).toThrow(
        /SAXO_SIM_ACCESS_TOKEN/,
      );
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('reads and trims the token from the environment when accessToken is not passed', async () => {
    const key = SAXO_CREDENTIAL_ENV_VARS.sim.token;
    vi.stubEnv(key, '  env-token  ');
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ Data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new SaxoHttpBrokerClient({
      baseUrl: 'https://gateway.example/sim/openapi/',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      rateLimiter: permissiveLimiter(),
      logger: recordingLogger(),
    });

    await client.listOpenOrders().catch(() => undefined);

    expect(calledInit(fetchMock, 0).headers).toMatchObject({ authorization: 'Bearer env-token' });
    vi.unstubAllEnvs();
  });

  it('collapses multiple trailing slashes in a configured base URL to one', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ Data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi//',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      rateLimiter: permissiveLimiter(),
      logger: recordingLogger(),
    });

    await client.listOpenOrders().catch(() => undefined);

    expect(calledPath(fetchMock, 0)).toBe(
      'https://gateway.example/sim/openapi/port/v1/accounts/me',
    );
  });

  it('refuses an explicitly empty accessToken, not just an absent one', () => {
    expect(() => new SaxoHttpBrokerClient({ accessToken: '', logger: recordingLogger() })).toThrow(
      /SAXO_SIM_ACCESS_TOKEN/,
    );
  });

  it('rejects a response whose body cannot be read', async () => {
    const readError = new Error('socket already closed');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(brokenBodyResponse(readError));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOpenOrders()).rejects.toThrow(
      /response body could not be read \(listOpenOrders\): socket already closed/,
    );
  });

  it('rejects a response body that is not valid JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(rawTextResponse('{not json'));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOpenOrders()).rejects.toThrow(
      /response body could not be parsed as JSON \(listOpenOrders\)/,
    );
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
    expect(calledInit(fetchMock, 0).method).toBe('GET');
    expect(calledPath(fetchMock, 1)).toBe('https://gateway.example/sim/openapi/trade/v2/orders');
    const init = calledInit(fetchMock, 1);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ AccountKey: 'acct-key', Uic: 3347273 });
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${FAKE_TOKEN}`,
      'x-request-id': 'key-1',
      'content-type': 'application/json',
      accept: 'application/json',
    });
  });

  it('rejects a placement response whose body is not an object (null, or a bare JSON value)', async () => {
    const nullBody = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse(null));
    await expect(
      makeClient(nullBody, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }).placeOrder(
        ORDER,
        'key-1',
      ),
    ).rejects.toThrow(/malformed response body \(placeOrder\): expected an object/);

    const stringBody = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse('just a string'));
    await expect(
      makeClient(stringBody, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }).placeOrder(
        ORDER,
        'key-1',
      ),
    ).rejects.toThrow(/malformed response body \(placeOrder\): expected an object/);
  });

  it('validates every related order inside Orders[], not just the top-level fields', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
        jsonResponse({
          OrderId: '1',
          ExternalReference: 'key-1',
          Orders: [{ OrderId: '2', ExternalReference: 'leg-ref' }],
        }),
      );
    const client = makeClient(fetchMock);

    const placement = await client.placeOrder(ORDER, 'key-1');

    expect(placement.Orders).toEqual([{ OrderId: '2', ExternalReference: 'leg-ref' }]);
  });

  it('rejects a non-object entry inside Orders[]', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ OrderId: '1', Orders: [42] }));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.placeOrder(ORDER, 'key-1')).rejects.toThrow(
      /Orders\[\] entries must be objects/,
    );
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
      message: expect.stringContaining('(cancelOrder)'),
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
      FilledAmount: 0.5,
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
          __next:
            'https://gateway.example/sim/openapi/port/v1/orders?AccountKey=acct-key&ClientKey=client-key&$top=500&$skip=500',
          Data: [row],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ __count: 2, Data: [{ ...row, OrderId: '3' }] }));
    const client = makeClient(fetchMock);

    const orders = await client.listOpenOrders();

    expect(orders.map((order) => order.OrderId)).toEqual(['1', '3']);
    expect(orders[0]).toEqual({
      ...row,
      RelatedOpenOrders: [
        {
          OrderId: '2',
          OpenOrderType: 'StopIfTraded',
          OrderPrice: 9,
          Amount: 1,
          Status: 'NotWorking',
        },
      ],
    });
    expect(calledPath(fetchMock, 1)).toBe(
      'https://gateway.example/sim/openapi/port/v1/orders?AccountKey=acct-key&ClientKey=client-key&%24top=500',
    );
    expect(calledPath(fetchMock, 2)).toBe(
      'https://gateway.example/sim/openapi/port/v1/orders?AccountKey=acct-key&ClientKey=client-key&$top=500&$skip=500',
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

  it('rejects a paged response with no Data envelope, naming the failing endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({}));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOpenOrders()).rejects.toThrow(
      /malformed response body \(listOpenOrders\): expected a \{Data: \[\.\.\.\]\} envelope/,
    );
  });

  it('rejects a non-object row inside an open-orders page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ Data: [42] }));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOpenOrders()).rejects.toThrow(/order rows must be objects/);
  });

  it('rejects a non-object entry inside an open order’s RelatedOpenOrders[]', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
        jsonResponse({
          Data: [
            {
              OrderId: '1',
              Status: 'Working',
              OpenOrderType: 'Limit',
              Amount: 1,
              BuySell: 'Buy',
              Uic: 1,
              AssetType: 'Etn',
              RelatedOpenOrders: [42],
            },
          ],
        }),
      );
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOpenOrders()).rejects.toThrow(/RelatedOpenOrders\[\] must be objects/);
  });

  it('stops paging when __next is present but not a string', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(rawTextResponse('{"Data":[],"__next":12345}'));
    const client = makeClient(fetchMock);

    const orders = await client.listOpenOrders();

    expect(orders).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an open order whose BuySell is neither Buy nor Sell', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
        jsonResponse({
          Data: [
            {
              OrderId: '1',
              Status: 'Working',
              OpenOrderType: 'Limit',
              Amount: 1,
              BuySell: 'Hold',
              Uic: 1,
              AssetType: 'Etn',
            },
          ],
        }),
      );
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOpenOrders()).rejects.toThrow(/BuySell must be 'Buy'\|'Sell'/);
  });

  it('drops an explicit null on an optional string field rather than throwing, and rejects a non-string one', async () => {
    const BASE_ROW = {
      OrderId: '1',
      Status: 'Working',
      OpenOrderType: 'Limit',
      Amount: 1,
      BuySell: 'Buy' as const,
      Uic: 1,
      AssetType: 'Etn',
    };
    const nullRef = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ Data: [{ ...BASE_ROW, ExternalReference: null }] }));
    const orders = await makeClient(nullRef).listOpenOrders();
    expect(orders[0]?.ExternalReference).toBeUndefined();

    const numericRef = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ Data: [{ ...BASE_ROW, ExternalReference: 42 }] }));
    await expect(
      makeClient(numericRef, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }).listOpenOrders(),
    ).rejects.toThrow(/ExternalReference must be a string/);
  });

  it("scopes listOpenOrders, listNetPositions, getBalances and listOrderActivities to the pinned account, and excludes the other account's rows from every response", async () => {
    // Models a server that leaks every account's rows unless AccountKey selects one —
    // proves the client's own request scoping is what keeps the other account's rows
    // out, not an assumption that the fixture would refuse an unscoped request
    const TWO_ACCOUNTS = {
      Data: [
        { AccountKey: 'acct-key', ClientKey: 'client-key' },
        { AccountKey: 'cfd-acct-key', ClientKey: 'client-key' },
      ],
    };
    const PINNED_ORDER = {
      OrderId: '1',
      ExternalReference: 'pinned-account-order',
      Status: 'Working',
      OpenOrderType: 'Limit',
      Amount: 1,
      BuySell: 'Buy',
      Uic: 3347273,
      AssetType: 'Etn',
    };
    const CFD_ORDER = { ...PINNED_ORDER, OrderId: '2', ExternalReference: 'cfd-account-order' };
    const PINNED_POSITION = {
      NetPositionId: '3347273__Etn',
      NetPositionBase: { Amount: 2, Uic: 3347273, AssetType: 'Etn' },
      NetPositionView: {},
    };
    const CFD_POSITION = { ...PINNED_POSITION, NetPositionId: '9999999__Etn' };
    const PINNED_ACTIVITY = {
      OrderId: '1',
      LogId: 'log-1',
      ActivityTime: '2026-09-06T00:00:00Z',
      Amount: 1,
      AssetType: 'Etn',
      BuySell: 'Buy',
      Status: 'Filled',
      Uic: 3347273,
    };
    const CFD_ACTIVITY = { ...PINNED_ACTIVITY, OrderId: '2', LogId: 'log-2' };

    interface AccountAwareRoute {
      matches: (pathname: string) => boolean;
      respond: (scopedToPinned: boolean) => Response;
    }
    const ACCOUNT_AWARE_ROUTES: readonly AccountAwareRoute[] = [
      {
        matches: (pathname) => pathname.endsWith('/port/v1/orders'),
        respond: (scopedToPinned) =>
          jsonResponse({ Data: scopedToPinned ? [PINNED_ORDER] : [PINNED_ORDER, CFD_ORDER] }),
      },
      {
        matches: (pathname) => pathname.endsWith('/port/v1/netpositions'),
        respond: (scopedToPinned) =>
          jsonResponse({
            Data: scopedToPinned ? [PINNED_POSITION] : [PINNED_POSITION, CFD_POSITION],
          }),
      },
      {
        matches: (pathname) => pathname.endsWith('/port/v1/balances'),
        respond: (scopedToPinned) =>
          scopedToPinned
            ? jsonResponse({ Currency: 'GBP', CashBalance: 1_000, TotalValue: 1_000 })
            : jsonResponse({ Currency: 'GBP', CashBalance: 9_999, TotalValue: 9_999 }),
      },
      {
        matches: (pathname) => pathname.endsWith('/cs/v1/audit/orderactivities'),
        respond: (scopedToPinned) =>
          jsonResponse({
            Data: scopedToPinned ? [PINNED_ACTIVITY] : [PINNED_ACTIVITY, CFD_ACTIVITY],
          }),
      },
    ];
    function accountAwareFetch(): ReturnType<typeof vi.fn> {
      return vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith('/port/v1/accounts/me')) {
          return jsonResponse(TWO_ACCOUNTS);
        }
        const route = ACCOUNT_AWARE_ROUTES.find((candidate) => candidate.matches(parsed.pathname));
        if (route === undefined) {
          // A 400, not a throw: an unmocked path must fail fast with a diagnostic,
          // not get classified as a retryable transport failure and hang under fake
          // timers until vitest's own test timeout
          return jsonResponse({ Message: `unmocked request ${parsed.pathname}` }, 400);
        }
        return route.respond(parsed.searchParams.get('AccountKey') === 'acct-key');
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
    const activities = await client.listOrderActivities(new Date('2026-09-05T00:00:00Z'));

    expect(orders.map((order) => order.ExternalReference)).toEqual(['pinned-account-order']);
    expect(positions.map((position) => position.NetPositionId)).toEqual(['3347273__Etn']);
    expect(balances).toEqual({ Currency: 'GBP', CashBalance: 1_000, TotalValue: 1_000 });
    expect(activities.map((activity) => activity.OrderId)).toEqual(['1']);
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

  describe('__next keeps the account scope (#1869)', () => {
    const TWO_ACCOUNTS = {
      Data: [
        { AccountKey: 'acct-key', ClientKey: 'client-key' },
        { AccountKey: 'cfd-acct-key', ClientKey: 'client-key' },
      ],
    };
    const PINNED_ORDER = {
      OrderId: '1',
      Status: 'Working',
      OpenOrderType: 'Limit',
      Amount: 1,
      BuySell: 'Buy',
      Uic: 3347273,
      AssetType: 'Etn',
    };
    const PINNED_POSITION = {
      NetPositionId: '3347273__Etn',
      NetPositionBase: { Amount: 2, Uic: 3347273, AssetType: 'Etn' },
      NetPositionView: {},
    };
    const PINNED_ACTIVITY = {
      OrderId: '1',
      LogId: 'log-1',
      ActivityTime: '2026-09-06T00:00:00Z',
      Amount: 1,
      AssetType: 'Etn',
      BuySell: 'Buy',
      Status: 'Filled',
      Uic: 3347273,
    };

    interface PagedReader {
      name: string;
      pathname: string;
      pinnedRow: Record<string, unknown>;
      otherRow: Record<string, unknown>;
      read: (client: SaxoHttpBrokerClient) => Promise<unknown[]>;
      idOf: (row: unknown) => string;
    }
    const READERS: readonly PagedReader[] = [
      {
        name: 'listOpenOrders',
        pathname: '/sim/openapi/port/v1/orders',
        pinnedRow: PINNED_ORDER,
        otherRow: { ...PINNED_ORDER, OrderId: 'cfd-2' },
        read: (client) => client.listOpenOrders(),
        idOf: (row) => (row as { OrderId: string }).OrderId,
      },
      {
        name: 'listNetPositions',
        pathname: '/sim/openapi/port/v1/netpositions',
        pinnedRow: PINNED_POSITION,
        otherRow: { ...PINNED_POSITION, NetPositionId: 'cfd-2' },
        read: (client) => client.listNetPositions(),
        idOf: (row) => (row as { NetPositionId: string }).NetPositionId,
      },
      {
        name: 'listOrderActivities',
        pathname: '/sim/openapi/cs/v1/audit/orderactivities',
        pinnedRow: PINNED_ACTIVITY,
        otherRow: { ...PINNED_ACTIVITY, OrderId: 'cfd-2', LogId: 'log-2' },
        read: (client) => client.listOrderActivities(new Date('2026-09-05T00:00:00Z')),
        idOf: (row) => (row as { OrderId: string }).OrderId,
      },
    ];

    function pinnedClient(baseUrl = 'https://gateway.example/sim/openapi/'): SaxoHttpBrokerClient {
      return new SaxoHttpBrokerClient({
        accessToken: FAKE_TOKEN,
        baseUrl,
        accountKey: 'acct-key',
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
        rateLimiter: permissiveLimiter(),
        logger: recordingLogger(),
      });
    }

    function isScopedToPinned(params: URLSearchParams): boolean {
      return params.get('AccountKey') === 'acct-key' && params.get('ClientKey') === 'client-key';
    }

    function leakyPage(reader: PagedReader, parsed: URL, nextFor: (parsed: URL) => string) {
      if (!parsed.searchParams.has('$skip')) {
        return jsonResponse({ Data: [reader.pinnedRow], __next: nextFor(parsed) });
      }
      return jsonResponse({ Data: isScopedToPinned(parsed.searchParams) ? [] : [reader.otherRow] });
    }

    function leakyPagedFetch(
      reader: PagedReader,
      nextFor: (parsed: URL) => string,
    ): ReturnType<typeof vi.fn> {
      return vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith('/port/v1/accounts/me')) return jsonResponse(TWO_ACCOUNTS);
        if (parsed.pathname !== reader.pathname) {
          return jsonResponse({ Message: `unmocked request ${parsed.pathname}` }, 400);
        }
        return leakyPage(reader, parsed, nextFor);
      });
    }

    it.each(READERS)(
      "$name re-applies AccountKey and ClientKey when __next drops the original query, so page 2 cannot return another account's rows",
      async (reader) => {
        const fetchMock = leakyPagedFetch(
          reader,
          (parsed) => `${parsed.origin}${parsed.pathname}?$skip=500`,
        );
        vi.stubGlobal('fetch', fetchMock);

        const rows = await reader.read(pinnedClient());

        expect(rows.map(reader.idOf)).not.toContain('cfd-2');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const page2 = new URL(calledPath(fetchMock, 2));
        expect(page2.pathname).toBe(reader.pathname);
        expect(page2.searchParams.get('$skip')).toBe('500');
        expect(page2.searchParams.getAll('AccountKey')).toEqual(['acct-key']);
        expect(page2.searchParams.getAll('ClientKey')).toEqual(['client-key']);
      },
    );

    it('adds the account scope to a relative __next that carries no query string at all', async () => {
      const reader = READERS[0] as PagedReader;
      let pages = 0;
      const fetchMock = vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith('/port/v1/accounts/me')) return jsonResponse(TWO_ACCOUNTS);
        pages += 1;
        return pages === 1
          ? jsonResponse({ Data: [reader.pinnedRow], __next: '/port/v1/orders' })
          : jsonResponse({ Data: [] });
      });
      vi.stubGlobal('fetch', fetchMock);

      await reader.read(pinnedClient());

      expect(calledPath(fetchMock, 2)).toBe(
        'https://gateway.example/sim/openapi/port/v1/orders?AccountKey=acct-key&ClientKey=client-key',
      );
    });

    it('adds only the scope key __next dropped and keeps the one it echoed', async () => {
      const reader = READERS[0] as PagedReader;
      const fetchMock = leakyPagedFetch(
        reader,
        (parsed) => `${parsed.origin}${parsed.pathname}?AccountKey=acct-key&$skip=500`,
      );
      vi.stubGlobal('fetch', fetchMock);

      await reader.read(pinnedClient());

      expect(calledPath(fetchMock, 2)).toBe(
        'https://gateway.example/sim/openapi/port/v1/orders?AccountKey=acct-key&$skip=500&ClientKey=client-key',
      );
    });

    it.each(['AccountKey', 'ClientKey'])(
      'refuses to fetch page 2 when __next names a different %s',
      async (key) => {
        const reader = READERS[1] as PagedReader;
        const fetchMock = leakyPagedFetch(reader, (parsed) => {
          const next = new URL(parsed.href);
          next.searchParams.set(key, 'other-key');
          next.searchParams.set('$skip', '500');
          return next.href;
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(reader.read(pinnedClient())).rejects.toThrow(
          new RegExp(`__next changed ${key} between pages \\(listNetPositions\\)`),
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
    );

    it.each([
      [
        'a duplicated AccountKey naming another account',
        'AccountKey=acct-key&AccountKey=other-key',
        'AccountKey',
      ],
      [
        'a duplicated ClientKey naming another client',
        'ClientKey=client-key&ClientKey=other-key',
        'ClientKey',
      ],
      ['a lower-case accountkey naming another account', 'accountkey=other-key', 'AccountKey'],
      ['an upper-case CLIENTKEY naming another client', 'CLIENTKEY=other-key', 'ClientKey'],
    ])('refuses to fetch page 2 when __next carries %s', async (_label, scope, key) => {
      const reader = READERS[0] as PagedReader;
      const fetchMock = leakyPagedFetch(
        reader,
        (parsed) => `${parsed.origin}${parsed.pathname}?${scope}&$skip=500`,
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(reader.read(pinnedClient())).rejects.toThrow(
        new RegExp(`__next changed ${key} between pages \\(listOpenOrders\\)`),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('treats a differently-cased scope key echoing the pinned value as present', async () => {
      const reader = READERS[0] as PagedReader;
      const fetchMock = leakyPagedFetch(
        reader,
        (parsed) =>
          `${parsed.origin}${parsed.pathname}?accountkey=acct-key&CLIENTKEY=client-key&$skip=500`,
      );
      vi.stubGlobal('fetch', fetchMock);

      await reader.read(pinnedClient());

      expect(calledPath(fetchMock, 2)).toBe(
        'https://gateway.example/sim/openapi/port/v1/orders?accountkey=acct-key&CLIENTKEY=client-key&$skip=500',
      );
    });

    it.each([
      [
        '/port/v1/orders?$skip=500#frag',
        '/port/v1/orders?$skip=500&AccountKey=acct-key&ClientKey=client-key',
      ],
      ['/port/v1/orders#frag?x', '/port/v1/orders?AccountKey=acct-key&ClientKey=client-key'],
      [
        '/../port/v1/orders?$skip=500',
        '/port/v1/orders?$skip=500&AccountKey=acct-key&ClientKey=client-key',
      ],
      ['/../../../port/v1/orders', '/port/v1/orders?AccountKey=acct-key&ClientKey=client-key'],
      [
        '/%2e%2e/%2E/port/v1/orders?$skip=500',
        '/port/v1/orders?$skip=500&AccountKey=acct-key&ClientKey=client-key',
      ],
      [
        '/port/v1/./orders?$skip=500',
        '/port/v1/orders?$skip=500&AccountKey=acct-key&ClientKey=client-key',
      ],
      [
        '/port/v1/or\tders?$skip=500',
        '/port/v1/orders?$skip=500&AccountKey=acct-key&ClientKey=client-key',
      ],
      [
        '/port/v1/orders\n?$skip=5\r00',
        '/port/v1/orders?$skip=500&AccountKey=acct-key&ClientKey=client-key',
      ],
      [
        '/port\\v1/orders?$skip=500',
        '/port/v1/orders?$skip=500&AccountKey=acct-key&ClientKey=client-key',
      ],
      [
        '/port/v1/orders?$skip=500 ',
        '/port/v1/orders?$skip=500&AccountKey=acct-key&ClientKey=client-key',
      ],
      [
        '/port/v1/orders?$filter=a b',
        '/port/v1/orders?$filter=a%20b&AccountKey=acct-key&ClientKey=client-key',
      ],
      ['/port/v1/orders?', '/port/v1/orders?AccountKey=acct-key&ClientKey=client-key'],
      [
        '/../port/v1/orders?AccountKey=acct-key&ClientKey=client-key#frag',
        '/port/v1/orders?AccountKey=acct-key&ClientKey=client-key',
      ],
    ])('sends the normalised path of __next %j on the wire (#2026)', async (next, expected) => {
      const reader = READERS[0] as PagedReader;
      let pages = 0;
      const fetchMock = vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith('/port/v1/accounts/me')) return jsonResponse(TWO_ACCOUNTS);
        pages += 1;
        return pages === 1
          ? jsonResponse({ Data: [reader.pinnedRow], __next: next })
          : jsonResponse({ Data: [] });
      });
      vi.stubGlobal('fetch', fetchMock);

      await reader.read(pinnedClient());

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(calledPath(fetchMock, 2)).toBe(`https://gateway.example/sim/openapi${expected}`);
    });

    function singleNextFetch(next: string): ReturnType<typeof vi.fn> {
      const reader = READERS[0] as PagedReader;
      let pages = 0;
      return vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith('/port/v1/accounts/me')) return jsonResponse(TWO_ACCOUNTS);
        pages += 1;
        return pages === 1
          ? jsonResponse({ Data: [reader.pinnedRow], __next: next })
          : jsonResponse({ Data: [reader.otherRow] });
      });
    }

    it.each([
      ['/port/v1/orders?Account\tKey=other-key', 'AccountKey'],
      ['/port/v1/orders?Client\nKey=other-key', 'ClientKey'],
      ['/../port/v1/orders?AccountKey=other-key', 'AccountKey'],
    ])('refuses a __next of %j that names another %s once normalised', async (next, key) => {
      const fetchMock = singleNextFetch(next);
      vi.stubGlobal('fetch', fetchMock);

      await expect(pinnedClient().listOpenOrders()).rejects.toThrow(
        new RegExp(`__next changed ${key} between pages \\(listOpenOrders\\)`),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      '/port/v1/orders/me?$skip=500',
      '/port/v1/netpositions?$skip=500',
      '/port/v1/orders/../orders/me?$skip=500',
      '/port/v1/orders/%2e%2e/orders/me',
      'port/v1/orders?$skip=500',
      '/\\evil.example/port/v1/orders',
      '/\t/evil.example/port/v1/orders',
      '/\n\\evil.example/port/v1/orders?$skip=500',
      'https://[bad/x',
    ])('refuses to fetch page 2 when listOpenOrders __next %s leaves the route', async (next) => {
      const fetchMock = singleNextFetch(next);
      vi.stubGlobal('fetch', fetchMock);

      const read = pinnedClient().listOpenOrders();

      await expect(read).rejects.toBeInstanceOf(SaxoBrokerProviderError);
      await expect(read).rejects.toThrow(
        /__next left the \/port\/v1\/orders route \(listOpenOrders\)/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      '@evil.example/x',
      '.evil.example/x',
      '//evil.example/x',
      'https://gateway.example.evil.example/x',
      'https://evil.example/port/v1/orders',
    ])(
      'refuses a __next of %s on a gateway with no path, so the bearer never leaves the gateway host',
      async (next) => {
        const fetchMock = singleNextFetch(next);
        vi.stubGlobal('fetch', fetchMock);

        await expect(pinnedClient('https://gateway.example').listOpenOrders()).rejects.toThrow(
          /__next left the \/port\/v1\/orders route/,
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual([
          'gateway.example',
          'gateway.example',
        ]);
      },
    );

    it('still follows a same-route absolute __next on a gateway with no path', async () => {
      const fetchMock = singleNextFetch('https://gateway.example/port/v1/orders?$skip=500');
      vi.stubGlobal('fetch', fetchMock);

      await pinnedClient('https://gateway.example').listOpenOrders();

      expect(calledPath(fetchMock, 2)).toBe(
        'https://gateway.example/port/v1/orders?$skip=500&AccountKey=acct-key&ClientKey=client-key',
      );
    });
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
    const activityRow = {
      ActivityTime: '2026-09-05T08:30:00Z',
      LogId: 'log-1',
      OrderId: '1',
      ExternalReference: 'key-1',
      Status: 'Placed',
      SubStatus: 'Rejected',
      Amount: 1,
      Price: 10,
      FillAmount: 0.5,
      AveragePrice: 9.9,
      BuySell: 'Buy',
      Uic: 3347273,
      AssetType: 'Etn',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ Data: [activityRow] }));
    const client = makeClient(fetchMock);

    const activities = await client.listOrderActivities(new Date('2026-09-05T00:00:00Z'));

    expect(activities).toEqual([activityRow]);
    expect(calledPath(fetchMock, 1)).toBe(
      'https://gateway.example/sim/openapi/cs/v1/audit/orderactivities?AccountKey=acct-key&ClientKey=client-key&FromDateTime=2026-09-05T00%3A00%3A00.000Z&%24top=500',
    );
  });

  it('rejects an order-activities response with no Data envelope, naming the endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({}));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOrderActivities(new Date('2026-09-05T00:00:00Z'))).rejects.toThrow(
      /malformed response body \(listOrderActivities\)/,
    );
  });

  it('rejects a non-object row inside an order-activities page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ Data: [42] }));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOrderActivities(new Date('2026-09-05T00:00:00Z'))).rejects.toThrow(
      /activity rows must be objects/,
    );
  });

  it('drops an explicit null on an optional numeric field rather than throwing', async () => {
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
              Status: 'Placed',
              Amount: 1,
              Price: null,
              BuySell: 'Buy',
              Uic: 3347273,
              AssetType: 'Etn',
            },
          ],
        }),
      );
    const client = makeClient(fetchMock);

    const activities = await client.listOrderActivities(new Date('2026-09-05T00:00:00Z'));

    expect(activities[0]?.Price).toBeUndefined();
  });

  it('rejects a required Amount that overflows to a non-finite number', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
        rawTextResponse(
          '{"Data":[{"ActivityTime":"2026-09-05T08:30:00Z","LogId":"log-1","OrderId":"1",' +
            '"Status":"Placed","Amount":1e400,"BuySell":"Buy","Uic":1,"AssetType":"Etn"}]}',
        ),
      );
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOrderActivities(new Date('2026-09-05T00:00:00Z'))).rejects.toThrow(
      /Amount must be a finite number/,
    );
  });

  it('rejects an optional Price that overflows to a non-finite number', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
        rawTextResponse(
          '{"Data":[{"ActivityTime":"2026-09-05T08:30:00Z","LogId":"log-1","OrderId":"1",' +
            '"Status":"Placed","Amount":1,"Price":1e400,"BuySell":"Buy","Uic":1,"AssetType":"Etn"}]}',
        ),
      );
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOrderActivities(new Date('2026-09-05T00:00:00Z'))).rejects.toThrow(
      /Price must be a finite number when present/,
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
    expect(calledPath(fetchMock, 1)).toBe(
      'https://gateway.example/sim/openapi/port/v1/netpositions?AccountKey=acct-key&ClientKey=client-key&FieldGroups=NetPositionBase%2CNetPositionView%2CDisplayAndFormat&%24top=500',
    );
  });

  it('rejects a non-object row inside a net-positions page, naming the endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse({ Data: [42] }));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listNetPositions()).rejects.toThrow(
      /malformed response body \(listNetPositions\): position rows must be objects/,
    );
  });

  it('rejects a net position whose NetPositionBase is not an object', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(
        jsonResponse({ Data: [{ NetPositionId: '1', NetPositionBase: 'not-an-object' }] }),
      );
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listNetPositions()).rejects.toThrow(/NetPositionBase must be an object/);
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
        'https://gateway.example/sim/openapi/port/v1/balances?AccountKey=acct-key&ClientKey=client-key',
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

    it('rejects a balances response that is not an object, naming getBalances', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockResolvedValue(jsonResponse(null));
      const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

      await expect(client.getBalances()).rejects.toThrow(
        /malformed response body \(getBalances\): expected an object/,
      );
    });

    it('rejects an explicitly empty Currency rather than treating it as present', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
        .mockResolvedValue(jsonResponse({ Currency: '', CashBalance: 1_000, TotalValue: 1_000 }));
      const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

      await expect(client.getBalances()).rejects.toThrow(/Currency must not be empty/);
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
    expect(calledInit(fetchMock, 0).method).toBe('GET');
    expect(calledInit(fetchMock, 0).headers).not.toHaveProperty('content-type');
  });

  it('rejects an instrument-details response that is not an object', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse('not-an-object'));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.getInstrumentDetails(29391797, 'Etn')).rejects.toThrow(
      /malformed response body \(getInstrumentDetails\): expected an object/,
    );
  });

  it('refuses instrument details whose AssetType alone mismatches the request (Uic matches)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        Uic: 29391797,
        AssetType: 'Stock',
        CurrencyCode: 'GBP',
        PriceToContractFactor: 1,
      }),
    );
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.getInstrumentDetails(29391797, 'Etn')).rejects.toThrow(
      /details for Uic 29391797\/Etn came back as 29391797\/Stock/,
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

  it('picks the pinned account even when it is not the first one the token can see', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          Data: [
            { AccountKey: 'first-acct', ClientKey: 'client-key' },
            { AccountKey: 'pinned-acct', ClientKey: 'client-key' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ Data: [] }));
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi/',
      accountKey: 'pinned-acct',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      rateLimiter: permissiveLimiter(),
      logger: recordingLogger(),
    });
    vi.stubGlobal('fetch', fetchMock);

    await client.listOpenOrders();

    expect(calledPath(fetchMock, 1)).toContain('AccountKey=pinned-acct');
  });

  it('refuses a pinned accountKey the token cannot see, rather than silently falling back', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        Data: [{ AccountKey: 'some-other-acct', ClientKey: 'client-key' }],
      }),
    );
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi/',
      accountKey: 'pinned-acct',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      rateLimiter: permissiveLimiter(),
      logger: recordingLogger(),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.listOpenOrders()).rejects.toThrow(
      /the configured accountKey is not among the accounts this token can see/,
    );
  });

  describe('accountKey from the environment', () => {
    const TWO_ACCOUNTS = {
      Data: [
        { AccountKey: 'fake-gia-acct', ClientKey: 'fake-client' },
        { AccountKey: 'fake-cfd-acct', ClientKey: 'fake-client' },
      ],
    };

    function envClient(environment: 'sim' | 'live', accountKey?: string): SaxoHttpBrokerClient {
      return new SaxoHttpBrokerClient({
        accessToken: FAKE_TOKEN,
        environment,
        baseUrl: 'https://gateway.example/openapi/',
        ...(accountKey === undefined ? {} : { accountKey }),
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
        rateLimiter: permissiveLimiter(),
        logger: recordingLogger(),
      });
    }

    function twoAccountFetch(): ReturnType<typeof vi.fn> {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(TWO_ACCOUNTS))
        .mockResolvedValueOnce(jsonResponse({ Data: [] }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      ['sim', 'SAXO_SIM_ACCESS_TOKEN', 'SAXO_SIM_GATEWAY', 'SAXO_SIM_ACCOUNT_KEY'],
      ['live', 'SAXO_LIVE_ACCESS_TOKEN', 'SAXO_LIVE_GATEWAY', 'SAXO_LIVE_ACCOUNT_KEY'],
    ] as const)(
      'reads the %s token, gateway and account key from %s, %s and %s',
      async (environment, token, gateway, accountKey) => {
        vi.stubEnv(token, 'fake-env-token');
        vi.stubEnv(gateway, 'https://env-gateway.example/openapi');
        vi.stubEnv(accountKey, 'fake-cfd-acct');
        const fetchMock = twoAccountFetch();
        const client = new SaxoHttpBrokerClient({
          environment,
          retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
          rateLimiter: permissiveLimiter(),
          logger: recordingLogger(),
        });

        await client.listOpenOrders();

        expect(calledPath(fetchMock, 0)).toBe(
          'https://env-gateway.example/openapi/port/v1/accounts/me',
        );
        expect(calledInit(fetchMock, 0).headers).toMatchObject({
          authorization: 'Bearer fake-env-token',
        });
        expect(calledPath(fetchMock, 1)).toContain('AccountKey=fake-cfd-acct');
      },
    );

    it.each([
      ['sim', 'SAXO_SIM_ACCOUNT_KEY'],
      ['live', 'SAXO_LIVE_ACCOUNT_KEY'],
    ] as const)('pins the %s account from %s, trimmed', async (environment, name) => {
      expect(saxoAccountKeyEnvVar(environment)).toBe(name);
      vi.stubEnv(name, '  fake-cfd-acct  ');
      const fetchMock = twoAccountFetch();

      await envClient(environment).listOpenOrders();

      expect(calledPath(fetchMock, 1)).toContain('AccountKey=fake-cfd-acct');
    });

    it.each([
      ['sim', 'SAXO_LIVE_ACCOUNT_KEY', 'SAXO_SIM_ACCOUNT_KEY'],
      ['live', 'SAXO_SIM_ACCOUNT_KEY', 'SAXO_LIVE_ACCOUNT_KEY'],
    ] as const)('%s ignores %s', async (environment, other, own) => {
      vi.stubEnv(other, 'fake-cfd-acct');
      twoAccountFetch();

      await expect(envClient(environment).listOpenOrders()).rejects.toThrow(
        `Saxo: 2 accounts are visible; set ${own} or pass { accountKey } to pick the trading one.`,
      );
    });

    it.each(['', '   '])(
      'treats an explicit accountKey of %j as unset and falls back to the environment',
      async (blank) => {
        vi.stubEnv('SAXO_SIM_ACCOUNT_KEY', 'fake-cfd-acct');
        const fetchMock = twoAccountFetch();

        await envClient('sim', blank).listOpenOrders();

        expect(calledPath(fetchMock, 1)).toContain('AccountKey=fake-cfd-acct');
      },
    );

    it.each(['', '   '])(
      'refuses 2+ accounts when the explicit accountKey is %j and the variable is unset',
      async (blank) => {
        twoAccountFetch();

        await expect(envClient('sim', blank).listOpenOrders()).rejects.toThrow(
          /2 accounts are visible; set SAXO_SIM_ACCOUNT_KEY/,
        );
      },
    );

    it('trims an explicit accountKey', async () => {
      const fetchMock = twoAccountFetch();

      await envClient('sim', '  fake-gia-acct  ').listOpenOrders();

      expect(calledPath(fetchMock, 1)).toContain('AccountKey=fake-gia-acct');
    });

    it('still refuses 2+ accounts when the variable is blank', async () => {
      vi.stubEnv('SAXO_SIM_ACCOUNT_KEY', '   ');
      twoAccountFetch();

      await expect(envClient('sim').listOpenOrders()).rejects.toThrow(
        /2 accounts are visible; set SAXO_SIM_ACCOUNT_KEY/,
      );
    });

    it('prefers an explicit accountKey over the environment', async () => {
      vi.stubEnv('SAXO_SIM_ACCOUNT_KEY', 'fake-cfd-acct');
      const fetchMock = twoAccountFetch();

      await envClient('sim', 'fake-gia-acct').listOpenOrders();

      expect(calledPath(fetchMock, 1)).toContain('AccountKey=fake-gia-acct');
    });

    it('refuses an environment accountKey the token cannot see', async () => {
      vi.stubEnv('SAXO_SIM_ACCOUNT_KEY', 'fake-missing-acct');
      twoAccountFetch();

      await expect(envClient('sim').listOpenOrders()).rejects.toThrow(
        /the configured accountKey is not among the accounts this token can see/,
      );
    });
  });

  it('refuses an accounts response with zero accounts, even unpinned', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ Data: [] }));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.placeOrder(ORDER, 'key-1')).rejects.toThrow(
      /Saxo: \/port\/v1\/accounts\/me returned no account\./,
    );
  });

  it('rejects a non-object row inside the accounts response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ Data: [42] }));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.placeOrder(ORDER, 'key-1')).rejects.toThrow(/account rows must be objects/);
  });

  it('names resolveAccount when the accounts response has no Data envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.placeOrder(ORDER, 'key-1')).rejects.toThrow(
      /malformed response body \(resolveAccount\)/,
    );
  });

  it('never embeds the token in an error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Message: 'nope' }, 401));
    const client = makeClient(fetchMock, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(client.listOpenOrders()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes(FAKE_TOKEN) &&
        error.message.includes('(resolveAccount)'),
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
        matches: (parsed) => parsed.pathname.endsWith('/port/v1/orders'),
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

describe('SaxoHttpBrokerClient getInfoPrice (#1916)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const NO_RETRY = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };

  function priceClient(body: unknown) {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse(body));
    return { fetchMock, client: makeClient(fetchMock, NO_RETRY) };
  }

  const CFD_ROW = {
    Uic: 211,
    AssetType: 'CfdOnStock',
    Quote: { Bid: 199.5, Ask: 200.5 },
    InstrumentPriceDetails: {
      IsMarketOpen: true,
      ShortTradeDisabled: false,
      CfdBorrowingCost: 0.25,
    },
  };

  it('reads a CFD quote with its short and borrow fields on the account', async () => {
    const { fetchMock, client } = priceClient(CFD_ROW);
    expect(await client.getInfoPrice(211, 'CfdOnStock')).toEqual({
      Uic: 211,
      AssetType: 'CfdOnStock',
      Bid: 199.5,
      Ask: 200.5,
      IsMarketOpen: true,
      Cfd: { ShortTradeDisabled: false, CfdBorrowingCost: 0.25 },
    });
    expect(calledPath(fetchMock, 1)).toBe(
      'https://gateway.example/sim/openapi/trade/v1/infoprices?AccountKey=acct-key&Uic=211' +
        '&AssetType=CfdOnStock&FieldGroups=Quote%2CInstrumentPriceDetails',
    );
    expect(calledInit(fetchMock, 1).method).toBe('GET');
  });

  it('reads the price on the background lane', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACCOUNTS))
      .mockResolvedValueOnce(jsonResponse(CFD_ROW));
    vi.stubGlobal('fetch', fetchMock);
    const rateLimiter = permissiveLimiter();
    const priority = vi.spyOn(rateLimiter, 'acquire');
    const background = vi.spyOn(rateLimiter, 'acquireBackground');
    const client = new SaxoHttpBrokerClient({
      accessToken: FAKE_TOKEN,
      baseUrl: 'https://gateway.example/sim/openapi/',
      retry: NO_RETRY,
      rateLimiter,
      logger: recordingLogger(),
    });
    await client.getInfoPrice(211, 'CfdOnStock');
    expect(priority).toHaveBeenCalledTimes(1);
    expect(background).toHaveBeenCalledTimes(1);
  });

  it.each(['CfdOnIndex', 'CfdOnEtf'] as const)('reads %s as a CFD', async (assetType) => {
    const { client } = priceClient({ ...CFD_ROW, AssetType: assetType });
    expect((await client.getInfoPrice(211, assetType)).Cfd).toEqual({
      ShortTradeDisabled: false,
      CfdBorrowingCost: 0.25,
    });
  });

  it('carries no CFD fields for a cash ETF, and an absent detail block reads market closed', async () => {
    const { client } = priceClient({
      Uic: 7,
      AssetType: 'Etf',
      Quote: { Bid: 10 },
      InstrumentPriceDetails: { ShortTradeDisabled: true },
    });
    expect(await client.getInfoPrice(7, 'Etf')).toEqual({
      Uic: 7,
      AssetType: 'Etf',
      Bid: 10,
      Ask: undefined,
      IsMarketOpen: false,
      Cfd: undefined,
    });
  });

  it.each([
    ['an absent detail block', {}],
    ['a missing ShortTradeDisabled', { InstrumentPriceDetails: { IsMarketOpen: true } }],
    ['a null ShortTradeDisabled', { InstrumentPriceDetails: { ShortTradeDisabled: null } }],
  ])('fails closed on %s: the CFD reads short-disabled', async (_label, change) => {
    const { InstrumentPriceDetails: _dropped, ...bare } = CFD_ROW;
    const { client } = priceClient({ ...bare, ...change });
    const price = await client.getInfoPrice(211, 'CfdOnStock');
    expect(price.Cfd).toEqual({ ShortTradeDisabled: true, CfdBorrowingCost: undefined });
  });

  it('reads an explicit ShortTradeDisabled true as disabled', async () => {
    const { client } = priceClient({
      ...CFD_ROW,
      InstrumentPriceDetails: { ShortTradeDisabled: true, CfdBorrowingCost: 0 },
    });
    expect((await client.getInfoPrice(211, 'CfdOnStock')).Cfd).toEqual({
      ShortTradeDisabled: true,
      CfdBorrowingCost: 0,
    });
  });

  it.each([
    ['not an object', 'nope', /\(getInfoPrice\): expected an object/],
    [
      'another Uic',
      { ...CFD_ROW, Uic: 212 },
      /price for Uic 211\/CfdOnStock came back as 212\/CfdOnStock/,
    ],
    ['another asset type', { ...CFD_ROW, AssetType: 'Stock' }, /came back as 211\/Stock/],
    ['no Quote', { ...CFD_ROW, Quote: undefined }, /Quote must be an object/],
    ['a string Bid', { ...CFD_ROW, Quote: { Bid: '1' } }, /Bid must be a finite number/],
    [
      'a negative borrow cost',
      { ...CFD_ROW, InstrumentPriceDetails: { ShortTradeDisabled: false, CfdBorrowingCost: -0.1 } },
      /CfdBorrowingCost must not be negative/,
    ],
    [
      'a string ShortTradeDisabled',
      { ...CFD_ROW, InstrumentPriceDetails: { ShortTradeDisabled: 'false' } },
      /ShortTradeDisabled must be a boolean/,
    ],
  ])('refuses a body with %s', async (_label, body, message) => {
    const { client } = priceClient(body);
    await expect(client.getInfoPrice(211, 'CfdOnStock')).rejects.toThrow(SaxoBrokerProviderError);
    const again = priceClient(body).client;
    await expect(again.getInfoPrice(211, 'CfdOnStock')).rejects.toThrow(message);
  });
});
