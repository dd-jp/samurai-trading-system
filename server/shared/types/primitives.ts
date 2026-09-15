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
export type { AssetClass, InstrumentSubclass, TradingArm } from '../../../contracts/index.js';

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

/**
 * The stable machine-matchable identifier on a log line (#1115).
 *
 * `message` is prose written for a human and may be reworded at any time;
 * `event` is what an alert rule, a grep or a dashboard filter keys on, so a
 * shipped code never changes. Codes are snake_case with at least two segments
 * and are chosen so a grep for one cannot collide with unrelated prose —
 * `token_bucket_wait`, not `wait` — which is the reasoning the two codes that
 * predate this type were already hand-rolled around.
 *
 * Deliberately not a union of every code. A central registry would make each
 * new log line an edit to a file every module imports, and nothing consumes
 * the codes as a set; `log-event-code.test.ts` enforces the spelling instead.
 */
export type LogEventCode = string;

/** The parts of a log line that do not vary with its level; see `LogEntry` */
interface LogEntryFields {
  trace_id: string;
  stage: string;
  message: string;
  payload?: unknown;
  /** Real wall-clock start of the stage, ISO 8601 — not `Clock.now()`, which doesn't advance on its own in backtest */
  started_at?: string;
  /** Monotonic elapsed time for the stage (`performance.now()` deltas), in milliseconds — not wall-clock, so an NTP step mid-stage can't produce a negative value */
  duration_ms?: number;
}

/**
 * One structured log line; `trace_id` threads every line (#95).
 *
 * A union rather than one interface so the compiler, not a convention, makes a
 * `warn`/`error` line without an `event` code impossible to write (#1115).
 *
 * The second arm is keyed on the whole `LogLevel` and not on `'warn' | 'error'`
 * because a dozen sites compute their level (`divergence.action ===
 * 'undetermined' ? 'warn' : 'info'`, `recordLevel(stage, decision)`), and an
 * object literal whose `level` is `'warn' | 'info'` matches neither a
 * `'debug' | 'info'` arm nor a `'warn' | 'error'` one. As written, such a site
 * fails to match the first arm and so must satisfy the second — it has to
 * carry an `event`, which is the right answer for a line that may come out as
 * a warning. The cost is an `event` on that site's `info` branch too.
 */
export type LogEntry = LogEntryFields &
  ({ level: 'debug' | 'info'; event?: LogEventCode } | { level: LogLevel; event: LogEventCode });

/**
 * `LogEntry` minus the keys a caller fills in later, distributing over the
 * union so the `event` requirement survives. A plain `Omit<LogEntry, K>` keys
 * off `keyof (A | B)` and collapses both arms into one shape whose `event` is
 * optional everywhere — the enforcement would be silently gone.
 */
export type LogEntryTemplate<Deferred extends keyof LogEntryFields = 'payload'> =
  LogEntry extends infer Arm ? (Arm extends LogEntry ? Omit<Arm, Deferred> : never) : never;

/**
 * Shared structured-logging interface. Canonical home (code-review
 * 2026-08-01, M6): the orchestrator's `Logger` and the debate engine's
 * `LogSink` are aliases of this one shape.
 */
export interface Logger {
  log(entry: LogEntry): void;
}
