/**
 * CLI-owned read model (docs/specs/cli-spec.md, "Module: Query Store").
 * `QueryStore` is a thin, read-only wrapper the CLI's render functions
 * depend on — never a competing shape for data owned elsewhere. Populated
 * ticket-by-ticket like every other component's port. #98 (debate view)
 * added `getRecentDebates`/`getTickStatus`. #97 (positions, verdicts,
 * performance) adds the remaining methods (`getOpenPositions`,
 * `getVerdictHistory`, `getAnalystWeights`, `getAttribution`,
 * `getDailyMetrics`, `getMark`).
 */
import type { MetricsSuite } from '../cost-model-backtest/validation-types.js';
import type { Mark } from '../market-data-service/types.js';
import type { AssetClass } from '../orchestrator/types.js';
import type { DebateLog, OpenPosition } from '../shared/types.js';

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
 * One row of the Verdict/audit_log history (cli-spec.md "Module: Query
 * Store"). CLI-owned shape — the audit_log's generic entry
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
 * (cli-spec.md "Module: Query Store"). CLI-owned shape — narrower than the
 * Feedback Loop's internal `AnalystCredit` (src/feedback-loop/attribution.ts),
 * which carries raw credit/trade_count rather than a windowed rolling-R.
 */
export interface AttributionSummary {
  analyst_id: string;
  /** Rolling realized-R contribution. */
  rolling_r: number;
  window_days: number;
}

export interface QueryStore {
  /** The `limit` most recent completed debates as of `asOf`, newest first. */
  getRecentDebates(limit: number, asOf: Date): DebateLog[];
  /** The active `current_tick` row as of `asOf`, or null if no tick is in progress. */
  getTickStatus(asOf: Date): TickStatus | null;
  /** All open positions as of `asOf` (Execution's `OpenPosition` store). */
  getOpenPositions(asOf: Date): OpenPosition[];
  /** The `limit` most recent verdict/audit_log entries as of `asOf`, newest first. */
  getVerdictHistory(limit: number, asOf: Date): VerdictAuditEntry[];
  /** Current per-analyst weights, keyed by `analyst_id` (Feedback Loop's `TuningStore`). */
  getAnalystWeights(asOf: Date): Record<string, number>;
  /** Current rolling attribution per analyst, keyed by `analyst_id`. */
  getAttribution(asOf: Date): Record<string, AttributionSummary>;
  /** The Feedback Loop's daily `MetricsSuite` as of `asOf`. */
  getDailyMetrics(asOf: Date): MetricsSuite;
  /** Current mark for `instrument`, for unrealized-PnL computation (Market Data Service). */
  getMark(instrument: string, asOf: Date): Mark;
}
