import { describe, expect, it } from 'vitest';
import { AlwaysOpenCalendar, UsEquityRegularHoursCalendar } from './trading-calendar.js';

describe('AlwaysOpenCalendar', () => {
  it('is open at every instant — crypto trades 24/7', () => {
    const calendar = new AlwaysOpenCalendar();

    // 03:00 UTC Sunday: no equity session anywhere near it.
    expect(calendar.isOpen(new Date('2026-07-12T03:00:00Z'))).toBe(true);
    expect(calendar.isTradingDay(new Date('2026-07-12T03:00:00Z'))).toBe(true);
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
});
