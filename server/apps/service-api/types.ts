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
import type { ArmComparisonSample } from '../../pipeline/feedback-loop/index.js';
import type { OutsideBenchmarkSample } from '../../pipeline/outside-benchmark/index.js';
import type { RiskCriticVerdict } from '../../pipeline/risk-manager/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition } from '../../shared/index.js';
import type { ProviderStatusReader } from './provider-status.js';

/**
 * The wire model, re-exported. Declared in `contracts/` because the browser
 * consumes every one of these and must not import a server module to do it.
 */
export type {
  AnalystPerformanceRow,
  ArmComparisonRow,
  ArmPerformanceWire,
  ClosedTradeRow,
  CloseReason,
  DashboardSnapshot,
  DebateRow,
  DroppedConditionWire,
  EvaluatedConditionWire,
  FillRow,
  LlmPerDebateStats,
  LlmSpendSummary,
  LlmSpendWindow,
  MetricsSuiteWire,
  OutsideBenchmarkRow,
  OutsideBenchmarkWire,
  PositionRow,
  RiskCriticRow,
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
 * One recent Risk decision joined to the Risk Critic verdict it was reached
 * with (#1066) — the store-side material behind the wire's `RiskCriticRow`.
 *
 * Server-side, not wire: `created_at` is a `Date` and `critic` is the Risk
 * Manager's own `RiskCriticVerdict`, carried across whole rather than picked
 * apart, because this store "defines no competing shapes for data owned
 * elsewhere" — the verdict, its conditions and its drop reasons belong to the
 * Risk Manager (#994).
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
 * store MUST filter to the six known stages before handing rows over.
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
  /**
   * Recent realized round trips (#940), most-recently-closed first — the
   * `closed_trades` mirror of `getRecentDebates`/`getVerdictHistory` above.
   */
  getRecentClosedTrades(limit: number, asOf: Date): ClosedTrade[];
  /**
   * Every fill belonging to the named lots, in no particular cross-lot order.
   * Scoped to `idempotencyKeys` rather than a bounded "recent fills" window
   * (contrast `getMarks`' instrument-list shape) — `buildSnapshot` always
   * calls this with the SAME closed trades it is about to render, so the
   * fills returned are guaranteed complete for those trades rather than
   * coincidentally so.
   */
  getFillsForTrades(idempotencyKeys: readonly string[], asOf: Date): Fill[];
  getVerdictHistory(limit: number, asOf: Date): VerdictAuditEntry[];
  /**
   * Recent Risk decisions with their critic verdicts (#1066), most recent
   * first — the drawer's invalidation section.
   *
   * Keyed by `(trace_id, instrument)` like `risk_log` itself, so the drawer
   * looks a decision up by the trace it is showing rather than by the debate,
   * which a retried tick shares across traces (migration 0015).
   */
  getRiskCritics(limit: number, asOf: Date): RiskCriticRecord[];
  getAnalystWeights(asOf: Date): Record<string, number>;
  getAttribution(asOf: Date): Record<string, AttributionSummary>;
  getDailyMetrics(asOf: Date): MetricsSuite;
  /**
   * The Feedback Loop's persisted matched-control comparisons (#971),
   * most-recently-computed first — the panel's whole data source.
   *
   * Returns FL's own `ArmComparisonSample`, not a dashboard-local shape: this
   * store "defines no competing shapes for data owned elsewhere", and the
   * comparison is owned by the Feedback Loop (#636). It is read here rather
   * than recomputed at snapshot time because recomputing would move the
   * computation out of FL and show a number FL never saw and never alerted on
   * — see migration 0034's own comment.
   */
  getArmComparisons(limit: number, asOf: Date): ArmComparisonSample[];
  /**
   * The Feedback Loop's outside benchmarks (#981), newest first, bounded by
   * `asOf`. `limit` counts ROWS, not cycles — two benchmarks per cycle.
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
  /**
   * Count of alert sends to the ESCALATION chat recorded in
   * `alert_delivery_failures` up to `asOf` (#1108) — same relationship to
   * that table `getLlmSpend` has to `llm_spend`: written by another
   * component (the Telegram client), read here. All-time from the lower
   * bound (the table carries no retention window), `asOf`-bounded above like
   * every other reader here, so a replay against an older snapshot cannot
   * see a failure that hadn't happened yet.
   *
   * Scoped to the chat `alert-transport.ts` reads `TELEGRAM_CHAT_ID` into
   * (#1108 third review pass): the table also durably records heartbeat-chat
   * sends (#342's isolation only stops those from advancing the escalation
   * counter, not from being written), and this tile answers "is the alert
   * channel down" — a heartbeat hiccup on its own chat must not degrade it.
   *
   * This IS the channel-down surface (#1130), not a supplement to one: the
   * in-band Telegram "channel degraded" notice
   * (`telegram-bot-api-client.ts`'s `#recordDeliveryFailure`) posts over the
   * exact chat/transport it is reporting on, so it gets through only while
   * that chat is reachable — its own retries widen that from an instant to a
   * window that can run to tens of seconds, but an outage outlasting them
   * silences it.
   * Only this tile answers regardless, because it is a plain SQL read of a
   * durable table, crossing no live transport at read time.
   *
   * **The precondition, and what violating it looks like (#1130 review
   * round 1).** This count is only as good as this process's own
   * `TELEGRAM_CHAT_ID` (`server/apps/service-api/index.ts`, which reads and
   * normalizes it the way `alert-transport.ts` does for the orchestrator).
   * That process warns at boot when the var is UNSET; a set-but-WRONG value
   * is accepted silently, this method then filters on a chat nothing ever
   * wrote to, and returns 0. `Rail.tsx`'s `AlertDeliveryBlock` renders
   * nothing at 0, so the tile is ABSENT — byte-identical to a healthy
   * channel.
   *
   * Tile absence is therefore three states, and only two are named at boot:
   * healthy, `log-only` (warned, and 0 by design there — nothing is ever
   * sent to mark), and chat-mismatch (silent). Since #1130 makes this tile
   * the sole channel-down surface, that third state is a silent false
   * all-clear. It is documented here, not mitigated — index.ts's
   * boot-warning block carries the local signal that could detect it, and
   * the three reasons #1130 still declines to build the detector.
   */
  getAlertDeliveryFailureCount(asOf: Date): number;
}
