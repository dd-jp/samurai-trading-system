/**
 * Domain types for the Feedback Loop (Stage 6) — daily batch cycle (#91),
 * setup-store R-labelling on trade close (#92), and metrics/revalidation
 * breach alerting (#93). See docs/specs/feedback-loop-spec.md ("Key
 * Interfaces", "Module: Weight Attribution", "Module: Guardrailed Tuning",
 * "Module: Metrics & Revalidation", "Module: Setup Store Labelling").
 *
 * Scope note: the repo populates its interfaces ticket-by-ticket — #91 is
 * `runDailyCycle`, #92 is `onTradeClose`, #93 is `computeMetrics`.
 */
import type { MetricsSuite } from '../cost-model-backtest/index.js';
import type {
  Clock,
  ClosedTrade,
  ClosedTradeStore,
  DebateLogStore,
  SetupStore,
  TuningStore,
} from '../shared/index.js';

/**
 * A human-set bound on one tunable dial. Every dial has all four: the spec's
 * guardrail is "bounded step per cycle, inside hard floors/ceilings", so a
 * dial without both a step cap and a hard band is not expressible.
 */
export interface TunableDial {
  /** Max absolute change one cycle may apply. The cap in acceptance criterion #4. */
  max_step: number;
  /** Hard floor — a weight never reaches 0 permanently, a threshold never vanishes. */
  floor: number;
  /** Hard ceiling — no dial runs away or dominates. */
  ceiling: number;
  /**
   * Which direction of change makes this dial SAFER. FL cannot infer it:
   * for `max_position_size` tightening means decreasing, for
   * `min_viable_size` it means increasing.
   *
   * For a RISK THRESHOLD this is the gate — moving against it requires human
   * approval (feedback-loop-spec.md story 7). For a STRATEGY PARAM it is
   * descriptive only: it labels the emitted `param_updates[].direction`,
   * which the spec's `DailyCycleResult` requires on every entry, but strategy
   * params tune freely within bounds and are never gated.
   */
  tighten_is: 'increase' | 'decrease';
}

export interface FeedbackConfig {
  /**
   * How far back from `clock.now()` the cycle attributes trades. Combined
   * with the store's half-open window this is what keeps a daily cycle
   * point-in-time: only outcomes known before T are ever read.
   */
  attribution_window_ms: number;
  /** Step cap + hard band applied to EVERY analyst weight. */
  weights: TunableDial;
  /**
   * Credit multiplier for a right-but-low-influence analyst, as a fraction of
   * the influence-weighted credit (spec story 3 — "small"). Lets a quietly
   * correct analyst climb back instead of being pinned by its own low
   * influence.
   */
  shadow_credit: number;
  /** `influence_score` at or below which an analyst counts as low-influence for shadow credit. */
  shadow_influence_ceiling: number;
  /** Per strategy-param bounds, keyed by param name. Tuned freely inside them. */
  strategy_params: Record<string, TunableDial>;
  /** Per risk-threshold bounds, keyed by threshold name. Loosening is gated. */
  risk_thresholds: Record<string, TunableDial>;
  /** Kill-line config for `computeMetrics`'s breach detection (#93). */
  kill_thresholds: KillThresholds;
}

/**
 * A requested move on one strategy param or risk threshold, fed into the
 * cycle's guardrail routing.
 *
 * The spec assigns FL the *authority* to tune params/thresholds but does not
 * define the signal that proposes a target — the one producer it does name,
 * defensive auto-tightening on a kill-threshold breach, belongs to #93. So
 * #91 implements the bounded, guardrailed APPLICATION path and takes the
 * proposal as an input rather than inventing a tuning heuristic the spec
 * does not describe. Analyst weights need no proposal: attribution computes
 * their target.
 */
export interface TuningProposal {
  kind: 'strategy_param' | 'risk_threshold';
  name: string;
  /** Where the proposer wants the dial; the cycle moves at most `max_step` toward it. */
  target: number;
}

