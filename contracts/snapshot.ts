/** Dashboard wire model — the JSON payload `GET /api/snapshot` returns; `Date` fields serialize to ISO strings at the HTTP boundary (`buildSnapshot`). */

import type { MetricsSuite, ProfitFactorWire } from './metrics.js';
import type { PipelineStage, PipelineView } from './pipeline.js';
import type { AssetClass, Direction, OrderState, StoreMode } from './primitives.js';
import type { ProviderStatusPanel } from './providers.js';

/** Coarse in-progress indicator off the Orchestrator's `current_tick` row — round-by-round debate state isn't persisted */
export interface TickStatus {
  instrument: string;
  asset_class: AssetClass;
  /**
   * Derived from `PipelineStage` (not `Exclude`) so a new pipeline stage is a
   * type error here rather than silently unreported. `'position_check'` is
   * the tick path's own exit-check pass, which occupies no decision stage.
   */
  stage: PipelineStage | 'position_check';
  trace_id: string;
}

/** One open position with its live unrealized PnL attached */
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
  /** Current mark used to compute unrealized PnL (never a stale entry value) */
  mark_price: number;
  unrealized_pnl: number;
  opened_at: string;
}

/** Wire-duplicated from the server-side `DebateTermination` — `contracts/` may import from neither `server/` nor `client/`. Widen both sides together. */
export type DebateTerminationWire = 'converged' | 'non_converged' | 'latency_truncated';

/** Wire-duplicated `DebateTerminationCause`, same reasoning as the type above */
export type DebateTerminationCauseWire = 'budget' | 'llm_failure';

/** One recent completed debate with per-analyst contributions */
export interface DebateRow {
  debate_id: string;
  instrument: string;
  direction: Direction;
  rounds: number;
  created_at: string;
  /** How this debate resolved. Absent for a row written before migration 0041. */
  termination?: DebateTerminationWire;
  /** Present only when `termination === 'latency_truncated'` and the row postdates migration 0051 — distinguishes an escaped LLM failure from latency-budget starvation. */
  termination_cause?: DebateTerminationCauseWire;
  contributions: {
    analyst_id: string;
    analyst_type: string;
    final_position: Direction;
    influence_score: number;
    /** Each analyst's position round by round. Absent means no per-round stance was recorded — an empty strip, never a fabricated flat line. */
    stance_during_debate?: Direction[];
  }[];
}

/** Which arm produced a trade. Duplicated from server-side `TradingArm` — `contracts/` may import from neither runtime. Widen both sides together. */
export type TradingArmWire = 'live' | 'control';

/**
 * One arm's performance over the comparison window. `max_drawdown_pct` is
 * REQUIRED: it mirrors server-side `ArmPerformance`, whose required drawdown
 * makes a return-only view of an arm impossible to construct (doc 12 D4).
 */
export interface ArmPerformanceWire {
  arm: TradingArmWire;
  trade_count: number;
  realized_pnl_net: number;
  /** Fraction of `basis`, not a percentage — 0.0125 is 1.25% */
  return_pct: number;
  /** Fraction of `basis`, peak-to-trough on this arm's realized-PnL series */
  max_drawdown_pct: number;
  /** Passes skipped by `control_arm_valuation_refused`. `null` for a row computed before migration 0057, never a fabricated `0`. */
  refused_pass_count: number | null;
  /** How `trade_count` was selected: fees never reaching the shared cost basis (`modelled_cost_charged = 0`) drop a trade first. `null` for a row before migration 0066. */
  cost_basis_drops: ExitClassDropCountsWire | null;
}

/** The exit classes the cost-basis exclusion is counted over. Duplicated from server-side `EXIT_CLASSES`; `snapshot.test.ts` holds a parity check. */
export const EXIT_CLASSES_WIRE = ['protective', 'flatten'] as const;
export type ExitClassWire = (typeof EXIT_CLASSES_WIRE)[number];

export interface CostBasisDropCountWire {
  kept: number;
  dropped: number;
}

export type ExitClassDropCountsWire = Readonly<
  Record<ExitClassWire, Readonly<CostBasisDropCountWire>>
>;

