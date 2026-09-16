/**
 * The dashboard backend's own shapes — everything the wire model is built
 * FROM, but is not.
 *
 * The JSON payload itself moved to `contracts/snapshot.ts`; this file kept the
 * half that never crosses the boundary. The dividing line is mechanical: a
 * type carrying a `Date` is pre-serialization, because `buildSnapshot` is the
 * single place that converts to ISO strings, so anything holding a `Date` is
 * by definition upstream of the wire. `DashboardQueryStore` is here for the
 * same reason at one remove — it is an interface of methods, which no JSON
 * payload can be.
 *
 * The wire types are re-exported below so the server's ~30 import sites (and
 * `snapshot.ts`, `sqlite-query-store.ts`, `fixture-store.ts`, `server.ts`)
 * keep working unchanged.
 */

import type {
  AssetClass,
  LlmSpendSummary,
  MetricsSuite,
  PipelineStage,
  TickStatus,
} from '../../../contracts/index.js';
import type { PersistedArmComparisonSample } from '../../pipeline/feedback-loop/index.js';
import type { OutsideBenchmarkSample } from '../../pipeline/outside-benchmark/index.js';
import type { RiskCriticVerdict } from '../../pipeline/risk-manager/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition, TradingArm } from '../../shared/index.js';

/**
 * The wire model, re-exported. Declared in `contracts/` because the browser
 * consumes every one of these and must not import a server module to do it.
 */
export type {
  ArmComparisonRow,
  ClosedTradeRow,
  DashboardSnapshot,
  EvaluatedConditionWire,
  FillRow,
  LlmPerDebateStats,
  LlmSpendSummary,
  LlmSpendWindow,
  MetricsSuiteWire,
  OutsideBenchmarkRow,
  PositionRow,
  RiskCriticRow,
  TickStatus,
} from '../../../contracts/index.js';

/**
 * One row of the Verdict/audit_log history (dashboard-spec.md "Module: Query
 * Store"). Dashboard-owned shape — the audit_log's generic entry
 * (server/apps/orchestrator/audit-log.ts `AuditLogEntry`) is stage-agnostic
 * (`decision`/`input_digest`/`output_digest`); this is the go/no-go-specific
 * projection the spec freezes for the verdicts view.
 *
 * Server-side, not wire: `timestamp` is a `Date`. Its serialized twin is
 * `VerdictRow`.
 */
export interface VerdictAuditEntry {
  trace_id: string;
  instrument: string;
  status: 'go' | 'no_go';
  /** The gate that fired, or 'approved' */
  reason: string;
  hitl_override: boolean;
  timestamp: Date;
}

/**
 * One recent Risk decision joined to the Risk Critic verdict it was reached
 * with — the store-side material behind the wire's `RiskCriticRow`.
 *
 * Server-side, not wire: `created_at` is a `Date` and `critic` is the Risk
 * Manager's own `RiskCriticVerdict`, carried across whole rather than picked
 * apart, because this store "defines no competing shapes for data owned
 * elsewhere" — the verdict, its conditions and its drop reasons belong to the
 * Risk Manager.
 *
 * `critic` is `undefined` when the decision has no `risk_critic_log` row: the
 * critic was skipped, was never consulted, or the trace has no `trader_log`
 * row naming the debate the verdict would be keyed by. That is a different
 * fact from a verdict whose conditions half is absent, and the two must not
 * collapse.
 */
export interface RiskCriticRecord {
  trace_id: string;
  instrument: string;
  debate_id: string | null;
  binding_constraint: string | null;
  critic: RiskCriticVerdict | undefined;
  created_at: Date;
}

/**
 * Per-analyst rolling performance, as surfaced to the performance view
 * (dashboard-spec.md "Module: Query Store"). Dashboard-owned shape — narrower
 * than the Feedback Loop's internal `AnalystCredit`
 * (server/pipeline/feedback-loop/attribution.ts), which carries raw credit/trade_count
 * rather than a windowed rolling-R.
 *
 * Server-side: the store returns these keyed by analyst; `buildSnapshot` joins
 * them with weights to produce the wire's `AnalystPerformanceRow`.
 */
