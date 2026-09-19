export interface TradingCalendar {
  isOpen(instant: Date): boolean;
  isTradingDay(instant: Date): boolean;
  sessionStart(instant: Date): Date;
  sessionEnd(instant: Date): Date | null;
}

export class AlwaysOpenCalendar implements TradingCalendar {
  isOpen(_instant: Date): boolean {
    return true;
  }

  isTradingDay(_instant: Date): boolean {
    return true;
  }

  sessionStart(instant: Date): Date {
    return new Date(
      Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
    );
  }

  sessionEnd(_instant: Date): Date | null {
    return null;
  }
}

export const ET_ZONE = 'America/New_York';
export const LONDON_ZONE = 'Europe/London';
const SESSION_OPEN_MINUTES = 9 * 60 + 30;
const SESSION_CLOSE_MINUTES = 16 * 60;

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

export function toZonedTime(instant: Date, zone: string): ZonedInstant {
  const parts = wallClockParts(zone).formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const hour = Number(lookup('hour')) % 24;

  return {
    weekday: lookup('weekday'),
    minutesSinceMidnight: hour * 60 + Number(lookup('minute')),
  };
}

const WEEKEND = new Set(['Sat', 'Sun']);

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
export const MAX_SESSION_SEARCH_DAYS = 10;
const MAX_OFFSET_PASSES = 3;

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

function wallClockAsUtc(instant: Date, zone: string): number {
  const { year, month, day, hour, minute, second } = zonedCivilFields(instant, zone);

  return Date.UTC(year, month - 1, day, hour, minute, second);
}

export function toCivilDate(instant: Date, zone: string): ZonedCivilDate {
  const { year, month, day } = zonedCivilFields(instant, zone);

  return { year, month, day };
}

export function previousCivilDay({ year, month, day }: ZonedCivilDate): ZonedCivilDate {
  const previous = new Date(Date.UTC(year, month - 1, day) - MS_PER_DAY);

  return {
    year: previous.getUTCFullYear(),
    month: previous.getUTCMonth() + 1,
    day: previous.getUTCDate(),
  };
}

export function nextCivilDay({ year, month, day }: ZonedCivilDate): ZonedCivilDate {
  const next = new Date(Date.UTC(year, month - 1, day) + MS_PER_DAY);

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

export function civilDateKey({ year, month, day }: ZonedCivilDate): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

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

const US_HOLIDAYS = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24',
]);

const US_EARLY_CLOSE_MINUTES = 13 * 60;
const US_EARLY_CLOSE_DAYS = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

export const US_TABLE_COVERAGE_END = '2027-12-31';

function searchSessionEnd(
  civilDate: ZonedCivilDate,
  zone: string,
  closeMinutesFor: (civilDate: ZonedCivilDate) => number,
  isTradingDay: (instant: Date) => boolean,
  instant: Date,
  marketName: string,
): Date {
  let current = civilDate;
  for (let day = 0; day <= MAX_SESSION_SEARCH_DAYS; day++) {
    const close = wallClockToInstant(current, closeMinutesFor(current), zone);
    if (close.getTime() > instant.getTime() && isTradingDay(close)) return close;
    current = nextCivilDay(current);
  }
  throw new Error(
    `No ${marketName} session close found within ${MAX_SESSION_SEARCH_DAYS} days after ${instant.toISOString()}`,
  );
}

function searchSessionStart(
  civilDate: ZonedCivilDate,
  zone: string,
  closeMinutesFor: (civilDate: ZonedCivilDate) => number,
  isTradingDay: (instant: Date) => boolean,
  instant: Date,
  marketName: string,
): Date {
  let current = civilDate;
  for (let day = 0; day <= MAX_SESSION_SEARCH_DAYS; day++) {
    const close = wallClockToInstant(current, closeMinutesFor(current), zone);
    if (close.getTime() <= instant.getTime() && isTradingDay(close)) return close;
    current = previousCivilDay(current);
  }
  throw new Error(
    `No ${marketName} session close found within ${MAX_SESSION_SEARCH_DAYS} days before ${instant.toISOString()}`,
  );
}