/** One Feedback Loop cycle's comparison of the two arms. Both share ONE window and ONE `basis` — doc 12 gate 4's exact-window requirement. */
export interface ArmComparisonRow {
  /** The FL cycle instant, ISO-8601 UTC */
  computed_at: string;
  window_from: string;
  window_to: string;
  /** The denominator both arms were divided by — the declared book in GBP */
  basis: number;
  live: ArmPerformanceWire;
  control: ArmPerformanceWire;
  diverged: boolean;
  /** The operator-facing sentence that was alerted. `null` exactly when `diverged` is false. */
  divergence_reason: string | null;
  /**
   * Trades each arm needed before dominance was even tested. Distinguishes
   * "tested, control didn't win" from "below floor, never tested" — stored
   * per row so historical rows keep the floor they were actually tested against.
   */
  min_trades_per_arm: number;
}

/** The outside benchmarks this system measures — closed union because #636 settled the set (SPY and 60/40). */
export type OutsideBenchmarkWire = 'spy' | 'sixty_forty';

/**
 * One cycle's measurement of ONE outside benchmark — SECONDARY to
 * `ArmComparisonRow` (CLAUDE.md; ADR-0014 amendment 2), so it has no
 * `diverged`/`trade_count`/`basis`/`arm`: a benchmark is held, not traded,
 * and cannot produce a verdict. `buy_and_hold_return_pct`, not `return_pct`,
 * because it is a fully-invested return through nights the live book is
 * deliberately flat — a different quantity in the same units.
 */
export interface OutsideBenchmarkRow {
  /** The FL cycle instant, ISO-8601 UTC */
  computed_at: string;
  benchmark: OutsideBenchmarkWire;
  /** Copied from the `ArmComparisonRow` computed in the same cycle — never chosen independently */
  window_from: string;
  window_to: string;
  /** Signed fraction of a fully-invested notional. See the type's header. */
  buy_and_hold_return_pct: number;
  /** REQUIRED, same reason as `ArmPerformanceWire` (doc 12 D4). Taken on the BLENDED index for a multi-leg benchmark. */
  max_drawdown_pct: number;
  /** Daily observations the figures were computed over — a 3-day and a 300-day percentage look identical without it */
  observation_count: number;
}

/** Where `PnlHeadlineWire.rate_usd_per_gbp` came from — one member today; a future source widens rather than making the literal ambiguous. Same rate `ArmComparisonRow.basis` uses. */
export type PnlRateSource = 'static_sizing_rate';

/**
 * All-time P&L for one arm. `max_drawdown_pct` is REQUIRED (see
 * `ArmPerformanceWire`) and realized-only, while `net_gbp` includes today's
 * open unrealized PnL — a positive `net_gbp` beside nonzero drawdown is not
 * a contradiction. Reads the UNFILTERED `closed_trades` population, unlike
 * the arm-comparison panel's cost-basis-filtered `trade_count` — the two can
 * legitimately disagree for the same arm and window.
 */
export interface PnlOverallWire {
  /** Cumulative realized `realized_pnl_net` plus current open unrealized, in GBP. Signed. */
  net_gbp: number;
  /** `net_gbp` as a signed fraction of the declared book (`PnlHeadlineWire.book_gbp`) — 0.05 is 5% */
  net_pct_of_book: number;
  /** Peak-to-trough fall of the REALIZED series only, as a positive fraction of the declared book. */
  max_drawdown_pct: number;
  /** Every closed trade this arm has ever recorded — unfiltered, can exceed the arm-comparison panel's figure for the same window. */
  trade_count: number;
}

/** One arm's P&L over the Europe/London calendar day — BST-aware. No `max_drawdown_pct`: a single day's figure is a snapshot, not a series with a peak. */
export interface PnlTodayWire {
  /** `realized_gbp + unrealized_gbp`, signed */
  net_gbp: number;
  /** `net_gbp` as a signed fraction of the declared book (`PnlHeadlineWire.book_gbp`) */
  net_pct_of_book: number;
  /** Sum of `realized_pnl_net` for trades closed today, in GBP. Signed. */
  realized_gbp: number;
  /** Current open positions' mark-to-market PnL, in GBP. Signed — this arm's `net_gbp` above already includes it. */
  unrealized_gbp: number;
  /** Sum of `fees_total` for trades closed today, in GBP. Always non-negative. */
  costs_gbp: number;
  /** Trades closed today, this arm */
  trade_count: number;
}