export interface AttributionSummary {
  analyst_id: string;
  /** Rolling realized-R contribution */
  rolling_r: number;
  window_days: number;
}

/**
 * One `audit_log` row that has been ATTRIBUTED to an instrument — the raw
 * material the Pipeline view's lanes are built from.
 *
 * `audit_log` itself carries no instrument (0001_init.sql: `trace_id`,
 * `stage`, `decision`, two digests, `timestamp`) and `trace_id` is a bare
 * `randomUUID()` (tick-loop.ts), so the instrument is a JOIN result, not a
 * column read. `SqliteQueryStore.getPipelineActivity` documents which joins
 * are available and what they cannot see.
 *
 * `stage` is narrowed to `PipelineStage` rather than left as the table's raw
 * TEXT: `audit_log.stage` is unconstrained and genuinely carries non-pipeline
 * values under a pipeline `trace_id` (the retired HITL Telegram callback
 * wrote `verdict.hitl.telegram_callback` rows, which persist in older
 * stores), so the store MUST filter to the six known stages before handing
 * rows over.
 */
export interface PipelineStageEvent {
  trace_id: string;
  instrument: string;
  asset_class: AssetClass;
  stage: PipelineStage;
  /** `audit_log.decision` — the stage's decision word (`quorum_skip`, `no_go`, …) */
  decision: string;
  timestamp: Date;
}

/**
 * One in-flight tick, from `current_tick`. Distinct from `TickStatus` only by
 * carrying `entered_at`, which the Pipeline view needs so the render layer can
 * run the live cell's clock forward between 3-second polls.
 */
export interface PipelineLiveTick {
  instrument: string;
  asset_class: AssetClass;
  stage: PipelineStage;
  trace_id: string;
  /** `current_tick.updated_at` — when the tick entered this stage */
  entered_at: Date;
}

/**
 * Everything `buildPipelineView` needs, in one read. Deliberately raw: the
 * store fetches and attributes, the pure builder in `pipeline-query.ts`
 * decides lane order, cell states and outcomes, so all of that is testable
 * without a database.
 */
export interface PipelineActivity {
  /**
   * The lane universe — one entry per instrument the dashboard draws a row
   * for, whether or not it has ticked. Already bounded to `maxLanes` by the
   * store; ordered into wire order by the builder.
   */
  universe: { instrument: string; asset_class: AssetClass }[];
  /**
   * Candidate traces' stage rows, ordered by `(trace_id, timestamp, rowid)`.
   * Ordering by `rowid` within a timestamp matches `SqliteAuditLog.getByTraceId`
   * — a fixed test clock puts several stages on the same ISO millisecond.
   */
  events: PipelineStageEvent[];
  /** Every in-flight tick in the window, newest first. Empty when nothing is running. */
  live: PipelineLiveTick[];
}

/**
 * Read-only view of the shared store (dashboard-spec.md "Module: Query
 * Store") plus `getMark`. The dashboard defines no competing shapes for data
 * owned elsewhere (execution, debate engine, feedback loop, etc.).
 */
