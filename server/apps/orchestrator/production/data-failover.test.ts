/**
 * The live OHLCV failover's WIRING decisions (#562), as distinct from the
 * failover mechanism itself (`failover-data-source.test.ts`) and from the
 * fact that the composition root builds one (`production.test.ts`).
 *
 * A documented decision nothing asserts is a comment, so each decision this
 * wiring records is asserted here: the malformed-pacing-override posture,
 * the equities-only scope, that a failed alert POST cannot turn a survived
 * vendor stall into a thrown tick, and the alert THROTTLE — a stall persists
 * across ticks, and an escalation chat flooded by it gets muted along with
 * everything else on that channel.
 */
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

/** Monday 12:00 ET — inside US regular hours, so a bar completed here survives session normalization */
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
    // The decision #562 asked to be recorded, asserted rather than only
    // documented: this variable paces a DEGRADATION MITIGATION, touched only
    // once the primary vendor has already failed. Refusing to boot over it
    // would take the whole book offline for a typo — strictly worse than the
    // stall the fallback exists to survive. Contrast `SAMURAI_ALERTS` /
    // `SAMURAI_MODE`, which gate whether the system operates correctly and
    // are refusals on purpose
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
    // The invariant #818 found missing: a bar reaching the store carries the
    // same session semantics whichever vendor served it. The primary is a
    // `NormalizingDataSource`; a vendor client is a bare `BarFetcher` that
    // applies no calendar and serves ~16 `1h` bars a day over 08:00Z-23:00Z
    // Asserted on an INJECTED fetcher on purpose — the wrap must not be
    // something only the default Polygon path gets
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
    // ADR-0015's 2026-08-16 amendment took crypto out of Samurai's scope, so
    // the Coinbase/Bitstamp pairing the backfill script uses has no live
    // counterpart. A crypto bar read must behave exactly as it did before.
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
    // A stall is a CONDITION, not an event: every tick that reads bars while
    // it lasts fails over again. Unthrottled, a day-long stall floods the
    // escalation chat until the operator mutes it — and #342's argument is
    // that muting that chat also mutes the orphan verdict and the kill-line
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
    // A counter that never resets would swallow a recovery-then-restall, and
    // a counter shared across instruments would hide a second name going down
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
    // Second SPY failover a minute later — same incident, suppressed
    now = new Date(ASOF.getTime() + 60_000);
    await source.fetchBars('SPY', WINDOW, now);
    // And one well past the incident gap, measured from that second failover
    // rather than from the first — a new incident, loud again
    now = new Date(ASOF.getTime() + 60_000 + FAILOVER_INCIDENT_GAP_MS + 1);
    await source.fetchBars('SPY', WINDOW, now);

    expect(postDataFailoverAlert.mock.calls.map((call) => call[0].symbol)).toEqual([
      'SPY',
      'QQQ',
      'SPY',
    ]);
  });

  it('logs, and does not rethrow, an alert POST that fails', async () => {
    // A Telegram outage must not turn "the fallback served these bars" into
    // "the tick threw" — the same posture `checkMiCoverage` documents
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
    // The rejection is handled off the fetch's own promise chain, so let the
    // microtask queue drain before reading the log
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
    // #1117 threaded `currentTraceId()` through the rest of the market-data
    // logging path but deliberately left this catch-line on its constant to
    // keep that diff honest. Without this join, the transport's own log for
    // the same failover carries the tick id while this line carries
    // 'data-failover' — one event, two taxonomies, nothing linking them
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
    // The alert POST's `.catch` is fire-and-forget, registered inside the
    // tick's context but settling after `fetchBars` already resolved
    await Promise.resolve();

    const errors = logger.entries.filter((entry) => entry.level === 'error');
    expect(errors[0]?.trace_id).toBe('tick-x');
  });
});

