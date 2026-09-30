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
      expect(calendar.sessionStart(new Date('2026-07-12T22:00:00Z'))).toEqual(
        new Date('2026-07-12T00:00:00Z'),
      );
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
    expect(calendar.isOpen(new Date('2026-07-15T20:00:00Z'))).toBe(false);
  });

  it('is open at the last intraday bar before the close', () => {
    expect(calendar.isOpen(new Date('2026-07-15T19:59:00Z'))).toBe(true);
  });

  it('is closed after hours', () => {
    expect(calendar.isOpen(new Date('2026-07-15T21:00:00Z'))).toBe(false);
  });

  it('closes early at 13:00 ET on a Christmas Eve half-day', () => {
    expect(calendar.isOpen(new Date('2026-12-24T17:59:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-12-24T18:00:00Z'))).toBe(false);
  });

  it('reports the early close as the session end the flatten offsets from', () => {
    const end = calendar.sessionEnd(new Date('2026-12-24T15:00:00Z'));

    expect(end?.toISOString()).toBe('2026-12-24T18:00:00.000Z');
  });

  it('still reports 16:00 ET on an ordinary December session', () => {
    const end = calendar.sessionEnd(new Date('2026-12-23T15:00:00Z'));

    expect(end?.toISOString()).toBe('2026-12-23T21:00:00.000Z');
  });

  describe('NYSE holidays', () => {
    it('reports no session on Thanksgiving, and one on the day before', () => {
      expect(calendar.isTradingDay(new Date('2026-11-26T17:00:00Z'))).toBe(false);
      expect(calendar.isOpen(new Date('2026-11-26T17:00:00Z'))).toBe(false);
      expect(calendar.isOpen(new Date('2026-11-25T17:00:00Z'))).toBe(true);
    });

    it('closes fully on an observed holiday that moved off a weekend', () => {
      expect(calendar.isTradingDay(new Date('2026-07-03T16:00:00Z'))).toBe(false);
      expect(calendar.isOpen(new Date('2026-07-02T16:00:00Z'))).toBe(true);
    });

    it('treats 2027-12-24 as a full closure, not a 13:00 early close', () => {
      expect(calendar.isTradingDay(new Date('2027-12-24T17:00:00Z'))).toBe(false);
      expect(calendar.isOpen(new Date('2027-12-24T17:00:00Z'))).toBe(false);
      expect(calendar.isOpen(new Date('2027-12-23T20:00:00Z'))).toBe(true);
    });

    it('agrees with itself: isOpen never reports a session isTradingDay denies', () => {
      for (let day = 0; day < 365; day++) {
        const instant = new Date(Date.UTC(2026, 0, 1, 17, 0) + day * 86_400_000);

        if (calendar.isOpen(instant)) {
          expect(calendar.isTradingDay(instant)).toBe(true);
        }
      }
    });

    it('steps sessionEnd over a holiday to the next real close', () => {
      expect(calendar.sessionEnd(new Date('2026-12-24T19:00:00Z'))?.toISOString()).toBe(
        '2026-12-28T21:00:00.000Z',
      );
    });

    it('resolves sessionStart on a holiday to the prior trading close', () => {
      expect(calendar.sessionStart(new Date('2026-12-25T15:00:00Z'))).toEqual(
        new Date('2026-12-24T18:00:00Z'),
      );
    });
  });

  it('is closed at the weekend', () => {
    expect(calendar.isOpen(new Date('2026-07-18T17:00:00Z'))).toBe(false);
    expect(calendar.isTradingDay(new Date('2026-07-18T17:00:00Z'))).toBe(false);
  });

  it('resolves sessions in Eastern time across DST, not a fixed UTC offset', () => {
    expect(calendar.isOpen(new Date('2026-01-14T14:30:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-01-14T14:29:59Z'))).toBe(false);
    expect(calendar.isOpen(new Date('2026-01-14T13:30:00Z'))).toBe(false);
  });

  it('counts a weekday as a trading day even outside session hours (daily bars)', () => {
    expect(calendar.isTradingDay(new Date('2026-07-15T04:00:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-07-15T04:00:00Z'))).toBe(false);
  });

  describe('sessionStart', () => {
    it('returns yesterday’s 16:00 ET close from inside today’s session', () => {
      expect(calendar.sessionStart(new Date('2026-07-15T14:00:00Z'))).toEqual(
        new Date('2026-07-14T20:00:00Z'),
      );
    });

    it('returns yesterday’s close pre-open, not today’s future close', () => {
      expect(calendar.sessionStart(new Date('2026-07-15T13:00:00Z'))).toEqual(
        new Date('2026-07-14T20:00:00Z'),
      );
    });

    it('returns today’s close once the bell has rung', () => {
      expect(calendar.sessionStart(new Date('2026-07-15T21:00:00Z'))).toEqual(
        new Date('2026-07-15T20:00:00Z'),
      );
    });

    it('treats the close instant as the START of the new session (half-open, matching isOpen)', () => {
      const close = new Date('2026-07-15T20:00:00Z');

      expect(calendar.isOpen(close)).toBe(false);
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
      expect(calendar.sessionStart(new Date('2026-07-18T21:00:00Z'))).toEqual(
        new Date('2026-07-17T20:00:00Z'),
      );
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
      expect(calendar.sessionStart(new Date('2026-07-20T13:00:00Z'))).toEqual(
        new Date('2026-07-17T20:00:00Z'),
      );
    });

    it('resolves 16:00 EST (21:00 UTC) in winter, not the summer 20:00 UTC close', () => {
      expect(calendar.sessionStart(new Date('2026-01-14T15:00:00Z'))).toEqual(
        new Date('2026-01-13T21:00:00Z'),
      );
    });

    it('spans the spring-forward transition — EDT instant, EST close', () => {
      expect(calendar.sessionStart(new Date('2026-03-09T14:00:00Z'))).toEqual(
        new Date('2026-03-06T21:00:00Z'),
      );
    });

    it('spans the fall-back transition — EST instant, EDT close', () => {
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
        expect(instant.getTime() - start.getTime()).toBeLessThan(4 * 86_400_000);
        expect(calendar.isTradingDay(start)).toBe(true);
      }
    });
  });
});