export interface DashboardQueryStore {
  /**
   * Arm-less by scope: `debate_log` is written only by the live debate path
   * — the control arm's `DebateResult` is synthesized in memory and never
   * written there — so this table cannot hold a control row for an `arm`
   * parameter to filter.
   */
  getRecentDebates(limit: number, asOf: Date): DebateLog[];
  /**
   * Arm-less by scope: reflects `current_tick`, persisted only by the live
   * arm's `SequentialTickRunner`. The control arm's ticks live in its own
   * in-memory, never-persisted store, so there is no control row this could
   * ever surface.
   */
  getTickStatus(asOf: Date): TickStatus | null;
  /**
   * `arm` is required, not optional — the "no read returns both arms"
   * guarantee lives in the type here, not just in a convention a future
   * caller could forget. The dashboard entry point resolves an absent
   * request-side arm to `'live'` before it ever reaches this interface.
   */
  getOpenPositions(asOf: Date, arm: TradingArm): OpenPosition[];
  /**
   * Recent realized round trips, most-recently-closed first — the
   * `closed_trades` mirror of `getRecentDebates`/`getVerdictHistory` above.
   * `arm` required for the same reason as `getOpenPositions`.
   */
  getRecentClosedTrades(limit: number, asOf: Date, arm: TradingArm): ClosedTrade[];
  /**
   * EVERY closed trade for one arm, unbounded — the P&L headline's source:
   * `cumulativePnl` needs the whole realized series to find the all-time
   * peak and trough, and a `LIMIT` window sized for a recent-history list
   * (`getRecentClosedTrades` above) would silently truncate the drawdown to
   * whatever fits in it. `arm` required for the same reason as
   * `getOpenPositions`/`getRecentClosedTrades` — the headline must never
   * blend the two arms' realized series.
   */
  getAllClosedTrades(asOf: Date, arm: TradingArm): ClosedTrade[];
  /**
   * Every fill belonging to the named lots, in no particular cross-lot order.
   * Scoped to `idempotencyKeys` rather than a bounded "recent fills" window
   * (contrast `getMarks`' instrument-list shape) — `buildSnapshot` always
   * calls this with the SAME closed trades it is about to render, so the
   * fills returned are guaranteed complete for those trades rather than
   * coincidentally so.
   *
   * Arm-less by scope: scoped by `idempotencyKeys`, not by an arm predicate
   * — the caller (`buildSnapshot`) passes only the keys of an already
   * arm-scoped `getRecentClosedTrades` read, so the arm boundary is enforced
   * by the caller, not by a column here.
   */
  getFillsForTrades(idempotencyKeys: readonly string[], asOf: Date): Fill[];
  /**
   * `arm` required, same guarantee as `getOpenPositions` — `verdict_log`
   * carries no `arm` column, so the store discriminates on `trace_id`
   * instead, but the type-level contract is identical: a read names exactly
   * one arm, and no read returns both.
   */
  getVerdictHistory(limit: number, asOf: Date, arm: TradingArm): VerdictAuditEntry[];
  /**
   * Recent Risk decisions with their critic verdicts, most recent first —
   * the drawer's invalidation section.
   *
   * Keyed by `(trace_id, instrument)` like `risk_log` itself, so the drawer
   * looks a decision up by the trace it is showing rather than by the debate,
   * which a retried tick shares across traces (migration 0015).
   *
   * `arm` required, same guarantee as `getOpenPositions`. A control-arm read
   * still returns rows — the control arm's own Risk decisions — each with
   * `critic: undefined`, since the control calls no model and consults no
   * critic; it does not mean "no risk decisions".
   */
  getRiskCritics(limit: number, asOf: Date, arm: TradingArm): RiskCriticRecord[];
  /**
   * Arm-less by structure, not by oversight. `analyst_weights` carries no
   * `arm` column: the Feedback Loop that writes it takes only the live arm's
   * closed trades — the control arm has no analyst contributions to credit,
   * so there is no control-arm weight set for a parameter to select between.
   */
  getAnalystWeights(asOf: Date): Record<string, number>;
  /**
   * `arm` required, same guarantee as `getOpenPositions`.
   * `getAttribution(asOf, 'control')` returns `{}`: the join is onto
   * `debate_log`, which the control arm never writes — the control's
   * `DebateResult` is synthesized in-memory and has no `debate_log` row — so
   * there is nothing for a control-scoped read to attribute, not a bug in
   * the join.
   */
  getAttribution(asOf: Date, arm: TradingArm): Record<string, AttributionSummary>;
  /** `arm` required, same guarantee as `getOpenPositions` */
  getDailyMetrics(asOf: Date, arm: TradingArm): MetricsSuite;
  /**
   * The Feedback Loop's persisted matched-control comparisons,
   * most-recently-computed first — the panel's whole data source.
   *
   * Returns FL's own `PersistedArmComparisonSample`, not a dashboard-local
   * shape: this store "defines no competing shapes for data owned elsewhere",
   * and the comparison is owned by the Feedback Loop. It is read here rather
   * than recomputed at snapshot time because recomputing would move the
   * computation out of FL and show a number FL never saw and never alerted
   * on — see migration 0034's own comment.
   *
   * The PERSISTED shape, so what this returns is bounded by what
   * `arm_comparison_samples` holds: `ArmPerformance.refused_pass_count` has
   * a nullable column since migration 0057 — `null` on a row computed
   * before that migration, a real count on every row after it, never a
   * fabricated `0` the table never actually measured.
   */
  getArmComparisons(limit: number, asOf: Date): PersistedArmComparisonSample[];
  /**
   * The Feedback Loop's outside benchmarks, newest first, bounded by `asOf`.
   * `limit` counts ROWS, not cycles — two benchmarks per cycle.
   */
  getOutsideBenchmarks(limit: number, asOf: Date): OutsideBenchmarkSample[];
  getMark(instrument: string, asOf: Date): Mark;
  /**
   * Batched `getMark` — one query for a whole position list instead of one per
   * position (the dashboard's N+1, which is per-HTTP-request rather than
   * per-tick).
   *
   * Carries `getMark`'s contract per instrument, deliberately: it THROWS for a
   * requested instrument with no mark rather than omitting the key. A missing
   * mark must not degrade into a position rendered with no price on a
   * live-money operator surface. Throws for the first such instrument in
   * `instruments` order, so the failure is identical to what the per-position
   * loop produced.
   *
   * Arm-less by scope: market data (`latest_mark`) has no arm dimension —
   * both arms price against the same observed market.
   */
  getMarks(instruments: readonly string[], asOf: Date): Map<string, Mark>;
  /**
   * Locally-metered Anthropic spend. Belongs on this interface, unlike the
   * Alpaca/Polygon tiles, because `llm_spend` genuinely IS a shared-store
   * table written by another component (the debate engine's LLM client) — the
   * same relationship this store has to `open_positions` or `verdict_log`.
   *
   * Arm-less by scope: the control arm calls no model, so it never writes a
   * row here — this table cannot hold control-arm spend.
   */
  getLlmSpend(asOf: Date): LlmSpendSummary;
  /**
   * Raw material for the Pipeline view. `maxLanes` bounds the number of
   * instruments; `lookbackMs` bounds how far back a lane reaches — both are
   * passed in rather than read from config so the caller that owns the poll
   * (`buildSnapshot`) owns the payload size, exactly as the `limit`
   * arguments above do.
   *
   * Bounded on purpose: this rides the 3-second poll, so it must never grow
   * with the audit history. At most one settled candidate trace and one live
   * trace per lane are returned.
   *
   * `arm` required, same guarantee as `getOpenPositions`. `PipelineActivity.live`
   * is always `[]` for `arm: 'control'`: `current_tick` is written only by
   * the live arm's `SequentialTickRunner` (the control arm is wired to its
   * own never-persisted `InMemoryCurrentTickStore`), so a control-arm
   * request excludes that table's leg from the universe query entirely
   * rather than reading a table that structurally cannot hold a control row.
   */
  getPipelineActivity(
    maxLanes: number,
    lookbackMs: number,
    asOf: Date,
    arm: TradingArm,
  ): PipelineActivity;
  /**
   * Count of alert sends to the ESCALATION chat that exhausted retries, in
   * the TRAILING 24 HOURS as of `asOf` — windowed, not all-time, so one
   * transient failure does not make the tile read "degraded" forever.
   *
   * A 0 does NOT prove the channel is reachable: a row is written only when
   * a send is attempted, so a quiet system with nothing to escalate reports
   * 0 even if the channel is dead. It is also silently wrong if this
   * process's `TELEGRAM_CHAT_ID` is set but mismatched — the read then
   * filters on a chat nothing ever wrote to, indistinguishable from healthy.
   * Scoped to the escalation chat specifically: the table also records
   * heartbeat-chat sends, which must not count toward this tile.
   */
  getAlertDeliveryFailureCount(asOf: Date): number;
}
