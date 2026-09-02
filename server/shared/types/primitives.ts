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
/**
 * The finer dimension ADR-0018 keys its brackets and sizing on. Same
 * re-export rule as `AssetClass` above, and same reason.
 */
/**
 * Which arm of #753's measurement a decision belongs to — the live
 * debate-driven arm, or falsifier arm 2's deterministic control. Same
 * re-export rule as `AssetClass` above, and same reason.
 */
export type { AssetClass, InstrumentSubclass, TradingArm } from '../../../contracts/primitives.js';

/** One structured log line; `trace_id` threads every line (#95). */
export interface LogEntry {
  trace_id: string;
  stage: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  payload?: unknown;
  /** Real wall-clock start of the stage, ISO 8601 — not `Clock.now()`, which doesn't advance on its own in backtest. */
  started_at?: string;
  /** Real wall-clock elapsed time for the stage, in milliseconds. */
  duration_ms?: number;
}

/**
 * Shared structured-logging interface. Canonical home (code-review
 * 2026-08-01, M6): the orchestrator's `Logger` and the debate engine's
 * `LogSink` are aliases of this one shape.
 */
export interface Logger {
  log(entry: LogEntry): void;
}