describe('buildFailoverDataSource — the default Polygon branch (#823)', () => {
  // Nothing above this block ever leaves `equitiesFallbackBarFetcher`
  // undefined, so the lazy `new PolygonBarsClient(...)` construction and the
  // `polygon.getBars(...)` call inside `buildFailoverDataSource`'s default
  // branch were exercised by nothing (#818 only reached the wrapping — the
  // fetcher was always injected). These tests let that branch run for real,
  // against a stubbed `fetch`, rather than re-implementing it here
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.POLYGON_API_KEY;
    // Cleanup lives here, not as a trailing statement inside the two #822/#825
    // tests below that set this — if the assertion above it throws, an inline
    // `delete` after the `expect` never runs and the malformed value leaks
    // into every later test in this file
    delete process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC;
  });

  it('does NOT throw at construction when POLYGON_API_KEY is unset — the throw is scoped to the failover, not the boot path', async () => {
    // The module doc: "an unset key must not stop the orchestrator booting
    // on a day Alpaca never stalls... A missing key then surfaces inside
    // withOhlcvFailover's combined error, scoped to the one pair that failed
    // over." Asserted as two separate facts: building the source never
    // throws, and only a read that actually needs the fallback does
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
    // The combined withOhlcvFailover error, naming both vendors...
    expect((thrown as Error).message).toMatch(/alpaca.*failed.*polygon.*failed/s);
    // ...whose cause is the key-unset throw from the lazy PolygonBarsClient
    // construction itself, not a network error — proving it is the
    // constructor's own guard that surfaced, scoped to this one failover
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(((thrown as Error).cause as Error).message).toMatch(/POLYGON_API_KEY is not set/);
  });

  it('constructs the client with a TokenBucket(pacing) rate limiter and maps window.lookback to the WIDENED raw limit getBars receives', async () => {
    // #818 wrapped the fallback in withSessionNormalization, so the `limit`
    // PolygonBarsClient.getBars sees is NormalizingDataSource's widened raw
    // ask (window.lookback + FORMING_BAR_FETCH_MARGIN), not the caller's
    // lookback verbatim. Nothing asserted that mapping before this test.
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
    // `TokenBucket`'s `config` constructor param is a plain (not `#private`)
    // property, so capturing `this` off the spy lets the test read back the
    // exact `TokenBucketConfig` the client's rate limiter was built with —
    // proving it carries `resolveFallbackPacing`'s result, not just that
    // SOME limiter is present
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

    // The Polygon client actually served bars, stamped as such
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.source)).toEqual(['polygon', 'polygon']);

    // The lookback -> getBars argument mapping: window.lookback (2) is NOT
    // what reaches the client. `NormalizingDataSource`'s first raw ask is
    // `lookback + FORMING_BAR_FETCH_MARGIN` (1) = 3, and this window is
    // satisfied on the first attempt (no widen-and-retry), so 3 is the exact
    // value getBars is called with
    expect(getBarsSpy).toHaveBeenCalledTimes(1);
    expect(getBarsSpy).toHaveBeenCalledWith('SPY', '1h', localAsOf, 3);

    // The TokenBucket(pacing) rate limiter reaches the client, is actually
    // exercised on the call path, and carries the resolved pacing (the
    // checked-in default here, since no SAMURAI_PACING_POLYGON_* override is
    // set) rather than some other config
    expect(acquireBackgroundSpy).toHaveBeenCalledTimes(1);
    expect(capturedBucket?.config).toEqual(DEFAULT_POLYGON_PACING);
  });

  it('escalates the raw limit getBars receives across a widen-and-retry, not just the first attempt', async () => {
    // The #818 scenario this ticket calls out by name: a raw vendor payload
    // that under-serves IN-SESSION bars relative to what it returns RAW
    // (extended-hours candles mixed in) makes NormalizingDataSource re-ask
    // with a LARGER raw limit. Point 3 asks for the actual widened value
    // that reaches the client on a re-attempt, not only the first ask
    process.env.POLYGON_API_KEY = 'test-key';

    // 15:00 ET Monday — after this, session normalization sees a mix of
    // in-session (09:30-16:00 ET / 13:30-20:00Z) and extended-hours candles
    const localAsOf = new Date('2026-08-18T01:00:00.000Z');
    const localWindow: BarWindow = { timeframe: '1h', lookback: 2 };

    function aggregate(isoOpenTime: string) {
      return { t: new Date(isoOpenTime).getTime(), o: 100, h: 101, l: 99, c: 100.5, v: 42 };
    }
    // Ascending by open_time. The newest two (23:30Z/22:30Z open) are
    // POST-CLOSE extended-hours candles; only the two around 13:30Z/14:30Z
    // (09:30/10:30 ET) fall inside the regular session
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
    // DEFAULT_POLYGON_PACING is capacity 1 / ~13s refill — real pacing would
    // make a second attempt in this test wait on the real clock. Not what
    // this test is about (that's the previous test's job), so bypass it
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

    // The eventual serve is the two IN-SESSION bars, still stamped polygon
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.source)).toEqual(['polygon', 'polygon']);

    // Exactly two attempts, and the WIDENED raw limit that reaches the
    // client on the second one: attempt 1 asks for lookback (2) +
    // FORMING_BAR_FETCH_MARGIN (1) = 3, nothing survives normalization (the
    // newest 3 raw candles are all post-close), so a widen is required
    //
    // The widened value was 24 until #828 — `widenRawLimit` had no survival
    // rate to estimate from (0 in-session out of 3 raw), so the estimate was
    // Infinity and `MAX_RAW_WIDEN_FACTOR` clamped the step to 3 * 8. The
    // fallback now takes its ONE permitted retry straight to
    // `rawLimitCeiling` (3 * MAX_RAW_LIMIT_MULTIPLE = 96) instead, because a
    // second Polygon request costs ~13 seconds and the rows it returns cost
    // nothing: asking the widest permitted question once beats converging on
    // it over four requests. The assertion's substance is unchanged — the raw
    // limit escalates across attempts, and this is the value that actually
    // reaches the client — only the widened number moved, by design
    expect(getBarsSpy.mock.calls.map((call) => call[3])).toEqual([3, 96]);
    // Every call target is the SAME (symbol, timeframe, asOf); only the
    // widened raw limit changes between attempts
    for (const call of getBarsSpy.mock.calls) {
      expect(call.slice(0, 3)).toEqual(['SPY', '1h', localAsOf]);
    }
  });

  it('takes a non-default pacing from deps.fallbackPacing WITHOUT mutating process.env (#822)', async () => {
    // Defect 1: `resolveFallbackPacing` used to be the only way in, forcing a
    // test (or a real caller) to mutate `SAMURAI_PACING_POLYGON_*` to
    // exercise a non-default rate. `fallbackPacing` is a config field now —
    // asserted here by supplying a value that differs from
    // `DEFAULT_POLYGON_PACING` on every field, with no env var touched at
    // all, and confirming the resolved config actually reaches the
    // `TokenBucket` the default Polygon fetcher is built with
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
    // Placed in this "(#823) default branch" describe block deliberately —
    // this test is about the NON-default branch, but it shares the block's
    // afterEach cleanup for SAMURAI_PACING_POLYGON_REFILL_PER_SEC
    //
    // Defect 2: resolving pacing unconditionally computed (and warned about)
    // a variable that a run with an injected fetcher never consults. This is
    // the symptom gone — the malformed var is set, but nothing about Polygon
    // pacing was ever read, so no warn fires
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
    // #825 must not be "solved" by making resolution lazy-on-first-failover —
    // the module doc requires it stay at construction time when the default
    // Polygon fetcher is the one in play. Asserted by reading the warn
    // immediately after `buildFailoverDataSource` returns, with no
    // `fetchBars` call in between: a lazy implementation would leave this log
    // empty at this point
    process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC = 'not-a-number';
    const logger = recordingLogger();

    buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      // No equitiesFallbackBarFetcher — the default Polygon branch is selected
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
    // `polygon ??= new PolygonBarsClient(...)` — constructed once, not once
    // per fetch. Asserted on the KEY-SET path so the assertion is genuinely
    // about caching: with the key removed after the first call, a client
    // re-constructed per fetch would throw on the second call; instead the
    // second call succeeds identically to the first, proving the SAME
    // already-constructed instance served it
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
    // Two acquireBackground() calls against the real DEFAULT_POLYGON_PACING
    // (capacity 1, ~13s refill) would wait on the real clock — irrelevant to
    // what this test asserts (client identity, not pacing), so bypass it
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

    // If the client were reconstructed per call, this would throw
    // "POLYGON_API_KEY is not set" instead of succeeding
    delete process.env.POLYGON_API_KEY;
    const second = await source.fetchBars('SPY', localWindow, localAsOf);
    expect(second).toHaveLength(2);
  });

  it('caps a failed-over read at TWO Polygon requests, counted at the client (#828)', async () => {
    // The composition-root proof for #828's request budget. Everything
    // between `buildFailoverDataSource` and the vendor is real here — the
    // default branch's lazily-built `PolygonBarsClient`, the
    // `withSessionNormalization` wrapper, `NormalizingDataSource`'s widen —
    // and the count is taken where the HTTP requests actually are:
    // `getBars` issues exactly one request per call, with no pagination, so
    // calls ARE requests
    //
    // The input is the worst case on purpose: a payload with no in-session
    // candle at all, so the widen is exhausted rather than satisfied early
    // Before #828 this cost four requests — ~39s of blocking on a bucket
    // that mints one token per 13 seconds, per instrument, every tick for as
    // long as the primary stall lasts
    process.env.POLYGON_API_KEY = 'test-key';

    const localAsOf = new Date('2026-08-18T01:00:00.000Z');
    // 120 candles, every one of them at 03:00Z — never a US regular-hours
    // open, so none survives `UsEquityRegularHoursCalendar` at any widen. The
    // COUNT matters as much as the timestamps: it has to exceed the widest
    // ask (the raw ceiling, 3 * 32 = 96) or the vendor would look like it had
    // run out of history, and `NormalizingDataSource` would take its
    // raw-scarcity early return instead of spending the widen this test is
    // counting
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
    // Real pacing would make the second request wait ~13s on the real clock
    // The BUDGET is what this test is about, not the wait
    vi.spyOn(TokenBucket.prototype, 'acquireBackground').mockResolvedValue(undefined);

    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      calendar: new UsEquityRegularHoursCalendar(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      // No equitiesFallbackBarFetcher — the real default Polygon branch
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger: recordingLogger(),
      now: () => localAsOf,
    });

    // Loud, not silent: the exhausted widen throws InSessionUnderfetchError,
    // which withOhlcvFailover reports as both vendors having failed
    await expect(
      source.fetchBars('SPY', { timeframe: '1h', lookback: 2 }, localAsOf),
    ).rejects.toThrow(/both alpaca .* and polygon .* failed/);

    expect(getBarsSpy).toHaveBeenCalledTimes(2);
  });

  it('WARNS AND DEFAULTS on a fallbackPacing that would park every fallback read forever (#828)', async () => {
    // `resolvePolygonPacing`'s `readPositive` guards the ENV path; this is
    // the CONFIG path (#822), which handed a plain `TokenBucketConfig`
    // straight to `new TokenBucket(...)`. A zero refill rate mints no token,
    // and `TokenBucket.take` has no deadline — so every equities fallback
    // read would have parked forever, with no timeout above it, inside a
    // fourteen-day unattended soak. A silent halt, not a stall.
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

    // Warned AT BOOT, before any stall — the same posture the malformed-env
    // override takes, and for the same reason: this paces a degradation
    // mitigation, so refusing to boot over it would be strictly worse
    const warned = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toContain('parked forever');

    const bars = await source.fetchBars('SPY', { timeframe: '1h', lookback: 2 }, localAsOf);

    expect(bars).toHaveLength(2);
    // The unusable config never reached the bucket; the checked-in default did
    expect(capturedBucket?.config).toEqual(DEFAULT_POLYGON_PACING);
  });

  it('rejects a capacity below one as well, not only a non-positive refill (#828)', () => {
    // The other field that wedges: `refill()` clamps `tokens` to `capacity`,
    // so `capacity: 0` never reaches the single token `take` needs no matter
    // how fast the refill rate is. Same indefinite park, different field.
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
    // The third wedge, and the least obvious: `PolygonBarsClient.getBars`
    // takes the BACKGROUND lane, which asks `take(reserveForPriority)` for
    // `1 + reserve` tokens. `refill()` clamps the balance to `capacity`, so
    // `reserve + 1 > capacity` never admits the background caller at ANY
    // refill rate — the rate here is the checked-in default's, and it still
    // parks forever. `reserveForPriority` is part of `TokenBucketConfig`, so
    // #822's `fallbackPacing` seam can set it
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
    // The guard must not warn about, or replace, a legitimate override —
    // otherwise it would quietly undo #822's config seam
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
    // The module claims the suppressed count is carried on the next alert
    // that does go out "so the operator still sees the true rate". Without
    // this, every failover between the last bounded-repeat alert and the
    // incident gap is silently unreported: 12 failovers then an hour quiet
    // alerts at #1 and #9, and #10-#12 vanish
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
