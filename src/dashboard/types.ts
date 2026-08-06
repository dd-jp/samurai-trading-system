/**
 * Dashboard wire model — the JSON-serializable projection of the
 * `DashboardQueryStore` reads `buildSnapshot` consumes (docs/specs/
 * dashboard-spec.md "Module: Snapshot"). Frozen operator surface: positions,
 * debates, verdicts, performance + tick status, client-side polling refresh.
 *
 * All `Date` fields from the domain types are serialized to ISO strings here,
 * at the HTTP/JSON boundary — `buildSnapshot` is the single place that
 * crosses it, so consumers downstream of the wire never see a `Date` object.
 *
 * Read-only by construction (dashboard-spec.md "Out of Scope": "Any write
 * path — no manual trade actions, kill-switch trigger, or config editing.
 * Strictly read-only"): the server exposes only `GET` handlers and only ever
 * calls `QueryStore` read methods.
 */

import type { MetricsSuite } from '../cost-model-backtest/index.js';
import type { Direction } from '../debate-engine/index.js';
import type { Mark } from '../market-data-service/index.js';
import type { AssetClass } from '../orchestrator/index.js';
import type { DebateLog, OpenPosition } from '../shared/index.js';
import type { PipelineStage, PipelineView } from './pipeline-types.js';
import type { ProviderStatusPanel, ProviderStatusReader } from './provider-status.js';

/**
 * Coarse in-progress indicator sourced from the Orchestrator's `current_tick`
 * row (orchestrator-spec.md, Module: Tick Runner). The Debate Engine's
 * round-by-round state isn't persisted (decision #10), so this is the only
 * observable signal of an in-flight tick — not a live debate-round view.
 */
export interface TickStatus {
  instrument: string;
  asset_class: AssetClass;
  stage: 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';
  trace_id: string;
}

/**
 * One row of the Verdict/audit_log history (dashboard-spec.md "Module: Query
 * Store"). Dashboard-owned shape — the audit_log's generic entry
 * (src/orchestrator/audit-log.ts `AuditLogEntry`) is stage-agnostic
 * (`decision`/`input_digest`/`output_digest`); this is the go/no-go-specific
 * projection the spec freezes for the verdicts view.
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
 * (src/feedback-loop/attribution.ts), which carries raw credit/trade_count
 * rather than a windowed rolling-R.
 */
export interface AttributionSummary {
  analyst_id: string;
  /** Rolling realized-R contribution. */
  rolling_r: number;
  window_days: number;
}

/** One open position with its live unrealized PnL attached (dashboard-spec story 1-2). */
export interface PositionRow {
  idempotency_key: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  filled_size: number;
  avg_entry_price: number;
  stop: number;
  target: number;
  order_state: OpenPosition['order_state'];
  /** Current mark used to compute unrealized PnL (never a stale entry value). */
  mark_price: number;
  unrealized_pnl: number;
  opened_at: string;
}

/** One recent completed debate with per-analyst contributions (story 3). */
export interface DebateRow {
  debate_id: string;
  instrument: string;
  direction: Direction;
  rounds: number;
  created_at: string;
  contributions: {
    analyst_id: string;
    analyst_type: string;
    final_position: Direction;
    influence_score: number;
    /**
     * Each analyst's position round by round (#427).
     *
     * `debate_log.contributions_json` has always carried it; this wire shape
     * projected only where an analyst ENDED UP, so the drawer could show the
     * outcome of a debate but not how it got there — and an analyst that
     * started bearish and was talked around is a different signal from one
     * that never moved. Both rendered identically.
     *
     * Optional because a row written before the field was projected, or by a
     * debate that recorded no per-round stance, genuinely has none — and an
     * empty strip is the honest rendering of that rather than a fabricated
     * flat line.
     */
    stance_during_debate?: Direction[];
  }[];
}

/** One verdict/audit_log entry — the go/no-go history (story 5). */
export interface VerdictRow {
  trace_id: string;
  instrument: string;
  status: 'go' | 'no_go';
  reason: string;
  hitl_override: boolean;
  timestamp: string;
}

/** Per-analyst weight + rolling attribution (story 6). */
export interface AnalystPerformanceRow {
  analyst_id: string;
  weight: number;
  rolling_r: number;
  window_days: number;
}

/** The Feedback Loop's daily MetricsSuite (story 7) — reported together, never one number. */
export type MetricsSuiteWire = MetricsSuite;

/**
 * Locally-metered Anthropic spend over one time window, from `llm_spend`
 * (migrations/0010_llm_spend.sql). Not an account balance and not an invoice:
 * Anthropic publishes no balance endpoint, so this is what THIS bot spent,
 * counted from the `usage` block on each Messages API response.
 */