/** The dashboard's server-computed P&L headline for one arm — all-time with drawdown, and today (Europe/London), both in GBP with the conversion rate carried alongside. */
export interface PnlHeadlineWire {
  overall: PnlOverallWire;
  today: PnlTodayWire;
  /** USD per GBP — `SIZING_USD_PER_GBP` (`paper-profile.ts`), the same static rate `ArmComparisonRow.basis` is converted at */
  rate_usd_per_gbp: number;
  rate_source: PnlRateSource;
  /** The declared book both `net_pct_of_book` fields are a fraction of, in GBP (`LIVE_BOOK_GBP`) — carried since this figure has already moved once (£1,500 → £1,000). */
  book_gbp: number;
}

/** Why a lot closed. Duplicated from the server-side union — `contracts/` may import from neither runtime. Widen both sides together. */
export type CloseReason =
  | 'stop'
  | 'target'
  | 'exit'
  | 'flatten'
  | 'signal_decay'
  | 'direction_flip';

/** One realized round trip from `closed_trades` — the dashboard's only view of a position after it flattens. */
export interface ClosedTradeRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  entry_price: number;
  /** Derived by `buildSnapshot` from weighted exit-fill price (or PnL arithmetic as fallback) — not a stored column. */
  exit_price: number;
  filled_size: number;
  realized_pnl_net: number;
  fees_total: number;
  opened_at: string;
  closed_at: string;
  close_reason: CloseReason;
}

/** One `fills` row — the venue-side execution trail; `broker_fill_id` outlives `open_positions.broker_order_ids`, which isn't kept once a lot closes. */
export interface FillRow {
  idempotency_key: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: string;
}

/** One verdict/audit_log entry — the go/no-go history */
export interface VerdictRow {
  trace_id: string;
  instrument: string;
  status: 'go' | 'no_go';
  reason: string;
  hitl_override: boolean;
  timestamp: string;
}

/** Comparators/tri-state for an invalidation condition. Structural twins of the server-side unions — duplicated because `contracts/` may import from neither runtime. */
export type InvalidationComparatorWire = '<' | '<=' | '>' | '>=';
export type InvalidationConditionStateWire = 'breached' | 'not_breached' | 'unevaluable';

/** The validator's drop reasons, mirroring the server's `InvalidationDropReason`. Same duplication rule as above. */
export type InvalidationDropReasonWire =
  | 'unparseable'
  | 'unknown_observable'
  | 'unknown_indicator'
  | 'lookback_too_large'
  | 'threshold_out_of_range'
  | 'direction_incoherent'
  | 'over_cap';

/**
 * One invalidation condition as measured. `observable` is a LABEL, not the
 * server's nested union — duplicating that onto the wire would put the
 * vocabulary in two places. `observed` is `null` exactly when `state` is
 * `unevaluable`, never `0`.
 */
export interface EvaluatedConditionWire {
  id: string;
  observable: string;
  comparator: InvalidationComparatorWire;
  threshold: number;
  state: InvalidationConditionStateWire;
  observed: number | null;
  /** Why the critic said this falsifies the thesis. Audit text, never machine-read. */
  rationale: string;
}

/** A condition the validator refused, with its reason. `id` is null when the emission carried none. */
export interface DroppedConditionWire {
  id: string | null;
  /** What the model said, bounded server-side. Audit only. */
  raw: string;
  reason: InvalidationDropReasonWire;
}

/**
 * One recent Risk decision with its critic verdict attached. Keyed by
 * `(trace_id, instrument)`, not `debate_id` — a retried tick mints a fresh
 * `trace_id` but keeps its content-hashed `debate_id`, so a `debate_id`-keyed
 * join could mismatch trace and conditions. Critic fields are all nullable
 * since the critic genuinely may not have run.
 */
export interface RiskCriticRow {
  trace_id: string;
  instrument: string;
  /** The debate this decision attacked, from `trader_log`. Null when the trace links to none. */
  debate_id: string | null;
  /** The gate that decided it, verbatim from `risk_log` — `risk_critic:invalidated` (measured breach) vs `risk_critic:reject` (critic's prose), kept distinct so the two can disagree visibly. */
  binding_constraint: string | null;
  critic_verdict: 'pass' | 'trim' | 'reject' | 'unavailable' | null;
  /** The critic's argument text (audit) */
  reasoning: string | null;
  /** The measured conditions, or `null` when the row carries none. REQUIRED not optional — `JSON.stringify` would drop `undefined`, collapsing "absent" and "null" to the same bytes. */
  conditions: EvaluatedConditionWire[] | null;
  dropped_conditions: DroppedConditionWire[] | null;
  created_at: string;
}

