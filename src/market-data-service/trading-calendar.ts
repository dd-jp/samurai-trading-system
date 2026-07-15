/**
 * Trading calendar port (ticket #66).
 *
 * Deliberately minimal. The trading-calendar/session source is an Orchestrator-
 * owned dependency, explicitly NOT designed here: "Trading-calendar source is a
 * small injected dependency (holiday/session table), not designed in depth here"
 * (docs/specs/orchestrator-spec.md, Module: Scheduler; tracked as the LOW-severity
 * trading-calendar OPEN-GAP in docs/specs/cross-spec-contracts.md). This file
 * defines only the seam stock ingestion needs to satisfy #66's "never produces
 * bars outside trading hours"; the real holiday/session table implements this
 * same port later without touching the sources.
 */

export interface TradingCalendar {
  /**
   * Is `instant` inside a trading session? Half-open: the session close
   * instant itself is NOT open, so a bar opening exactly at the close is
   * out-of-session.
   */
  isOpen(instant: Date): boolean;
  /**
   * Does `instant` fall on a day that has a session at all? Whole-session
   * (daily) bars are admitted on this rather than `isOpen`, since a daily
   * bar's open timestamp sits at midnight — outside the intraday session.
   */
  isTradingDay(instant: Date): boolean;
}

/** Crypto: 24/7, no session boundaries (spec Module: Ingestion & Sources). */
export class AlwaysOpenCalendar implements TradingCalendar {
  isOpen(): boolean {
    return true;
  }

  isTradingDay(): boolean {
    return true;
  }
}

const ET_ZONE = 'America/New_York';
const SESSION_OPEN_MINUTES = 9 * 60 + 30; // 09:30 ET
const SESSION_CLOSE_MINUTES = 16 * 60; // 16:00 ET

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

interface EtInstant {
  weekday: string;
  minutesSinceMidnight: number;
}

/** Resolves an instant into Eastern wall-clock, DST included, via Intl. */
function toEasternTime(instant: Date): EtInstant {
  const parts = ET_PARTS.formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  // Intl renders midnight as '24' in hour12:false; normalize it to 0.
  const hour = Number(lookup('hour')) % 24;

  return {
    weekday: lookup('weekday'),
    minutesSinceMidnight: hour * 60 + Number(lookup('minute')),
  };
}

const WEEKEND = new Set(['Sat', 'Sun']);

/**
 * US equity regular trading hours: Mon-Fri, 09:30-16:00 ET.
 *
 * Holidays are NOT modelled — that needs the holiday/session table this port
 * exists to defer to (see file header). This implementation is therefore
 * permissive on holidays and must not be treated as the authoritative
 * calendar; it is the regular-session default that keeps stock ingestion
 * inside session boundaries until the real source is injected.
 */
export class UsEquityRegularHoursCalendar implements TradingCalendar {
  isOpen(instant: Date): boolean {
    const { weekday, minutesSinceMidnight } = toEasternTime(instant);
    if (WEEKEND.has(weekday)) {
      return false;
    }

    return (
      minutesSinceMidnight >= SESSION_OPEN_MINUTES && minutesSinceMidnight < SESSION_CLOSE_MINUTES
    );
  }

  isTradingDay(instant: Date): boolean {
    return !WEEKEND.has(toEasternTime(instant).weekday);
  }
}
