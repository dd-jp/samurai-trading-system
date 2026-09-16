import {
  AlwaysOpenCalendar,
  earlierOf,
  LSE_HALF_DAYS,
  LSE_HALF_DAYS_CHECKED_THROUGH,
  LSE_HOLIDAYS,
  LSE_HOLIDAYS_CHECKED_THROUGH,
  LSE_TABLE_COVERAGE_END,
  LseRegularHoursCalendar,
  UsEquityRegularHoursCalendar,
} from './trading-calendar.js';

describe('AlwaysOpenCalendar', () => {
  it('is open at every instant — crypto trades 24/7', () => {
    const calendar = new AlwaysOpenCalendar();

    // 03:00 UTC Sunday: no equity session anywhere near it
    expect(calendar.isOpen(new Date('2026-07-12T03:00:00Z'))).toBe(true);
    expect(calendar.isTradingDay(new Date('2026-07-12T03:00:00Z'))).toBe(true);
  });

  describe('sessionStart', () => {
    const calendar = new AlwaysOpenCalendar();

    it('returns UTC midnight of the instant’s UTC day', () => {
      expect(calendar.sessionStart(new Date('2026-07-12T03:00:00Z'))).toEqual(
        new Date('2026-07-12T00:00:00Z'),
      );
      expect(calendar.sessionStart(new Date('2026-07-12T23:59:59.999Z'))).toEqual(
        new Date('2026-07-12T00:00:00Z'),
      );
    });

    it('is idempotent at the boundary — midnight starts its own session', () => {
      expect(calendar.sessionStart(new Date('2026-07-12T00:00:00Z'))).toEqual(
        new Date('2026-07-12T00:00:00Z'),
      );
    });

    it('uses UTC days, not Eastern days — 20:00 ET is already tomorrow’s UTC day', () => {
      // 2026-07-12T22:00Z is 18:00 ET the same evening; the UTC day is still the 12th
      expect(calendar.sessionStart(new Date('2026-07-12T22:00:00Z'))).toEqual(
        new Date('2026-07-12T00:00:00Z'),
      );
      // 2026-07-13T02:00Z is 22:00 ET on the 12th, but the UTC day has rolled
      expect(calendar.sessionStart(new Date('2026-07-13T02:00:00Z'))).toEqual(
        new Date('2026-07-13T00:00:00Z'),
      );
    });

    it('ignores DST entirely — UTC has none', () => {
      expect(calendar.sessionStart(new Date('2026-03-08T12:00:00Z'))).toEqual(
        new Date('2026-03-08T00:00:00Z'),
      );
      expect(calendar.sessionStart(new Date('2026-11-01T12:00:00Z'))).toEqual(
        new Date('2026-11-01T00:00:00Z'),
      );
    });
  });
});

