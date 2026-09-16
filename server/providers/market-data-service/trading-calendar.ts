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
   * Holidays ARE modelled by both shipped implementations, so a holiday Monday
   * no longer reports a session start for a session that never traded. That
   * was true of `UsEquityRegularHoursCalendar` until #696; it was always the
   * reason the boundary lives on the calendar rather than being duplicated in
   * each consumer, and it is why fixing the table fixed every consumer at once.
   *
   * The tables are HAND-ENTERED and their coverage ENDS — see each
   * implementation. Past the end of a table `isTradingDay`/`sessionStart`
   * report an ordinary trading day, which is the safe direction for THIS
   * predicate: a phantom trading day makes accounting reset on a boundary
   * that never traded, not a position get stranded. That is not true of every
   * boundary this file resolves — see `LSE_HALF_DAYS`'s doc for the case
   * where past-coverage permissiveness is the DANGEROUS direction instead.
   *
   * THROWS on the same terms as `sessionEnd` — see its "cannot answer" note.
   * There is no `null` here to confuse it with, since every venue has a session
   * start, so exhausting the search means the calendar is broken outright.
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
   *
   * ## THROWS — `null` and "cannot answer" are different answers (#691)
   *
   * An implementation that searches a calendar MAY THROW when it cannot find a
   * close at all, and both equity calendars here do, after
   * `MAX_SESSION_SEARCH_DAYS`. Callers must be throw-safe as well as
   * null-safe; the two mean opposite things and must not be collapsed:
   *
   * - `null` — "this venue has no close." A settled, correct answer. Do nothing.
   * - throw — "this venue HAS a close and I could not find it." The calendar is
   *   broken or its holiday table is wrong.
   *
   * The port previously documented only `Date | null` while the implementations
   * threw, so a caller written against the contract handled `null` and was
   * ambushed by the throw. Documenting the throw is the deliberate resolution;
   * the alternative — returning `null` on exhaustion — was rejected because it
   * makes a broken calendar indistinguishable from crypto, and the trader's
   * response to `null` is to SKIP FLATTENING. That converts a loud data fault
   * into an overnight carry against ADR-0014 with nothing logged, which is the
   * same silent-non-flatten failure #670 exists to prevent.
   *
   * There are FOUR callers on the money path, they are caught in DIFFERENT
   * places, and they leave different durable records. All were verified from
   * the code, not assumed:
   *
   * - `withinFlattenWindow` (`server/pipeline/trader/decide.ts`) runs inside a
   *   pipeline pass, so a throw lands in `runTickPlan`'s PER-INSTRUMENT `catch`
   *   (`server/apps/orchestrator/tick-loop.ts`). That logs `instrument failed`
   *   at `level: 'error'` AND writes an `audit_log` row with
   *   `stage: 'tick-loop'`, `decision: 'crashed'` (#507). Only that instrument
   *   is lost, and the fault is durable — it survives the process.
   * - `withFlattenTail` (`server/apps/orchestrator/production/stocks-tick-window.ts`)
   *   runs inside `UniverseScheduler.nextTick`, which is called during plan
   *   construction — BEFORE `runTickPlan` and therefore outside that catch. It
   *   is caught one level out, by `runOnce`'s `catch` in
   *   `server/apps/orchestrator/production.ts` (the `trace_id: 'tick-loop'`
   *   handler that logs `tick failed` at `level: 'error'`). That drops the
   *   WHOLE tick — crypto included — and writes NO `audit_log` row. The log
   *   line is the only record.
   * - `postCloseFlattenTail` (same file as `withFlattenTail`, #1389) runs in
   *   the same `nextTick` plan construction and is caught in the same place,
   *   with the same whole-tick blast radius.
   * - `findCarriedLots` (`server/apps/orchestrator/production/carried-lot-alert.ts`,
   *   #1389) runs on the fill-sync poll, and `buildCarriedLotReporter` catches
   *   its own throw: an exhausted walk there logs `carried_lot_check_failed` at
   *   error and the poll continues. It is the only one of the four that cannot
   *   take anything else down with it.
   *
   * None is a crash, and all are LOGGED at error level where the heartbeat and
   * the operator can see them, which is the whole reason the throw is
   * acceptable. The `nextTick` pair is the weaker: wider blast radius, no
   * durable row.
   *
   * **#1389 narrowed the guarantee that made that pair tolerable, and did so on
   * purpose.** This paragraph used to say `nextTick` consults `sessionEnd`
   * exclusively when `isOpen(instant)` is already true, so an exhausted forward
   * walk needed a calendar inconsistent with itself. That is still true of
   * `withFlattenTail` and is now FALSE of the scheduler as a whole:
   * `postCloseFlattenTail` is OR'd with the open-hours branch precisely so a
   * tick can be planned after the bell, which means `sessionEnd` is now
   * consulted overnight, at weekends and on holidays too.
   *
   * The consequence is bounded and was checked rather than assumed. Both equity
   * implementations answer a date their table does not cover the same way they
   * always did — `UsEquityRegularHoursCalendar` throws past
   * `US_TABLE_COVERAGE_END`, `AlpacaEquitySessionCalendar` throws once the walk
   * exhausts — and on a WEEKDAY past coverage `isOpen` already threw from
   * `#closeMinutesFor` before this caller existed. What #1389 adds is the
   * weekend and holiday instants of an already-past-coverage run, where the
   * whole-tick drop is the same fault surfacing one day earlier rather than a
   * new one. The live leg's cliff is refused at boot outright
   * (`assertLseCalendarCoverage`, #1378).
   *
   * That is a CROSS-MODULE claim and this port cannot enforce it. It is named
   * here rather than left implicit so the next reader can check it in one grep;
   * if any handler ever stops catching, or drops to `warn`, this paragraph
   * becomes wrong and the flatten path becomes a silent skip. Any new caller on
   * the money path must state where its throw lands.
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

/**
 * Exported for `alpaca-session-calendar.ts` (#684): the Alpaca-backed
 * calendar needs the same DST-aware Eastern wall-clock arithmetic this file
 * already built for `UsEquityRegularHoursCalendar`, and re-deriving it there
 * would be a second, driftable copy of the `Intl` fixpoint below
 */
export const ET_ZONE = 'America/New_York';
/**
 * #668 — the live equity leg is LSE-listed GBP ETFs/ETCs (#659, ADR-0015).
 *
 * Exported for `production/lse-calendar-coverage-guard.ts` (#1378), same
 * reason `ET_ZONE` is exported for `us-equity-session-source.ts`: the boot
 * guard has to ask "what civil date is it in London right now" to measure
 * the horizon to `LSE_TABLE_COVERAGE_END`, and reimplementing this fixpoint
 * there would be a second, driftable copy of it.
 *
 * Also exported (alongside `toCivilDate`, `nextCivilDay` and
 * `wallClockToInstant`) for `production/saxo-weekly-reminder-alert.ts`
 * (#1524): the weekly re-login reminder needs "next Sunday 18:00 London,
 * DST included" and this file already owns the only `Intl` fixpoint for it.
 */
export const LONDON_ZONE = 'Europe/London';
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

/**
 * Resolves an instant into a zone's wall-clock, DST included, via Intl.
 * Exported for `alpaca-session-calendar.ts` (#684) — see `ET_ZONE`'s doc.
 */
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
 * How far the session walks search before giving up, in civil days.
 *
 * Widest weekday-only gap is a weekend (2 days); the margin is for the holiday
 * table to come. Comfortably clear of the LSE's 4-day Christmas and Easter
 * stretches — that headroom is the reason 10 rather than 3.
 *
 * Named for the SEARCH rather than a direction because it bounds both: the
 * backward walk in `sessionStart` and the forward walk in `sessionEnd` (#691).
 * It was `MAX_SESSION_LOOKBACK_DAYS`, which described half its uses and made
 * `sessionEnd`'s error read "lookback days after".
 */
export const MAX_SESSION_SEARCH_DAYS = 10;
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
 * Every civil field of `instant` in `zone`, as numbers.
 *
 * Throws rather than defaulting a missing part: a silently-zeroed year would
 * put the session boundary in year 0 and be read as a plausible timestamp
 * downstream.
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
 *
 * Zone-neutral: it serves New York and London alike, which is why neither the
 * name nor the types mention Eastern any more (#668 gave these a `zone`
 * parameter but left the Eastern names behind).
 *
 * The offset is resolved from `Intl` by fixpoint rather than hard-coded: a
 * literal -4h/-5h is right for half the year and silently wrong for the other
 * half. The loop converges because every session close this calendar asks
 * about — 16:00 and 13:00 in New York, 16:30 and 12:30 in London — sits well
 * clear of either zone's DST transition hour, so it exists exactly once on
 * every day.
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
 * NYSE full-closure holidays (#696).
 *
 * Until #696 this calendar was weekday-only, so it reported Thanksgiving,
 * Christmas and every other full closure as an ordinary trading day. That was
 * documented as a deliberate, safe simplification — and the safety argument
 * was sound only while the calendar merely gated INGESTION. Since #668 it also
 * decides when the paper equity book must be flat, and once a calendar drives
 * the flatten a missing holiday stops being free: the orchestrator ticks a
 * dead market all day, the debate spends against a feed that is not updating,
 * and the flatten fires into a venue that cannot fill it.
 *
 * A TABLE, not a rule, for the same reason as `LSE_HOLIDAYS`: Good Friday is
 * lunar, and the observed-date rule shifts a weekend holiday to the adjacent
 * weekday (Saturday to the Friday before, Sunday to the Monday after), which
 * is derivable but easy to get wrong silently. Written out so a wrong date is
 * a visible diff. Every date below was checked against the NYSE published
 * calendar, not derived.
 *
 * COVERAGE ENDS 2027-12-24. Past that this reports a normal trading day, which
 * is the SAFE direction: the flatten still computes and fires on a shut day,
 * closing a position that does not exist. The DANGEROUS error is the opposite
 * — a wrongly-listed holiday, which makes a real trading day invisible, skips
 * the flatten and carries the position overnight, exactly what ADR-0014
 * forbids. So an entry added here must be right; an entry missing is merely
 * wasteful. Extend before 2028, or prefer `AlpacaEquitySessionCalendar`
 * (`alpaca-session-calendar.ts`, #684), which fetches the live table and does
 * not carry this cliff at all — this hand-entered table is what the paper
 * leg falls back to when that fetch fails
 * (`resolveUsEquitySessionCalendar`, `production/us-equity-session-source.ts`).
 *
 * NOT modelled: ad-hoc closures — national days of mourning, weather. Those
 * are announced, not scheduled, and no hand-entered table can carry them.
 */
const US_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', // New Year's Day (Thursday)
  '2026-01-19', // Martin Luther King, Jr. Day
  '2026-02-16', // Washington's Birthday
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth (Friday)
  '2026-07-03', // Independence Day observed — 4 July 2026 is a Saturday
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day (Friday)
  // 2027
  '2027-01-01', // New Year's Day (Friday)
  '2027-01-18', // Martin Luther King, Jr. Day
  '2027-02-15', // Washington's Birthday
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth observed — 19 June 2027 is a Saturday
  '2027-07-05', // Independence Day observed — 4 July 2027 is a Sunday
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas Day observed — 25 December 2027 is a Saturday
]);

/**
 * Early closes: the session ends at 13:00 ET rather than 16:00.
 *
 * These are the more dangerous of the two tables, and were modelled first for
 * that reason. A holiday is a day with no session and nothing to flatten; an
 * unmodelled EARLY CLOSE is a REAL trading day whose close moves three hours
 * earlier, so the flatten is computed for 15:55 on a market that shut at 13:00
 * and the position sits unflattened — the overnight carry ADR-0014 forbids.
 * Same argument as `LSE_HALF_DAYS`.
 *
 * The two tables are DISJOINT and must stay so: a date here is a shortened
 * session, a date in `US_HOLIDAYS` has no session at all. `2027-12-24` used to
 * be listed here as "Christmas Eve, a Friday", which was wrong — Christmas
 * 2027 falls on a Saturday, so NYSE observes it with a FULL closure that
 * Friday and there is no 2027 Christmas Eve early close. It has moved to
 * `US_HOLIDAYS`. The mistake was invisible while holidays went unmodelled,
 * because both tables were read only for the close MINUTE and a full closure
 * had nowhere to be expressed.
 *
 * The day before Independence Day is absent for both years, and now has a
 * destination: 3 July 2026 is a full holiday in `US_HOLIDAYS`, and 4 July 2027
 * is a Sunday observed on Monday 5 July, which carries no Friday early close.
 *
 * Coverage and the `AlpacaEquitySessionCalendar` alternative (#684) are as
 * described on `US_HOLIDAYS`.
 */
const US_EARLY_CLOSE_MINUTES = 13 * 60; // 13:00 ET
const US_EARLY_CLOSE_DAYS = new Set([
  '2026-11-27', // Friday after Thanksgiving (Thanksgiving is 26 Nov 2026)
  '2026-12-24', // Christmas Eve, a Thursday
  '2027-11-26', // Friday after Thanksgiving (Thanksgiving is 25 Nov 2027)
]);

/**
 * The last civil date `US_HOLIDAYS`/`US_EARLY_CLOSE_DAYS` were checked
 * against the NYSE published calendar for (#684). Lexicographic comparison
 * against `civilDateKey`'s `YYYY-MM-DD` is intentional — it sorts exactly
 * like the calendar for any date this table will ever hold.
 *
 * Past this date `#closeMinutesFor` THROWS instead of returning
 * `SESSION_CLOSE_MINUTES`. That is a deliberate reversal of `isTradingDay`'s
 * posture, not an oversight: `isTradingDay` stays permissive past its own
 * table (a phantom holiday closes nothing that is open, the safe direction),
 * but the close-MINUTE lookup cannot make the same bet — a real trading day
 * whose actual close is unknown must not be silently guessed at a normal
 * 16:00, because that is precisely the unmodelled-early-close failure
 * `AlpacaEquitySessionCalendar` (#684) avoids by fetching the real table
 * instead (see the module doc's "coverage stops at 2027" gap). The
 * throw propagates through `isOpen`/`sessionStart`/`sessionEnd` exactly the
 * way an exhausted `MAX_SESSION_SEARCH_DAYS` walk already does, so callers
 * that are throw-safe for one are throw-safe for the other.
 */
export const US_TABLE_COVERAGE_END = '2027-12-31';

/**
 * US equity regular trading hours: Mon-Fri, 09:30-16:00 ET, with NYSE holidays
 * from `US_HOLIDAYS` and 13:00 early closes from `US_EARLY_CLOSE_DAYS`.
 *
 * Holidays and early closes are both modelled as of #696. Before that this
 * class was weekday-only and documented itself as permissive-on-holidays,
 * which was defensible while it only kept stock ingestion inside session
 * boundaries. It stopped being defensible at #668, when the same calendar
 * began deciding when the PAPER equity book must be flat — a money-path
 * question, where reporting a session on a day the exchange was shut means
 * ticking, debating and spending against a market that is not there.
 *
 * Still not the sole calendar: both tables are hand-entered and end after
 * 2027. `AlpacaEquitySessionCalendar` (#684) fetches the live table for the
 * paper leg instead and does not share this cliff; this class remains that
 * leg's fallback and the type any caller reaches for when it wants a static
 * table on purpose.
 */
export class UsEquityRegularHoursCalendar implements TradingCalendar {
  isOpen(instant: Date): boolean {
    // Delegates rather than repeating the weekend check, so the holiday table
    // reaches this predicate too. The two used to disagree: `isTradingDay`
    // said Thanksgiving had no session while `isOpen` reported 09:30-16:00 on
    // it — the same split-brain the `sessionStart`/`sessionEnd` walks avoid by
    // asking `isTradingDay` rather than testing the weekend themselves
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
   * The next regular or early close strictly after `instant` (#668).
   *
   * Not "the next 16:00 ET close", which is what this said before #691: on a
   * half-day it returns 13:00, and the flatten offset must ride the early close
   * rather than a constant.
   *
   * Walks FORWARD a civil day at a time, asking `isTradingDay` for the same
   * reason `sessionStart` walks backward asking it: the holiday table backing
   * that predicate must move this boundary with it rather than leaving the two
   * to disagree. Since #696 that table is populated, so the walk now steps
   * OVER holidays as well as weekends — a flatten scheduled on Christmas Eve
   * 2026 resolves to the 28 December close, not the 25th's phantom one. That
   * propagation is why #696 was a table plus a predicate and needed no change
   * to either boundary walk.
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
   * The most recent regular or early close at or before `instant` (see the port
   * doc for the half-open convention). Early closes for the same reason
   * `sessionEnd` names them: the boundary is whatever `#closeMinutesFor` says,
   * not a constant 16:00.
   *
   * Walks back a civil day at a time, asking `isTradingDay` — not a private
   * weekend check — whether each candidate close happened, so the holiday table
   * behind `isTradingDay` moves this boundary with it instead of leaving the
   * two to disagree. Since #696 that matters in practice rather than in
   * principle: session PnL and the kill-line metrics reset on this boundary,
   * and before the table existed a holiday opened a fresh accounting window on
   * a day with no trading.
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

const LSE_OPEN_MINUTES = 8 * 60; // 08:00 London
const LSE_CLOSE_MINUTES = 16 * 60 + 30; // 16:30 London
/** Christmas Eve and New Year's Eve close early; the auction ends 12:30 */
const LSE_HALF_DAY_CLOSE_MINUTES = 12 * 60 + 30;

/**
 * London Stock Exchange non-trading days.
 *
 * A TABLE, not a rule, because UK bank holidays are not derivable: the early
 * and late May holidays move, Easter is lunar, and one-off royal holidays are
 * announced by proclamation. Written out so a wrong date is a visible diff
 * rather than an arithmetic bug, and so a soak's logs can be reconciled
 * against it by eye. Dates are sourced from the UK government's published
 * bank holiday list for England and Wales
 * (https://www.gov.uk/bank-holidays.json, `england-and-wales` division), not
 * derived.
 *
 * Checked through `LSE_HOLIDAYS_CHECKED_THROUGH`. Beyond that this table
 * reports a normal trading day, which IS the safe direction for
 * `isTradingDay`: it means the flatten window still computes and fires on a
 * day the market happens to be shut, where the position it would close does
 * not exist. The dangerous error is the opposite — treating a real trading
 * day as a holiday, skipping the flatten, and carrying a position overnight.
 * That asymmetry does NOT extend to `LSE_HALF_DAYS` below — see its doc.
 * Extend this table before the checked-through date; `isTradingDay` is the
 * single place that reads it.
 *
 * Exported directly (not through the barrel), same convention as `ET_ZONE`:
 * `trading-calendar.test.ts` reads this for the drift-protection test on
 * `LSE_HOLIDAYS_CHECKED_THROUGH`, and it is not otherwise part of this
 * package's public surface.
 */
export const LSE_HOLIDAYS = new Set([
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
  // 2028
  '2028-01-03', // New Year's Day substitute (1 January 2028 is a Saturday)
  '2028-04-14', // Good Friday
  '2028-04-17', // Easter Monday
  '2028-05-01', // Early May bank holiday
  '2028-05-29', // Spring bank holiday
  '2028-08-28', // Summer bank holiday
  '2028-12-25', // Christmas Day
  '2028-12-26', // Boxing Day
]);

/**
 * The last civil date `LSE_HOLIDAYS` was checked against the published UK
 * bank holiday calendar for. Lexicographic comparison against
 * `civilDateKey`'s `YYYY-MM-DD` is intentional, matching
 * `US_TABLE_COVERAGE_END`.
 *
 * This is `2028-12-31`, matching `LSE_HALF_DAYS_CHECKED_THROUGH`, not
 * `2028-12-26` (the table's own last entry) — the two tables were populated
 * from the same hand-entry pass over the same 2026-2028 window, so their
 * checked boundary is the same. The table's last entry stops short of that
 * boundary because there is no further UK bank holiday between Boxing Day
 * (26 Dec 2028) and year end: New Year's Eve (31 Dec 2028) is not itself a
 * bank holiday, and that year it is not a half-day either — 31 December 2028
 * falls on a Sunday, so `LSE_HALF_DAYS` gains no 2028 entries (see its doc).
 * An entry ending before the checked-through date is expected; an entry
 * AFTER it is what this constant guards against.
 *
 * `2028-12-31`, not `2029-12-31`, because the source this table is checked
 * against — https://www.gov.uk/bank-holidays.json's `england-and-wales`
 * division — publishes nothing past 2028-12-26 as of this check. That is a
 * property of the source, not a choice: extending past what it publishes
 * would mean inventing dates rather than sourcing them. Move this forward
 * once the source publishes 2029.
 *
 * A hand-checked literal, not derived from the table's own contents — see
 * `LSE_TABLE_COVERAGE_END`'s doc for why deriving it from the max key would
 * be the wrong direction. `trading-calendar.test.ts` asserts no key in
 * `LSE_HOLIDAYS` exceeds this constant, so an entry added past it fails
 * that test until this constant is deliberately moved too.
 */
export const LSE_HOLIDAYS_CHECKED_THROUGH = '2028-12-31';

/**
 * Half-day closes: the session ends at 12:30 rather than 16:30.
 *
 * These matter more than ordinary holidays for #668's purpose. A holiday is a
 * day with no session and nothing to flatten; a half-day is a REAL trading day
 * whose close moves four hours earlier, so a calendar that did not model them
 * would compute a 16:25 flatten for a market that shut at 12:30 — and the
 * position would sit unflattened through the break, which is precisely the
 * overnight carry ADR-0014 forbids.
 *
 * Checked through `LSE_HALF_DAYS_CHECKED_THROUGH`, same convention as
 * `LSE_HOLIDAYS` — but past that end, this table's permissiveness is the
 * DANGEROUS direction, unlike `LSE_HOLIDAYS`'s: an unmodelled half-day reads
 * as an ordinary 16:30 close, so the flatten fires four hours late and the
 * position sits unflattened over the break — the exact carry ADR-0014
 * forbids, not the safe do-nothing failure a phantom holiday produces.
 * `#closeMinutesFor` stays total rather than throwing on this (see its doc);
 * the boot-time guard in `production/lse-calendar-coverage-guard.ts` is what
 * actually stops this from reaching a live position.
 */
export const LSE_HALF_DAYS = new Set([
  '2026-12-24', // Christmas Eve
  '2026-12-31', // New Year's Eve
  '2027-12-24',
  '2027-12-31',
  // 2028: no entries — 24 and 31 December 2028 both fall on a Sunday, so
  // neither qualifies (half-days apply only when the date is a weekday)
]);

/**
 * The last civil date `LSE_HALF_DAYS` was checked against the published UK
 * bank holiday calendar for. Same convention as `LSE_HOLIDAYS_CHECKED_THROUGH`;
 * `trading-calendar.test.ts` asserts no key in `LSE_HALF_DAYS` exceeds this one.
 *
 * `2028-12-31`, not `2029-12-31` — see `LSE_HOLIDAYS_CHECKED_THROUGH`'s doc:
 * the source both tables are checked against does not yet publish 2029.
 */
export const LSE_HALF_DAYS_CHECKED_THROUGH = '2028-12-31';

/**
 * The lexicographically earlier of two `YYYY-MM-DD` civil-date keys. Exported
 * so `trading-calendar.test.ts` can pin the min-not-max property against
 * unequal literal inputs, independent of whatever `LSE_HOLIDAYS_CHECKED_THROUGH`
 * and `LSE_HALF_DAYS_CHECKED_THROUGH` currently happen to equal.
 */
export function earlierOf(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * The binding LSE table-coverage cliff: the EARLIER of
 * `LSE_HOLIDAYS_CHECKED_THROUGH` and `LSE_HALF_DAYS_CHECKED_THROUGH`, not the
 * later. Whichever table's checked-through date comes first is unverified
 * first, regardless of how far the OTHER table happens to reach. Both are
 * `2028-12-31` today (one hand-entry pass checked both tables through the
 * same boundary), so this is currently their common value — but the two
 * are extended independently, and the day one moves ahead of the other
 * without the other following, `min()` is what keeps this constant pinned
 * to the LESS-covered table rather than silently trusting the more-covered
 * one.
 *
 * Computed via `earlierOf`, not a third hand-typed literal: the two inputs
 * are themselves hand-checked (see their own docs for why THEY are not
 * derived from table contents), so taking the earlier of two verified dates
 * carries no drift risk — unlike deriving straight from
 * `LSE_HOLIDAYS`/`LSE_HALF_DAYS`, which would let a stray table entry
 * silently move this forward.
 *
 * Unlike `US_TABLE_COVERAGE_END`, nothing throws on this from inside the
 * calendar — `#closeMinutesFor` below stays total. See its doc for why an
 * unconditional throw here would be the wrong shape of fix (it sits on the
 * flatten path, unlike the US throw, which is caught well clear of it).
 * `assertLseCalendarCoverage` (`production/lse-calendar-coverage-guard.ts`)
 * is where this constant is actually enforced, at boot, before a live
 * position can exist to be stranded.
 */
export const LSE_TABLE_COVERAGE_END = earlierOf(
  LSE_HOLIDAYS_CHECKED_THROUGH,
  LSE_HALF_DAYS_CHECKED_THROUGH,
);

/**
 * London Stock Exchange regular trading hours: Mon-Fri, 08:00-16:30 London,
 * with UK bank holidays and 12:30 half-day closes (#668).
 *
 * This is the calendar the LIVE equity leg runs on. #659 put that leg on
 * GBP LSE-listed ETFs/ETCs (venue: Saxo Capital Markets UK, GIA, since the
 * 2026-08-30 ADR-0015 amendment; this comment said "Trading 212 ISA" until
 * #946), so the US 16:00 ET boundary the repo previously had is the PAPER
 * venue's, not the live one's —
 * and #656 measured that the two sessions overlap by only two hours, which is
 * why the flatten rule had to be an offset resolved through the instrument's
 * own calendar rather than a shared wall-clock constant.
 *
 * Holidays are modelled here and, since #696, in
 * `UsEquityRegularHoursCalendar` too. This class had them from the start
 * because it shipped with #668 already driving the flatten; the US one was
 * written earlier, for ingestion, and kept a permissive posture that #668
 * silently invalidated. Both are hand-entered tables ending at their own
 * `*_TABLE_COVERAGE_END` — #684 was scoped to the US table only (its own
 * body: "The LSE side has no equivalent free endpoint and stays a table").
 * These hand-entered tables are the source of truth for the LSE session; a
 * venue session feed, where one exists, is a cross-check run against them,
 * not a replacement for them.
 *
 * `#closeMinutesFor` stays TOTAL past `LSE_TABLE_COVERAGE_END` — it does not
 * throw, unlike `UsEquityRegularHoursCalendar`'s. That is deliberate, not a
 * gap: this method backs `isOpen`/`sessionStart`/`sessionEnd`, all on the
 * flatten path, so an unconditional throw past a static coverage cliff would
 * fire on every tick from that date forward and no position could ever be
 * closed again (this repo has already shipped that shape of bug once — a
 * guard placed above an early return blocked exits, not just entries). The
 * coverage boundary is instead enforced once, at boot, by
 * `assertLseCalendarCoverage` (`production/lse-calendar-coverage-guard.ts`),
 * while no position exists yet to strand — see `coversCloseFor` below for
 * how a caller can ask the question this method itself will not raise.
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
   * `false` past `LSE_TABLE_COVERAGE_END` — not a throw, because
   * `#closeMinutesFor` stays total (see the class doc). This is the answer a
   * caller reads instead: `assertLseCalendarCoverage` calls it at boot, and a
   * test can call it directly to prove a date past coverage is a GUESS, not a
   * verified 16:30, without needing the calendar itself to raise anything.
   *
   * Keyed on the civil date, same as `#closeMinutesFor`, for the same reason:
   * whether today's close is trustworthy cannot depend on the time of day
   * the question is asked.
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
export const OVERLAP_WINDOW_OPEN_MINUTES = 14 * 60 + 30;
/** 15:45 London — last entry, leaving 40 minutes to the 16:25 flatten (#706) */
export const OVERLAP_WINDOW_LAST_ENTRY_MINUTES = 15 * 60 + 45;

/**
 * A London wall-clock predicate for `SchedulerConfig.stocksTradingWindow`.
 *
 * **This narrows a session; it does not define one.** It answers "may an
 * equity be entered at this instant", and the Scheduler only consults it once
 * the calendar has already said the venue is open — so holidays, half-days,
 * weekends and DST stay the calendar's business, resolved through the same
 * `Intl` machinery every other boundary in this file uses.
 *
 * Kept here rather than in the orchestrator precisely so it CANNOT drift from
 * that machinery: a window that did its own timezone arithmetic would be right
 * for eight months of the year.
 *
 * Defaults are the overlap-only window (#706): entries armed 14:30-15:45
 * London. #656 measured LSE 08:00-16:30 against US 14:30-21:00 — a two-hour
 * overlap — and every measurement the intraday product rests on is computed on
 * US tape, because no free LSE intraday history exists.
 *
 * Half-open at the top (`< end`), matching `isOpen`: 15:45:00 exactly is past
 * the last entry, so the two boundaries compose without an off-by-one minute.
 */
export function londonEntryWindow(
  startMinutes: number = OVERLAP_WINDOW_OPEN_MINUTES,
  endMinutes: number = OVERLAP_WINDOW_LAST_ENTRY_MINUTES,
): (instant: Date) => boolean {
  // Ordering alone is not enough. `minutesSinceMidnight` is always in [0, 1440),
  // so a clock-style `1545` (meant as 15:45) or a negative offset passes an
  // ordering check and yields a window that is silently ALWAYS or NEVER true —
  // the first arms entries for the whole session, the second deletes them, and
  // both look like a working config. Reject the out-of-range value at
  // construction, where the caller still knows what it meant
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
