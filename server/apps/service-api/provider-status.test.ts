/**
 * `ProviderStatusPoller` — the live Alpaca-balance / Polygon-health probes.
 *
 * Two invariants carry most of the weight here:
 *
 *  - **Failure is a result, not an exception.** "Polygon is 401" is precisely
 *    what an operator opens the dashboard to learn, so every probe must
 *    resolve to a tile rather than reject.
 *  - **A balance is shown only when the probe succeeded.** A last-known figure
 *    rendered beside a failed probe reads as current, which on money is the one
 *    wrong answer that looks like a right one.
 *
 * `fetch` is stubbed via `vi.stubGlobal`, the same seam
 * `fetch-with-timeout.test.ts` uses.
 */
import type {
  AlpacaAccount,
  AlpacaClient,
} from '../../pipeline/execution/adapters/alpaca-client.js';
import { NULL_PROVIDER_STATUS, ProviderStatusPoller } from './provider-status.js';

/** Only `getAccount` is exercised; the order methods throw if the poller ever reaches for them. */
function alpacaStub(getAccount: () => Promise<AlpacaAccount>): AlpacaClient {
  const unreachable = () => {
    throw new Error('the status poller must never place or read orders');
  };
  return {
    getAccount,
    submitOrder: unreachable,
    getOrder: unreachable,
    getOrderByClientOrderId: unreachable,
  } as unknown as AlpacaClient;
}

function stubFetch(impl: (url: string) => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', (input: string | URL) => {
    const result = impl(String(input));
    return result instanceof Promise ? result : Promise.resolve(result);
  });
}