/** Per-analyst weight + rolling attribution */
export interface AnalystPerformanceRow {
  analyst_id: string;
  weight: number;
  rolling_r: number;
  window_days: number;
}

/** The Feedback Loop's daily MetricsSuite — NOT `MetricsSuite` verbatim: `profit_factor` is `ProfitFactorWire`, since `Infinity` has no `JSON.stringify` form (see `contracts/metrics.ts`). */
export type MetricsSuiteWire = Omit<MetricsSuite, 'profit_factor'> & {
  profit_factor: ProfitFactorWire;
};

/** Locally-metered Anthropic spend over one time window, from `llm_spend`. Not a balance/invoice — Anthropic exposes neither, so this is what this bot spent per its own `usage` blocks. */
export interface LlmSpendWindow {
  /** USD across PRICED calls only — a model missing from the rate table contributes tokens but no dollars, so a non-zero `unpriced_calls` means this is a floor. */
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  calls: number;
  /** Calls whose model was not in the rate table; excluded from `cost_usd` */
  unpriced_calls: number;
  /** What one decision cost and how long its LLM calls took */
  per_debate: LlmPerDebateStats;
}

/** Per-DECISION cost/latency, grouped by `debate_id`, percentiles ACROSS debates. p50/p95 not a mean: LLM latency is long-tailed. */
export interface LlmPerDebateStats {
  /** Distinct `debate_id`s with at least one metered call in the window */
  debates: number;
  /** Calls in the window with no `debate_id` — excluded from the per-debate figures here, but in the window total above */
  unattributed_calls: number;
  /** Median / 95th-percentile USD across debates (unpriced calls contribute 0) */
  cost_usd_p50: number;
  cost_usd_p95: number;
  /** Sum of per-call LLM latency, NOT wall-clock elapsed time — they differ on overlapping/retried calls. Pre-migration-0012 NULLs excluded, never counted as 0. */
  llm_latency_ms_p50: number;
  llm_latency_ms_p95: number;
}

/** Rolling windows, not calendar days: a UTC-day bucket would disagree with the operator's wall clock. */
export interface LlmSpendSummary {
  last_24h: LlmSpendWindow;
  last_7d: LlmSpendWindow;
  all_time: LlmSpendWindow;
  /** The ceiling actually enforced (ADR-0008). `null` is AMBIGUOUS alone — "armed uncapped" or "never armed" — disambiguate with `cap_armed_at`. */
  cap_usd: number | null;
  /**
   * When the current cap was armed, or `null` if never written — the
   * discriminator `cap_usd` alone can't carry that. A non-null
   * `cap_armed_at` beside `cap_usd: null` can also mean "armed, but the
   * stored ceiling is corrupt" — not reachable via any live path.
   */
  cap_armed_at: string | null;
}

