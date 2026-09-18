import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Bar, BarWindow } from '../../../providers/market-data-service/index.js';
import {
  PolygonBarsClient,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import {
  DEFAULT_POLYGON_PACING,
  type LogEntry,
  type Logger,
  runWithTraceId,
  TokenBucket,
} from '../../../shared/index.js';
import {
  ALERT_REPEAT_EVERY_FAILOVERS,
  buildFailoverDataSource,
  type DataFailoverAlert,
  DataFailoverAlertThrottle,
  FAILOVER_INCIDENT_GAP_MS,
  resolveFallbackPacing,
} from './data-failover.js';

const ASOF = new Date('2026-08-17T16:00:00.000Z');
const WINDOW: BarWindow = { timeframe: '1h', lookback: 2 };

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

function fallbackBar(): Bar {
  return {
    instrument: 'SPY',
    timeframe: '1h',
    open_time: new Date('2026-08-17T15:00:00.000Z'),
    close_time: ASOF,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
    source: 'polygon',
  };
}

function stallingPrimary() {
  return {
    fetchBars: vi.fn(async (): Promise<Bar[]> => {
      throw new Error('alpaca 503');
    }),
    fetchMark: vi.fn(async () => {
      throw new Error('unreachable — no case here marks');
    }),
  };
}

describe('resolveFallbackPacing — the boot-path pacing decision', () => {
  it('applies a well-formed SAMURAI_PACING_POLYGON_* override', () => {
    const logger = recordingLogger();

    const pacing = resolveFallbackPacing(logger, { SAMURAI_PACING_POLYGON_CAPACITY: '3' });

    expect(pacing.capacity).toBe(3);
    expect(logger.entries).toHaveLength(0);
  });

  it('WARNS AND DEFAULTS on a malformed override rather than refusing to boot', () => {
    const logger = recordingLogger();

    const pacing = resolveFallbackPacing(logger, {
      SAMURAI_PACING_POLYGON_REFILL_PER_SEC: 'not-a-number',
    });

    expect(pacing).toEqual(DEFAULT_POLYGON_PACING);
    const warned = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toContain('SAMURAI_PACING_POLYGON');
  });
});

describe('buildFailoverDataSource', () => {
  it('fails an equities instrument over and reports it on the alert channel', async () => {
    const logger = recordingLogger();
    const postDataFailoverAlert = vi.fn(async () => undefined);
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      equitiesFallbackBarFetcher: async () => [fallbackBar()],
      alertChannel: { postDataFailoverAlert },
      logger,
      now: () => ASOF,
    });

    const bars = await source.fetchBars('SPY', WINDOW, ASOF);

    expect(bars.map((bar) => bar.source)).toEqual(['polygon']);
    expect(postDataFailoverAlert).toHaveBeenCalledWith(
      expect.objectContaining({ leg: 'equities', symbol: 'SPY', reported_at: ASOF }),
    );
  });

  it('session-normalizes the fallback, including an INJECTED fetcher', async () => {
    const preMarket: Bar = { ...fallbackBar(), open_time: new Date('2026-08-17T09:00:00.000Z') };
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      equitiesFallbackBarFetcher: async () => [preMarket, fallbackBar()],
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger: recordingLogger(),
      now: () => ASOF,
    });

    const bars = await source.fetchBars('SPY', WINDOW, ASOF);

    expect(bars.map((bar) => bar.open_time.toISOString())).toEqual([
      fallbackBar().open_time.toISOString(),
    ]);
  });

  it('leaves a crypto instrument with no fallback — equities-only by scope', async () => {
    const equitiesFallbackBarFetcher = vi.fn(async () => [fallbackBar()]);
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'BTC-USD', asset_class: 'crypto' }],
      equitiesFallbackBarFetcher,
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger: recordingLogger(),
      now: () => ASOF,
    });

    await expect(source.fetchBars('BTC-USD', WINDOW, ASOF)).rejects.toThrow('alpaca 503');
    expect(equitiesFallbackBarFetcher).not.toHaveBeenCalled();
  });

  it('throttles a persisting stall to one alert, then every eighth, carrying the suppressed count', async () => {
    const postDataFailoverAlert = vi.fn(async (_alert: DataFailoverAlert) => undefined);
    let now = ASOF;
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      equitiesFallbackBarFetcher: async () => [fallbackBar()],
      alertChannel: { postDataFailoverAlert },
      logger: recordingLogger(),
      now: () => now,
    });

    for (let tick = 0; tick < ALERT_REPEAT_EVERY_FAILOVERS + 1; tick += 1) {
      now = new Date(ASOF.getTime() + tick * 60_000);
      await source.fetchBars('SPY', WINDOW, now);
    }

    expect(postDataFailoverAlert).toHaveBeenCalledTimes(2);
    expect(postDataFailoverAlert.mock.calls[0]?.[0]).toMatchObject({ suppressed_since_last: 0 });
    expect(postDataFailoverAlert.mock.calls[1]?.[0]).toMatchObject({
      suppressed_since_last: ALERT_REPEAT_EVERY_FAILOVERS - 1,
    });
  });

  it('is loud again for a NEW incident after a quiet gap, and throttles each instrument separately', async () => {
    const postDataFailoverAlert = vi.fn(async (_alert: DataFailoverAlert) => undefined);
    let now = ASOF;
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [
        { asset: 'SPY', asset_class: 'stocks' },
        { asset: 'QQQ', asset_class: 'stocks' },
      ],
      equitiesFallbackBarFetcher: async () => [fallbackBar()],
      alertChannel: { postDataFailoverAlert },
      logger: recordingLogger(),
      now: () => now,
    });

    await source.fetchBars('SPY', WINDOW, now);
    await source.fetchBars('QQQ', WINDOW, now);
    now = new Date(ASOF.getTime() + 60_000);
    await source.fetchBars('SPY', WINDOW, now);
    now = new Date(ASOF.getTime() + 60_000 + FAILOVER_INCIDENT_GAP_MS + 1);
    await source.fetchBars('SPY', WINDOW, now);

    expect(postDataFailoverAlert.mock.calls.map((call) => call[0].symbol)).toEqual([
      'SPY',
      'QQQ',
      'SPY',
    ]);
  });

  it('logs, and does not rethrow, an alert POST that fails', async () => {
    const logger = recordingLogger();
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      equitiesFallbackBarFetcher: async () => [fallbackBar()],
      alertChannel: {
        postDataFailoverAlert: async () => {
          throw new Error('telegram 502');
        },
      },
      logger,
      now: () => ASOF,
    });

    const bars = await source.fetchBars('SPY', WINDOW, ASOF);
    await Promise.resolve();

    expect(bars).toHaveLength(1);
    const errors = logger.entries.filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('telegram 502');
  });

  it('falls back to the data-failover constant when the alert POST fails outside a tick (#1118)', async () => {
    const logger = recordingLogger();
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      equitiesFallbackBarFetcher: async () => [fallbackBar()],
      alertChannel: {
        postDataFailoverAlert: async () => {
          throw new Error('telegram 502');
        },
      },
      logger,
      now: () => ASOF,
    });

    await source.fetchBars('SPY', WINDOW, ASOF);
    await Promise.resolve();

    const errors = logger.entries.filter((entry) => entry.level === 'error');
    expect(errors[0]?.trace_id).toBe('data-failover');
  });

  it('joins a failed alert POST to the enclosing tick instead (#1118)', async () => {
    const logger = recordingLogger();
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      equitiesFallbackBarFetcher: async () => [fallbackBar()],
      alertChannel: {
        postDataFailoverAlert: async () => {
          throw new Error('telegram 502');
        },
      },
      logger,
      now: () => ASOF,
    });

    await runWithTraceId('tick-x', () => source.fetchBars('SPY', WINDOW, ASOF));
    await Promise.resolve();

    const errors = logger.entries.filter((entry) => entry.level === 'error');
    expect(errors[0]?.trace_id).toBe('tick-x');
  });
});

