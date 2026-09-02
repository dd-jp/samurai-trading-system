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

/**
 * The severities a log line can carry.
 *
 * `'debug'` joined the three originals in #1035 and is the ONLY filterable
 * one: `SAMURAI_LOG_LEVEL=info` drops it and nothing else. That asymmetry is
 * deliberate — `warn` and `error` carry the degradation notices #714's rule is
 * built on, and a verbosity setting that could suppress those would let an
 * operator configure the run into the silence that rule exists to prevent.
 *
 * Internal to the server runtime. Verified at introduction: `level` appears in
 * no `contracts/` type, no client component and no migration, so widening it
 * is not a wire-format or schema change.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One structured log line; `trace_id` threads every line (#95). */
export interface LogEntry {
  trace_id: string;
  stage: string;
  level: LogLevel;
  message: string;
  payload?: unknown;
  /** Real wall-clock start of the stage, ISO 8601 — not `Clock.now()`, which doesn't advance on its own in backtest. */
  started_at?: string;
  /** Monotonic elapsed time for the stage (`performance.now()` deltas), in milliseconds — not wall-clock, so an NTP step mid-stage can't produce a negative value. */
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
