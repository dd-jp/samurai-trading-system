import type { AlpacaCalendarClient } from '../../../providers/market-data-service/index.js';
import {
  AlpacaEquitySessionCalendar,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { Logger } from '../types.js';
import type {
  CalendarFallbackAlert,
  CalendarFallbackAlertChannel,
} from './calendar-fallback-alert.js';
import { resolveUsEquitySessionCalendar } from './us-equity-session-source.js';

function recordingLogger(): Logger & { entries: Parameters<Logger['log']>[0][] } {
  const entries: Parameters<Logger['log']>[0][] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

function recordingAlertChannel(): CalendarFallbackAlertChannel & {
  alerts: CalendarFallbackAlert[];
} {
  const alerts: CalendarFallbackAlert[] = [];
  return { alerts, postCalendarFallbackAlert: (alert) => alerts.push(alert) };
}

const NOW = new Date('2026-08-18T12:00:00Z');

describe('resolveUsEquitySessionCalendar', () => {
  it('returns an Alpaca-sourced calendar on a successful fetch — no real network call', async () => {
    const client: AlpacaCalendarClient = {
      fetchCalendar: vi.fn(async () => [
        { date: '2026-08-18', open: '09:30', close: '16:00' },
        // An early close NOT present in the hand-entered US_EARLY_CLOSE_DAYS —
        // proving this comes from the fetched table, not the table #684
        // replaces
        { date: '2026-08-19', open: '09:30', close: '13:00' },
      ]),
    };
    const logger = recordingLogger();

    const calendar = await resolveUsEquitySessionCalendar({ logger, now: () => NOW, client });

    expect(calendar).toBeInstanceOf(AlpacaEquitySessionCalendar);
    // The flatten boundary computes against the venue's actual close on the
    // early-close day — 13:00 ET = 17:00 UTC in August (EDT)
    expect(calendar.isOpen(new Date('2026-08-19T16:59:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-08-19T17:00:00Z'))).toBe(false);
    expect(calendar.sessionEnd(new Date('2026-08-19T14:00:00Z'))?.toISOString()).toBe(
      '2026-08-19T17:00:00.000Z',
    );
  });

  it('requests a window that spans well before and after `now`', async () => {
    const fetchCalendar = vi.fn(async () => [
      { date: '2026-08-18', open: '09:30', close: '16:00' },
    ]);
    await resolveUsEquitySessionCalendar({
      logger: recordingLogger(),
      now: () => NOW,
      client: { fetchCalendar },
    });

    const [range] = fetchCalendar.mock.calls[0] as unknown as [{ start: string; end: string }];
    expect(range.start < '2026-08-18').toBe(true);
    expect(range.end > '2027-08-18').toBe(true);
  });

  it('falls back to the hand-entered calendar and posts a loud alert on a fetch failure', async () => {
    const client: AlpacaCalendarClient = {
      fetchCalendar: vi.fn(async () => {
        throw new Error('network error fetching Alpaca calendar: getaddrinfo ENOTFOUND');
      }),
    };
    const logger = recordingLogger();
    const alertChannel = recordingAlertChannel();

    const calendar = await resolveUsEquitySessionCalendar({
      logger,
      now: () => NOW,
      client,
      alertChannel,
    });

    expect(calendar).toBeInstanceOf(UsEquityRegularHoursCalendar);

    // The alert/refusal is ASSERTED, not merely logged: a distinct channel
    // call, not just a grep over log entries
    expect(alertChannel.alerts).toHaveLength(1);
    expect(alertChannel.alerts[0]?.reason).toMatch(/ENOTFOUND/);
    expect(alertChannel.alerts[0]?.reported_at).toEqual(NOW);

    const errorEntry = logger.entries.find((entry) => entry.level === 'error');
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.message).toMatch(/falling back to the hand-entered/);
  });

  it('falls back and alerts on a malformed response too, not just a network error', async () => {
    const client: AlpacaCalendarClient = {
      fetchCalendar: vi.fn(async () => [
        { date: '2026-08-18', open: 'not-a-time', close: '16:00' } as never,
      ]),
    };
    const alertChannel = recordingAlertChannel();

    const calendar = await resolveUsEquitySessionCalendar({
      logger: recordingLogger(),
      now: () => NOW,
      client,
      alertChannel,
    });

    expect(calendar).toBeInstanceOf(UsEquityRegularHoursCalendar);
    expect(alertChannel.alerts).toHaveLength(1);
  });

  it('falls back and alerts on an empty calendar rather than trusting a table that can flatten nothing', async () => {
    const client: AlpacaCalendarClient = { fetchCalendar: vi.fn(async () => []) };
    const alertChannel = recordingAlertChannel();

    const calendar = await resolveUsEquitySessionCalendar({
      logger: recordingLogger(),
      now: () => NOW,
      client,
      alertChannel,
    });

    expect(calendar).toBeInstanceOf(UsEquityRegularHoursCalendar);
    expect(alertChannel.alerts).toHaveLength(1);
  });

  it('never assumes a normal session on a fallback date beyond the hand table’s own coverage cliff', async () => {
    const client: AlpacaCalendarClient = {
      fetchCalendar: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const calendar = await resolveUsEquitySessionCalendar({
      logger: recordingLogger(),
      now: () => NOW,
      client,
      alertChannel: recordingAlertChannel(),
    });

    // The fallback hand table (#684) throws rather than guessing a normal
    // close for a date past its own checked coverage — the dangerous
    // direction is unreachable even on the degraded path
    expect(() => calendar.isOpen(new Date('2028-03-14T15:00:00Z'))).toThrow(
      /past the hand-entered table/,
    );
  });
});
