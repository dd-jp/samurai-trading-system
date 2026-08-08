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

import type { MetricsSuite } from '../../../contracts/metrics.js';
import type { PipelineStage } from '../../../contracts/pipeline.js';
import type { AssetClass, StoreMode } from '../../../contracts/primitives.js';
import type {
  DashboardSnapshot,
  LlmSpendSummary,
  TickStatus,
} from '../../../contracts/snapshot.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { DebateLog, OpenPosition } from '../../shared/index.js';
import type { ProviderStatusReader } from './provider-status.js';

/**
 * The wire model, re-exported. Declared in `contracts/` because the browser
 * consumes every one of these and must not import a server module to do it.
 */
export type {
  AnalystPerformanceRow,
  DashboardSnapshot,
  DebateRow,
  LlmPerDebateStats,
  LlmSpendSummary,
  LlmSpendWindow,
  MetricsSuiteWire,
  PositionRow,
  TickStatus,
  VerdictRow,
} from '../../../contracts/snapshot.js';

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
  /** The gate that fired, or 'approved'. */
  reason: string;
  hitl_override: boolean;
  timestamp: Date;
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
  /** Rolling realized-R contribution. */
  rolling_r: number;
  window_days: number;
}

/**
 * One `audit_log` row that has been ATTRIBUTED to an instrument — the raw
 * material the Pipeline view's lanes are built from (wayfinder map #411).
 *
 * `audit_log` itself carries no instrument (0001_init.sql: `trace_id`,
 * `stage`, `decision`, two digests, `timestamp`) and `trace_id` is a bare
 * `randomUUID()` (tick-loop.ts), so the instrument is a JOIN result, not a
 * column read. `SqliteQueryStore.getPipelineActivity` documents which joins
 * are available and what they cannot see.
 *
 * `stage` is narrowed to `PipelineStage` rather than left as the table's raw
 * TEXT: `audit_log.stage` is unconstrained and genuinely carries non-pipeline
 * values under a pipeline `trace_id` (the HITL Telegram callback writes
 * `verdict.hitl.telegram_callback`, telegram-bot-api-client.ts:112), so the
 * store MUST filter to the seven known stages before handing rows over.
 */
export interface PipelineStageEvent {
  trace_id: string;
  instrument: string;
  asset_class: AssetClass;
  stage: PipelineStage;
  /** `audit_log.decision` — the stage's decision word (`quorum_skip`, `no_go`, …). */
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
  /** `current_tick.updated_at` — when the tick entered this stage. */
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
 * The pure test seam — a function of `(DashboardQueryStore, asOf)` that
 * produces the wire snapshot. No I/O beyond the injected store; trivially
 * testable against a fake `DashboardQueryStore` (dashboard-spec.md "Testing
 * Decisions").
 */
export interface DashboardSnapshotBuilder {
  buildSnapshot(
    store: DashboardQueryStore,
    asOf: Date,
    mode: StoreMode,
    providers?: ProviderStatusReader,
  ): DashboardSnapshot;
}

/**
 * Read-only view of the shared store (dashboard-spec.md "Module: Query
 * Store") plus `getMark`. The dashboard defines no competing shapes for data
 * owned elsewhere (execution, debate engine, feedback loop, etc.).
 */
export interface DashboardQueryStore {
  getRecentDebates(limit: number, asOf: Date): DebateLog[];
  getTickStatus(asOf: Date): TickStatus | null;
  getOpenPositions(asOf: Date): OpenPosition[];
  getVerdictHistory(limit: number, asOf: Date): VerdictAuditEntry[];
  getAnalystWeights(asOf: Date): Record<string, number>;
  getAttribution(asOf: Date): Record<string, AttributionSummary>;
  getDailyMetrics(asOf: Date): MetricsSuite;
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
   */
  getMarks(instruments: readonly string[], asOf: Date): Map<string, Mark>;
  /**
   * Locally-metered Anthropic spend. Belongs on this interface, unlike the
   * Alpaca/Polygon tiles, because `llm_spend` genuinely IS a shared-store
   * table written by another component (the debate engine's LLM client) — the
   * same relationship this store has to `open_positions` or `verdict_log`.
   */
  getLlmSpend(asOf: Date): LlmSpendSummary;
  /**
   * Raw material for the Pipeline view (#411). `maxLanes` bounds the number of
   * instruments; `lookbackMs` bounds how far back a lane reaches (#413) — both
   * are passed in rather than read from config so the caller that owns the
   * poll (`buildSnapshot`) owns the payload size, exactly as the `limit`
   * arguments above do.
   *
   * Bounded on purpose: this rides the 3-second poll, so it must never grow
   * with the audit history. At most one settled candidate trace and one live
   * trace per lane are returned.
   */
  getPipelineActivity(maxLanes: number, lookbackMs: number, asOf: Date): PipelineActivity;
}
