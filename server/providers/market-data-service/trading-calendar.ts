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
  /**
   * The next session CLOSE strictly after `instant`, or `null` for a venue
   * that never closes.
   *
   * Added for #668, whose subject is ADR-0014's "intraday, flat by market
   * close, no overnight carry": the Trader flattens at `close − N` resolved
   * through this method, so the rule is an OFFSET rather than a wall-clock
   * constant and holds for a 16:00 ET paper venue and a 16:30 London live
   * venue alike, half-days included.
   *
   * **`null` is a real answer, not a missing one.** Crypto has no close, and
   * what flat-by-close should mean for the crypto leg is an open thesis
   * amendment (#667) that is David's to make — so the type refuses to let an
   * implementation quietly invent one. Callers must handle `null` by doing
   * nothing rather than by substituting a boundary; `AlwaysOpenCalendar`
   * returns it, and the flatten path skips instruments whose calendar does.
   *
   * Strictly after, not at-or-after, so that calling it AT a close returns the
   * NEXT session's close rather than the one just passed. That keeps it a
   * usable "when must I be flat by" question at every instant, and makes it the
   * mirror of `sessionStart`'s at-or-before convention rather than an
   * inconsistent twin.
   */
  sessionEnd(instant: Date): Date | null;
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

  /**
   * `null` — the venue never closes.
   *
   * Deliberately NOT the 00:00 UTC boundary `sessionStart` uses. That boundary
   * is an ACCOUNTING anchor, chosen so the daily return series the Feedback
   * Loop and kill-lines consume has a defined day. Reusing it here would turn
   * an accounting convention into a TRADING instruction — a midnight-UTC
   * flatten of the crypto book — which is one of the four options #667 is
   * open on and is David's call, not this class's.
   *
   * Returning null means the flatten path skips crypto entirely until #667
   * decides. That is the honest default: the risk flat-by-close exists to
   * prevent is an unfillable stop in a closed market, and crypto's venue is
   * open with its bracket leg live.
   */
  sessionEnd(_instant: Date): Date | null {
    return null;
  }
}

const ET_ZONE = 'America/New_York';
/** #668 — the live equity leg is LSE-listed GBP ETFs/ETCs (#659, ADR-0015). */
const LONDON_ZONE = 'Europe/London';
const SESSION_OPEN_MINUTES = 9 * 60 + 30; // 09:30 ET
const SESSION_CLOSE_MINUTES = 16 * 60; // 16:00 ET

