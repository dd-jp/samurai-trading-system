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
}

/**
 * The pure test seam — a function of `(DashboardQueryStore, asOf)` that
 * produces the wire snapshot. No I/O beyond the injected store; trivially
 * testable against a fake `DashboardQueryStore` (dashboard-spec.md "Testing
 * Decisions").
 */
export interface DashboardSnapshotBuilder {
  buildSnapshot(store: DashboardQueryStore, asOf: Date): DashboardSnapshot;
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
}
