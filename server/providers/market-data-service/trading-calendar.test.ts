import { AlwaysOpenCalendar, UsEquityRegularHoursCalendar } from './trading-calendar.js';

describe('AlwaysOpenCalendar', () => {
  it('is open at every instant — crypto trades 24/7', () => {
    const calendar = new AlwaysOpenCalendar();

    // 03:00 UTC Sunday: no equity session anywhere near it.
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
      // 2026-07-12T22:00Z is 18:00 ET the same evening; the UTC day is still the 12th.
      expect(calendar.sessionStart(new Date('2026-07-12T22:00:00Z'))).toEqual(
        new Date('2026-07-12T00:00:00Z'),
      );
      // 2026-07-13T02:00Z is 22:00 ET on the 12th, but the UTC day has rolled.
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

  it('is closed at the weekend', () => {
    // Saturday 2026-07-18, mid-session-hours if it were a weekday.
    expect(calendar.isOpen(new Date('2026-07-18T17:00:00Z'))).toBe(false);
    expect(calendar.isTradingDay(new Date('2026-07-18T17:00:00Z'))).toBe(false);
  });

  it('resolves sessions in Eastern time across DST, not a fixed UTC offset', () => {
    // 2026-01-14 is a Wednesday in EST (UTC-5), so 09:30 ET = 14:30 UTC.
    expect(calendar.isOpen(new Date('2026-01-14T14:30:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-01-14T14:29:59Z'))).toBe(false);
    // The EDT open (13:30 UTC) must NOT be open in January.
    expect(calendar.isOpen(new Date('2026-01-14T13:30:00Z'))).toBe(false);
  });

  it('counts a weekday as a trading day even outside session hours (daily bars)', () => {
    // Midnight ET — where a daily bar is timestamped.
    expect(calendar.isTradingDay(new Date('2026-07-15T04:00:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-07-15T04:00:00Z'))).toBe(false);
  });

  // Every expectation below is a hand-computed literal UTC instant, never a value
  // derived from the implementation's own Intl machinery — a test that recomputes
  // the answer the same way the code does cannot catch a broken conversion.
  describe('sessionStart', () => {
    it('returns yesterday’s 16:00 ET close from inside today’s session', () => {
      // Wed 2026-07-15 10:00 EDT (14:00 UTC) -> Tue 2026-07-14 16:00 EDT.
      expect(calendar.sessionStart(new Date('2026-07-15T14:00:00Z'))).toEqual(
        new Date('2026-07-14T20:00:00Z'),
      );
    });

    it('returns yesterday’s close pre-open, not today’s future close', () => {
      // Wed 2026-07-15 09:00 EDT (13:00 UTC), before the bell.
      expect(calendar.sessionStart(new Date('2026-07-15T13:00:00Z'))).toEqual(
        new Date('2026-07-14T20:00:00Z'),
      );
    });

    it('returns today’s close once the bell has rung', () => {
      // Wed 2026-07-15 17:00 EDT (21:00 UTC), after hours.
      expect(calendar.sessionStart(new Date('2026-07-15T21:00:00Z'))).toEqual(
        new Date('2026-07-15T20:00:00Z'),
      );
    });

    it('treats the close instant as the START of the new session (half-open, matching isOpen)', () => {
      const close = new Date('2026-07-15T20:00:00Z'); // 16:00 ET exactly.

      // isOpen is half-open: the close instant is not inside the old session.
      expect(calendar.isOpen(close)).toBe(false);
      // sessionStart agrees: the accounting window that begins here is its own.
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
      // notional 16:00, so only the weekday check can rule Saturday out.
      expect(calendar.sessionStart(new Date('2026-07-18T21:00:00Z'))).toEqual(
        new Date('2026-07-17T20:00:00Z'),
      );
      // Sat 2026-07-18 13:00 EDT (17:00 UTC), before it.
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
      // Mon 2026-07-20 09:00 EDT (13:00 UTC).
      expect(calendar.sessionStart(new Date('2026-07-20T13:00:00Z'))).toEqual(
        new Date('2026-07-17T20:00:00Z'),
      );
    });

    it('resolves 16:00 EST (21:00 UTC) in winter, not the summer 20:00 UTC close', () => {
      // Wed 2026-01-14 10:00 EST (15:00 UTC) -> Tue 2026-01-13 16:00 EST = 21:00 UTC.
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
      // offset gets this wrong.
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
      // Mon 2026-03-09 17:00 EDT (21:00 UTC) -> that day's 16:00 EDT = 20:00 UTC.
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
        // Never more than four days back: a weekend is the widest weekday-only gap.
        expect(instant.getTime() - start.getTime()).toBeLessThan(4 * 86_400_000);
        expect(calendar.isTradingDay(start)).toBe(true);
      }
    });
  });
});