/**
 * Formatters are built once per zone and cached.
 *
 * `Intl.DateTimeFormat` construction is the expensive part, and the session
 * boundary is now asked for on every tick of every instrument rather than
 * only during ingestion. Zone count is bounded by the venues in the
 * repo — two — so this never grows.
 */
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
function toZonedTime(instant: Date, zone: string): ZonedInstant {
  const parts = wallClockParts(zone).formatToParts(instant);
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
function etCivilFields(instant: Date, zone: string): EtCivilFields {
  const rendered: Record<string, number> = {};
  for (const part of civilParts(zone).formatToParts(instant)) {
    if (part.type !== 'literal') {
      rendered[part.type] = Number(part.value);
    }
  }

  const field = (name: keyof EtCivilFields): number => {
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

/** `instant`'s zone wall-clock read back as if it were UTC — the DST-aware pivot. */
function easternWallClockAsUtc(instant: Date, zone: string): number {
  const { year, month, day, hour, minute, second } = etCivilFields(instant, zone);

  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function toEasternCivilDate(instant: Date, zone: string): EtCivilDate {
  const { year, month, day } = etCivilFields(instant, zone);

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

/** The mirror of `previousCivilDay`, for the forward walk `sessionEnd` needs. */
function nextCivilDay({ year, month, day }: EtCivilDate): EtCivilDate {
  const next = new Date(Date.UTC(year, month - 1, day) + MS_PER_DAY);

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/** `2026-12-25` — the key both holiday tables below are written in. */
function civilDateKey({ year, month, day }: EtCivilDate): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The instant at which a given Eastern wall-clock time on `date` occurs.
 *
 * The offset is resolved from `Intl` by fixpoint rather than hard-coded: a
 * literal -4h/-5h is right for half the year and silently wrong for the other
 * half. The loop converges because 16:00 ET exists exactly once on every day.
 */
function easternWallClockToInstant(
  date: EtCivilDate,
  minutesSinceMidnight: number,
  zone: string,
): Date {
  const target =
    Date.UTC(date.year, date.month - 1, date.day) + minutesSinceMidnight * MS_PER_MINUTE;
  let instant = new Date(target);

  for (let pass = 0; pass < MAX_OFFSET_PASSES; pass++) {
    const drift = easternWallClockAsUtc(instant, zone) - target;
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
    const { weekday, minutesSinceMidnight } = toZonedTime(instant, ET_ZONE);
    if (WEEKEND.has(weekday)) {
      return false;
    }

    return (
      minutesSinceMidnight >= SESSION_OPEN_MINUTES && minutesSinceMidnight < SESSION_CLOSE_MINUTES
    );
  }

  isTradingDay(instant: Date): boolean {
    return !WEEKEND.has(toZonedTime(instant, ET_ZONE).weekday);
  }

  /**
   * The next 16:00 ET close strictly after `instant` (#668).
   *
   * Walks FORWARD a civil day at a time, asking `isTradingDay` for the same
   * reason `sessionStart` walks backward asking it: the holiday table that
   * eventually backs that predicate must move this boundary with it rather
   * than leaving the two to disagree.
   */
  sessionEnd(instant: Date): Date | null {
    let civilDate = toEasternCivilDate(instant, ET_ZONE);

    for (let day = 0; day <= MAX_SESSION_LOOKBACK_DAYS; day++) {
      const close = easternWallClockToInstant(civilDate, SESSION_CLOSE_MINUTES, ET_ZONE);
      if (close.getTime() > instant.getTime() && this.isTradingDay(close)) {
        return close;
      }
      civilDate = nextCivilDay(civilDate);
    }

    throw new Error(
      `No US equity session close found within ${MAX_SESSION_LOOKBACK_DAYS} days after ${instant.toISOString()}`,
    );
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
    let civilDate = toEasternCivilDate(instant, ET_ZONE);

    for (let day = 0; day <= MAX_SESSION_LOOKBACK_DAYS; day++) {
      const close = easternWallClockToInstant(civilDate, SESSION_CLOSE_MINUTES, ET_ZONE);
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

const LSE_OPEN_MINUTES = 8 * 60; // 08:00 London
const LSE_CLOSE_MINUTES = 16 * 60 + 30; // 16:30 London
/** Christmas Eve and New Year's Eve close early; the auction ends 12:30. */
const LSE_HALF_DAY_CLOSE_MINUTES = 12 * 60 + 30;

/**
 * London Stock Exchange non-trading days.
 *
 * A TABLE, not a rule, because UK bank holidays are not derivable: the early
 * and late May holidays move, Easter is lunar, and one-off royal holidays are
 * announced by proclamation. Written out so a wrong date is a visible diff
 * rather than an arithmetic bug, and so a soak's logs can be reconciled
 * against it by eye.
 *
 * COVERAGE ENDS 2027-12-28. Beyond that this calendar reports a normal
 * trading day, which is the SAFE direction of error for its purpose: it means
 * the flatten window still computes and fires on a day the market happens to
 * be shut, where the position it would close does not exist. The dangerous
 * error is the opposite — treating a real trading day as a holiday, skipping
 * the flatten, and carrying a position overnight. Extend the table before
 * 2028; `isTradingDay` is the single place that reads it.
 */
const LSE_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-04-03', // Good Friday
  '2026-04-06', // Easter Monday
  '2026-05-04', // Early May bank holiday
  '2026-05-25', // Spring bank holiday
  '2026-08-31', // Summer bank holiday
  '2026-12-25', // Christmas Day
  '2026-12-28', // Boxing Day (substitute — 26th is a Saturday)
  // 2027
  '2027-01-01',
  '2027-03-26', // Good Friday
  '2027-03-29', // Easter Monday
  '2027-05-03',
  '2027-05-31',
  '2027-08-30',
  '2027-12-27', // Christmas Day substitute (25th is a Saturday)
  '2027-12-28', // Boxing Day substitute
]);

/**
 * Half-day closes: the session ends at 12:30 rather than 16:30.
 *
 * These matter more than ordinary holidays for #668's purpose. A holiday is a
 * day with no session and nothing to flatten; a half-day is a REAL trading day
 * whose close moves four hours earlier, so a calendar that did not model them
 * would compute a 16:25 flatten for a market that shut at 12:30 — and the
 * position would sit unflattened through the break, which is precisely the
 * overnight carry ADR-0014 forbids.
 */
const LSE_HALF_DAYS = new Set([
  '2026-12-24', // Christmas Eve
  '2026-12-31', // New Year's Eve
  '2027-12-24',
  '2027-12-31',
]);

/**
 * London Stock Exchange regular trading hours: Mon-Fri, 08:00-16:30 London,
 * with UK bank holidays and 12:30 half-day closes (#668).
 *
 * This is the calendar the LIVE equity leg runs on. #659 put that leg on the
 * Trading 212 ISA restricted to GBP LSE-listed ETFs/ETCs, so the US 16:00 ET
 * boundary the repo previously had is the PAPER venue's, not the live one's —
 * and #656 measured that the two sessions overlap by only two hours, which is
 * why the flatten rule had to be an offset resolved through the instrument's
 * own calendar rather than a shared wall-clock constant.
 *
 * Unlike `UsEquityRegularHoursCalendar`, holidays ARE modelled here. That
 * class's permissive posture is acceptable for keeping ingestion inside
 * session boundaries; it is not acceptable for deciding when the book must be
 * flat, which is a money-path question.
 */
export class LseRegularHoursCalendar implements TradingCalendar {
  isOpen(instant: Date): boolean {
    if (!this.isTradingDay(instant)) {
      return false;
    }

    const { minutesSinceMidnight } = toZonedTime(instant, LONDON_ZONE);

    return (
      minutesSinceMidnight >= LSE_OPEN_MINUTES &&
      minutesSinceMidnight < this.#closeMinutesFor(toEasternCivilDate(instant, LONDON_ZONE))
    );
  }

  isTradingDay(instant: Date): boolean {
    const civilDate = toEasternCivilDate(instant, LONDON_ZONE);
    if (LSE_HOLIDAYS.has(civilDateKey(civilDate))) {
      return false;
    }

    return !WEEKEND.has(toZonedTime(instant, LONDON_ZONE).weekday);
  }

  /** The most recent close at or before `instant` — the accounting boundary. */
  sessionStart(instant: Date): Date {
    let civilDate = toEasternCivilDate(instant, LONDON_ZONE);

    for (let day = 0; day <= MAX_SESSION_LOOKBACK_DAYS; day++) {
      const close = easternWallClockToInstant(
        civilDate,
        this.#closeMinutesFor(civilDate),
        LONDON_ZONE,
      );
      if (close.getTime() <= instant.getTime() && this.isTradingDay(close)) {
        return close;
      }
      civilDate = previousCivilDay(civilDate);
    }

    throw new Error(
      `No LSE session close found within ${MAX_SESSION_LOOKBACK_DAYS} days before ${instant.toISOString()}`,
    );
  }

  /** The next close strictly after `instant` — what the flatten offsets from. */
  sessionEnd(instant: Date): Date | null {
    let civilDate = toEasternCivilDate(instant, LONDON_ZONE);

    for (let day = 0; day <= MAX_SESSION_LOOKBACK_DAYS; day++) {
      const close = easternWallClockToInstant(
        civilDate,
        this.#closeMinutesFor(civilDate),
        LONDON_ZONE,
      );
      if (close.getTime() > instant.getTime() && this.isTradingDay(close)) {
        return close;
      }
      civilDate = nextCivilDay(civilDate);
    }

    throw new Error(
      `No LSE session close found within ${MAX_SESSION_LOOKBACK_DAYS} days after ${instant.toISOString()}`,
    );
  }

  /**
   * Keyed on the CIVIL DATE rather than on the instant, so the half-day lookup
   * cannot depend on the time of day being asked about — the close of
   * 24 December is 12:30 whether the question is asked at 09:00 or at 16:00.
   */
  #closeMinutesFor(civilDate: EtCivilDate): number {
    return LSE_HALF_DAYS.has(civilDateKey(civilDate))
      ? LSE_HALF_DAY_CLOSE_MINUTES
      : LSE_CLOSE_MINUTES;
  }
}