describe('UsEquityRegularHoursCalendar', () => {
  const calendar = new UsEquityRegularHoursCalendar();

  // 2026-07-15 is a Wednesday. July = EDT (UTC-4), so 09:30 ET = 13:30 UTC.
  it('is open from the opening bell', () => {
    expect(calendar.isOpen(new Date('2026-07-15T13:30:00Z'))).toBe(true);
  });

  it('is closed before the opening bell (pre-market is not a session)', () => {
    expect(calendar.isOpen(new Date('2026-07-15T13:29:59Z'))).toBe(false);
  });

  it('is open during the session', () => {
    expect(calendar.isOpen(new Date('2026-07-15T17:00:00Z'))).toBe(true);
  });

  it('treats the closing bell as closed — the session is half-open [open, close)', () => {
    // 16:00 ET exactly. A bar opening here belongs to no session.
    expect(calendar.isOpen(new Date('2026-07-15T20:00:00Z'))).toBe(false);
  });

  it('is open at the last intraday bar before the close', () => {
    expect(calendar.isOpen(new Date('2026-07-15T19:59:00Z'))).toBe(true);
  });

  it('is closed after hours', () => {
    expect(calendar.isOpen(new Date('2026-07-15T21:00:00Z'))).toBe(false);
  });

  /**
   * 2026-12-24 is a Christmas Eve early close: 13:00 ET, not 16:00. December =
   * EST (UTC-5), so 13:00 ET = 18:00 UTC.
   *
   * This matters because since #668 this calendar decides when the paper equity
   * book must be flat. An unmodelled early close leaves the flatten computed for
   * 15:55 on a market that shut at 13:00, and the position sits unflattened —
   * the overnight carry ADR-0014 forbids. An unmodelled ordinary holiday fails
   * the other way and is harmless: the flatten fires on a day with no position.
   */
  it('closes early at 13:00 ET on a Christmas Eve half-day', () => {
    expect(calendar.isOpen(new Date('2026-12-24T17:59:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-12-24T18:00:00Z'))).toBe(false);
  });

  it('reports the early close as the session end the flatten offsets from', () => {
    const end = calendar.sessionEnd(new Date('2026-12-24T15:00:00Z'));

    expect(end?.toISOString()).toBe('2026-12-24T18:00:00.000Z');
  });

  it('still reports 16:00 ET on an ordinary December session', () => {
    // 2026-12-23, a Wednesday and not an early close
    const end = calendar.sessionEnd(new Date('2026-12-23T15:00:00Z'));

    expect(end?.toISOString()).toBe('2026-12-23T21:00:00.000Z');
  });

  // #696. Before this the calendar was weekday-only, so it reported every NYSE
  // full closure as an ordinary trading day — the orchestrator would tick a
  // dead market, spend on debate against a feed that is not moving, and fire a
  // flatten into a venue that cannot fill it
  describe('NYSE holidays', () => {
    it('reports no session on Thanksgiving, and one on the day before', () => {
      // Thu 2026-11-26 12:00 EST (17:00 UTC), mid-session-hours if it traded
      expect(calendar.isTradingDay(new Date('2026-11-26T17:00:00Z'))).toBe(false);
      expect(calendar.isOpen(new Date('2026-11-26T17:00:00Z'))).toBe(false);
      // Wed 2026-11-25, same clock time, is an ordinary full session
      expect(calendar.isOpen(new Date('2026-11-25T17:00:00Z'))).toBe(true);
    });

    it('closes fully on an observed holiday that moved off a weekend', () => {
      // 4 July 2026 is a Saturday, so NYSE observes it on Friday 3 July
      // 12:00 EDT = 16:00 UTC
      expect(calendar.isTradingDay(new Date('2026-07-03T16:00:00Z'))).toBe(false);
      // Thu 2 July trades normally — the observance moves the closure, it does
      // not extend it backwards
      expect(calendar.isOpen(new Date('2026-07-02T16:00:00Z'))).toBe(true);
    });

    it('treats 2027-12-24 as a full closure, not a 13:00 early close', () => {
      // The regression this guards. Christmas 2027 falls on a Saturday, so the
      // observed holiday is Friday 24 December — but the date was originally
      // listed in US_EARLY_CLOSE_DAYS as "Christmas Eve, a Friday", which had
      // the calendar reporting a live 09:30-13:00 session on a day the exchange
      // is shut. 12:00 EST = 17:00 UTC, inside that phantom window.
      expect(calendar.isTradingDay(new Date('2027-12-24T17:00:00Z'))).toBe(false);
      expect(calendar.isOpen(new Date('2027-12-24T17:00:00Z'))).toBe(false);
      // Thu 23 December 2027 is a normal 16:00 close, so the closure is the
      // holiday and not a stray early-close entry bleeding across days
      expect(calendar.isOpen(new Date('2027-12-23T20:00:00Z'))).toBe(true);
    });

    it('agrees with itself: isOpen never reports a session isTradingDay denies', () => {
      // These two disagreed before #696 — isTradingDay checked only the weekend
      // and isOpen repeated that check privately, so neither saw a holiday
      // Sampled across 2026 at 12:00 ET, inside session hours on any real day
      for (let day = 0; day < 365; day++) {
        const instant = new Date(Date.UTC(2026, 0, 1, 17, 0) + day * 86_400_000);

        if (calendar.isOpen(instant)) {
          expect(calendar.isTradingDay(instant)).toBe(true);
        }
      }
    });

    it('steps sessionEnd over a holiday to the next real close', () => {
      // Thu 2026-12-24 14:00 EST (19:00 UTC) — after that day's 13:00 early
      // close. Christmas Day is the Friday, then the weekend, so the next close
      // is Mon 28 December at 16:00 EST (21:00 UTC). Weekday-only arithmetic
      // would have returned the 25th's phantom close
      expect(calendar.sessionEnd(new Date('2026-12-24T19:00:00Z'))?.toISOString()).toBe(
        '2026-12-28T21:00:00.000Z',
      );
    });

    it('resolves sessionStart on a holiday to the prior trading close', () => {
      // Christmas Day 2026 at 10:00 EST (15:00 UTC). The accounting boundary is
      // the 24th's EARLY close at 13:00 EST (18:00 UTC), so a holiday does not
      // open a fresh PnL window on a day with no trading
      expect(calendar.sessionStart(new Date('2026-12-25T15:00:00Z'))).toEqual(
        new Date('2026-12-24T18:00:00Z'),
      );
    });
  });

  it('is closed at the weekend', () => {
    // Saturday 2026-07-18, mid-session-hours if it were a weekday
    expect(calendar.isOpen(new Date('2026-07-18T17:00:00Z'))).toBe(false);
    expect(calendar.isTradingDay(new Date('2026-07-18T17:00:00Z'))).toBe(false);
  });

  it('resolves sessions in Eastern time across DST, not a fixed UTC offset', () => {
    // 2026-01-14 is a Wednesday in EST (UTC-5), so 09:30 ET = 14:30 UTC
    expect(calendar.isOpen(new Date('2026-01-14T14:30:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-01-14T14:29:59Z'))).toBe(false);
    // The EDT open (13:30 UTC) must NOT be open in January
    expect(calendar.isOpen(new Date('2026-01-14T13:30:00Z'))).toBe(false);
  });

  it('counts a weekday as a trading day even outside session hours (daily bars)', () => {
    // Midnight ET — where a daily bar is timestamped
    expect(calendar.isTradingDay(new Date('2026-07-15T04:00:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-07-15T04:00:00Z'))).toBe(false);
  });

  // Every expectation below is a hand-computed literal UTC instant, never a value
  // derived from the implementation's own Intl machinery — a test that recomputes
  // the answer the same way the code does cannot catch a broken conversion
  describe('sessionStart', () => {
    it('returns yesterday’s 16:00 ET close from inside today’s session', () => {
      // Wed 2026-07-15 10:00 EDT (14:00 UTC) -> Tue 2026-07-14 16:00 EDT
      expect(calendar.sessionStart(new Date('2026-07-15T14:00:00Z'))).toEqual(
        new Date('2026-07-14T20:00:00Z'),
      );
    });

    it('returns yesterday’s close pre-open, not today’s future close', () => {
      // Wed 2026-07-15 09:00 EDT (13:00 UTC), before the bell
      expect(calendar.sessionStart(new Date('2026-07-15T13:00:00Z'))).toEqual(
        new Date('2026-07-14T20:00:00Z'),
      );
    });

    it('returns today’s close once the bell has rung', () => {
      // Wed 2026-07-15 17:00 EDT (21:00 UTC), after hours
      expect(calendar.sessionStart(new Date('2026-07-15T21:00:00Z'))).toEqual(
        new Date('2026-07-15T20:00:00Z'),
      );
    });

    it('treats the close instant as the START of the new session (half-open, matching isOpen)', () => {
      const close = new Date('2026-07-15T20:00:00Z');

      // isOpen is half-open: the close instant is not inside the old session
      expect(calendar.isOpen(close)).toBe(false);
      // sessionStart agrees: the accounting window that begins here is its own
      expect(calendar.sessionStart(close)).toEqual(close);
    });

    it('is on the previous close one millisecond before the bell', () => {
      expect(calendar.sessionStart(new Date('2026-07-15T19:59:59.999Z'))).toEqual(
        new Date('2026-07-14T20:00:00Z'),
      );
    });

    it('is on the new close one millisecond after the bell', () => {
      expect(calendar.sessionStart(new Date('2026-07-15T20:00:00.001Z'))).toEqual(
        new Date('2026-07-15T20:00:00Z'),
      );
    });

    it('resolves a Saturday to the prior Friday close', () => {
      // Sat 2026-07-18 17:00 EDT (21:00 UTC) — deliberately PAST Saturday's own
      // notional 16:00, so only the weekday check can rule Saturday out
      expect(calendar.sessionStart(new Date('2026-07-18T21:00:00Z'))).toEqual(
        new Date('2026-07-17T20:00:00Z'),
      );
      // Sat 2026-07-18 13:00 EDT (17:00 UTC), before it
      expect(calendar.sessionStart(new Date('2026-07-18T17:00:00Z'))).toEqual(
        new Date('2026-07-17T20:00:00Z'),
      );
    });

    it('resolves a Sunday to the prior Friday close', () => {
      expect(calendar.sessionStart(new Date('2026-07-19T17:00:00Z'))).toEqual(
        new Date('2026-07-17T20:00:00Z'),
      );
    });

    it('resolves Monday pre-open to the prior Friday close, skipping the weekend', () => {
      // Mon 2026-07-20 09:00 EDT (13:00 UTC)
      expect(calendar.sessionStart(new Date('2026-07-20T13:00:00Z'))).toEqual(
        new Date('2026-07-17T20:00:00Z'),
      );
    });

    it('resolves 16:00 EST (21:00 UTC) in winter, not the summer 20:00 UTC close', () => {
      // Wed 2026-01-14 10:00 EST (15:00 UTC) -> Tue 2026-01-13 16:00 EST = 21:00 UTC
      expect(calendar.sessionStart(new Date('2026-01-14T15:00:00Z'))).toEqual(
        new Date('2026-01-13T21:00:00Z'),
      );
    });

    it('spans the spring-forward transition — EDT instant, EST close', () => {
      // DST 2026 begins Sun 2026-03-08. Mon 2026-03-09 10:00 EDT (14:00 UTC);
      // the previous close is Fri 2026-03-06 16:00 EST = 21:00 UTC, an hour
      // later in UTC terms than a summer close. A fixed -4h offset gets this wrong.
      expect(calendar.sessionStart(new Date('2026-03-09T14:00:00Z'))).toEqual(
        new Date('2026-03-06T21:00:00Z'),
      );
    });

    it('spans the fall-back transition — EST instant, EDT close', () => {
      // DST 2026 ends Sun 2026-11-01. Mon 2026-11-02 10:00 EST (15:00 UTC);
      // the previous close is Fri 2026-10-30 16:00 EDT = 20:00 UTC. A fixed -5h
      // offset gets this wrong
      expect(calendar.sessionStart(new Date('2026-11-02T15:00:00Z'))).toEqual(
        new Date('2026-10-30T20:00:00Z'),
      );
    });

    it('resolves the fall-back Sunday itself to the prior Friday EDT close', () => {
      expect(calendar.sessionStart(new Date('2026-11-01T15:00:00Z'))).toEqual(
        new Date('2026-10-30T20:00:00Z'),
      );
    });

    it('resolves the spring-forward Monday’s own close in EDT', () => {
      // Mon 2026-03-09 17:00 EDT (21:00 UTC) -> that day's 16:00 EDT = 20:00 UTC
      expect(calendar.sessionStart(new Date('2026-03-09T21:00:00Z'))).toEqual(
        new Date('2026-03-09T20:00:00Z'),
      );
    });

    it('is idempotent — the session start of a session start is itself', () => {
      const start = calendar.sessionStart(new Date('2026-03-09T14:00:00Z'));

      expect(calendar.sessionStart(start)).toEqual(start);
    });

    it('never returns an instant in the future, sampled across a full year', () => {
      for (let day = 0; day < 365; day++) {
        const instant = new Date(Date.UTC(2026, 0, 1, 7, 30) + day * 86_400_000);
        const start = calendar.sessionStart(instant);

        expect(start.getTime()).toBeLessThanOrEqual(instant.getTime());
        // Never more than four days back. A weekend alone is a two-day gap; the
        // widest in 2026 is Christmas, where a Friday holiday follows a 13:00
        // early close and runs into the weekend — Thu 24 Dec 18:00 UTC to Mon
        // 28 Dec, 3d13h30m. Holidays widened this bound (#696), so the margin is
        // now under eleven hours rather than the two days it was: a new
        // multi-day closure would fail here, which is the point of asserting it
        expect(instant.getTime() - start.getTime()).toBeLessThan(4 * 86_400_000);
        expect(calendar.isTradingDay(start)).toBe(true);
      }
    });
  });
});

