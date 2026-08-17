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
import { describe, expect, it, vi } from 'vitest';

import type { Bar, BarWindow } from '../../../providers/market-data-service/index.js';
import { UsEquityRegularHoursCalendar } from '../../../providers/market-data-service/index.js';
import { DEFAULT_POLYGON_PACING, type LogEntry, type Logger } from '../../../shared/index.js';
import {
  ALERT_REPEAT_EVERY_FAILOVERS,
  buildFailoverDataSource,
  type DataFailoverAlert,
  DataFailoverAlertThrottle,
  FAILOVER_INCIDENT_GAP_MS,
  resolveFallbackPacing,
} from './data-failover.js';

/** Monday 12:00 ET — inside US regular hours, so a bar completed here survives session normalization. */
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
    // are refusals on purpose.
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
    // applies no calendar and serves ~16 `1h` bars a day over 08:00Z-23:00Z.
    // Asserted on an INJECTED fetcher on purpose — the wrap must not be
    // something only the default Polygon path gets.
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
    // that muting that chat also mutes the orphan verdict and the kill-line.
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
    // a counter shared across instruments would hide a second name going down.
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
    // Second SPY failover a minute later — same incident, suppressed.
    now = new Date(ASOF.getTime() + 60_000);
    await source.fetchBars('SPY', WINDOW, now);
    // And one well past the incident gap, measured from that second failover
    // rather than from the first — a new incident, loud again.
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
    // "the tick threw" — the same posture `checkMiCoverage` documents.
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
    // microtask queue drain before reading the log.
    await Promise.resolve();

    expect(bars).toHaveLength(1);
    const errors = logger.entries.filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('telegram 502');
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
    // alerts at #1 and #9, and #10-#12 vanish.
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
