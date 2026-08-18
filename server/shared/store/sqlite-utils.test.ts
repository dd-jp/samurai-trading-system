import {
  fromStoredTimestamp,
  fromStoredTimestampOrNull,
  isUniqueConstraintError,
  toStoredTimestamp,
  toStoredTimestampOrNull,
} from './sqlite-utils.js';

/** The shape better-sqlite3 throws on a PK collision. */
function driverError(): Error {
  const error = new Error('UNIQUE constraint failed: open_positions.idempotency_key');
  (error as NodeJS.ErrnoException).code = 'SQLITE_CONSTRAINT_PRIMARYKEY';
  return error;
}

describe('isUniqueConstraintError', () => {
  it('recognizes the raw driver error', () => {
    expect(isUniqueConstraintError(driverError())).toBe(true);
  });

  // The stores rethrow a message-bearing wrapper, so callers above a store
  // never see the code-carrying original (PR #290 review, deepseek).
  it('recognizes a constraint error wrapped by a store', () => {
    const wrapped = new Error('SqliteExecutionStore.writeAheadPosition: ...', {
      cause: driverError(),
    });
    expect(isUniqueConstraintError(wrapped)).toBe(true);
  });

  it('rejects an unrelated failure, wrapped or not', () => {
    const disk = new Error('database or disk is full');
    expect(isUniqueConstraintError(disk)).toBe(false);
    expect(isUniqueConstraintError(new Error('write-ahead failed', { cause: disk }))).toBe(false);
  });

  it('rejects non-Error values', () => {
    expect(isUniqueConstraintError('SQLITE_CONSTRAINT_PRIMARYKEY')).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });
});

describe('the timestamp round-trip (#837 M7)', () => {
  it('writes the fixed-width ISO-8601 UTC form', () => {
    expect(toStoredTimestamp(new Date(Date.UTC(2026, 7, 18, 9, 30, 0, 250)))).toBe(
      '2026-08-18T09:30:00.250Z',
    );
  });

  it('round-trips a Date without losing a millisecond', () => {
    const original = new Date('2026-08-18T09:30:00.007Z');
    expect(fromStoredTimestamp(toStoredTimestamp(original)).getTime()).toBe(original.getTime());
  });

  // Fixed width is what makes MAX()/BETWEEN over the stored TEXT chronological.
  it('renders every timestamp at the same width, so TEXT order is time order', () => {
    const written = [
      new Date('2026-01-02T03:04:05.006Z'),
      new Date('2026-11-12T13:14:15.160Z'),
      new Date('2025-12-31T23:59:59.999Z'),
    ].map(toStoredTimestamp);

    expect(new Set(written.map((text) => text.length))).toEqual(new Set([24]));
    expect([...written].sort()).toEqual([
      '2025-12-31T23:59:59.999Z',
      '2026-01-02T03:04:05.006Z',
      '2026-11-12T13:14:15.160Z',
    ]);
  });

  // The expanded-year form ("+010000-...") sorts before every ordinary row, so
  // the width check rejects it rather than letting it poison an ordering query.
  it('refuses a year outside the fixed-width range', () => {
    expect(() => toStoredTimestamp(new Date(Date.UTC(10000, 0, 1)))).toThrow(/fixed-width/);
  });

  // Left exactly as `Date.prototype.toISOString` has always thrown it — the
  // helper adds no wrapping of its own.
  it('lets an invalid Date throw the RangeError it always threw', () => {
    expect(() => toStoredTimestamp(new Date('not a date'))).toThrow(RangeError);
  });

  it('passes null through on both sides of a nullable column', () => {
    expect(toStoredTimestampOrNull(null)).toBeNull();
    expect(fromStoredTimestampOrNull(null)).toBeNull();
    expect(toStoredTimestampOrNull(new Date('2026-08-18T09:30:00.000Z'))).toBe(
      '2026-08-18T09:30:00.000Z',
    );
    expect(fromStoredTimestampOrNull('2026-08-18T09:30:00.000Z')).toEqual(
      new Date('2026-08-18T09:30:00.000Z'),
    );
  });
});
