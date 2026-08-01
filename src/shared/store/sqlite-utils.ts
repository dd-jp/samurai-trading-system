/**
 * Shared SQLite error guards for the store family (extracted from the
 * verbatim-triplicated copies in the execution/trader/debate-engine stores —
 * code-review 2026-08-01, H4).
 */

/** True when `better-sqlite3` rejected an INSERT on a primary-key collision. */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  );
}
