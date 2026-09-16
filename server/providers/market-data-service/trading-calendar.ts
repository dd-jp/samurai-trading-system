/**
 * Trading calendar port (#66) — deliberately minimal, defining only the seam
 * stock ingestion needs so a real holiday/session table can implement it later.
 */

export interface TradingCalendar {
  /** Is `instant` inside a trading session? Half-open: the close instant itself is NOT open. */
  isOpen(instant: Date): boolean;
  /**
   * Does `instant` fall on a day that has a session at all? Daily bars are
   * admitted on this rather than `isOpen`, since a daily bar's open timestamp
   * sits at midnight — outside the intraday session.
   */
  isTradingDay(instant: Date): boolean;
  /**
   * The instant the *accounting* session containing `instant` began
   * (close-to-close), NOT the intraday `isOpen` window. Throws rather than
   * returning `null` on an exhausted search — every venue has a session start.
   */
  sessionStart(instant: Date): Date;
  /**
   * The next session CLOSE strictly after `instant`, or `null` for a venue
   * that never closes (#668). `null` means "no close, do nothing"; a throw
   * means the calendar couldn't find one and is broken — the two must not be
   * collapsed, and any new caller on the money path must catch the throw.
   */
  sessionEnd(instant: Date): Date | null;
}

/** Crypto: 24/7, no session boundaries (spec Module: Ingestion & Sources) */
export class AlwaysOpenCalendar implements TradingCalendar {
  isOpen(_instant: Date): boolean {
    return true;
  }

  isTradingDay(_instant: Date): boolean {
    return true;
  }

  /** 00:00 UTC of `instant`'s UTC day — crypto has no close to anchor to */
  sessionStart(instant: Date): Date {
    return new Date(
      Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
    );
  }

  /**
   * `null` — the venue never closes. Deliberately not `sessionStart`'s
   * midnight-UTC boundary: that's an accounting anchor, and reusing it here
   * would smuggle in a crypto flatten policy #667 hasn't decided.
   */
  sessionEnd(_instant: Date): Date | null {
    return null;
  }
}

/** Exported so other Eastern-time callers reuse this file's `Intl` fixpoint rather than re-deriving it */
export const ET_ZONE = 'America/New_York';
/** Exported so other London-time callers (boot guards, alert scheduling) reuse this file's `Intl` fixpoint */
export const LONDON_ZONE = 'Europe/London';
// 09:30 ET
const SESSION_OPEN_MINUTES = 9 * 60 + 30;
// 16:00 ET
const SESSION_CLOSE_MINUTES = 16 * 60;

/** Formatters cached per zone — `Intl.DateTimeFormat` construction is the expensive part, and zone count is bounded (two venues). */
const WALL_CLOCK_PARTS = new Map<string, Intl.DateTimeFormat>();
const CIVIL_PARTS = new Map<string, Intl.DateTimeFormat>();

function wallClockParts(zone: string): Intl.DateTimeFormat {
  let formatter = WALL_CLOCK_PARTS.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    WALL_CLOCK_PARTS.set(zone, formatter);
  }

  return formatter;
}

interface ZonedInstant {
  weekday: string;
  minutesSinceMidnight: number;
}

/** Resolves an instant into a zone's wall-clock, DST included, via Intl. */
export function toZonedTime(instant: Date, zone: string): ZonedInstant {
  const parts = wallClockParts(zone).formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  // Intl renders midnight as '24' in hour12:false; normalize it to 0
  const hour = Number(lookup('hour')) % 24;

  return {
    weekday: lookup('weekday'),
    minutesSinceMidnight: hour * 60 + Number(lookup('minute')),
  };
}

const WEEKEND = new Set(['Sat', 'Sun']);

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/**
 * How far the session walks search before giving up, in civil days —
 * comfortably clear of the LSE's 4-day Christmas/Easter stretches. Bounds
 * both the backward walk in `sessionStart` and the forward walk in `sessionEnd`.
 */
export const MAX_SESSION_SEARCH_DAYS = 10;
/** One pass computes the UTC offset, the second confirms it. 16:00 ET is never in a DST gap. */
const MAX_OFFSET_PASSES = 3;