describe('the exhausted-search contract (#691)', () => {
  class NeverTradingCalendar extends UsEquityRegularHoursCalendar {
    override isTradingDay(_instant: Date): boolean {
      return false;
    }
  }

  const calendar = new NeverTradingCalendar();
  const instant = new Date('2026-07-15T18:00:00Z');

  it('throws rather than returning null when no close can be found', () => {
    expect(() => calendar.sessionEnd(instant)).toThrow(/No US equity session close found/);
  });

  it('names the search bound and the instant, so the fault is diagnosable', () => {
    expect(() => calendar.sessionEnd(instant)).toThrow(/within 10 days after/);
    expect(() => calendar.sessionStart(instant)).toThrow(/within 10 days before/);
  });

  it('still returns null for a venue that genuinely has no close', () => {
    expect(new AlwaysOpenCalendar().sessionEnd(instant)).toBeNull();
  });

  it('throws when no session open can be found', () => {
    expect(() => calendar.nextSessionOpen(instant)).toThrow(
      /No US equity session open found within 10 days after 2026-07-15T18:00:00.000Z/,
    );
  });
});

describe('UsEquityRegularHoursCalendar.nextSessionOpen', () => {
  const calendar = new UsEquityRegularHoursCalendar();
  const open = (iso: string) => calendar.nextSessionOpen(new Date(iso)).toISOString();

  it('is the same morning before the bell', () => {
    expect(open('2026-07-15T08:00:00Z')).toBe('2026-07-15T13:30:00.000Z');
  });

  it('is the next session once the bell has rung', () => {
    expect(open('2026-07-15T13:30:00Z')).toBe('2026-07-16T13:30:00.000Z');
    expect(open('2026-07-15T21:00:00Z')).toBe('2026-07-16T13:30:00.000Z');
  });

  it('skips a weekend and a holiday', () => {
    expect(open('2026-11-25T22:00:00Z')).toBe('2026-11-27T14:30:00.000Z');
    expect(open('2026-07-17T21:00:00Z')).toBe('2026-07-20T13:30:00.000Z');
  });

  it('follows the ET offset across the DST change', () => {
    expect(open('2026-11-01T12:00:00Z')).toBe('2026-11-02T14:30:00.000Z');
  });

  it('refuses a date past the hand-entered table', () => {
    expect(() => calendar.nextSessionOpen(new Date('2028-03-14T15:00:00Z'))).toThrow(
      /past the hand-entered table/,
    );
  });
});

