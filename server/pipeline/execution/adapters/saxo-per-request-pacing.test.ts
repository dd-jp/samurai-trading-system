import { TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { InMemoryBrokerStateStore } from '../broker-state-store.js';
import type { DormantLegsUnresolvedAlertChannel } from '../dormant-legs-unresolved-alert.js';
import type { LegResizeUnverifiedAlertChannel } from '../leg-resize-unverified-alert.js';
import type { NativeBracketRequest } from '../types.js';
import type { UnresolvedPriceUnitAlertChannel } from '../unresolved-price-unit-alert.js';
import {
  SaxoBrokerAdapter,
  type SaxoInstrumentResolver,
  saxoExternalReference,
} from './saxo-adapter.js';
import { SaxoHttpBrokerClient } from './saxo-http-client.js';

function wireRef(clientOrderId = 'key-3usl-0930', leg?: 'stop' | 'target'): string {
  const base = saxoExternalReference(clientOrderId);
  return leg === undefined ? base : `${base}:${leg}`;
}

const ACCOUNTS = { Data: [{ AccountKey: 'acct-key', ClientKey: 'client-key' }] };
const PLACEMENT = {
  ExternalReference: wireRef(),
  OrderId: '5040047177',
  Orders: [
    { ExternalReference: wireRef(undefined, 'target'), OrderId: '5040047179' },
    { ExternalReference: wireRef(undefined, 'stop'), OrderId: '5040047178' },
  ],
};
const BRACKET_OPEN_ORDERS = [
  {
    OrderId: '5040047177',
    ExternalReference: wireRef(),
    Status: 'Working',
    OpenOrderType: 'Limit',
    Amount: 3,
    BuySell: 'Buy',
    Uic: 3347273,
    AssetType: 'Etn',
  },
  {
    OrderId: '5040047178',
    ExternalReference: wireRef(undefined, 'stop'),
    Status: 'NotWorking',
    OpenOrderType: 'StopIfTraded',
    Amount: 3,
    BuySell: 'Sell',
    Uic: 3347273,
    AssetType: 'Etn',
  },
  {
    OrderId: '5040047179',
    ExternalReference: wireRef(undefined, 'target'),
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
    lseTicker === '3USL'
      ? {
          uic: 3347273,
          asset_type: 'Etn',
          currency: 'USD',
          price_currency: 'USD',
          price_to_contract_factor: 1,
        }
      : undefined,
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

interface RoutedFetchRoute {
  method: string;
  matches: (pathname: string) => boolean;
  respond: () => Response;
}

function routedFetch(openOrders: readonly unknown[]): ReturnType<typeof vi.fn> {
  const routes: readonly RoutedFetchRoute[] = [
    {
      method: 'GET',
      matches: (pathname) => pathname.endsWith('/port/v1/accounts/me'),
      respond: () => jsonResponse(ACCOUNTS),
    },
    {
      method: 'GET',
      matches: (pathname) => pathname.endsWith('/port/v1/orders/me'),
      respond: () => jsonResponse({ Data: openOrders }),
    },
    {
      method: 'GET',
      matches: (pathname) => pathname.endsWith('/cs/v1/audit/orderactivities'),
      respond: () => jsonResponse({ Data: [] }),
    },
    {
      method: 'POST',
      matches: (pathname) => pathname.endsWith('/trade/v2/orders'),
      respond: () => jsonResponse(PLACEMENT),
    },
    {
      method: 'DELETE',
      matches: (pathname) => pathname.includes('/trade/v2/orders/'),
      respond: () => jsonResponse(undefined),
    },
  ];

  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => r.method === method && r.matches(pathname));
    if (route === undefined) {
      throw new Error(`saxo-per-request-pacing.test.ts: unmocked request ${method} ${pathname}`);
    }
    return route.respond();
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

function noopDormantLegsAlerts(): DormantLegsUnresolvedAlertChannel {
  return { async postDormantLegsUnresolvedAlert() {} };
}

function noopPriceUnitAlerts(): UnresolvedPriceUnitAlertChannel {
  return { async postUnresolvedPriceUnitAlert() {} };
}

function makeWiredAdapter(openOrders: readonly unknown[]) {
  const fetchMock = routedFetch(openOrders);
  vi.stubGlobal('fetch', fetchMock);
  const rateLimiter = new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
  const acquireSpy = vi.spyOn(rateLimiter, 'acquire');
  const acquireBackgroundSpy = vi.spyOn(rateLimiter, 'acquireBackground');
  const client = new SaxoHttpBrokerClient({
    accessToken: 'test-fake-saxo-token',
    baseUrl: 'https://gateway.example/sim/openapi',
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    rateLimiter,
    logger: recordingLogger(),
  });
  const adapter = new SaxoBrokerAdapter({
    client,
    instruments: RESOLVER,
    state: new InMemoryBrokerStateStore(),
    clock: { now: () => new Date('2026-09-05T09:00:00Z') },
    legResizeAlerts: noopLegResizeAlerts(),
    dormantLegsAlerts: noopDormantLegsAlerts(),
    priceUnitAlerts: noopPriceUnitAlerts(),
    logger: recordingLogger(),
  });
  return { adapter, fetchMock, acquireSpy, acquireBackgroundSpy };
}

describe('Saxo per-request pacing (#1222)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submitBracket acquires one token per upstream request (listOpenOrders + listOrderActivities + placeOrder), not one per operation — split across the background/priority lanes (#1419)', async () => {
    const { adapter, fetchMock, acquireSpy, acquireBackgroundSpy } = makeWiredAdapter([]);

    await adapter.getOrder('warmup', '3USL');
    fetchMock.mockClear();
    acquireSpy.mockClear();
    acquireBackgroundSpy.mockClear();

    await adapter.submitBracket(makeBracket());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(acquireBackgroundSpy).toHaveBeenCalledTimes(2);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy.mock.calls.length + acquireBackgroundSpy.mock.calls.length).toBe(
      fetchMock.mock.calls.length,
    );
  });

  it('cancel of a three-leg bracket acquires one token per upstream request (listOpenOrders + cancelOrder on the master), not one per operation — split across the background/priority lanes (#1419)', async () => {
    const { adapter, fetchMock, acquireSpy, acquireBackgroundSpy } =
      makeWiredAdapter(BRACKET_OPEN_ORDERS);

    await adapter.getOrder('warmup', '3USL');
    fetchMock.mockClear();
    acquireSpy.mockClear();
    acquireBackgroundSpy.mockClear();

    await adapter.cancel('key-3usl-0930', '3USL');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(acquireBackgroundSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy.mock.calls.length + acquireBackgroundSpy.mock.calls.length).toBe(
      fetchMock.mock.calls.length,
    );
  });
});
