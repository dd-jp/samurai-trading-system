/**
 * Shared SQLite helpers for the store family — error guards (extracted from the
 * verbatim-triplicated copies in the execution/trader/debate-engine stores —
 * code-review 2026-08-01, H4) and the timestamp round-trip (#837 M7, from
 * #289's finding that the `sqlite-*-store.ts` classes each re-spell the same
 * `Date.toISOString()` / `new Date(row.x)` convention).
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

/**
 * A timestamp in the store's on-disk form: a fixed-width ISO-8601 UTC string,
 * exactly `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * Branded so the type records *which* helper produced it. The brand documents
 * provenance; it does not make a non-conforming write impossible, because
 * `better-sqlite3`'s `.run(...)` binds loose values (see #837's M9 note).
 */
export type StoredTimestamp = string & { readonly __storedTimestamp: unique symbol };

/**
 * The one spelling every timestamp column is allowed to hold. Fixed width is
 * the load-bearing part, not the ISO-ness: `sqlite-shared-store.ts` reads
 * `MAX(timestamp)` over the stored TEXT and gets a chronological answer *only*
 * because every row is the same width in the same zone. A single row written
 * as `2026-08-18T09:00:00Z` (no milliseconds) or in a local offset would sort
 * wrong against its neighbours and silently corrupt that query, and every
 * range scan beside it.
 */
const STORED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Renders `value` for a timestamp column.
 *
 * `toISOString()` is called unguarded on purpose: an invalid `Date` throws the
 * driver-agnostic `RangeError: Invalid time value` it always has, and that
 * error is left exactly as it was. The width check below runs on the *result*,
 * so for every year 1000–9999 it is dead code — it exists to catch the
 * expanded-year form (`+010000-…`), which `toISOString()` emits outside that
 * range and which would sort before every ordinary row.
 */
export function toStoredTimestamp(value: Date): StoredTimestamp {
  const text = value.toISOString();
  if (!STORED_TIMESTAMP.test(text)) {
    throw new Error(
      `toStoredTimestamp: refusing to store ${JSON.stringify(text)} — timestamp columns must be ` +
        'fixed-width ISO-8601 UTC (YYYY-MM-DDTHH:mm:ss.sssZ), or MAX()/range queries over the ' +
        'stored TEXT stop being chronological.',
    );
  }
  return text as StoredTimestamp;
}

/** `toStoredTimestamp` for a nullable column. */
export function toStoredTimestampOrNull(value: Date | null): StoredTimestamp | null {
  return value === null ? null : toStoredTimestamp(value);
}

/**
 * Reads a timestamp column back.
 *
 * Deliberately lenient — no format assertion. The ordering invariant is a
 * write-side property, and a strict reader would turn any row already on disk
 * in an older shape into a crash on the live-money read path rather than a
 * mis-sort. `toStoredTimestamp` is where the convention is held.
 */
export function fromStoredTimestamp(text: string): Date {
  return new Date(text);
}

/** `fromStoredTimestamp` for a nullable column. */
export function fromStoredTimestampOrNull(text: string | null): Date | null {
  return text === null ? null : new Date(text);
}
