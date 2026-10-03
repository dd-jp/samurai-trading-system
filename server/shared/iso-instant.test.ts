import { parseIsoInstant } from './iso-instant.js';

describe('parseIsoInstant', () => {
  it('round-trips a canonical UTC instant with its milliseconds', () => {
    const iso = '2026-10-03T14:30:05.123Z';
    const parsed = parseIsoInstant(iso);
    expect(parsed.getTime()).toBe(Date.UTC(2026, 9, 3, 14, 30, 5, 123));
    expect(parsed.toISOString()).toBe(iso);
  });

  it('round-trips a Date through its ISO string without losing a millisecond', () => {
    const original = new Date(Date.UTC(1999, 11, 31, 23, 59, 59, 999));
    expect(parseIsoInstant(original.toISOString()).getTime()).toBe(original.getTime());
  });

  it.each([
    ['empty', ''],
    ['garbage', 'not a date'],
    ['date only', '2026-10-03'],
    ['no milliseconds', '2026-10-03T14:30:05Z'],
    ['offset instead of Z', '2026-10-03T15:30:05.123+01:00'],
    ['no zone', '2026-10-03T14:30:05.123'],
    ['microseconds', '2026-10-03T14:30:05.123456Z'],
    ['lower-case z', '2026-10-03T14:30:05.123z'],
    ['impossible day', '2026-02-30T00:00:00.000Z'],
    ['epoch millis', '1790000000000'],
    ['surrounding whitespace', ' 2026-10-03T14:30:05.123Z'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseIsoInstant(value)).toThrow(RangeError);
    expect(() => parseIsoInstant(value)).toThrow(JSON.stringify(value));
  });
});