describe('the hand-entered table coverage cliff (#684)', () => {
  const calendar = new UsEquityRegularHoursCalendar();
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
    expect(calendar.isTradingDay(beyondCoverage)).toBe(true);
  });

  it('does not throw for the last covered date', () => {
    expect(() => calendar.isOpen(new Date('2027-12-31T15:00:00Z'))).not.toThrow();
  });
});

describe('the LSE table coverage cliff (#1378)', () => {
  const calendar = new LseRegularHoursCalendar();
  const beyondCoverage = new Date(
    `${Number(LSE_TABLE_COVERAGE_END.slice(0, 4)) + 1}-03-14T15:00:00Z`,
  );

  it('LSE_TABLE_COVERAGE_END currently equals both checked-through dates', () => {
    expect(LSE_TABLE_COVERAGE_END).toBe('2028-12-31');
    expect(LSE_HOLIDAYS_CHECKED_THROUGH).toBe(LSE_TABLE_COVERAGE_END);
    expect(LSE_HALF_DAYS_CHECKED_THROUGH).toBe(LSE_TABLE_COVERAGE_END);
  });

  it('no LSE_HOLIDAYS entry exceeds LSE_HOLIDAYS_CHECKED_THROUGH', () => {
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
    it('returns the earlier date regardless of argument order', () => {
      expect(earlierOf('2027-01-01', '2027-06-30')).toBe('2027-01-01');
      expect(earlierOf('2027-06-30', '2027-01-01')).toBe('2027-01-01');
    });

    it('returns the shared value when both dates are equal', () => {
      expect(earlierOf('2027-03-15', '2027-03-15')).toBe('2027-03-15');
    });
  });

  it('does NOT throw on isOpen past the coverage end — the resolver stays total', () => {
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
    const unmodelledHalfDay = new Date(
      `${Number(LSE_TABLE_COVERAGE_END.slice(0, 4)) + 2}-12-24T15:00:00Z`,
    );
    expect(unmodelledHalfDay.getUTCDay()).toBeGreaterThanOrEqual(1);
    expect(unmodelledHalfDay.getUTCDay()).toBeLessThanOrEqual(5);

    expect(calendar.coversCloseFor(unmodelledHalfDay)).toBe(false);
    expect(() => calendar.sessionEnd(unmodelledHalfDay)).not.toThrow();
  });

  it('does not throw for the last covered date', () => {
    expect(() => calendar.isOpen(new Date(`${LSE_TABLE_COVERAGE_END}T15:00:00Z`))).not.toThrow();
  });

  it('resolves a substitute day in the extended range as a non-trading day (#1379)', () => {
    const substituteDay = new Date('2028-01-03T12:00:00Z');
    const followingWeekday = new Date('2028-01-04T12:00:00Z');

    expect(calendar.isTradingDay(substituteDay)).toBe(false);
    expect(calendar.isOpen(substituteDay)).toBe(false);
    expect(calendar.isTradingDay(followingWeekday)).toBe(true);
  });

  it('does not add a 2028 half-day — 24 and 31 December 2028 both fall on a Sunday', () => {
    expect(new Date('2028-12-24T12:00:00Z').getUTCDay()).toBe(0);
    expect(new Date('2028-12-31T12:00:00Z').getUTCDay()).toBe(0);
    expect(LSE_HALF_DAYS.has('2028-12-24')).toBe(false);
    expect(LSE_HALF_DAYS.has('2028-12-31')).toBe(false);
  });
});