/**
 * #691 finding 2 — the port documents `Date | null` and the implementations
 * also THROW. The throw is now documented rather than removed, so it is
 * behaviour and gets pinned like any other.
 *
 * Pinned specifically so the "return null on exhaustion instead" change cannot
 * be made silently: `null` means "this venue has no close" and the trader's
 * response to it is to skip flattening, so collapsing the two would turn a
 * broken calendar into an unlogged overnight carry against ADR-0014.
 */
describe('the exhausted-search contract (#691)', () => {
  /** A calendar whose holiday table has swallowed every day — the broken case */
  class NeverTradingCalendar extends UsEquityRegularHoursCalendar {
    override isTradingDay(_instant: Date): boolean {
      return false;
    }
  }

  const calendar = new NeverTradingCalendar();
  const instant = new Date('2026-07-15T18:00:00Z');

  it('throws rather than returning null when no close can be found', () => {
    // NOT `toBeNull()`. That is the distinction the port doc now turns on.
    expect(() => calendar.sessionEnd(instant)).toThrow(/No US equity session close found/);
  });

  it('names the search bound and the instant, so the fault is diagnosable', () => {
    expect(() => calendar.sessionEnd(instant)).toThrow(/within 10 days after/);
    expect(() => calendar.sessionStart(instant)).toThrow(/within 10 days before/);
  });

  it('still returns null for a venue that genuinely has no close', () => {
    // The other half of the contract: `AlwaysOpenCalendar` is not broken, it is
    // crypto. Same method, opposite meaning, and the port keeps them apart.
    expect(new AlwaysOpenCalendar().sessionEnd(instant)).toBeNull();
  });
});

