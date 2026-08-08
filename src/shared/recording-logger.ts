/**
 * Test-only `Logger` double (#573 review) — what `safe-log.test.ts`,
 * `execution/ingest-fills.test.ts` and `execution/reconcile.test.ts` build on
 * to assert what got logged, in place of three byte-identical copies of the
 * same six lines. Follows `execution/sqlite-store-harness.ts`'s placement
 * convention: a plain (non-`.test.ts`) helper file, imported directly by its
 * consumers rather than re-exported through `shared/index.ts` — a recording
 * double is not a production dependency, so it stays off that barrel.
 *
 * Never throws itself — a THROWING logger (the property `safeLog`/
 * `logCaughtFailure` exist to survive) is a distinct, deliberately different
 * test double each of those suites constructs inline where it is needed.
 */
import type { LogEntry, Logger } from './types.js';

export function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(entry: LogEntry): void {
      entries.push(entry);
    },
  };
}
