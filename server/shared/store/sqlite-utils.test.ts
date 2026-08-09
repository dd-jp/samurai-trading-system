import { isUniqueConstraintError } from './sqlite-utils.js';

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