/** A minimal ok/failing Response; `fetchWithTimeout` only reads `.ok` and `.status`. */
function response(status: number): Response {
  return new Response(status === 200 ? '{}' : '', { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NULL_PROVIDER_STATUS', () => {
  it('reports both tiles as not_configured rather than omitting them', () => {
    // Keeps `buildSnapshot`'s output total: the UI renders a state, it never
    // has to guard a missing key.
    const panel = NULL_PROVIDER_STATUS.readProviderStatus();
    expect(panel.alpaca.state).toBe('not_configured');
    expect(panel.polygon.state).toBe('not_configured');
    expect(panel.alpaca.balance).toBeNull();
  });
});

describe('ProviderStatusPoller — Alpaca', () => {
  it('parses cash, equity and buying power from the account ledger', async () => {
    stubFetch(() => response(200));
    const poller = new ProviderStatusPoller({
      alpaca: alpacaStub(async () => ({
        cash: '12345.67',
        equity: '98765.43',
        buying_power: '197530.86',
      })),
      polygonApiKey: 'test-key',
    });

    const { alpaca } = await poller.pollOnce();
    expect(alpaca.state).toBe('ok');
    expect(alpaca.balance).toEqual({
      cash: 12345.67,
      equity: 98765.43,
      buying_power: 197530.86,
    });
  });

  it('reports buying_power as null when Alpaca omits it, without failing the tile', async () => {
    stubFetch(() => response(200));
    const poller = new ProviderStatusPoller({
      alpaca: alpacaStub(async () => ({ cash: '100', equity: '100' })),
      polygonApiKey: 'test-key',
    });

    const { alpaca } = await poller.pollOnce();
    expect(alpaca.state).toBe('ok');
    expect(alpaca.balance?.buying_power).toBeNull();
  });

  it('classifies a 401 from the account call as unauthorized and shows no balance', async () => {
    stubFetch(() => response(200));
    const poller = new ProviderStatusPoller({
      alpaca: alpacaStub(async () => {
        // Mirrors how the real client surfaces HTTP failures: a thrown error
        // carrying `.status`, duck-typed the same way elsewhere in this repo.
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      }),
      polygonApiKey: 'test-key',
    });

    const { alpaca } = await poller.pollOnce();
    expect(alpaca.state).toBe('unauthorized');
    expect(alpaca.balance).toBeNull();
  });

  it('treats a 200 with unparseable money as an error, never as a zero balance', async () => {
    stubFetch(() => response(200));
    const poller = new ProviderStatusPoller({
      alpaca: alpacaStub(async () => ({ cash: 'not-a-number', equity: '100' })),
      polygonApiKey: 'test-key',
    });

    const { alpaca } = await poller.pollOnce();
    // Reporting `ok` with a blank balance would render as "$0.00", which on a
    // money tile is worse than a visible failure.
    expect(alpaca.state).toBe('error');
    expect(alpaca.balance).toBeNull();
  });

  it('reports not_configured — not an error — when no client is wired', async () => {
    stubFetch(() => response(200));
    const poller = new ProviderStatusPoller({ polygonApiKey: 'test-key' });

    const { alpaca } = await poller.pollOnce();
    expect(alpaca.state).toBe('not_configured');
  });

  it('bounds a hung account call instead of stalling the poller forever (PR #367 review)', async () => {
    // The `AlpacaClient` interface promises nothing about timeouts. Without a
    // bound here, one hung `getAccount()` leaves `pollOnce` pending forever —
    // and since both probes share a `Promise.all`, it takes the Polygon tile
    // down with it and freezes the whole panel silently.
    vi.useFakeTimers();
    try {
      stubFetch(() => response(200));
      const poller = new ProviderStatusPoller({
        // Never settles.
        alpaca: alpacaStub(() => new Promise<never>(() => {})),
        polygonApiKey: 'test-key',
      });

      const polled = poller.pollOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      const { alpaca, polygon } = await polled;

      expect(alpaca.state).toBe('error');
      expect(alpaca.detail).toContain('timed out');
      expect(alpaca.balance).toBeNull();
      // The point of the fix: the other tile still updates.
      expect(polygon.state).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws out of pollOnce when the account call rejects', async () => {
    stubFetch(() => response(200));
    const poller = new ProviderStatusPoller({
      alpaca: alpacaStub(async () => {
        throw new Error('socket hang up');
      }),
      polygonApiKey: 'test-key',
    });

    await expect(poller.pollOnce()).resolves.toBeDefined();
  });
});

describe('ProviderStatusPoller — Polygon', () => {
  it('probes the authenticated market-status path with a bearer header, not a URL key', async () => {
    // A key in the query string leaks into any error message, proxy log or
    // stack trace that quotes the request URL.
    let seenUrl = '';
    let seenAuth: string | undefined;
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return Promise.resolve(response(200));
    });

    const poller = new ProviderStatusPoller({ polygonApiKey: 'secret-key' });
    const { polygon } = await poller.pollOnce();

    expect(polygon.state).toBe('ok');
    expect(seenUrl).toContain('/v1/marketstatus/now');
    expect(seenUrl).not.toContain('secret-key');
    expect(seenAuth).toBe('Bearer secret-key');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'error'],
  ])('maps HTTP %i onto the %s cause', async (status, expected) => {
    // The cause is kept distinct because the operator's fix differs per case:
    // wrong key vs. plan without the endpoint vs. plan being hit too hard.
    stubFetch(() => response(status));
    const poller = new ProviderStatusPoller({ polygonApiKey: 'test-key' });

    const { polygon } = await poller.pollOnce();
    expect(polygon.state).toBe(expected);
  });

  it('reports not_configured when POLYGON_API_KEY is absent', async () => {
    stubFetch(() => response(200));
    const poller = new ProviderStatusPoller({ polygonApiKey: '' });

    const { polygon } = await poller.pollOnce();
    expect(polygon.state).toBe('not_configured');
  });

  it('resolves to an error tile when the network call rejects outright', async () => {
    stubFetch(() => Promise.reject(new Error('ENOTFOUND api.polygon.io')));
    const poller = new ProviderStatusPoller({ polygonApiKey: 'test-key' });

    const { polygon } = await poller.pollOnce();
    expect(polygon.state).toBe('error');
    expect(polygon.detail).toContain('ENOTFOUND');
  });
});

describe('ProviderStatusPoller — reader seam', () => {
  it('serves the last polled panel synchronously so no request awaits a provider', async () => {
    stubFetch(() => response(200));
    const poller = new ProviderStatusPoller({
      alpaca: alpacaStub(async () => ({ cash: '1', equity: '2' })),
      polygonApiKey: 'test-key',
    });

    // Before any poll: the not-yet-polled panel, not a throw or a pending promise.
    expect(poller.readProviderStatus().alpaca.observed_at).toBeNull();

    await poller.pollOnce();
    const panel = poller.readProviderStatus();
    expect(panel.alpaca.balance?.equity).toBe(2);
    expect(panel.alpaca.observed_at).not.toBeNull();
  });
});