/**
 * #684. Before this, a date past the hand-entered tables' checked coverage
 * silently got `SESSION_CLOSE_MINUTES` — a normal 16:00 ET close — which is
 * the DANGEROUS direction for an unmodelled early close: the flatten would
 * compute against a close time nobody ever checked. Now it throws, the same
 * "un-modelled, not guessed" posture #691 already gives an exhausted search.
 */
describe('the hand-entered table coverage cliff (#684)', () => {
  const calendar = new UsEquityRegularHoursCalendar();
  // A Tuesday, ordinary-looking, comfortably past 2027-12-31
  const beyondCoverage = new Date('2028-03-14T15:00:00Z');

  it('throws on isOpen for a date past the checked coverage, rather than assuming a normal close', () => {
    expect(() => calendar.isOpen(beyondCoverage)).toThrow(/past the hand-entered table/);
  });

  it('throws on sessionEnd for a date past the checked coverage', () => {
    expect(() => calendar.sessionEnd(beyondCoverage)).toThrow(/past the hand-entered table/);
  });

  it('throws on sessionStart for a date past the checked coverage', () => {
    expect(() => calendar.sessionStart(beyondCoverage)).toThrow(/past the hand-entered table/);
  });

  it('still answers isTradingDay past the cliff — the SAFE direction is unchanged', () => {
    // A weekday past coverage still reads as a trading day: `isTradingDay`
    // never consulted the early-close table, only the (empty, past 2027)
    // holiday table and the weekend check — nothing overnight is carried by
    // treating a day this calendar cannot see the close of as a phantom
    // holiday would be worse, not better
    expect(calendar.isTradingDay(beyondCoverage)).toBe(true);
  });

  it('does not throw for the last covered date', () => {
    expect(() => calendar.isOpen(new Date('2027-12-31T15:00:00Z'))).not.toThrow();
  });
});

