import { describe, expect, it } from 'vitest';
import { formatDateUtc, formatHeld, formatQty, formatSignedPercent, formatWhen } from './format.ts';

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
