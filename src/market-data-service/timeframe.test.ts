import { closeTimeOf, isDailyTimeframe, timeframeToMs } from './timeframe.js';

describe('timeframeToMs', () => {
  it('parses the timeframes the service keys bars on', () => {
    expect(timeframeToMs('1m')).toBe(60_000);
    expect(timeframeToMs('5m')).toBe(300_000);
    expect(timeframeToMs('1h')).toBe(3_600_000);
    expect(timeframeToMs('1d')).toBe(86_400_000);
  });

  it('throws rather than guessing at an unparseable timeframe', () => {
    expect(() => timeframeToMs('1w')).toThrow(/Unsupported timeframe/);
    expect(() => timeframeToMs('hourly')).toThrow(/Unsupported timeframe/);
    expect(() => timeframeToMs('0m')).toThrow(/must be positive/);
  });
});

describe('isDailyTimeframe', () => {
  it('distinguishes whole-session bars from intraday bars', () => {
    expect(isDailyTimeframe('1d')).toBe(true);
    expect(isDailyTimeframe('1h')).toBe(false);
    expect(isDailyTimeframe('5m')).toBe(false);
  });
});

describe('closeTimeOf', () => {
  it('derives close_time from a source-native open timestamp', () => {
    const closeTime = closeTimeOf(new Date('2026-07-15T10:00:00Z'), '1h');

    expect(closeTime.toISOString()).toBe('2026-07-15T11:00:00.000Z');
  });

  it('leaves the source open_time untouched', () => {
    const openTime = new Date('2026-07-15T10:00:00Z');
    closeTimeOf(openTime, '1h');

    expect(openTime.toISOString()).toBe('2026-07-15T10:00:00.000Z');
  });
});