/** The single payload `GET /api/snapshot` returns — the CLI views plus the coarse tick-in-progress line, projected to JSON-friendly shapes. */
export interface DashboardSnapshot {
  generated_at: string;
  as_of: string;
  /**
   * Resolved server-side from `resolveStoreMode()` and injected, never read
   * from `process.env` here, so `buildSnapshot` stays pure. `StoreMode`, not
   * the narrower `'paper' | 'live'`, since the resolver can return a third value.
   */
  mode: StoreMode;
  /** The arm `positions`/`closed_trades` were read for. Absent means `'live'`; every other section still reads the live arm only. */
  arm: TradingArmWire;
  tick_status: TickStatus | null;
  positions: PositionRow[];
  /** Recent realized round trips — most-recently-closed first */
  closed_trades: ClosedTradeRow[];
  /** Fills belonging to `closed_trades` above — every leg, entry through exit */
  fills: FillRow[];
  debates: DebateRow[];
  verdicts: VerdictRow[];
  /** Recent Risk decisions with critic verdicts, most recent first. Required, EMPTY ARRAY when nothing recorded — never optional, so "no data" and "no decisions" stay distinguishable. */
  risk_critics: RiskCriticRow[];
  analysts: AnalystPerformanceRow[];
  metrics: MetricsSuiteWire;
  /** Matched-control comparisons, newest first. Required, EMPTY ARRAY when none computed — never rendered as zeros, which would misread as "no divergence" (ADR-0014 amendment 2). */
  arm_comparison: ArmComparisonRow[];
  /** Outside benchmarks, newest first, over the SAME window as `arm_comparison` — SECONDARY to it (CLAUDE.md; ADR-0017 §Consequences). A benchmark with no data is absent, never a fabricated zero row. */
  outside_benchmarks: OutsideBenchmarkRow[];
  /** The server-computed P&L headline for `arm` above. See `PnlHeadlineWire`'s doc for why the rate travels with the figures. */
  pnl: PnlHeadlineWire;
  /**
   * Escalation-chat alert sends that exhausted retry, TRAILING 24 HOURS
   * (`alert_delivery_failures`). Windowed, not all-time, so one resolved
   * blip doesn't read "degraded" forever. Scoped to the escalation chat only
   * — the same table also records heartbeat-chat failures, which must not
   * falsely degrade this tile.
   */
  alert_delivery_failures_24h: number;
  /** Third-party provider tiles. Shapes differ because the facts do: `alpaca` is a polled balance, `polygon` is reachability only, `llm_spend` is a locally-metered total. */
  providers: ProviderStatusPanel;
  llm_spend: LlmSpendSummary;
  /** The Pipeline view's lanes — rides the existing `GET /api/snapshot` poll rather than a new endpoint, so the two views can't disagree about `as_of`. */
  pipeline: PipelineView;
  /**
   * The server's stamp of its own wire shape, compared by the client every
   * poll against its own build's copy — catches a served client bundle and
   * running server built from different `DashboardSnapshot` shapes. Derived
   * from `DASHBOARD_SNAPSHOT_FIELD_NAMES`, not hand-bumped; shallow — covers
   * only this interface's own field names, not nested shapes.
   */
  contract_version: string;
}

/**
 * `DashboardSnapshot`'s own field names, in declaration order — hashed into
 * `CONTRACT_VERSION`. The ONE place this list is hand-written; `as const
 * satisfies readonly (keyof DashboardSnapshot)[]` rejects a listed name that
 * isn't real, but can't catch a real key missing from the list — see
 * `_assertDashboardSnapshotFieldNamesCoverAllKeys` below for that direction.
 */
export const DASHBOARD_SNAPSHOT_FIELD_NAMES = [
  'generated_at',
  'as_of',
  'mode',
  'arm',
  'tick_status',
  'positions',
  'closed_trades',
  'fills',
  'debates',
  'verdicts',
  'risk_critics',
  'analysts',
  'metrics',
  'arm_comparison',
  'outside_benchmarks',
  'pnl',
  'alert_delivery_failures_24h',
  'providers',
  'llm_spend',
  'pipeline',
  'contract_version',
] as const satisfies readonly (keyof DashboardSnapshot)[];

/**
 * The other half of the exhaustiveness check: a key missing from
 * `DASHBOARD_SNAPSHOT_FIELD_NAMES` gives the mapped type below a required
 * key, so `{}` no longer satisfies it and `npm run typecheck` fails, naming it.
 */
type _MissingDashboardSnapshotFieldNames = Exclude<
  keyof DashboardSnapshot,
  (typeof DASHBOARD_SNAPSHOT_FIELD_NAMES)[number]
>;
const _assertDashboardSnapshotFieldNamesCoverAllKeys: {
  [K in _MissingDashboardSnapshotFieldNames]: never;
} = {};

/** FNV-1a, 32-bit, hex-encoded. Chosen over `node:crypto`, which isn't available in the browser client this file is also bundled into. */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Exported so a test can prove this mechanism is content-sensitive without touching `DashboardSnapshot` itself */
export function contractVersionOf(fieldNames: readonly string[]): string {
  return fnv1aHex(fieldNames.join(','));
}

/** The server's stamp of its own wire shape, and the client's point of comparison — both computed by this same function from the same source list. */
export const CONTRACT_VERSION = contractVersionOf(DASHBOARD_SNAPSHOT_FIELD_NAMES);
