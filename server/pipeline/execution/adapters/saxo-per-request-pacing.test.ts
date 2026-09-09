/**
 * #1222: `SaxoBrokerAdapter.call()` used to acquire one pacing token per
 * PUBLIC OPERATION, but `submitBracket`/`cancel` fan out to several upstream
 * Saxo HTTP requests each (`listOpenOrders` + `listOrderActivities` +
 * `placeOrder`; `listOpenOrders` + one `cancelOrder` per leg). Against a
 * bucket configured 2 capacity / 1 per second, that let real request bursts
 * outrun the pacing config.
 *
 * These tests wire the real `SaxoHttpBrokerClient` (mocked `fetch`) into
 * `SaxoBrokerAdapter` and assert one pacing token per actual upstream
 * request, not per operation.
 */
import { TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { InMemoryBrokerStateStore } from '../broker-state-store.js';
import type { LegResizeUnverifiedAlertChannel } from '../leg-resize-unverified-alert.js';
import type { NativeBracketRequest } from '../types.js';
import { SaxoBrokerAdapter, type SaxoInstrumentResolver } from './saxo-adapter.js';
import { SaxoHttpBrokerClient } from './saxo-http-client.js';

const ACCOUNTS = { Data: [{ AccountKey: 'acct-key', ClientKey: 'client-key' }] };
const PLACEMENT = {
  ExternalReference: 'key-3usl-0930',
  OrderId: '5040047177',
  Orders: [
    { ExternalReference: 'key-3usl-0930:target', OrderId: '5040047179' },
    { ExternalReference: 'key-3usl-0930:stop', OrderId: '5040047178' },
  ],
};
const BRACKET_OPEN_ORDERS = [
  {
    OrderId: '5040047177',
    ExternalReference: 'key-3usl-0930',
    Status: 'Working',
    OpenOrderType: 'Limit',
    Amount: 3,
    BuySell: 'Buy',
    Uic: 3347273,
    AssetType: 'Etn',
  },
  {
    OrderId: '5040047178',
    ExternalReference: 'key-3usl-0930:stop',
    Status: 'NotWorking',
    OpenOrderType: 'StopIfTraded',
    Amount: 3,
    BuySell: 'Sell',
    Uic: 3347273,
    AssetType: 'Etn',
  },
  {
    OrderId: '5040047179',
    ExternalReference: 'key-3usl-0930:target',
    Status: 'NotWorking',
    OpenOrderType: 'Limit',
    Amount: 3,
    BuySell: 'Sell',
    Uic: 3347273,
    AssetType: 'Etn',
  },
];

const RESOLVER: SaxoInstrumentResolver = {
  resolve: (lseTicker) =>
    lseTicker === '3USL' ? { uic: 3347273, asset_type: 'Etn', currency: 'USD' } : undefined,
  lseTickerFor: (uic) => (uic === 3347273 ? '3USL' : undefined),
};

function jsonResponse(body: unknown, status = 200): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => text,
  } as Response;
}

/**
 * Routed by path suffix + verb rather than call order, so the fixture
 * doesn't have to predict the client's internal request sequence — only
 * what each endpoint returns.
 */
function routedFetch(openOrders: readonly unknown[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && pathname.endsWith('/port/v1/accounts/me')) {
      return jsonResponse(ACCOUNTS);
    }
    if (method === 'GET' && pathname.endsWith('/port/v1/orders/me')) {
      return jsonResponse({ Data: openOrders });
    }
    if (method === 'GET' && pathname.endsWith('/cs/v1/audit/orderactivities')) {
      return jsonResponse({ Data: [] });
    }
    if (method === 'POST' && pathname.endsWith('/trade/v2/orders')) {
      return jsonResponse(PLACEMENT);
    }
    if (method === 'DELETE' && pathname.includes('/trade/v2/orders/')) {
      return jsonResponse(undefined);
    }
    throw new Error(`saxo-per-request-pacing.test.ts: unmocked request ${method} ${pathname}`);
  });
}

function makeBracket(): NativeBracketRequest {
  return {
    client_order_id: 'key-3usl-0930',
    instrument: '3USL',
    asset_class: 'stocks',
    side: 'buy',
    size: 3,
    entry: 10,
    stop: 9,
    target: 12,
    time_in_force: 'day',
  };
}

function noopLegResizeAlerts(): LegResizeUnverifiedAlertChannel {
  return { async postLegResizeUnverifiedAlert() {} };
}

/**
 * Builds an adapter over the REAL `SaxoHttpBrokerClient` (mocked `fetch`),
 * with `rateLimiter.acquire` spied so a test can count tokens issued rather
 * than only requests made — the two diverged under the pre-#1222 defect.
 */
function makeWiredAdapter(openOrders: readonly unknown[]) {
  const fetchMock = routedFetch(openOrders);
  vi.stubGlobal('fetch', fetchMock);
  const rateLimiter = new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
  const acquireSpy = vi.spyOn(rateLimiter, 'acquire');
  const client = new SaxoHttpBrokerClient({
    accessToken: 'test-fake-saxo-token',
    baseUrl: 'https://gateway.example/sim/openapi',
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    rateLimiter,
  });
  const adapter = new SaxoBrokerAdapter({
    client,
    instruments: RESOLVER,
    state: new InMemoryBrokerStateStore(),
    clock: { now: () => new Date('2026-09-05T09:00:00Z') },
    legResizeAlerts: noopLegResizeAlerts(),
    logger: recordingLogger(),
  });
  return { adapter, fetchMock, acquireSpy };
}

describe('Saxo per-request pacing (#1222)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submitBracket acquires one token per upstream request (listOpenOrders + listOrderActivities + placeOrder), not one per operation', async () => {
    const { adapter, fetchMock, acquireSpy } = makeWiredAdapter([]);

    // Warm up account-identity resolution (memoised on the client) so the
    // assertions below count only submitBracket's own requests, not the
    // one-time /port/v1/accounts/me lookup a cold client would also pay.
    await adapter.getOrder('warmup', '3USL');
    fetchMock.mockClear();
    acquireSpy.mockClear();

    await adapter.submitBracket(makeBracket());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The defect: `SaxoBrokerAdapter.call()` acquired exactly one token for
    // the whole operation regardless of how many requests `fn()` issued —
    // this is the assertion a per-operation-accounting mutant fails.
    expect(acquireSpy).toHaveBeenCalledTimes(3);
    expect(acquireSpy.mock.calls.length).toBe(fetchMock.mock.calls.length);
  });

  it('cancel of a three-leg bracket acquires one token per upstream request (listOpenOrders + 3x cancelOrder), not one per operation', async () => {
    const { adapter, fetchMock, acquireSpy } = makeWiredAdapter(BRACKET_OPEN_ORDERS);

    await adapter.getOrder('warmup', '3USL');
    fetchMock.mockClear();
    acquireSpy.mockClear();

    await adapter.cancel('key-3usl-0930', '3USL');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(acquireSpy).toHaveBeenCalledTimes(4);
    expect(acquireSpy.mock.calls.length).toBe(fetchMock.mock.calls.length);
  });
});