/**
 * Approval seam for gated risk-threshold loosening.
 *
 * Deliberately NOT Verdict's `ApprovalChannel` (src/verdict/types.ts): that
 * port's `ApprovalRequest` is order-shaped (`order_intent`, `risk_decision`)
 * and cannot describe a threshold move. Same trade channel, different
 * request shape.
 *
 * Fire-and-forget by design: `runDailyCycle` is synchronous per the spec, so
 * a loosening is queued into `loosen_pending_approval` and never applied by
 * the cycle that proposed it. Acting on the human's answer is a later
 * cycle's job (or a later ticket's) — the loop can never relax its own
 * safety limits unsupervised.
 */
export interface LoosenApprovalChannel {
  requestLoosenApproval(request: LoosenApprovalRequest): void;
}

export interface LoosenApprovalRequest {
  /** Risk-threshold name, as keyed in `FeedbackConfig.risk_thresholds`. */
  name: string;
  from: number;
  /** The bounded value that WOULD be written if a human approves — not the raw target. */
  to: number;
  requested_at: Date;
}

/**
 * One dial move, appended on write. This record IS the reversibility the
 * spec asks for (story 8): `from` is the pre-cycle value, so an operator can
 * roll a bad cycle back by replaying the log backwards. No rollback engine
 * is built here — #91 provides the audit trail, not the undo command.
 */
export interface Adjustment {
  dial: 'analyst_weight' | 'strategy_param' | 'risk_threshold';
  /** `analyst_id` for a weight, otherwise the param/threshold name. */
  name: string;
  from: number;
  to: number;
  direction: 'tighten' | 'loosen';
  /** `clock.now()` of the cycle that applied it. */
  applied_at: Date;
  /** Machine-readable cause, e.g. 'attribution', 'proposal', 'proposal:backtest_auto_approved'. */
  reason: string;
}

/** Append-only tuning audit log. FL-local: FL is its only writer today. */
export interface AdjustmentLog {
  append(entry: Adjustment): void;
}

/**
 * A gated risk-threshold loosening queued for human approval — the
 * `dial_adjustments` row `runDailyCycle` would write if `AdjustmentLog`
 * recorded `loosen_pending_approval` entries (it doesn't yet: see
 * `LoosenApprovalChannel`'s doc, "acting on the human's answer is a later
 * cycle's job"). `dial` excludes `'analyst_weight'` — weights are never
 * gated (spec: "Weights + strategy params tune freely within bounds").
 * Kept as a schema-shaped type for `SqliteAdjustmentLog`'s pending-approval
 * capability (#197) even though no current caller produces one, the same
 * documented-gap pattern as `SqliteConfigTrialLog`'s `config_json`.
 */
export interface PendingApprovalAdjustment {
  dial: 'strategy_param' | 'risk_threshold';
  name: string;
  from: number;
  to: number;
  direction: 'tighten' | 'loosen';
  requested_at: Date;
  reason: string;
}

/**
 * The subset of the spec's `FeedbackInput` that `runDailyCycle` actually
 * consumes. `portfolio` (PortfolioView) is absent because it feeds
 * `computeMetrics` (#93), not attribution; `store` is split into the two
 * narrow ports the cycle needs rather than one god-object `SharedStore`.
 */
export interface DailyCycleInput {
  /** Wall-clock live, simulated T in replay — the cycle reads time only through this. */
  clock: Clock;
  /** Outcomes to attribute. */
  trades: ClosedTradeStore;
  /** FL's system-of-record for per-analyst attribution, joined by `debate_id`. */
  debate_log: DebateLogStore;
  /** The three dials, read and written. */
  tuning: TuningStore;
  /** Where every applied move is recorded. */
  adjustments: AdjustmentLog;
  config: FeedbackConfig;
  approvals: LoosenApprovalChannel;
  /** Param/threshold moves requested this cycle. Weights are not proposed — they are attributed. */
  proposals: TuningProposal[];
  /**
   * Backtest auto-handles loosening approvals (like Verdict's HITL bypass)
   * and records them, so a replay exercises the same code path as live.
   * Paper takes the same gated approval path as live.
   */
  mode: 'live' | 'paper' | 'backtest';
}