describe('the LSE table coverage cliff (#1378)', () => {
  const calendar = new LseRegularHoursCalendar();
  // Ordinary-looking (mid-March, no holiday shape) and comfortably past
  // LSE_TABLE_COVERAGE_END, wherever that constant currently lands — derived
  // rather than a bare literal so extending the table doesn't strand this at
  // a date that is no longer past coverage
  const beyondCoverage = new Date(
    `${Number(LSE_TABLE_COVERAGE_END.slice(0, 4)) + 1}-03-14T15:00:00Z`,
  );

  it('LSE_TABLE_COVERAGE_END currently equals both checked-through dates', () => {
    // Both tables were hand-checked through the same 2026-2028 window, so
    // today LSE_HOLIDAYS_CHECKED_THROUGH === LSE_HALF_DAYS_CHECKED_THROUGH
    // === LSE_TABLE_COVERAGE_END. The min()-of-the-two property (below) is
    // what keeps this correct once the two are extended independently and
    // stop matching
    expect(LSE_TABLE_COVERAGE_END).toBe('2028-12-31');
    expect(LSE_HOLIDAYS_CHECKED_THROUGH).toBe(LSE_TABLE_COVERAGE_END);
    expect(LSE_HALF_DAYS_CHECKED_THROUGH).toBe(LSE_TABLE_COVERAGE_END);
  });

  it('no LSE_HOLIDAYS entry exceeds LSE_HOLIDAYS_CHECKED_THROUGH', () => {
    // Drift protection: extending the table without moving its own
    // checked-through constant fails here, rather than silently widening
    // what the boot guard trusts
    for (const key of LSE_HOLIDAYS) {
      expect(key <= LSE_HOLIDAYS_CHECKED_THROUGH).toBe(true);
    }
  });

  it('no LSE_HALF_DAYS entry exceeds LSE_HALF_DAYS_CHECKED_THROUGH', () => {
    for (const key of LSE_HALF_DAYS) {
      expect(key <= LSE_HALF_DAYS_CHECKED_THROUGH).toBe(true);
    }
  });

  it('LSE_TABLE_COVERAGE_END is computed via earlierOf', () => {
    expect(LSE_TABLE_COVERAGE_END).toBe(
      earlierOf(LSE_HOLIDAYS_CHECKED_THROUGH, LSE_HALF_DAYS_CHECKED_THROUGH),
    );
  });

  describe('earlierOf', () => {
    // Unequal literals, independent of whatever LSE_HOLIDAYS_CHECKED_THROUGH
    // and LSE_HALF_DAYS_CHECKED_THROUGH currently equal — a `max()` mutation
    // of the ternary above would still pass the two tests above (both
    // constants are currently equal) but fails here
    it('returns the earlier date regardless of argument order', () => {
      expect(earlierOf('2027-01-01', '2027-06-30')).toBe('2027-01-01');
      expect(earlierOf('2027-06-30', '2027-01-01')).toBe('2027-01-01');
    });

    it('returns the shared value when both dates are equal', () => {
      expect(earlierOf('2027-03-15', '2027-03-15')).toBe('2027-03-15');
    });
  });

  it('does NOT throw on isOpen past the coverage end — the resolver stays total', () => {
    // Unlike UsEquityRegularHoursCalendar: a throw here sits on the flatten
    // path (isOpen/sessionStart/sessionEnd all route through
    // #closeMinutesFor), so a position open past this date must still be
    // flattenable. The boot guard, not this method, is what refuses the run.
    expect(() => calendar.isOpen(beyondCoverage)).not.toThrow();
  });

  it('does NOT throw on sessionEnd past the coverage end', () => {
    expect(() => calendar.sessionEnd(beyondCoverage)).not.toThrow();
  });

  it('does NOT throw on sessionStart past the coverage end', () => {
    expect(() => calendar.sessionStart(beyondCoverage)).not.toThrow();
  });

  it('coversCloseFor is true at and before the coverage end', () => {
    expect(calendar.coversCloseFor(new Date(`${LSE_TABLE_COVERAGE_END}T15:00:00Z`))).toBe(true);
    expect(calendar.coversCloseFor(new Date('2020-01-06T15:00:00Z'))).toBe(true);
  });

  it('coversCloseFor is false past the coverage end', () => {
    expect(calendar.coversCloseFor(beyondCoverage)).toBe(false);
  });

  it('an unmodelled half-day past coverage does not silently report a verified close', () => {
    // Christmas Eve, two years past LSE_TABLE_COVERAGE_END — half-day-shaped
    // but never checked against the source, so LSE_HALF_DAYS was never
    // extended to cover it. What matters is that coversCloseFor says this
    // date is UNVERIFIED, and that a live boot for this date is refused
    // elsewhere (production.test.ts's "refuses to boot on an unmodelled
    // half-day past coverage (AC5)" case) — not what #closeMinutesFor's
    // specific numeric guess for this date happens to be. Pinning that
    // guess as "correct" would tie this test to an implementation detail
    // the coverage guard exists precisely so nothing downstream has to
    // trust
    const unmodelledHalfDay = new Date(
      `${Number(LSE_TABLE_COVERAGE_END.slice(0, 4)) + 2}-12-24T15:00:00Z`,
    );
    // The half-day-shaped premise only holds if this lands on a weekday;
    // asserted explicitly so a future coverage-end shift that puts it on a
    // weekend reds this test instead of silently testing something else
    expect(unmodelledHalfDay.getUTCDay()).toBeGreaterThanOrEqual(1);
    expect(unmodelledHalfDay.getUTCDay()).toBeLessThanOrEqual(5);

    expect(calendar.coversCloseFor(unmodelledHalfDay)).toBe(false);
    // #closeMinutesFor stays total (see the class doc) — still answers,
    // still doesn't throw, past coverage
    expect(() => calendar.sessionEnd(unmodelledHalfDay)).not.toThrow();
  });

  it('does not throw for the last covered date', () => {
    expect(() => calendar.isOpen(new Date(`${LSE_TABLE_COVERAGE_END}T15:00:00Z`))).not.toThrow();
  });

  it('resolves a substitute day in the extended range as a non-trading day (#1379)', () => {
    // 1 January 2028 is a Saturday, so New Year's Day is observed on the
    // following Monday, 3 January 2028 — a substitute day, not a bank
    // holiday in its own right, and it must still resolve as non-trading
    const substituteDay = new Date('2028-01-03T12:00:00Z');
    const followingWeekday = new Date('2028-01-04T12:00:00Z');

    expect(calendar.isTradingDay(substituteDay)).toBe(false);
    expect(calendar.isOpen(substituteDay)).toBe(false);
    // The adjacent Tuesday is an ordinary trading day — proves the false
    // above comes from the holiday table, not from a weekend check
    expect(calendar.isTradingDay(followingWeekday)).toBe(true);
  });

  it('does not add a 2028 half-day — 24 and 31 December 2028 both fall on a Sunday', () => {
    // The weekday rule, not an oversight: LSE_HALF_DAYS applies only when
    // Christmas Eve / New Year's Eve fall on a weekday, and in 2028 both are
    // already non-trading (weekend) days, so no entry was added for them
    // The 12:30 half-day close itself is already pinned on a weekday case —
    // session-end.test.ts's "closes a half-day at 12:30, not 16:30" (Christmas
    // Eve 2026)
    // Asserted rather than only claimed in the comment above, so a wrong
    // premise here fails this test instead of staying silently green
    expect(new Date('2028-12-24T12:00:00Z').getUTCDay()).toBe(0);
    expect(new Date('2028-12-31T12:00:00Z').getUTCDay()).toBe(0);
    expect(LSE_HALF_DAYS.has('2028-12-24')).toBe(false);
    expect(LSE_HALF_DAYS.has('2028-12-31')).toBe(false);
  });
});