/** Kept separate from the wall-clock formatter so `isOpen`/`isTradingDay` stay untouched; `hourCycle: 'h23'` renders midnight as 00, not '24'. */
function civilParts(zone: string): Intl.DateTimeFormat {
  let formatter = CIVIL_PARTS.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    CIVIL_PARTS.set(zone, formatter);
  }

  return formatter;
}

/** A calendar date in some venue's zone. `month` is 1-based, as rendered. */
export interface ZonedCivilDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedCivilFields extends ZonedCivilDate {
  hour: number;
  minute: number;
  second: number;
}

/**
 * Every civil field of `instant` in `zone`, as numbers. Throws rather than
 * defaulting a missing part — a silently-zeroed year would read downstream
 * as a plausible timestamp.
 */
function zonedCivilFields(instant: Date, zone: string): ZonedCivilFields {
  const rendered: Record<string, number> = {};
  for (const part of civilParts(zone).formatToParts(instant)) {
    if (part.type !== 'literal') {
      rendered[part.type] = Number(part.value);
    }
  }

  const field = (name: keyof ZonedCivilFields): number => {
    const value = rendered[name];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`Intl rendered no ${zone} '${name}' for ${instant.toISOString()}`);
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

/** `instant`'s zone wall-clock read back as if it were UTC — the DST-aware pivot */
function wallClockAsUtc(instant: Date, zone: string): number {
  const { year, month, day, hour, minute, second } = zonedCivilFields(instant, zone);

  return Date.UTC(year, month - 1, day, hour, minute, second);
}

export function toCivilDate(instant: Date, zone: string): ZonedCivilDate {
  const { year, month, day } = zonedCivilFields(instant, zone);

  return { year, month, day };
}

/** Civil-date arithmetic only — anchored in UTC, so DST never shortens the step */
export function previousCivilDay({ year, month, day }: ZonedCivilDate): ZonedCivilDate {
  const previous = new Date(Date.UTC(year, month - 1, day) - MS_PER_DAY);

  return {
    year: previous.getUTCFullYear(),
    month: previous.getUTCMonth() + 1,
    day: previous.getUTCDate(),
  };
}

/** The mirror of `previousCivilDay`, for the forward walk `sessionEnd` needs */
export function nextCivilDay({ year, month, day }: ZonedCivilDate): ZonedCivilDate {
  const next = new Date(Date.UTC(year, month - 1, day) + MS_PER_DAY);

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/** `2026-12-25` — the key both holiday tables below are written in */
export function civilDateKey({ year, month, day }: ZonedCivilDate): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The instant at which a given wall-clock time on `date` occurs in `zone`.
 * Resolves the offset from `Intl` by fixpoint rather than a hard-coded
 * -4h/-5h, which is wrong for half the year; converges because every session
 * close this file asks about sits well clear of a DST transition hour.
 */
export function wallClockToInstant(
  date: ZonedCivilDate,
  minutesSinceMidnight: number,
  zone: string,
): Date {
  const target =
    Date.UTC(date.year, date.month - 1, date.day) + minutesSinceMidnight * MS_PER_MINUTE;
  let instant = new Date(target);

  for (let pass = 0; pass < MAX_OFFSET_PASSES; pass++) {
    const drift = wallClockAsUtc(instant, zone) - target;
    if (drift === 0) {
      return instant;
    }
    instant = new Date(instant.getTime() - drift);
  }

  throw new Error(
    `Could not resolve ${minutesSinceMidnight} minutes past midnight in ${zone} on ${date.year}-${date.month}-${date.day}`,
  );
}

/**
 * NYSE full-closure holidays, hand-checked against the NYSE published
 * calendar (not derived — Good Friday is lunar). Coverage ends 2027-12-24;
 * past that this reports a normal trading day, the safe direction (flatten
 * fires on a shut day, closing nothing) — a wrongly-listed holiday is the
 * dangerous one, since it hides a real trading day and skips the flatten.
 */
const US_HOLIDAYS = new Set([
  // 2026
  // New Year's Day (Thursday)
  '2026-01-01',
  // Martin Luther King, Jr. Day
  '2026-01-19',
  // Washington's Birthday
  '2026-02-16',
  // Good Friday
  '2026-04-03',
  // Memorial Day
  '2026-05-25',
  // Juneteenth (Friday)
  '2026-06-19',
  // Independence Day observed — 4 July 2026 is a Saturday
  '2026-07-03',
  // Labor Day
  '2026-09-07',
  // Thanksgiving
  '2026-11-26',
  // Christmas Day (Friday)
  '2026-12-25',
  // 2027
  // New Year's Day (Friday)
  '2027-01-01',
  // Martin Luther King, Jr. Day
  '2027-01-18',
  // Washington's Birthday
  '2027-02-15',
  // Good Friday
  '2027-03-26',
  // Memorial Day
  '2027-05-31',
  // Juneteenth observed — 19 June 2027 is a Saturday
  '2027-06-18',
  // Independence Day observed — 4 July 2027 is a Sunday
  '2027-07-05',
  // Labor Day
  '2027-09-06',
  // Thanksgiving
  '2027-11-25',
  // Christmas Day observed — 25 December 2027 is a Saturday
  '2027-12-24',
]);

/**
 * Early closes: session ends at 13:00 ET rather than 16:00. More dangerous
 * than a full holiday — an unmodelled early close leaves a real trading day's
 * position unflattened past its actual close. Must stay disjoint from
 * `US_HOLIDAYS` (a date is either a shortened session or no session at all).
 */
// 13:00 ET
const US_EARLY_CLOSE_MINUTES = 13 * 60;
const US_EARLY_CLOSE_DAYS = new Set([
  // Friday after Thanksgiving (Thanksgiving is 26 Nov 2026)
  '2026-11-27',
  // Christmas Eve, a Thursday
  '2026-12-24',
  // Friday after Thanksgiving (Thanksgiving is 25 Nov 2027)
  '2027-11-26',
]);

/**
 * Last date `US_HOLIDAYS`/`US_EARLY_CLOSE_DAYS` were checked against the NYSE
 * calendar. Past this, `#closeMinutesFor` THROWS rather than guessing a normal
 * 16:00 close — unlike `isTradingDay`'s permissive posture, a wrong guess here
 * would silently hide a real early close.
 */
export const US_TABLE_COVERAGE_END = '2027-12-31';

/**
 * US equity regular trading hours: Mon-Fri, 09:30-16:00 ET, with NYSE holidays
 * and early closes from the tables above. Both tables are hand-entered and end
 * after 2027; `AlpacaEquitySessionCalendar` fetches the live table for the
 * paper leg instead, and this class is that leg's fallback.
 */
export class UsEquityRegularHoursCalendar implements TradingCalendar {
  isOpen(instant: Date): boolean {
    // Delegates rather than repeating the weekend check, so the holiday table reaches this predicate too
    if (!this.isTradingDay(instant)) {
      return false;
    }

    const { minutesSinceMidnight } = toZonedTime(instant, ET_ZONE);

    return (
      minutesSinceMidnight >= SESSION_OPEN_MINUTES &&
      minutesSinceMidnight < this.#closeMinutesFor(toCivilDate(instant, ET_ZONE))
    );
  }

  /**
   * Keyed on the CIVIL DATE rather than the instant, so the early-close lookup
   * cannot depend on the time of day being asked about — 24 December closes at
   * 13:00 whether the question is asked at 09:35 or at 15:59
   */
  #closeMinutesFor(civilDate: ZonedCivilDate): number {
    const key = civilDateKey(civilDate);
    if (key > US_TABLE_COVERAGE_END) {
      throw new Error(
        `UsEquityRegularHoursCalendar: ${key} is past the hand-entered table's checked ` +
          `coverage (through ${US_TABLE_COVERAGE_END}). Whether it is a normal close, an early ` +
          'close or a full holiday is unknown, and assuming a normal 16:00 ET close is the ' +
          'DANGEROUS direction (#684) — extend US_HOLIDAYS/US_EARLY_CLOSE_DAYS for this date, or ' +
          "source the live table from Alpaca's GET /v2/calendar instead of this hand-entered " +
          'one (alpaca-session-calendar.ts).',
      );
    }
    return US_EARLY_CLOSE_DAYS.has(key) ? US_EARLY_CLOSE_MINUTES : SESSION_CLOSE_MINUTES;
  }

  isTradingDay(instant: Date): boolean {
    const civilDate = toCivilDate(instant, ET_ZONE);
    if (US_HOLIDAYS.has(civilDateKey(civilDate))) {
      return false;
    }

    return !WEEKEND.has(toZonedTime(instant, ET_ZONE).weekday);
  }

  /**
   * The next regular or early close strictly after `instant` — not a constant
   * 16:00, since a half-day returns 13:00. Walks forward asking `isTradingDay`
   * so the holiday table moves this boundary with it rather than disagreeing.
   */
  sessionEnd(instant: Date): Date | null {
    let civilDate = toCivilDate(instant, ET_ZONE);

    for (let day = 0; day <= MAX_SESSION_SEARCH_DAYS; day++) {
      const close = wallClockToInstant(civilDate, this.#closeMinutesFor(civilDate), ET_ZONE);
      if (close.getTime() > instant.getTime() && this.isTradingDay(close)) {
        return close;
      }
      civilDate = nextCivilDay(civilDate);
    }

    throw new Error(
      `No US equity session close found within ${MAX_SESSION_SEARCH_DAYS} days after ${instant.toISOString()}`,
    );
  }

  /**
   * The most recent regular or early close at or before `instant` (half-open,
   * per the port doc). Walks back asking `isTradingDay`, not a private weekend
   * check, so the holiday table moves this boundary with it.
   */
  sessionStart(instant: Date): Date {
    let civilDate = toCivilDate(instant, ET_ZONE);

    for (let day = 0; day <= MAX_SESSION_SEARCH_DAYS; day++) {
      const close = wallClockToInstant(civilDate, this.#closeMinutesFor(civilDate), ET_ZONE);
      if (close.getTime() <= instant.getTime() && this.isTradingDay(close)) {
        return close;
      }
      civilDate = previousCivilDay(civilDate);
    }

    throw new Error(
      `No US equity session close found within ${MAX_SESSION_SEARCH_DAYS} days before ${instant.toISOString()}`,
    );
  }
}

// 08:00 London
const LSE_OPEN_MINUTES = 8 * 60;
// 16:30 London
const LSE_CLOSE_MINUTES = 16 * 60 + 30;
/** Christmas Eve and New Year's Eve close early; the auction ends 12:30 */
const LSE_HALF_DAY_CLOSE_MINUTES = 12 * 60 + 30;

/**
 * UK bank holidays are not derivable (Easter is lunar, dates move by
 * proclamation), so this is a hand-checked table sourced from
 * https://www.gov.uk/bank-holidays.json (`england-and-wales`). Checked
 * through `LSE_HOLIDAYS_CHECKED_THROUGH`; past that, reporting a normal
 * trading day is the safe direction (unlike `LSE_HALF_DAYS` below).
 */
export const LSE_HOLIDAYS = new Set([
  // 2026
  // New Year's Day
  '2026-01-01',
  // Good Friday
  '2026-04-03',
  // Easter Monday
  '2026-04-06',
  // Early May bank holiday
  '2026-05-04',
  // Spring bank holiday
  '2026-05-25',
  // Summer bank holiday
  '2026-08-31',
  // Christmas Day
  '2026-12-25',
  // Boxing Day (substitute — 26th is a Saturday)
  '2026-12-28',
  // 2027
  '2027-01-01',
  // Good Friday
  '2027-03-26',
  // Easter Monday
  '2027-03-29',
  '2027-05-03',
  '2027-05-31',
  '2027-08-30',
  // Christmas Day substitute (25th is a Saturday)
  '2027-12-27',
  // Boxing Day substitute
  '2027-12-28',
  // 2028
  // New Year's Day substitute (1 January 2028 is a Saturday)
  '2028-01-03',
  // Good Friday
  '2028-04-14',
  // Easter Monday
  '2028-04-17',
  // Early May bank holiday
  '2028-05-01',
  // Spring bank holiday
  '2028-05-29',
  // Summer bank holiday
  '2028-08-28',
  // Christmas Day
  '2028-12-25',
  // Boxing Day
  '2028-12-26',
]);

/**
 * Last date `LSE_HOLIDAYS` was checked against the source. `2028-12-31`, not
 * `2029-12-31`, because gov.uk's `bank-holidays.json` publishes nothing past
 * 2028-12-26 as of this check — move forward once the source publishes 2029.
 */
export const LSE_HOLIDAYS_CHECKED_THROUGH = '2028-12-31';

/**
 * Half-day closes: session ends at 12:30 rather than 16:30. Unlike
 * `LSE_HOLIDAYS`, an unmodelled half-day is the DANGEROUS direction — it
 * reads as an ordinary 16:30 close, so the flatten fires 4 hours late and the
 * position carries over the break. `assertLseCalendarCoverage` guards this at boot.
 */
export const LSE_HALF_DAYS = new Set([
  // Christmas Eve
  '2026-12-24',
  // New Year's Eve
  '2026-12-31',
  '2027-12-24',
  '2027-12-31',
  // 2028: no entries — 24 and 31 December 2028 both fall on a Sunday, so
  // neither qualifies (half-days apply only when the date is a weekday)
]);

/** Last date `LSE_HALF_DAYS` was checked for — see `LSE_HOLIDAYS_CHECKED_THROUGH` for why it's 2028-12-31, not 2029. */
export const LSE_HALF_DAYS_CHECKED_THROUGH = '2028-12-31';

/** The lexicographically earlier of two `YYYY-MM-DD` civil-date keys. */
export function earlierOf(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * The binding LSE coverage cliff: the EARLIER of the two checked-through
 * dates, so an under-covered table isn't masked by the other's reach. Unlike
 * `US_TABLE_COVERAGE_END`, nothing throws on this internally — it's enforced
 * once at boot by `assertLseCalendarCoverage`, before a live position exists.
 */
export const LSE_TABLE_COVERAGE_END = earlierOf(
  LSE_HOLIDAYS_CHECKED_THROUGH,
  LSE_HALF_DAYS_CHECKED_THROUGH,
);

/**
 * London Stock Exchange regular trading hours: Mon-Fri, 08:00-16:30 London,
 * with UK bank holidays and 12:30 half-day closes. This is the calendar the
 * LIVE equity leg (Saxo, GBP LSE-listed ETFs/ETCs) runs on.
 *
 * `#closeMinutesFor` stays TOTAL past `LSE_TABLE_COVERAGE_END` rather than
 * throwing like the US calendar does — this backs `isOpen`/`sessionStart`/
 * `sessionEnd` on the flatten path, so throwing here would block every future
 * tick from closing a position. Coverage is enforced once at boot instead,
 * by `assertLseCalendarCoverage`, before a live position exists to strand.
 */
export class LseRegularHoursCalendar implements TradingCalendar {
  isOpen(instant: Date): boolean {
    if (!this.isTradingDay(instant)) {
      return false;
    }

    const { minutesSinceMidnight } = toZonedTime(instant, LONDON_ZONE);

    return (
      minutesSinceMidnight >= LSE_OPEN_MINUTES &&
      minutesSinceMidnight < this.#closeMinutesFor(toCivilDate(instant, LONDON_ZONE))
    );
  }

  isTradingDay(instant: Date): boolean {
    const civilDate = toCivilDate(instant, LONDON_ZONE);
    if (LSE_HOLIDAYS.has(civilDateKey(civilDate))) {
      return false;
    }

    return !WEEKEND.has(toZonedTime(instant, LONDON_ZONE).weekday);
  }

  /** The most recent close at or before `instant` — the accounting boundary */
  sessionStart(instant: Date): Date {
    let civilDate = toCivilDate(instant, LONDON_ZONE);

    for (let day = 0; day <= MAX_SESSION_SEARCH_DAYS; day++) {
      const close = wallClockToInstant(civilDate, this.#closeMinutesFor(civilDate), LONDON_ZONE);
      if (close.getTime() <= instant.getTime() && this.isTradingDay(close)) {
        return close;
      }
      civilDate = previousCivilDay(civilDate);
    }

    throw new Error(
      `No LSE session close found within ${MAX_SESSION_SEARCH_DAYS} days before ${instant.toISOString()}`,
    );
  }

  /**
   * The next REGULAR OR EARLY close strictly after `instant` — what the flatten
   * offsets from.
   *
   * Named the same way as the US calendar's, and for the same reason (#691):
   * `#closeMinutesFor` returns 12:30 on an LSE half-day, so "the next close" on
   * its own reads as a constant 16:30 and the flatten offset must ride the
   * early close instead. #715 corrected the US docblock and left this one, and
   * the LSE leg is the one that trades live (ADR-0015).
   */
  sessionEnd(instant: Date): Date | null {
    let civilDate = toCivilDate(instant, LONDON_ZONE);

    for (let day = 0; day <= MAX_SESSION_SEARCH_DAYS; day++) {
      const close = wallClockToInstant(civilDate, this.#closeMinutesFor(civilDate), LONDON_ZONE);
      if (close.getTime() > instant.getTime() && this.isTradingDay(close)) {
        return close;
      }
      civilDate = nextCivilDay(civilDate);
    }

    throw new Error(
      `No LSE session close found within ${MAX_SESSION_SEARCH_DAYS} days after ${instant.toISOString()}`,
    );
  }

  /**
   * Keyed on the CIVIL DATE rather than on the instant, so the half-day lookup
   * cannot depend on the time of day being asked about — the close of
   * 24 December is 12:30 whether the question is asked at 09:00 or at 16:00
   */
  #closeMinutesFor(civilDate: ZonedCivilDate): number {
    return LSE_HALF_DAYS.has(civilDateKey(civilDate))
      ? LSE_HALF_DAY_CLOSE_MINUTES
      : LSE_CLOSE_MINUTES;
  }

  /**
   * Can this instant's close be TRUSTED against the hand-entered tables?
   * `false` past `LSE_TABLE_COVERAGE_END`, rather than a throw, since
   * `#closeMinutesFor` stays total — `assertLseCalendarCoverage` reads this at boot.
   */
  coversCloseFor(instant: Date): boolean {
    return civilDateKey(toCivilDate(instant, LONDON_ZONE)) <= LSE_TABLE_COVERAGE_END;
  }
}

/**
 * The exclusive upper bound on a minute-of-day. `1440` itself is accepted as an
 * END bound — "up to midnight" — but never produced by `toZonedTime`, which
 * returns `minutesSinceMidnight` in [0, 1440).
 */
const MINUTES_PER_DAY = 24 * 60;

/** 14:30 London — the US cash open, and the start of the overlap (#706) */
const OVERLAP_WINDOW_OPEN_MINUTES = 14 * 60 + 30;
/** 15:45 London — last entry, leaving 40 minutes to the 16:25 flatten (#706) */
const OVERLAP_WINDOW_LAST_ENTRY_MINUTES = 15 * 60 + 45;

/**
 * A London wall-clock predicate for `SchedulerConfig.stocksTradingWindow`.
 * Narrows a session; does not define one — the Scheduler consults this only
 * once the calendar says the venue is open. Defaults to the LSE/US overlap
 * window, 14:30-15:45 London (#706), since intraday measurements are on US tape.
 */
export function londonEntryWindow(
  startMinutes: number = OVERLAP_WINDOW_OPEN_MINUTES,
  endMinutes: number = OVERLAP_WINDOW_LAST_ENTRY_MINUTES,
): (instant: Date) => boolean {
  // Reject out-of-range minute values here: a clock-style `1545` (meant as
  // 15:45) would pass an ordering check but silently produce an always/never window
  for (const [name, value] of [
    ['startMinutes', startMinutes],
    ['endMinutes', endMinutes],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > MINUTES_PER_DAY) {
      throw new Error(
        `londonEntryWindow needs ${name} to be a whole minute-of-day in [0, ${MINUTES_PER_DAY}], got ${value}. ` +
          `Minutes since midnight London — 15:45 is ${15 * 60 + 45}, not 1545.`,
      );
    }
  }
  if (!(startMinutes < endMinutes)) {
    throw new Error(
      `londonEntryWindow needs startMinutes < endMinutes, got ${startMinutes} and ${endMinutes}`,
    );
  }

  return (instant: Date): boolean => {
    const { minutesSinceMidnight } = toZonedTime(instant, LONDON_ZONE);
    return minutesSinceMidnight >= startMinutes && minutesSinceMidnight < endMinutes;
  };
}
