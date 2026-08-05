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
   * Locally-metered Anthropic spend. Belongs on this interface, unlike the
   * Alpaca/Polygon tiles, because `llm_spend` genuinely IS a shared-store
   * table written by another component (the debate engine's LLM client) — the
   * same relationship this store has to `open_positions` or `verdict_log`.
   */
  getLlmSpend(asOf: Date): LlmSpendSummary;
}
