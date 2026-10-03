import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LSE_CALENDAR_REFERENCE } from '../../apps/v2/data/index.js';
import type { SaxoSessionState } from '../../apps/v2/execution/saxo/saxo-token-source.js';
import type { FetchResult } from '../bar-store/index.js';
import {
  assertUnitMatchesSaxo,
  gbpPerQuotedUnit,
  isSpliced,
  LSE_MOMENTUM_LINES,
} from './lse-lines.js';
import {
  type ChartSample,
  jsonFetcher,
  mergeChartPages,
  parseChartPage,
  parseInstrumentDetails,
  SAXO_CHART_PAGE,
  SaxoReadOnlyApi,
  samplesToBars,
} from './saxo-api.js';

function weekdays(from: string, count: number): string[] {
  const out: string[] = [];
  const day = new Date(`${from}T00:00:00Z`);
  while (out.length < count) {
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

const calendar = weekdays('2010-01-04', 2_500);

function sample(date: string, close: number): ChartSample {
  return {
    Time: `${date}T00:00:00.000000Z`,
    Open: close,
    High: close,
    Low: close,
    Close: close,
    Volume: 1,
  };
}

const tokens = {
  getAccessToken: async () => 'tok',
  sessionState: (): SaxoSessionState => ({ status: 'active' }) as SaxoSessionState,
  stop: async () => {},
};

describe('lse lines', () => {
  it('declares 24 pre-registered lines, two of them spliced from a USD sibling, the LSE calendar reference among them', () => {
    expect(LSE_MOMENTUM_LINES.length).toBe(24);
    expect(new Set(LSE_MOMENTUM_LINES.map((line) => line.tidm)).size).toBe(24);
    expect(new Set(LSE_MOMENTUM_LINES.map((line) => line.uic)).size).toBe(24);
    expect(LSE_MOMENTUM_LINES.filter(isSpliced).map((line) => line.tidm)).toEqual(['IHCU', 'CMFP']);
    expect(LSE_MOMENTUM_LINES.filter(isSpliced).map((line) => line.spliceFrom.unit)).toEqual([
      'USD',
      'USD',
    ]);
    expect(LSE_CALENDAR_REFERENCE).toBe('ISF');
    expect(LSE_MOMENTUM_LINES.some((line) => line.tidm === LSE_CALENDAR_REFERENCE)).toBe(true);
  });

  it('converts GBX to GBP exactly once by unit and refuses a unit factor for USD', () => {
    expect(gbpPerQuotedUnit('GBX')).toBe(0.01);
    expect(gbpPerQuotedUnit('GBP')).toBe(1);
    expect(() => gbpPerQuotedUnit('USD')).toThrow(/needs an FX rate/);
  });

  it('refuses a line whose Saxo PriceToContractFactor disagrees with the declared unit', () => {
    const gbx = { tidm: 'ISF', uic: 1, assetType: 'Etf' as const, unit: 'GBX' as const, role: '' };
    const details = parseInstrumentDetails({ PriceToContractFactor: 0.01 });
    expect(() => assertUnitMatchesSaxo(gbx, details)).not.toThrow();
    expect(() => assertUnitMatchesSaxo({ ...gbx, unit: 'GBP' }, details)).toThrow(
      /PriceToContractFactor is 0.01/,
    );
    expect(() =>
      assertUnitMatchesSaxo({ ...gbx, unit: 'USD' }, parseInstrumentDetails({})),
    ).not.toThrow();
  });
});

describe('saxo chart parsing', () => {
  it('parses ChartInfo and samples and rejects malformed bodies', () => {
    const page = parseChartPage({
      ChartInfo: { FirstSampleTime: '2000-04-28T00:00:00Z', DelayedByMinutes: 15 },
      Data: [sample('2016-01-05', 2), sample('2016-01-04', 1)],
    });
    expect(page.firstSampleTime).toBe('2000-04-28T00:00:00Z');
    expect(page.delayedByMinutes).toBe(15);
    expect(page.samples.length).toBe(2);
    const bare = parseChartPage({ Data: [] });
    expect(bare.firstSampleTime).toBeUndefined();
    expect(bare.delayedByMinutes).toBeUndefined();
    expect(() => parseChartPage({ Data: 'x' })).toThrow(/Data is not an array/);
    expect(() => parseChartPage({ Data: [{ Time: 'x' }] })).toThrow(/malformed sample/);
    expect(() => parseChartPage(null)).toThrow(/non-object/);
  });

  it('scales GBX samples by 0.01 once, sorts by date and sets rawClose to the scaled close', () => {
    const bars = samplesToBars([sample('2016-01-05', 250), sample('2016-01-04', 200)], 0.01);
    expect(bars.map((b) => b.date)).toEqual(['2016-01-04', '2016-01-05']);
    expect(bars.map((b) => b.close)).toEqual([2, 2.5]);
    expect(bars.map((b) => b.rawClose)).toEqual([2, 2.5]);
    expect(bars[0]?.open).toBe(2);
    expect(() => samplesToBars([], 0)).toThrow(/bad unit factor/);
  });

  it('merges pages by sample time, later pages overriding, in ascending order', () => {
    const merged = mergeChartPages([
      [sample('2016-01-06', 3), sample('2016-01-05', 2)],
      [sample('2016-01-05', 9), sample('2016-01-04', 1)],
    ]);
    expect(merged.map((s) => [s.Time.slice(0, 10), s.Close])).toEqual([
      ['2016-01-04', 1],
      ['2016-01-05', 9],
      ['2016-01-06', 3],
    ]);
  });

  it('parses instrument details with defaults', () => {
    const details = parseInstrumentDetails({
      Symbol: 'ISF:xlon',
      CurrencyCode: 'GBP',
      PriceToContractFactor: 0.01,
      IsTradable: true,
      IsComplex: false,
      Exchange: { ExchangeId: 'LSE_ETF' },
    });
    expect(details).toEqual({
      symbol: 'ISF:xlon',
      currencyCode: 'GBP',
      priceToContractFactor: 0.01,
      isTradable: true,
      isComplex: false,
      exchangeId: 'LSE_ETF',
    });
    expect(parseInstrumentDetails({})).toEqual({
      symbol: '',
      currencyCode: '',
      priceToContractFactor: 1,
      isTradable: false,
      isComplex: false,
      exchangeId: '',
    });
    expect(parseInstrumentDetails({ ExchangeId: 'NYSE' }).exchangeId).toBe('NYSE');
    expect(() => parseInstrumentDetails(1)).toThrow(/non-object/);
  });
});

describe('saxo read-only api', () => {
  it('pages back with Mode=UpTo until a short page, keeping only samples older than the cursor', async () => {
    const dates = calendar.slice(0, 2 * SAXO_CHART_PAGE + 5);
    const calls: string[] = [];
    const fetcher = async (url: string, token: string): Promise<FetchResult> => {
      calls.push(url);
      expect(token).toBe('tok');
      const params = new URL(url).searchParams;
      const upTo = params.get('Time');
      const eligible =
        upTo === null ? dates : dates.filter((date) => `${date}T00:00:00.000000Z` <= upTo);
      const page = eligible.slice(-SAXO_CHART_PAGE);
      return {
        status: 200,
        body: {
          ChartInfo: { DelayedByMinutes: 15 },
          Data: page.map((date, i) => sample(date, i + 1)),
        },
      };
    };
    const api = new SaxoReadOnlyApi(tokens, 'https://gw.example/openapi/', fetcher, async () => {});
    const history = await api.dailyHistory(4361, 'Etf');
    expect(history.delayedByMinutes).toBe(15);
    expect(history.samples.length).toBe(dates.length);
    expect(history.samples[0]?.Time.slice(0, 10)).toBe(dates[0]);
    expect(calls.length).toBe(3);
    expect(calls[0]).toContain('/openapi/chart/v3/charts?');
    expect(calls[0]).toContain('Horizon=1440');
    expect(calls[0]).toContain('FieldGroups=ChartInfo%2CData');
    expect(calls[1]).toContain('Mode=UpTo');
  });

  it('stops paging when the older page brings nothing new', async () => {
    const dates = calendar.slice(0, SAXO_CHART_PAGE);
    let calls = 0;
    const fetcher = async (): Promise<FetchResult> => {
      calls++;
      return { status: 200, body: { Data: dates.map((date, i) => sample(date, i + 1)) } };
    };
    const api = new SaxoReadOnlyApi(tokens, 'https://gw.example', fetcher, async () => {});
    const history = await api.dailyHistory(1, 'Etc');
    expect(history.samples.length).toBe(SAXO_CHART_PAGE);
    expect(calls).toBe(2);
  });

  it('backs off on 429, retries a 401 twice and throws on any other status', async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    const api = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => {
        attempt++;
        if (attempt === 1) return { status: 429, body: '' };
        if (attempt === 2) return { status: 401, body: '' };
        return { status: 200, body: { Symbol: 'X' } };
      },
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect((await api.instrumentDetails(1, 'Etf')).symbol).toBe('X');
    expect(sleeps).toEqual([65_000, 2_000]);
    const failing = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => ({ status: 500, body: 'boom' }),
      async () => {},
    );
    await expect(failing.instrumentDetails(1, 'Etf')).rejects.toThrow(/Saxo 500/);
    const dead = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => ({ status: 401, body: '' }),
      async () => {},
    );
    await expect(dead.instrumentDetails(1, 'Etf')).rejects.toThrow(/Saxo 401/);
  });

  it('paces chart calls at 100 per minute', async () => {
    const sleeps: number[] = [];
    const api = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => ({ status: 200, body: { Data: [] } }),
      async (ms) => {
        sleeps.push(ms);
      },
    );
    for (let i = 0; i < 101; i++) await api.dailyHistory(1, 'Etf');
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(60_500);
  });
});

