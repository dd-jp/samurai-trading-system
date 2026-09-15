/**
 * `sessionEnd` and the LSE calendar (#668).
 *
 * A separate file from `trading-calendar.test.ts` because these are money-path
 * assertions rather than ingestion ones: `sessionEnd` is what ADR-0014's
 * "intraday, flat by market close, no overnight carry" resolves through, so a
 * wrong boundary here is a position carried overnight, not a mis-filtered bar.
 */
import {
  AlwaysOpenCalendar,
  LseRegularHoursCalendar,
  UsEquityRegularHoursCalendar,
} from './trading-calendar.js';

describe('AlwaysOpenCalendar.sessionEnd', () => {
  it('returns null — crypto has no close, and #667 has not decided what it should mean', () => {
    expect(new AlwaysOpenCalendar().sessionEnd(new Date('2026-07-15T12:00:00Z'))).toBeNull();
  });

  it('does NOT reuse the 00:00 UTC accounting boundary as a trading instruction', () => {
    const calendar = new AlwaysOpenCalendar();
    const instant = new Date('2026-07-15T12:00:00Z');

    // `sessionStart` has a real answer; `sessionEnd` deliberately does not. An
    // implementation returning `sessionStart + 1 day` here would silently pick
    // one of #667's four options on David's behalf, turning an accounting
    // convention into a midnight-UTC flatten of the crypto book
    expect(calendar.sessionStart(instant)).toBeInstanceOf(Date);
    expect(calendar.sessionEnd(instant)).toBeNull();
  });
});

describe('UsEquityRegularHoursCalendar.sessionEnd', () => {
  const calendar = new UsEquityRegularHoursCalendar();

  it('returns the same day 16:00 ET when asked during the session', () => {
    // 2026-07-15 is a Wednesday. 14:00 UTC = 10:00 EDT, mid-session.
    expect(calendar.sessionEnd(new Date('2026-07-15T14:00:00Z'))?.toISOString()).toBe(
      '2026-07-15T20:00:00.000Z',
    );
  });

  it('returns the NEXT close when asked exactly at a close', () => {
    // Strictly-after, so "when must I be flat by" is answerable at every
    // instant rather than handing back a boundary already in the past
    expect(calendar.sessionEnd(new Date('2026-07-15T20:00:00Z'))?.toISOString()).toBe(
      '2026-07-16T20:00:00.000Z',
    );
  });

  it('skips the weekend', () => {
    // Friday 2026-07-17 after the close → Monday the 20th
    expect(calendar.sessionEnd(new Date('2026-07-17T21:00:00Z'))?.toISOString()).toBe(
      '2026-07-20T20:00:00.000Z',
    );
  });

  it('tracks DST rather than a fixed offset', () => {
    // January: EST is UTC-5, so 16:00 ET is 21:00 UTC, not July's 20:00
    expect(calendar.sessionEnd(new Date('2026-01-14T14:00:00Z'))?.toISOString()).toBe(
      '2026-01-14T21:00:00.000Z',
    );
  });
});

describe('LseRegularHoursCalendar', () => {
  const calendar = new LseRegularHoursCalendar();

  it('closes at 16:30 London', () => {
    // 2026-07-15 Wednesday, BST (UTC+1) → 16:30 London = 15:30 UTC
    expect(calendar.sessionEnd(new Date('2026-07-15T10:00:00Z'))?.toISOString()).toBe(
      '2026-07-15T15:30:00.000Z',
    );
  });

  it('tracks GMT/BST rather than a fixed offset', () => {
    // January: GMT, so 16:30 London = 16:30 UTC
    expect(calendar.sessionEnd(new Date('2026-01-14T10:00:00Z'))?.toISOString()).toBe(
      '2026-01-14T16:30:00.000Z',
    );
  });

  it('is open 08:00-16:30 and shut either side', () => {
    expect(calendar.isOpen(new Date('2026-07-15T06:59:00Z'))).toBe(false); // 07:59 London
    expect(calendar.isOpen(new Date('2026-07-15T07:00:00Z'))).toBe(true); // 08:00 London
    expect(calendar.isOpen(new Date('2026-07-15T15:29:00Z'))).toBe(true); // 16:29 London
    // Half-open at the close, matching the port's convention
    expect(calendar.isOpen(new Date('2026-07-15T15:30:00Z'))).toBe(false);
  });

  it('treats a UK bank holiday as a non-trading day and skips it', () => {
    const boxingDaySubstitute = new Date('2026-12-28T10:00:00Z');

    expect(calendar.isTradingDay(boxingDaySubstitute)).toBe(false);
    expect(calendar.isOpen(boxingDaySubstitute)).toBe(false);

    // Christmas Day (Fri 25th) and the Boxing Day substitute (Mon 28th) are
    // both shut, so the close after the 24th half-day is Tuesday the 29th
    expect(calendar.sessionEnd(new Date('2026-12-24T13:00:00Z'))?.toISOString()).toBe(
      '2026-12-29T16:30:00.000Z',
    );
  });

  /**
   * The case that motivated modelling half-days at all. A holiday is a day
   * with no session and nothing to flatten; a half-day is a REAL trading day
   * whose close moves four hours earlier, so a calendar blind to it would
   * schedule a 16:25 flatten for a market that shut at 12:30 and carry the
   * position through the break — exactly the overnight carry ADR-0014 forbids.
   */
  it('closes a half-day at 12:30, not 16:30', () => {
    // Christmas Eve 2026, GMT → 12:30 London = 12:30 UTC
    expect(calendar.sessionEnd(new Date('2026-12-24T09:00:00Z'))?.toISOString()).toBe(
      '2026-12-24T12:30:00.000Z',
    );

    // And the session really is over at 12:30 that day...
    expect(calendar.isOpen(new Date('2026-12-24T12:30:00Z'))).toBe(false);
    expect(calendar.isOpen(new Date('2026-12-24T12:29:00Z'))).toBe(true);
    // ...while an ordinary day is still open at the same wall-clock time
    expect(calendar.isOpen(new Date('2026-07-15T12:29:00Z'))).toBe(true);
  });

  it('skips the weekend', () => {
    // Friday 2026-07-17 after the close → Monday the 20th
    expect(calendar.sessionEnd(new Date('2026-07-17T16:00:00Z'))?.toISOString()).toBe(
      '2026-07-20T15:30:00.000Z',
    );
  });

  it('sessionStart is the most recent close at or before the instant', () => {
    expect(calendar.sessionStart(new Date('2026-07-15T10:00:00Z')).toISOString()).toBe(
      '2026-07-14T15:30:00.000Z',
    );
  });

  it('differs from the US calendar — the two venues do not share a boundary', () => {
    // #656 measured LSE 08:00-16:30 London against US 14:30-21:00 UTC, a
    // two-hour overlap. That is why the flatten rule had to be an OFFSET
    // resolved through the instrument's own calendar rather than one shared
    // wall-clock constant
    const instant = new Date('2026-07-15T10:00:00Z');

    expect(calendar.sessionEnd(instant)?.toISOString()).not.toBe(
      new UsEquityRegularHoursCalendar().sessionEnd(instant)?.toISOString(),
    );
  });
});
