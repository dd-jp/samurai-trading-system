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
  /**
   * The instant the session containing `instant` began — the boundary that
   * daily accounting (session PnL, kill-line metrics) resets on.
   *
   * This is the *accounting* session, a close-to-close window, NOT the
   * 09:30–16:00 intraday window `isOpen` describes: for stocks the boundary is
   * the previous 16:00 ET close, so an overnight gap falls inside the new
   * session rather than being stranded at the end of the old one. Crypto,
   * having no close, uses 00:00 UTC.
   *
   * Consistent with `isOpen`'s half-open convention: at exactly 16:00:00 ET the
   * old session is over, so `sessionStart` returns that same 16:00 instant —
   * the start of the new window, not the previous day's. The result is always
   * at or before `instant`, and `sessionStart(sessionStart(t))` is idempotent.
   *
   * LIMITATION — holidays are not modelled. `UsEquityRegularHoursCalendar` is
   * weekday-only by design (see the class doc and the LOW-severity
   * trading-calendar OPEN-GAP in docs/specs/cross-spec-contracts.md), so a
   * holiday Monday reports a session start for a session that never traded.
   * The real holiday/session table this port defers to fixes that here, which
   * is why the boundary lives on the calendar rather than being duplicated in
   * each consumer.
   */
  sessionStart(instant: Date): Date;
}

/** Crypto: 24/7, no session boundaries (spec Module: Ingestion & Sources). */
export class AlwaysOpenCalendar implements TradingCalendar {
  isOpen(_instant: Date): boolean {
    return true;
  }

  isTradingDay(_instant: Date): boolean {
    return true;
  }

  /** 00:00 UTC of `instant`'s UTC day — crypto has no close to anchor to. */
  sessionStart(instant: Date): Date {
    return new Date(
      Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
    );
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

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** Widest weekday-only gap is a weekend (2 days); the margin is for the holiday table to come. */
const MAX_SESSION_LOOKBACK_DAYS = 10;
/** One pass computes the UTC offset, the second confirms it. 16:00 ET is never in a DST gap. */
const MAX_OFFSET_PASSES = 3;

/**
 * Full Eastern civil fields. Kept separate from `ET_PARTS` so the `isOpen` /
 * `isTradingDay` path is untouched; `hourCycle: 'h23'` renders midnight as 00
 * rather than the '24' that `hour12: false` produces.
 */
const ET_CIVIL_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** An Eastern calendar date. `month` is 1-based, as rendered. */
interface EtCivilDate {
  year: number;
  month: number;
  day: number;
}

interface EtCivilFields extends EtCivilDate {
  hour: number;
  minute: number;
  second: number;
}

/**
 * Every Eastern civil field of `instant`, as numbers.
 *
 * Throws rather than defaulting a missing part: a silently-zeroed year would
 * put the session boundary in year 0 and be read as a plausible timestamp
 * downstream.
 */
function etCivilFields(instant: Date): EtCivilFields {
  const rendered: Record<string, number> = {};
  for (const part of ET_CIVIL_PARTS.formatToParts(instant)) {
    if (part.type !== 'literal') {
      rendered[part.type] = Number(part.value);
    }
  }

  const field = (name: keyof EtCivilFields): number => {
    const value = rendered[name];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`Intl rendered no Eastern '${name}' for ${instant.toISOString()}`);
    }

    return value;
  };

  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
}

/** `instant`'s Eastern wall-clock read back as if it were UTC — the DST-aware pivot. */
function easternWallClockAsUtc(instant: Date): number {
  const { year, month, day, hour, minute, second } = etCivilFields(instant);

  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function toEasternCivilDate(instant: Date): EtCivilDate {
  const { year, month, day } = etCivilFields(instant);

  return { year, month, day };
}

/** Civil-date arithmetic only — anchored in UTC, so DST never shortens the step. */
function previousCivilDay({ year, month, day }: EtCivilDate): EtCivilDate {
  const previous = new Date(Date.UTC(year, month - 1, day) - MS_PER_DAY);

  return {
    year: previous.getUTCFullYear(),
    month: previous.getUTCMonth() + 1,
    day: previous.getUTCDate(),
  };
}

/**
 * The instant at which a given Eastern wall-clock time on `date` occurs.
 *
 * The offset is resolved from `Intl` by fixpoint rather than hard-coded: a
 * literal -4h/-5h is right for half the year and silently wrong for the other
 * half. The loop converges because 16:00 ET exists exactly once on every day.
 */
function easternWallClockToInstant(date: EtCivilDate, minutesSinceMidnight: number): Date {
  const target =
    Date.UTC(date.year, date.month - 1, date.day) + minutesSinceMidnight * MS_PER_MINUTE;
  let instant = new Date(target);

  for (let pass = 0; pass < MAX_OFFSET_PASSES; pass++) {
    const drift = easternWallClockAsUtc(instant) - target;
    if (drift === 0) {
      return instant;
    }
    instant = new Date(instant.getTime() - drift);
  }

  throw new Error(
    `Could not resolve ${minutesSinceMidnight} minutes past midnight ET on ${date.year}-${date.month}-${date.day}`,
  );
}

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

  /**
   * The most recent 16:00 ET close at or before `instant` (see the port doc for
   * the half-open convention and the holiday limitation).
   *
   * Walks back a civil day at a time, asking `isTradingDay` — not a private
   * weekend check — whether each candidate close happened, so the holiday table
   * that eventually backs `isTradingDay` moves this boundary with it instead of
   * leaving the two to disagree.
   */
  sessionStart(instant: Date): Date {
    let civilDate = toEasternCivilDate(instant);

    for (let day = 0; day <= MAX_SESSION_LOOKBACK_DAYS; day++) {
      const close = easternWallClockToInstant(civilDate, SESSION_CLOSE_MINUTES);
      if (close.getTime() <= instant.getTime() && this.isTradingDay(close)) {
        return close;
      }
      civilDate = previousCivilDay(civilDate);
    }

    throw new Error(
      `No US equity session close found within ${MAX_SESSION_LOOKBACK_DAYS} days before ${instant.toISOString()}`,
    );
  }
}