export interface LlmSpendWindow {
  /**
   * USD across PRICED calls only. `unpriced_calls` is the honest caveat that
   * travels with it — a model missing from the rate table contributes tokens
   * here but no dollars, so a non-zero `unpriced_calls` means this figure is a
   * floor rather than a total.
   */
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  calls: number;
  /** Calls whose model was not in the rate table; excluded from `cost_usd`. */
  unpriced_calls: number;
  /** What one decision cost and how long its LLM calls took (#326). */
  per_debate: LlmPerDebateStats;
}

/**
 * Per-DECISION cost and LLM latency over a window (#326) — the figures that
 * answer "what does one decision cost me, and is round 3 earning its
 * latency?". Computed by grouping `llm_spend` on `debate_id` (one debate = one
 * decision = ~3 rounds x 3 personas + one disagreement call) and taking
 * percentiles ACROSS debates.
 *
 * p50/p95 rather than a mean, deliberately: LLM latency is long-tailed (a
 * retried call adds a whole extra attempt), and a mean over that tail reports
 * a duration no debate actually experienced.
 */
export interface LlmPerDebateStats {
  /** Distinct `debate_id`s with at least one metered call in the window. */
  debates: number;
  /**
   * Calls in the window with no `debate_id`. The honest caveat that travels
   * with these percentiles, exactly as `unpriced_calls` does for `cost_usd`:
   * spend from unattributed calls is in the window total above but in none of
   * the per-debate figures here.
   */
  unattributed_calls: number;
  /** Median / 95th-percentile USD across debates (unpriced calls contribute 0). */
  cost_usd_p50: number;
  cost_usd_p95: number;
  /**
   * Median / 95th-percentile SUM OF PER-CALL LLM LATENCY across debates.
   *
   * Read the name literally: this is time spent inside LLM calls, NOT the
   * debate's wall-clock elapsed time. The two differ whenever calls overlap or
   * a call is retried under itself. Time in the provider is the number the
   * ticket asks about ("is round 3 earning its latency?"), and it is the only
   * one `llm_spend` can honestly report — the table has no debate start/end.
   *
   * Calls with a NULL `latency_ms` (rows written before migration 0012) are
   * excluded from the sum rather than counted as 0, so a pre-existing row
   * cannot drag a percentile toward zero.
   */
  llm_latency_ms_p50: number;
  llm_latency_ms_p95: number;
}

/**
 * Rolling windows rather than calendar days: a UTC-day bucket would disagree
 * with the operator's wall clock, and this system already has one hard-won
 * lesson (#332, `session_equity`) about blended reset boundaries nobody
 * verified. "Last 24 hours" needs no boundary to be right about.
 */
export interface LlmSpendSummary {
  last_24h: LlmSpendWindow;
  last_7d: LlmSpendWindow;
  all_time: LlmSpendWindow;
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
 * The single payload `GET /api/snapshot` returns. Exactly the four CLI views
 * plus the coarse tick-in-progress line, projected to JSON-friendly shapes.
 */
export interface DashboardSnapshot {
  generated_at: string;
  as_of: string;
  tick_status: TickStatus | null;
  positions: PositionRow[];
  debates: DebateRow[];
  verdicts: VerdictRow[];
  analysts: AnalystPerformanceRow[];
  metrics: MetricsSuiteWire;
  /**
   * Third-party provider tiles. Three providers, three different realities,
   * and the shapes differ because the underlying facts do rather than for
   * presentational convenience:
   *
   *  - `alpaca` is a real broker balance (`GET /v2/account`), polled live.
   *  - `polygon` is reachability only — Polygon sells a subscription and
   *    exposes no balance, credits, or quota endpoint.
   *  - `llm_spend` is a locally-metered Anthropic total, because Anthropic
   *    publishes no credit-balance endpoint either (`/v1/organizations/balance`
   *    is a 404) and its only monetary API needs an Admin key + Organization.
   *
   * Flattening these into one uniform "balance" field would require inventing
   * two numbers that do not exist.
   */
  providers: ProviderStatusPanel;
  llm_spend: LlmSpendSummary;
  /**
   * The Pipeline view's lanes (#411/#412) — the same poll, a second view.
   * Rides on the existing 3s `GET /api/snapshot` rather than a new endpoint:
   * charting decision 1 on the map rules out any new liveness transport, and
   * a second endpoint would let the two views disagree about `as_of`.
   */
  pipeline: PipelineView;
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
