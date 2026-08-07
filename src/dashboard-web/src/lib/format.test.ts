import { describe, expect, it } from 'vitest';
import { formatClockUtc, formatSignedR, formatSignedUsd, formatStageDuration } from './format.ts';

describe('formatStageDuration', () => {
  it('renders null as an em dash (an unknown duration is not zero)', () => {
    expect(formatStageDuration(null)).toBe('—');
  });

  it('renders sub-second durations in milliseconds', () => {
    expect(formatStageDuration(0)).toBe('0ms');
    expect(formatStageDuration(850)).toBe('850ms');
    expect(formatStageDuration(999)).toBe('999ms');
  });

  it('renders sub-minute durations in seconds with one decimal', () => {
    expect(formatStageDuration(1_000)).toBe('1.0s');
    expect(formatStageDuration(2_450)).toBe('2.5s');
    expect(formatStageDuration(59_940)).toBe('59.9s');
  });

  it('renders minute-scale durations as m + zero-padded seconds', () => {
    expect(formatStageDuration(60_000)).toBe('1m 00s');
    expect(formatStageDuration(65_000)).toBe('1m 05s');
    expect(formatStageDuration(754_000)).toBe('12m 34s');
  });
});

describe('formatClockUtc', () => {
  it('renders an ISO timestamp as HH:MM:SSZ in UTC', () => {
    expect(formatClockUtc('2026-08-07T12:00:00.000Z')).toBe('12:00:00Z');
    expect(formatClockUtc('2026-08-07T09:05:07.123Z')).toBe('09:05:07Z');
  });

  it('normalizes a non-UTC offset to UTC', () => {
    expect(formatClockUtc('2026-08-07T13:00:00.000+01:00')).toBe('12:00:00Z');
  });

  it('renders an unparseable timestamp as an em dash, never NaN', () => {
    expect(formatClockUtc('not a timestamp')).toBe('—');
  });
});

describe('formatSignedUsd', () => {
  it('always carries an explicit sign', () => {
    expect(formatSignedUsd(12.34)).toBe('+$12.34');
    expect(formatSignedUsd(-0.5)).toBe('−$0.50');
    expect(formatSignedUsd(0)).toBe('+$0.00');
  });

  it('treats negative zero as zero', () => {
    expect(formatSignedUsd(-0)).toBe('+$0.00');
  });

  it('groups thousands', () => {
    expect(formatSignedUsd(1234567.891)).toBe('+$1,234,567.89');
    expect(formatSignedUsd(-9876.5)).toBe('−$9,876.50');
  });
});

describe('formatSignedR', () => {
  it('always carries an explicit sign and the R suffix', () => {
    expect(formatSignedR(1.25)).toBe('+1.25R');
    expect(formatSignedR(-0.4)).toBe('−0.40R');
    expect(formatSignedR(0)).toBe('+0.00R');
  });
});
