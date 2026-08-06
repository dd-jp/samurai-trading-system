/**
 * Cross-cutting primitives — the vocabulary every other module speaks (#308).
 *
 * Split out of the single `shared/types.ts` because that file is imported
 * almost everywhere, so touching any one domain's types dirtied a module every
 * other domain depends on. `types.ts` remains a re-export barrel, so no import
 * site changed.
 */

/**
 * The two markets this system trades. Canonical home (code-review 2026-08-01,
 * H5): component `types.ts` files re-export this rather than redeclaring the
 * union, so adding an asset class is one edit, not five.
 */
export type AssetClass = 'crypto' | 'stocks';

/** One structured log line; `trace_id` threads every line (#95). */
export interface LogEntry {
  trace_id: string;
  stage: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  payload?: unknown;
}

/**
 * Shared structured-logging interface. Canonical home (code-review
 * 2026-08-01, M6): the orchestrator's `Logger` and the debate engine's
 * `LogSink` are aliases of this one shape.
 */
export interface Logger {
  log(entry: LogEntry): void;
}