/** Shape frozen by feedback-loop-spec.md ("Key Interfaces"). */
export interface DailyCycleResult {
  /** Per `analyst_id`, bounded. */
  weight_updates: Record<string, { from: number; to: number }>;
  /** Strategy params AND risk thresholds, keyed by name. */
  param_updates: Record<string, { from: number; to: number; direction: 'tighten' | 'loosen' }>;
  /** Risk-threshold loosenings awaiting human OK — proposed, NOT written. */
  loosen_pending_approval: string[];
  /** True if the cycle wrote at least one dial. */
  applied: boolean;
}

/**
 * The subset of the spec's `FeedbackInput` that `onTradeClose` actually
 * consumes: just the setup store it labels. Narrower than `DailyCycleInput`
 * for the same reason that one is narrower than the spec's `FeedbackInput` —
 * this event-driven path touches none of the daily cycle's dials/log/config.
 */
export interface OnTradeCloseInput {
  /** The cosine setup store FL owns and labels on trade close. */
  setup_store: SetupStore;
}

/** Single test seam. Deterministic given its clock-scoped inputs. */
export interface FeedbackLoop {
  runDailyCycle(input: DailyCycleInput): DailyCycleResult;
  /**
   * Event-driven R-labelling of the setup store (#92). `trace_id` is the
   * correlation id of the tick that produced this trade close (spec's Key
   * Interfaces note: this is the one FL entry point tied to a single trace,
   * unlike the daily-batch methods) — threaded for future audit-log wiring,
   * not consumed by the labelling logic itself.
   */
  onTradeClose(trade: ClosedTrade, trace_id: string, input: OnTradeCloseInput): void;
}

/**
 * Kill-line config for `computeMetrics` (#93) — feedback-loop-spec.md
 * ("Module: Metrics & Revalidation", story 13): "PBO > 0.05, OOS/paper Sharpe
 * < 0.5, DSR insignificant, live-vs-backtest divergence". Config, not
 * hardcoded, for the same reason `TunableDial`'s bounds are: the spec lists
 * "kill thresholds" alongside step caps and cadences as `FeedbackConfig`
 * fields the operator sets, not values this module bakes in.
 */
export interface KillThresholds {
  /** PBO's own reject line is 0.05 (validation-types.ts `PboVerdict`); this is FL's copy of it. */
  max_pbo: number;
  /** Below this, the mean out-of-sample/paper Sharpe across the walk-forward distribution breaches. */
  min_oos_sharpe: number;
  /** Below this Deflated Sharpe (a probability), the edge is statistically insignificant. */
  min_deflated_sharpe: number;
  /** Fractional drop of live Sharpe below the frozen backtest reference before it counts as divergence. */
  max_live_backtest_divergence: number;
}

/**
 * The validation library's periodic (weekly/monthly) walk-forward/DSR/PBO
 * OUTPUT, computed elsewhere (offline research / the eval executor, using
 * `generateSplits`/`deflatedSharpe`/`pbo` from cost-model-backtest) and handed
 * to `computeMetrics` to recompose and evaluate — never reimplemented here.
 * Absent outside the periodic cadence; the daily call has no revalidation to
 * recompose.
 */
export interface RevalidationSnapshot {
  walk_forward_sharpe_distribution: number[];
  deflated_sharpe: number;
  pbo: number;
}

/**
 * Fire-and-forget human alert on a kill-threshold breach (spec story 13, "the
 * trade channel"). Deliberately NOT `LoosenApprovalChannel`: a breach alert
 * expects no response — the kill/rework call is the human's to make later,
 * out of band — whereas a loosening is a request this module waits on.
 */
export interface BreachAlertChannel {
  postBreachAlert(alert: BreachAlert): void;
}

export interface BreachAlert {
  /** The breach identifiers also written to `MetricsReport.breaches`. */
  breaches: string[];
  reported_at: Date;
}

/**
 * Narrow seam `computeMetrics` (#93) actually consumes — the spec's
 * `FeedbackInput` minus the fields `runDailyCycle` alone needs (`trades`,
 * `debate_log`, `proposals`), same split rationale as `DailyCycleInput`.
 */
