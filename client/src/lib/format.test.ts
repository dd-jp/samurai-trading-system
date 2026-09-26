import { describe, expect, it } from 'vitest';
import { fixed, gbp, percent, quote, sizeStep, UNKNOWN, utcMinute } from './format.ts';

describe('money', () => {
  it('signs a loss with a true minus and pads to pence', () => {
    expect(gbp(-1234.5)).toBe('−£1,234.50');
    expect(gbp(0)).toBe('£0.00');
    expect(gbp(7)).toBe('£7.00');
  });

  it('shows the unknown mark for a missing or non-finite amount', () => {
    expect(gbp(null)).toBe(UNKNOWN);
    expect(gbp(Number.NaN)).toBe(UNKNOWN);
    expect(gbp(Number.POSITIVE_INFINITY)).toBe(UNKNOWN);
  });

  it('quotes in the instrument currency', () => {
    expect(quote(-2.5, 'USD')).toBe('−$2.50');
    expect(quote(2.5, 'GBP')).toBe('£2.50');
  });
});

describe('percent', () => {
  it('scales a fraction and signs a loss', () => {
    expect(percent(-0.0123)).toBe('−1.2%');
    expect(percent(0)).toBe('0.0%');
    expect(percent(0.5, 0)).toBe('50%');
  });

  it.each([null, Number.NaN])('shows the unknown mark for %s', (value) => {
    expect(percent(value)).toBe(UNKNOWN);
  });
});

describe('fixed', () => {
  it('signs a negative value and keeps zero unsigned', () => {
    expect(fixed(-1.234)).toBe('−1.23');
    expect(fixed(0)).toBe('0.00');
    expect(fixed(1.5, 1)).toBe('1.5');
  });

  it.each([null, Number.NaN])('shows the unknown mark for %s', (value) => {
    expect(fixed(value)).toBe(UNKNOWN);
  });
});

describe('utcMinute', () => {
  it('prints the UTC minute of a timestamp in any offset', () => {
    expect(utcMinute('2026-10-05T21:30:59+01:00')).toBe('2026-10-05 20:30Z');
  });

  it('shows the unknown mark for an unparseable timestamp', () => {
    expect(utcMinute('not a date')).toBe(UNKNOWN);
  });
});

describe('sizeStep', () => {
  it.each([
    [1, '1'],
    [0.5, '½'],
    [0.25, '¼'],
    [0, 'halted'],
    [0.75, '0.75'],
  ])('names the multiplier %s as %s', (multiplier, label) => {
    expect(sizeStep(multiplier)).toBe(label);
  });
});
