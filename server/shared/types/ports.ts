/**
 * Store ports — the interfaces the pipeline depends on and SQLite implements
 * (#308). Deliberately separate from the records in `records.ts`: a port
 * changes when a consumer's needs change, a record when the domain does, and
 * they rarely move together.
 */
import type { ClosedTrade, DebateLog, SetupNeighbor, SetupVector, VerdictLog } from './records.js';

/**
 * Owned by the Feedback Loop (Stage 6, `docs/wayfinder/feedback-loop-map.md`
 * "Setup store & outcome labelling"); the Trader reads neighbors and writes
 * new setups but does not build or label the store. Part of the shared
 * SQLite store family (docs/specs/trader-spec.md "Module: Cosine Precedent
 * Retrieval").
 */
export interface SetupStore {
  /** Only setups closed with a known outcome as of `asOf` are returned. */
  findNeighbors(vector: SetupVector, asOf: Date): SetupNeighbor[];
  /** Persists the new setup for later outcome labelling by the Feedback Loop. */
  writeSetup(debateId: string, vector: SetupVector, decidedAt: Date): void;
  /**
   * Labels a previously-written setup with its realized outcome on trade
   * close (Feedback Loop, #92), joined by `debate_id` — the same key
   * `writeSetup` was called with. Per-lot `ClosedTrade`/`debate_id` design
   * (see `ClosedTrade`) means this is exactly once per setup: a second label
   * on the same `debate_id` is a bug (double-close or replay), not a valid
   * state, and implementations should reject it rather than overwrite
   * silently. Point-in-time: the setup is only visible to `findNeighbors`
   * once labelled.
   */
  labelSetup(debate_id: string, r_multiple: number, closed_at: Date): void;
}

/**
 * shared_store `DebateLog` port. Owned by the Feedback Loop (the reader/
 * attribution consumer, docs/wayfinder/feedback-loop-map.md), written by the
 * Debate Engine — same ownership split as `SetupStore` above. Append-only:
 * no update/delete, one row per `debate_id`.
 */
export interface DebateLogStore {
  /** Persists the completed debate's log row; called once, after resolution. */
  writeLog(entry: DebateLog): void;
  /** FL's attribution join point — absent for a debate never completed. */
  getByDebateId(debate_id: string): DebateLog | undefined;
}

/**
 * shared_store `VerdictLog` port. Owned by Verdict (the writer) — the only
 * production consumer is `LoggingVerdict` (verdict/logging-verdict.ts),
 * which calls `writeLog` once per `decide()`. Append-only: no update/delete,
 * one row per `trace_id`.
 *
 * Deliberately write-only (no `getByTraceId` or similar read accessor,
 * #306): every real reader of `verdict_log` — the Dashboard's
 * `SqliteQueryStore` and the Orchestrator's `OrphanVerdictScanner` — reads
 * the table directly over `SharedStore`, not through this port, and the
 * scanner's orphan query (a `NOT EXISTS` join against `audit_log`) couldn't
 * be expressed through a `trace_id` getter regardless. Widening the port to
 * match `InMemoryVerdictLogStore`'s old `getByTraceId` (test-only
 * convenience, never called by production code) would advertise a contract
 * nothing needs; see verdict-log-store.ts's doc comment for the fuller
 * accounting.
 */
export interface VerdictLogStore {
  /** Persists one row per `VerdictDecision`; called once per `decide()`. */
  writeLog(entry: VerdictLog): void;
}

/**
 * Windowed read over the shared store's `ClosedTrade` rows — the Feedback
 * Loop's daily-cycle input (#91). Execution's own store port
 * (server/pipeline/execution/types.ts `ExecutionStore`) only *writes* closed trades; FL
 * is their reader, the same ownership split as `SetupStore`/`DebateLogStore`.
 * Synchronous like those two ports, so `runDailyCycle` keeps the synchronous
 * signature feedback-loop-spec.md gives it.
 */
export interface ClosedTradeStore {
  /**
   * Every trade whose `closed_at` falls in `(from, to]`. Half-open at the
   * start so consecutive cycles partition the timeline: a trade sitting
   * exactly on a boundary is attributed once, by the later cycle.
   */
  getClosedTradesBetween(from: Date, to: Date): ClosedTrade[];
}

/**
 * The three dials CONTEXT.md lets the Feedback Loop turn — analyst weights,
 * strategy params, risk thresholds. FL is the SOLE writer; the Debate Engine
 * (weights), Trader (params) and Risk Manager (thresholds) read them live at
 * decision time rather than from startup config, per feedback-loop-spec.md
 * ("Consumers must read live from the store"). Those consumer wirings are
 * separate tickets — this port is only the storage seam.
 *
 * Deliberately NOT a home for the market model: FL tunes dials, never the
 * model (CONTEXT.md invariant).
 */
export interface TuningStore {
  /** Keyed by `analyst_id`, matching `AnalystContribution.analyst_id`. */
  getAnalystWeights(): Record<string, number>;
  setAnalystWeight(analyst_id: string, weight: number): void;
  /**
   * Writes a STARTING weight for an analyst that has none, and does nothing
   * at all to one that already has a row. Returns whether this call was the
   * one that wrote it (#371).
   *
   * A separate operation rather than a caller's `getAnalystWeights()` check
   * followed by `setAnalystWeight`, because first-write-wins has to be a
   * property of the WRITE. A read-then-write is only idempotent under a
   * single serialized boot: two processes against the same database — the
   * overlap a restart during a 14-day soak (#238) actually produces — can
   * both read "absent" before either writes, and the second one then flattens
   * a weight the first has already tuned. Silently, and to a value that looks
   * exactly like a healthy seed.
   *
   * Same first-write-wins shape (and the same reason) as
   * `SqliteVerdictLogStore.writeLog`'s `ON CONFLICT DO NOTHING`: the row that
   * exists is the record, and a later write must not be able to erase it.
   */
  seedAnalystWeight(analyst_id: string, weight: number): boolean;
  getStrategyParams(): Record<string, number>;
  setStrategyParam(name: string, value: number): void;
  getRiskThresholds(): Record<string, number>;
  setRiskThreshold(name: string, value: number): void;
  /**
   * Writes a STARTING value for a risk threshold that has none, and does
   * nothing to one that already has a row (#433). Returns whether this call
   * wrote it.
   *
   * Same first-write-wins semantics as `seedAnalystWeight`, for the same
   * reason and with more at stake: the row this seeds is a SAFETY LIMIT, and a
   * restart that re-wrote it would undo every tightening `autoTighten` had
   * applied since the last boot — silently re-opening the caps the system
   * narrowed because it had detected its edge might be gone.
   *
   * Seeding at all is what makes `autoTighten` reachable: it steps a value it
   * can already read and `continue`s past a dial whose `current` is undefined,
   * so an unseeded table meant every breach tightened nothing.
   */
  seedRiskThreshold(name: string, value: number): boolean;
}
