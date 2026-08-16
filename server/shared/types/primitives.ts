/**
 * Cross-cutting primitives — the vocabulary every other module speaks (#308).
 *
 * Split out of the single `shared/types.ts` because that file is imported
 * almost everywhere, so touching any one domain's types dirtied a module every
 * other domain depends on. `types.ts` remains a re-export barrel, so no import
 * site changed.
 */

/**
 * The two markets this system trades. Re-exported rather than declared: the
 * canonical home is now `contracts/primitives.ts`, because the dashboard wire
 * shapes reference it and the browser must not import a server module to learn
 * what an asset class is.
 *
 * The rule from code-review 2026-08-01 (H5) is unchanged in substance —
 * component `types.ts` files re-export rather than redeclaring the union, so
 * adding an asset class is one edit — only the single edit's location moved.
 */
export type { AssetClass } from '../../../contracts/primitives.js';

/**
 * The finer dimension ADR-0018 keys its brackets and sizing on. Same
 * re-export rule as `AssetClass` above, and same reason.
 */
export type { InstrumentSubclass } from '../../../contracts/primitives.js';

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
