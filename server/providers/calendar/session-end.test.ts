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

    expect(calendar.sessionStart(instant)).toBeInstanceOf(Date);
    expect(calendar.sessionEnd(instant)).toBeNull();
  });
});

describe('UsEquityRegularHoursCalendar.sessionEnd', () => {
  const calendar = new UsEquityRegularHoursCalendar();

  it('returns the same day 16:00 ET when asked during the session', () => {
    expect(calendar.sessionEnd(new Date('2026-07-15T14:00:00Z'))?.toISOString()).toBe(
      '2026-07-15T20:00:00.000Z',
    );
  });

  it('returns the NEXT close when asked exactly at a close', () => {
    expect(calendar.sessionEnd(new Date('2026-07-15T20:00:00Z'))?.toISOString()).toBe(
      '2026-07-16T20:00:00.000Z',
    );
  });

  it('skips the weekend', () => {
    expect(calendar.sessionEnd(new Date('2026-07-17T21:00:00Z'))?.toISOString()).toBe(
      '2026-07-20T20:00:00.000Z',
    );
  });

  it('tracks DST rather than a fixed offset', () => {
    expect(calendar.sessionEnd(new Date('2026-01-14T14:00:00Z'))?.toISOString()).toBe(
      '2026-01-14T21:00:00.000Z',
    );
  });
});

describe('LseRegularHoursCalendar', () => {
  const calendar = new LseRegularHoursCalendar();

  it('closes at 16:30 London', () => {
    expect(calendar.sessionEnd(new Date('2026-07-15T10:00:00Z'))?.toISOString()).toBe(
      '2026-07-15T15:30:00.000Z',
    );
  });

  it('tracks GMT/BST rather than a fixed offset', () => {
    expect(calendar.sessionEnd(new Date('2026-01-14T10:00:00Z'))?.toISOString()).toBe(
      '2026-01-14T16:30:00.000Z',
    );
  });

  it('is open 08:00-16:30 and shut either side', () => {
    expect(calendar.isOpen(new Date('2026-07-15T06:59:00Z'))).toBe(false);
    expect(calendar.isOpen(new Date('2026-07-15T07:00:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-07-15T15:29:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-07-15T15:30:00Z'))).toBe(false);
  });

  it('treats a UK bank holiday as a non-trading day and skips it', () => {
    const boxingDaySubstitute = new Date('2026-12-28T10:00:00Z');

    expect(calendar.isTradingDay(boxingDaySubstitute)).toBe(false);
    expect(calendar.isOpen(boxingDaySubstitute)).toBe(false);

    expect(calendar.sessionEnd(new Date('2026-12-24T13:00:00Z'))?.toISOString()).toBe(
      '2026-12-29T16:30:00.000Z',
    );
  });

  it('closes a half-day at 12:30, not 16:30', () => {
    expect(calendar.sessionEnd(new Date('2026-12-24T09:00:00Z'))?.toISOString()).toBe(
      '2026-12-24T12:30:00.000Z',
    );

    expect(calendar.isOpen(new Date('2026-12-24T12:30:00Z'))).toBe(false);
    expect(calendar.isOpen(new Date('2026-12-24T12:29:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-07-15T12:29:00Z'))).toBe(true);
  });

  it('skips the weekend', () => {
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
    const instant = new Date('2026-07-15T10:00:00Z');

    expect(calendar.sessionEnd(instant)?.toISOString()).not.toBe(
      new UsEquityRegularHoursCalendar().sessionEnd(instant)?.toISOString(),
    );
  });
});
