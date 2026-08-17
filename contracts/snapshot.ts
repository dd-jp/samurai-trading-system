/**
 * Dashboard wire model — the JSON payload `GET /api/snapshot` returns.
 *
 * All `Date` fields from the domain types are serialized to ISO strings here,
 * at the HTTP/JSON boundary — `buildSnapshot` is the single place that crosses
 * it, so consumers downstream of the wire never see a `Date` object.
 *
 * Read-only by construction (dashboard-spec.md "Out of Scope": "Any write
 * path — no manual trade actions, kill-switch trigger, or config editing.
 * Strictly read-only"): the server exposes only `GET` handlers and only ever
 * calls `QueryStore` read methods.
 *
 * ## The boundary rule this file is on the right side of
 *
 * `contracts/` holds JSON-serializable shapes only. Anything carrying a `Date`
 * is pre-wire and stays server-side — which is why `VerdictAuditEntry`,
 * `AttributionSummary`, `PipelineStageEvent`, `PipelineLiveTick`,
 * `PipelineActivity`, `DashboardQueryStore` and `DashboardSnapshotBuilder`
 * remained in `server/apps/service-api/types.ts` when the rest of that file moved here.
 * They are the store's shapes, not the wire's, and the two only look alike.
 */

import type { MetricsSuite } from './metrics.js';
import type { PipelineStage, PipelineView } from './pipeline.js';
import type { AssetClass, Direction, OrderState, StoreMode } from './primitives.js';
import type { ProviderStatusPanel } from './providers.js';

/**
 * Coarse in-progress indicator sourced from the Orchestrator's `current_tick`
 * row (orchestrator-spec.md, Module: Tick Runner). The Debate Engine's
 * round-by-round state isn't persisted (decision #10), so this is the only
 * observable signal of an in-flight tick — not a live debate-round view.
 */
export interface TickStatus {
  instrument: string;
  asset_class: AssetClass;
  /**
   * Derived from `PipelineStage` rather than re-typed, so this directory
   * publishes ONE stage vocabulary. `invalidation` is excluded because it is
   * specced and not built (see `PIPELINE_STAGES`): the runtime chain is six
   * stages and a tick can never report standing in a stage that does not run.
   * Deriving it means a seventh stage becoming real surfaces here as a type
   * error instead of silently going unreported.
   *
   * `'position_check'` (#743) is the tick path's own stage — the
   * exit-check-only pass that runs every tick between decisions. It is a
   * union member here rather than a `PipelineStage`, because the pipeline
   * lane view renders the DECISION chain and a tick-path pass occupies no
   * decision stage; but the in-flight indicator must still be able to say
   * "position check in progress", since after the tick/decision split that
   * is the most common in-flight state the system has.
   */
  stage: Exclude<PipelineStage, 'invalidation'> | 'position_check';
  trace_id: string;
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
  order_state: OrderState;
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
 * The single payload `GET /api/snapshot` returns. Exactly the four CLI views
 * plus the coarse tick-in-progress line, projected to JSON-friendly shapes.
 */
export interface DashboardSnapshot {
  generated_at: string;
  as_of: string;
  /**
   * The run the operator is looking at (dashboard-spec.md "Wire Shape",
   * #539). Resolved by the dashboard entry point from `resolveStoreMode()` —
   * the same `SAMURAI_MODE` derivation `sharedStorePath()` uses to pick the
   * database file — and injected, never read from `process.env` here, so
   * `buildSnapshot` stays pure.
   *
   * On the wire because the browser cannot see the server's environment, and
   * a mode word baked into the bundle would keep saying "paper" during a live
   * run — the one time being wrong matters.
   *
   * `StoreMode`, not the spec's narrower `'paper' | 'live'`: the resolver the
   * spec names has three legal returns, and narrowing would force either a
   * lie (report `backtest` as `paper`) or a refusal to boot a mode the store
   * layer accepts. The client validates against the two literals it renders
   * and shows "mode unknown" for anything else, so an honest third value
   * degrades to ignorance rather than to a wrong claim.
   */
  mode: StoreMode;
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