export class UsEquityRegularHoursCalendar implements TradingCalendar {
  isOpen(instant: Date): boolean {
    if (!this.isTradingDay(instant)) {
      return false;
    }

    const { minutesSinceMidnight } = toZonedTime(instant, ET_ZONE);

    return (
      minutesSinceMidnight >= SESSION_OPEN_MINUTES &&
      minutesSinceMidnight < this.#closeMinutesFor(toCivilDate(instant, ET_ZONE))
    );
  }

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

  sessionEnd(instant: Date): Date | null {
    return searchSessionEnd(
      toCivilDate(instant, ET_ZONE),
      ET_ZONE,
      (civilDate) => this.#closeMinutesFor(civilDate),
      (i) => this.isTradingDay(i),
      instant,
      'US equity',
    );
  }

  sessionStart(instant: Date): Date {
    return searchSessionStart(
      toCivilDate(instant, ET_ZONE),
      ET_ZONE,
      (civilDate) => this.#closeMinutesFor(civilDate),
      (i) => this.isTradingDay(i),
      instant,
      'US equity',
    );
  }
}

const LSE_OPEN_MINUTES = 8 * 60;
const LSE_CLOSE_MINUTES = 16 * 60 + 30;
const LSE_HALF_DAY_CLOSE_MINUTES = 12 * 60 + 30;

export const LSE_HOLIDAYS = new Set([
  '2026-01-01',
  '2026-04-03',
  '2026-04-06',
  '2026-05-04',
  '2026-05-25',
  '2026-08-31',
  '2026-12-25',
  '2026-12-28',
  '2027-01-01',
  '2027-03-26',
  '2027-03-29',
  '2027-05-03',
  '2027-05-31',
  '2027-08-30',
  '2027-12-27',
  '2027-12-28',
  '2028-01-03',
  '2028-04-14',
  '2028-04-17',
  '2028-05-01',
  '2028-05-29',
  '2028-08-28',
  '2028-12-25',
  '2028-12-26',
]);

export const LSE_HOLIDAYS_CHECKED_THROUGH = '2028-12-31';

export const LSE_HALF_DAYS = new Set(['2026-12-24', '2026-12-31', '2027-12-24', '2027-12-31']);

export const LSE_HALF_DAYS_CHECKED_THROUGH = '2028-12-31';

export function earlierOf(a: string, b: string): string {
  return a < b ? a : b;
}

export const LSE_TABLE_COVERAGE_END = earlierOf(
  LSE_HOLIDAYS_CHECKED_THROUGH,
  LSE_HALF_DAYS_CHECKED_THROUGH,
);

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

  sessionStart(instant: Date): Date {
    return searchSessionStart(
      toCivilDate(instant, LONDON_ZONE),
      LONDON_ZONE,
      (civilDate) => this.#closeMinutesFor(civilDate),
      (i) => this.isTradingDay(i),
      instant,
      'LSE',
    );
  }

  sessionEnd(instant: Date): Date | null {
    return searchSessionEnd(
      toCivilDate(instant, LONDON_ZONE),
      LONDON_ZONE,
      (civilDate) => this.#closeMinutesFor(civilDate),
      (i) => this.isTradingDay(i),
      instant,
      'LSE',
    );
  }

  #closeMinutesFor(civilDate: ZonedCivilDate): number {
    return LSE_HALF_DAYS.has(civilDateKey(civilDate))
      ? LSE_HALF_DAY_CLOSE_MINUTES
      : LSE_CLOSE_MINUTES;
  }

  coversCloseFor(instant: Date): boolean {
    return civilDateKey(toCivilDate(instant, LONDON_ZONE)) <= LSE_TABLE_COVERAGE_END;
  }
}

const MINUTES_PER_DAY = 24 * 60;

const OVERLAP_WINDOW_OPEN_MINUTES = 14 * 60 + 30;
const OVERLAP_WINDOW_LAST_ENTRY_MINUTES = 15 * 60 + 45;

export function londonEntryWindow(
  startMinutes: number = OVERLAP_WINDOW_OPEN_MINUTES,
  endMinutes: number = OVERLAP_WINDOW_LAST_ENTRY_MINUTES,
): (instant: Date) => boolean {
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