describe('buildFailoverDataSource — the default Polygon branch (#823)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.POLYGON_API_KEY;
    delete process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC;
  });

  it('does NOT throw at construction when POLYGON_API_KEY is unset — the throw is scoped to the failover, not the boot path', async () => {
    delete process.env.POLYGON_API_KEY;
    const logger = recordingLogger();

    let source: ReturnType<typeof buildFailoverDataSource> | undefined;
    expect(() => {
      source = buildFailoverDataSource({
        primary: stallingPrimary(),
        calendar: new UsEquityRegularHoursCalendar(),
        universe: [{ asset: 'SPY', asset_class: 'stocks' }],
        alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
        logger,
        now: () => ASOF,
      });
    }).not.toThrow();

    let thrown: unknown;
    try {
      await source?.fetchBars('SPY', WINDOW, ASOF);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/alpaca.*failed.*polygon.*failed/s);
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(((thrown as Error).cause as Error).message).toMatch(/POLYGON_API_KEY is not set/);
  });

  it('constructs the client with a TokenBucket(pacing) rate limiter and maps window.lookback to the WIDENED raw limit getBars receives', async () => {
    process.env.POLYGON_API_KEY = 'test-key';

    const localAsOf = new Date('2026-08-17T17:00:00.000Z');
    const localWindow: BarWindow = { timeframe: '1h', lookback: 2 };

    function inSessionAggregate(isoOpenTime: string) {
      return {
        t: new Date(isoOpenTime).getTime(),
        o: 100,
        h: 101,
        l: 99,
        c: 100.5,
        v: 42,
      };
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            inSessionAggregate('2026-08-17T14:00:00.000Z'),
            inSessionAggregate('2026-08-17T15:00:00.000Z'),
            inSessionAggregate('2026-08-17T16:00:00.000Z'),
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const getBarsSpy = vi.spyOn(PolygonBarsClient.prototype, 'getBars');
    let capturedBucket: { config: unknown } | undefined;
    const acquireBackgroundSpy = vi
      .spyOn(TokenBucket.prototype, 'acquireBackground')
      .mockImplementation(async function (this: { config: unknown }) {
        // oxlint-disable-next-line typescript/no-this-alias -- needs the mock's call-site `this`; an arrow function would close over the wrong one
        capturedBucket = this;
      });

    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger: recordingLogger(),
      now: () => localAsOf,
    });

    const bars = await source.fetchBars('SPY', localWindow, localAsOf);

    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.source)).toEqual(['polygon', 'polygon']);

    expect(getBarsSpy).toHaveBeenCalledTimes(1);
    expect(getBarsSpy).toHaveBeenCalledWith('SPY', '1h', localAsOf, 3);

    expect(acquireBackgroundSpy).toHaveBeenCalledTimes(1);
    expect(capturedBucket?.config).toEqual(DEFAULT_POLYGON_PACING);
  });

  it('escalates the raw limit getBars receives across a widen-and-retry, not just the first attempt', async () => {
    process.env.POLYGON_API_KEY = 'test-key';

    const localAsOf = new Date('2026-08-18T01:00:00.000Z');
    const localWindow: BarWindow = { timeframe: '1h', lookback: 2 };

    function aggregate(isoOpenTime: string) {
      return { t: new Date(isoOpenTime).getTime(), o: 100, h: 101, l: 99, c: 100.5, v: 42 };
    }
    const rawAggregates = [
      aggregate('2026-08-17T12:00:00.000Z'),
      aggregate('2026-08-17T13:00:00.000Z'),
      aggregate('2026-08-17T13:30:00.000Z'),
      aggregate('2026-08-17T14:30:00.000Z'),
      aggregate('2026-08-17T20:30:00.000Z'),
      aggregate('2026-08-17T21:30:00.000Z'),
      aggregate('2026-08-17T22:30:00.000Z'),
      aggregate('2026-08-17T23:30:00.000Z'),
    ];
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ results: rawAggregates }), { status: 200 })),
      );
    vi.stubGlobal('fetch', fetchMock);

    const getBarsSpy = vi.spyOn(PolygonBarsClient.prototype, 'getBars');
    vi.spyOn(TokenBucket.prototype, 'acquireBackground').mockResolvedValue(undefined);

    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger: recordingLogger(),
      now: () => localAsOf,
    });

    const bars = await source.fetchBars('SPY', localWindow, localAsOf);

    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.source)).toEqual(['polygon', 'polygon']);

    expect(getBarsSpy.mock.calls.map((call) => call[3])).toEqual([3, 96]);
    for (const call of getBarsSpy.mock.calls) {
      expect(call.slice(0, 3)).toEqual(['SPY', '1h', localAsOf]);
    }
  });

  it('takes a non-default pacing from deps.fallbackPacing WITHOUT mutating process.env (#822)', async () => {
    process.env.POLYGON_API_KEY = 'test-key';
    expect(process.env.SAMURAI_PACING_POLYGON_CAPACITY).toBeUndefined();
    expect(process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC).toBeUndefined();

    const localAsOf = new Date('2026-08-17T17:00:00.000Z');
    const localWindow: BarWindow = { timeframe: '1h', lookback: 2 };
    function inSessionAggregate(isoOpenTime: string) {
      return { t: new Date(isoOpenTime).getTime(), o: 100, h: 101, l: 99, c: 100.5, v: 42 };
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              inSessionAggregate('2026-08-17T14:00:00.000Z'),
              inSessionAggregate('2026-08-17T15:00:00.000Z'),
              inSessionAggregate('2026-08-17T16:00:00.000Z'),
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    let capturedBucket: { config: unknown } | undefined;
    vi.spyOn(TokenBucket.prototype, 'acquireBackground').mockImplementation(async function (this: {
      config: unknown;
    }) {
      // oxlint-disable-next-line typescript/no-this-alias -- needs the mock's call-site `this`; an arrow function would close over the wrong one
      capturedBucket = this;
    });

    const nonDefaultPacing = {
      capacity: DEFAULT_POLYGON_PACING.capacity + 5,
      refillPerSecond: DEFAULT_POLYGON_PACING.refillPerSecond + 1,
      reserveForPriority: (DEFAULT_POLYGON_PACING.reserveForPriority ?? 0) + 1,
    };

    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      fallbackPacing: nonDefaultPacing,
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger: recordingLogger(),
      now: () => localAsOf,
    });

    const bars = await source.fetchBars('SPY', localWindow, localAsOf);

    expect(bars).toHaveLength(2);
    expect(capturedBucket?.config).toEqual(nonDefaultPacing);
    expect(capturedBucket?.config).not.toEqual(DEFAULT_POLYGON_PACING);
  });

  it('emits NO startup warn for a malformed SAMURAI_PACING_POLYGON_* when equitiesFallbackBarFetcher is injected (#825)', () => {
    process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC = 'not-a-number';
    const logger = recordingLogger();

    buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      equitiesFallbackBarFetcher: async () => [fallbackBar()],
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger,
      now: () => ASOF,
    });

    const pacingWarns = logger.entries.filter((entry) =>
      entry.message.includes('SAMURAI_PACING_POLYGON'),
    );
    expect(pacingWarns).toHaveLength(0);
  });

  it('still resolves pacing EAGERLY at boot, before any fetch, when the default branch is selected (#822 constraint from #825)', () => {
    process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC = 'not-a-number';
    const logger = recordingLogger();

    buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger,
      now: () => ASOF,
    });

    const pacingWarns = logger.entries.filter((entry) =>
      entry.message.includes('SAMURAI_PACING_POLYGON'),
    );
    expect(pacingWarns).toHaveLength(1);
  });

  it('reuses the SAME lazily-constructed PolygonBarsClient across calls', async () => {
    process.env.POLYGON_API_KEY = 'test-key';

    const localAsOf = new Date('2026-08-17T17:00:00.000Z');
    const localWindow: BarWindow = { timeframe: '1h', lookback: 2 };
    function inSessionAggregate(isoOpenTime: string) {
      return { t: new Date(isoOpenTime).getTime(), o: 100, h: 101, l: 99, c: 100.5, v: 42 };
    }
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              inSessionAggregate('2026-08-17T14:00:00.000Z'),
              inSessionAggregate('2026-08-17T15:00:00.000Z'),
              inSessionAggregate('2026-08-17T16:00:00.000Z'),
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(TokenBucket.prototype, 'acquireBackground').mockResolvedValue(undefined);

    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger: recordingLogger(),
      now: () => localAsOf,
    });

    const first = await source.fetchBars('SPY', localWindow, localAsOf);
    expect(first).toHaveLength(2);

    delete process.env.POLYGON_API_KEY;
    const second = await source.fetchBars('SPY', localWindow, localAsOf);
    expect(second).toHaveLength(2);
  });

  it('caps a failed-over read at TWO Polygon requests, counted at the client (#828)', async () => {
    process.env.POLYGON_API_KEY = 'test-key';

    const localAsOf = new Date('2026-08-18T01:00:00.000Z');
    const rawAggregates = Array.from({ length: 120 }, (_, i) => {
      const open = new Date(localAsOf.getTime() - (i + 1) * 86_400_000);
      open.setUTCHours(3, 0, 0, 0);
      return { t: open.getTime(), o: 100, h: 101, l: 99, c: 100.5, v: 42 };
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify({ results: rawAggregates }), { status: 200 }),
          ),
        ),
    );
    const getBarsSpy = vi.spyOn(PolygonBarsClient.prototype, 'getBars');
    vi.spyOn(TokenBucket.prototype, 'acquireBackground').mockResolvedValue(undefined);

    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger: recordingLogger(),
      now: () => localAsOf,
    });

    await expect(
      source.fetchBars('SPY', { timeframe: '1h', lookback: 2 }, localAsOf),
    ).rejects.toThrow(/both alpaca .* and polygon .* failed/);

    expect(getBarsSpy).toHaveBeenCalledTimes(2);
  });

  it('WARNS AND DEFAULTS on a fallbackPacing that would park every fallback read forever (#828)', async () => {
    process.env.POLYGON_API_KEY = 'test-key';

    const localAsOf = new Date('2026-08-17T17:00:00.000Z');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [14, 15, 16].map((hour) => ({
              t: new Date(`2026-08-17T${hour}:00:00.000Z`).getTime(),
              o: 100,
              h: 101,
              l: 99,
              c: 100.5,
              v: 42,
            })),
          }),
          { status: 200 },
        ),
      ),
    );

    let capturedBucket: { config: unknown } | undefined;
    vi.spyOn(TokenBucket.prototype, 'acquireBackground').mockImplementation(async function (this: {
      config: unknown;
    }) {
      // oxlint-disable-next-line typescript/no-this-alias -- needs the mock's call-site `this`; an arrow function would close over the wrong one
      capturedBucket = this;
    });

    const logger = recordingLogger();
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      fallbackPacing: { capacity: 1, refillPerSecond: 0 },
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger,
      now: () => localAsOf,
    });

    const warned = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toContain('parked forever');

    const bars = await source.fetchBars('SPY', { timeframe: '1h', lookback: 2 }, localAsOf);

    expect(bars).toHaveLength(2);
    expect(capturedBucket?.config).toEqual(DEFAULT_POLYGON_PACING);
  });

  it('rejects a capacity below one as well, not only a non-positive refill (#828)', () => {
    const logger = recordingLogger();

    buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      fallbackPacing: { capacity: 0, refillPerSecond: 10 },
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger,
      now: () => ASOF,
    });

    expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
  });

  it('rejects a priority reserve that starves the background lane (#828)', () => {
    const logger = recordingLogger();

    buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      fallbackPacing: { capacity: 1, refillPerSecond: 1 / 13, reserveForPriority: 1 },
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger,
      now: () => ASOF,
    });

    expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
  });

  it('leaves a well-formed fallbackPacing untouched and silent', () => {
    const logger = recordingLogger();

    buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      fallbackPacing: { capacity: 2, refillPerSecond: 1 / 20 },
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger,
      now: () => ASOF,
    });

    expect(logger.entries).toHaveLength(0);
  });
});

describe('DataFailoverAlertThrottle', () => {
  const event = {
    leg: 'equities' as const,
    symbol: 'SPY',
    timeframe: '1h',
    primaryName: 'alpaca',
    fallbackName: 'polygon',
    primaryError: 'alpaca 503',
  };

  it('carries the tail of suppressed failovers onto the NEXT incident, not into the bin', () => {
    const throttle = new DataFailoverAlertThrottle();
    const decisions = Array.from({ length: 12 }, (_, i) =>
      throttle.decide(event, new Date(ASOF.getTime() + i * 60_000)),
    );

    expect(decisions.filter((decision) => decision.alert)).toHaveLength(2);

    const newIncident = throttle.decide(
      event,
      new Date(ASOF.getTime() + 11 * 60_000 + FAILOVER_INCIDENT_GAP_MS + 1),
    );

    expect(newIncident.alert).toBe(true);
    expect(newIncident.suppressedSinceLast).toBe(3);
  });

  it('reports nothing suppressed for a first-ever failover', () => {
    const throttle = new DataFailoverAlertThrottle();

    expect(throttle.decide(event, ASOF)).toEqual({ alert: true, suppressedSinceLast: 0 });
  });
});
