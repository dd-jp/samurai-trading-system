import { describe, expect, it } from 'vitest';
import {
  barWidth,
  formatClockUtc,
  formatCount,
  formatDateUtc,
  formatFixed,
  formatHeld,
  formatPercent,
  formatPrice,
  formatQty,
  formatSignedGbp,
  formatSignedPercent,
  formatSignedR,
  formatSignedUsd,
  formatStageDuration,
  formatUsd,
  formatWhen,
} from './format.ts';

describe('formatStageDuration', () => {
  it('renders null as an em dash (an unknown duration is not zero)', () => {
    expect(formatStageDuration(null)).toBe('—');
  });

  it('renders NaN and Infinity as an em dash, never NaNm NaNs', () => {
    // PR #582 review: NaN compares false against every branch condition, so
    // it fell through to the minutes branch instead of the unknown-value path
    expect(formatStageDuration(Number.NaN)).toBe('—');
    expect(formatStageDuration(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatStageDuration(Number.NEGATIVE_INFINITY)).toBe('—');
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

  it('carries rounded seconds into the minute rather than rendering 60s', () => {
    // PR #582 review: the seconds were rounded independently of the floored
    // minutes, so these rendered '59m 60s' / '12m 60s'
    expect(formatStageDuration(3_599_500)).toBe('60m 00s');
    expect(formatStageDuration(779_500)).toBe('13m 00s');
  });

  it('promotes a sub-minute duration that rounds up to 60s into the minute branch', () => {
    // PR #582 review: `toFixed(1)` rounded these up inside the seconds
    // branch, rendering '60.0s' just below the 60_000ms boundary
    expect(formatStageDuration(59_950)).toBe('1m 00s');
    expect(formatStageDuration(59_999)).toBe('1m 00s');
    expect(formatStageDuration(59_949)).toBe('59.9s');
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

describe('formatSignedGbp', () => {
  it('always carries an explicit sign', () => {
    expect(formatSignedGbp(12.34)).toBe('+£12.34');
    expect(formatSignedGbp(-0.5)).toBe('−£0.50');
    expect(formatSignedGbp(0)).toBe('+£0.00');
  });

  it('treats negative zero as zero', () => {
    expect(formatSignedGbp(-0)).toBe('+£0.00');
  });

  it('groups thousands', () => {
    expect(formatSignedGbp(1234567.891)).toBe('+£1,234,567.89');
    expect(formatSignedGbp(-9876.5)).toBe('−£9,876.50');
  });

  it('renders non-finite input as an em dash, never +£NaN (#1596: never £0.00 for an absent figure)', () => {
    expect(formatSignedGbp(Number.NaN)).toBe('—');
    expect(formatSignedGbp(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatSignedGbp(Number.NEGATIVE_INFINITY)).toBe('—');
  });
});

describe('signed formatters — non-finite input', () => {
  it('renders NaN and Infinity as an em dash, never +$NaN', () => {
    // PR #582 review: the unknown-value contract formatStageDuration and
    // formatClockUtc keep must hold for money and R too
    expect(formatSignedUsd(Number.NaN)).toBe('—');
    expect(formatSignedUsd(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatSignedUsd(Number.NEGATIVE_INFINITY)).toBe('—');
    expect(formatSignedR(Number.NaN)).toBe('—');
    expect(formatSignedR(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatSignedR', () => {
  it('always carries an explicit sign and the R suffix', () => {
    expect(formatSignedR(1.25)).toBe('+1.25R');
    expect(formatSignedR(-0.4)).toBe('−0.40R');
    expect(formatSignedR(0)).toBe('+0.00R');
  });
});

// The display formatters added for the components (issue #538). Every one of
// them shares the unknown-value contract above: a value it cannot honestly
// display renders as the em dash, never as `NaN` and never as a blank

describe('unsigned formatters', () => {
  it('renders USD with grouping and two decimals', () => {
    expect(formatUsd(1_234.5)).toBe('$1,234.50');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('renders fixed-precision figures and counts', () => {
    expect(formatFixed(0.8412)).toBe('0.84');
    expect(formatFixed(260, 0)).toBe('260');
    expect(formatCount(1_900_000)).toBe('1,900,000');
  });

  it('renders a 0-1 fraction as a percentage', () => {
    expect(formatPercent(0.42, 0)).toBe('42%');
    expect(formatPercent(0.018, 2)).toBe('1.80%');
  });

  it('renders prices with grouping', () => {
    expect(formatPrice(61_240)).toBe('61,240.00');
  });

  it('renders every non-finite input as an em dash', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatUsd(bad)).toBe('—');
      expect(formatFixed(bad)).toBe('—');
      expect(formatCount(bad)).toBe('—');
      expect(formatPercent(bad)).toBe('—');
      expect(formatPrice(bad)).toBe('—');
    }
  });
});

describe('barWidth', () => {
  it('renders a fraction as a CSS percentage', () => {
    expect(barWidth(0.42)).toBe('42.0%');
    expect(barWidth(0)).toBe('0.0%');
  });

  it('clamps above the cap rather than painting over the page', () => {
    // A 300%-wide meter would overflow its neighbours; the over-cap fact is
    // carried by a word beside the meter instead
    expect(barWidth(3)).toBe('100.0%');
    expect(barWidth(-1)).toBe('0.0%');
  });

  it('returns null — not "0%" — for a value it cannot draw', () => {
    // Zero is a legitimate reading (nothing spent), so unknown must be
    // distinguishable from it: the caller renders a named state instead
    expect(barWidth(Number.NaN)).toBeNull();
    expect(barWidth(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatSignedPercent', () => {
  it('always carries a sign, with a true minus', () => {
    expect(formatSignedPercent(0.0187)).toBe('+1.87%');
    expect(formatSignedPercent(-0.004)).toBe('−0.40%');
    expect(formatSignedPercent(Number.NaN)).toBe('—');
  });
});

describe('formatQty', () => {
  it('prints whole units plainly and fractional fills to four places', () => {
    expect(formatQty(18)).toBe('18');
    expect(formatQty(2.4)).toBe('2.4');
    expect(formatQty(0.00025)).toBe('0.0003');
    expect(formatQty(1.00001)).toBe('1');
  });
});

describe('formatHeld', () => {
  it('reads minutes, then hours and minutes, then days', () => {
    expect(formatHeld('2026-08-07T06:30:00Z', '2026-08-07T07:11:00Z')).toBe('41m');
    expect(formatHeld('2026-08-07T06:30:00Z', '2026-08-07T07:42:00Z')).toBe('1h 12m');
    expect(formatHeld('2026-08-05T06:30:00Z', '2026-08-07T09:30:00Z')).toBe('2d 3h');
  });

  it('refuses a close before its open', () => {
    expect(formatHeld('2026-08-07T07:00:00Z', '2026-08-07T06:00:00Z')).toBe('—');
  });
});

describe('formatWhen / formatDateUtc', () => {
  it('shows the clock on the snapshot’s day and the date otherwise', () => {
    const asOf = '2026-08-07T12:00:00Z';
    expect(formatWhen('2026-08-07T08:00:00Z', asOf)).toBe('08:00:00Z');
    expect(formatWhen('2026-08-06T23:00:00Z', asOf)).toBe('2026-08-06');
    expect(formatDateUtc('garbage')).toBe('—');
  });
});