describe('saxo read-only api abort signal (#2027)', () => {
  it('cancels the request on the wire: fetch rejects with an AbortError and the socket closes', async () => {
    const received: IncomingMessage[] = [];
    const server = createServer((request) => void received.push(request));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const controller = new AbortController();
      const api = new SaxoReadOnlyApi(
        tokens,
        `http://127.0.0.1:${port}`,
        undefined,
        undefined,
        controller.signal,
      );
      const pending = api.instrumentDetails(1, 'Etf');
      await vi.waitFor(() => expect(received).toHaveLength(1));
      const closed = new Promise<void>((resolve) => received[0]?.socket.once('close', resolve));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('gives up on a request the gateway never answers at the per-request timeout', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const api = new SaxoReadOnlyApi(tokens, `http://127.0.0.1:${port}`, jsonFetcher(50));
      const started = Date.now();
      await expect(api.instrumentDetails(1, 'Etf')).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('hands the signal to the fetcher and makes no request once it has aborted', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const api = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async (_url, _token, signal) => {
        signals.push(signal);
        return { status: 200, body: { Symbol: 'X' } };
      },
      async () => {},
      controller.signal,
    );
    await api.instrumentDetails(1, 'Etf');
    expect(signals).toEqual([controller.signal]);
    controller.abort();
    await expect(api.instrumentDetails(1, 'Etf')).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals).toHaveLength(1);
  });

  it('cuts a 429 backoff short and does not retry after the abort', async () => {
    const controller = new AbortController();
    let calls = 0;
    const api = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => {
        calls++;
        setTimeout(() => controller.abort(), 5);
        return { status: 429, body: '' };
      },
      undefined,
      controller.signal,
    );
    const started = Date.now();
    await expect(api.instrumentDetails(1, 'Etf')).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toBe(1);
  });

  it('does not retry after an abort during a sleeper that ignores the signal', async () => {
    const controller = new AbortController();
    const sleeps: AbortSignal[] = [];
    let calls = 0;
    const api = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => {
        calls++;
        return { status: 401, body: '' };
      },
      async (_ms, signal) => {
        sleeps.push(signal);
        controller.abort();
      },
      controller.signal,
    );
    await expect(api.instrumentDetails(1, 'Etf')).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([controller.signal]);
  });

  it('requests no further chart page once the signal aborts mid-pagination', async () => {
    const controller = new AbortController();
    const dates = calendar.slice(0, SAXO_CHART_PAGE);
    let calls = 0;
    const api = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => {
        calls++;
        controller.abort();
        return { status: 200, body: { Data: dates.map((date, i) => sample(date, i + 1)) } };
      },
      async () => {},
      controller.signal,
    );
    await expect(api.dailyHistory(1, 'Etf')).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('passes the signal to the chart pacing wait, which an abort cuts short', async () => {
    const controller = new AbortController();
    const api = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => ({ status: 200, body: { Data: [] } }),
      undefined,
      controller.signal,
    );
    for (let i = 0; i < 100; i++) await api.dailyHistory(1, 'Etf');
    const paced = api.dailyHistory(1, 'Etf');
    setTimeout(() => controller.abort(), 5);
    await expect(paced).rejects.toMatchObject({ name: 'AbortError' });
  });
});