export interface MetricsInput {
  /** Wall-clock live, simulated T in replay — read only through this. */
  clock: Clock;
  /**
   * = the validation library's `MetricsSuite`, already computed by its
   * `computeMetrics` (cost-model-backtest/metrics.ts) over the day's returns
   * and trades. This module recomposes it into the report; it does not
   * derive it from raw returns itself (acceptance criterion #1).
   */
  daily: MetricsSuite;
  /** The frozen selected config's backtest Sharpe — the divergence check's baseline. */
  backtest_reference_sharpe: number;
  /** Present only on the weekly/monthly revalidation cadence. */
  revalidation?: RevalidationSnapshot;
  /** The three dials, read and written — auto-tighten writes here on breach. */
  tuning: TuningStore;
  /** Where every auto-tighten move is recorded, same log `runDailyCycle` appends to. */
  adjustments: AdjustmentLog;
  config: FeedbackConfig;
  alerts: BreachAlertChannel;
}

/** Shape frozen by feedback-loop-spec.md ("Key Interfaces"). */
export interface MetricsReport {
  /** = the library's `MetricsSuite`, recomposed — no reimplemented math (acceptance criterion #1). */
  daily: MetricsSuite;
  /** The library's DSR/PBO/walk-forward output, recomposed — present only on the periodic cadence. */
  revalidation?: RevalidationSnapshot;
  /** FL-only. e.g. 'pbo_over_max', 'oos_sharpe_under_min'. Never triggers a kill — alert + auto-tighten only. */
  breaches: string[];
  /**
   * Kill-lines this run could NOT evaluate, so that "did not breach" is never
   * mistaken for "was never checked" (#327).
   *
   * Two causes, both routine and both silent until now:
   *
   * - No `revalidation` snapshot — which is every non-revalidation day, by
   *   design. The three snapshot-gated lines (`pbo_over_max`,
   *   `oos_sharpe_under_min`, `dsr_insignificant`) simply do not run.
   * - `backtest_reference_sharpe <= 0` — `liveBacktestDivergence` returns `0`
   *   rather than manufacture a false breach off a broken reference (correct,
   *   and unchanged), which leaves `live_backtest_divergence_over_max` inert.
   *
   * An empty array is the only clean bill of health: it means all four lines
   * actually ran. A caller reading `breaches` alone cannot tell the
   * difference — which is precisely how a degrading paper run reports nothing.
   */
  not_evaluated: string[];
}

/**
 * Where a live run gets the `MetricsSuite` that `computeMetrics` evaluates
 * (#327).
 *
 * A supplied port, not a computation here. It stayed one for a while because
 * the validation library's `computeMetrics(returns, trades)` needs a
 * `ReturnSeries` — evenly spaced periodic equity returns — and nothing
 * persisted such a series: `account_state` (migration 0006) holds
 * `peak_equity`, a high-water scalar, and that migration's own comment recorded
 * `daily_open_equity` as an OPEN decision (GAP-8). Deriving returns from
 * realized `ClosedTrade` PnL instead would use the wrong denominator and be
 * unevenly spaced.
 *
 * **#345 closed that.** `daily_equity` (migration 0011) persists one immutable
 * equity observation per portfolio session — per UTC day, so exactly evenly
 * spaced — and `SqliteDailyEquityMetricsSource` (orchestrator/production)
 * derives a real `ReturnSeries` from it. See ADR-0006.
 *
 * The port survives that, rather than being replaced by a direct computation,
 * because a breach does not merely report: `autoTighten` WRITES every risk
 * threshold toward its extreme and appends to the `AdjustmentLog`. Deciding
 * whether the sample can carry that weight is a policy question — the
 * implementation refuses below a justified minimum observation count — and
 * keeping it behind a port is what lets the answer be "not this cycle" without
 * anything downstream having to understand why.
 *
 * So: returning `undefined` is a first-class answer meaning "no suite this
 * cycle", not an error. The orchestrator says so out loud rather than booking
 * it as a passing check. Backtest and Stage-2 harnesses supply their own
 * implementations, exactly as they do for `LoosenApprovalChannel`.
 */
export interface DailyMetricsSource {
  getDailyMetrics(): DailyMetricsSample | undefined;
}

export interface DailyMetricsSample {
  /** Already computed by the validation library — never derived here. */
  daily: MetricsSuite;
  /** Present only on the weekly/monthly revalidation cadence. */
  revalidation?: RevalidationSnapshot;
}
