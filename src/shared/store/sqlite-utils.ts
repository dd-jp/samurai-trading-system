/**
 * Shared SQLite error guards for the store family (extracted from the
 * verbatim-triplicated copies in the execution/trader/debate-engine stores —
 * code-review 2026-08-01, H4).
 */

/**
 * True when `better-sqlite3` rejected an INSERT on a primary-key collision.
 *
 * Walks the `cause` chain: the stores catch the raw driver error and rethrow a
 * message-bearing `Error(..., { cause })`, so callers above a store see the
 * wrapper, not the `code`-carrying original.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ((current as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return true;
    }
  }
  return false;
}
