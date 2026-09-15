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

import type { MetricsSuite, ProfitFactorWire } from './metrics.js';
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
   * publishes ONE stage vocabulary: every member of `PIPELINE_STAGES` is a
   * stage a tick can genuinely be standing in, so this is a plain union
   * rather than an `Exclude` over it. Deriving it means a stage the pipeline
   * ever grows surfaces here as a type error rather than silently going
   * unreported.
   *
   * `'position_check'` (#743) is the tick path's own stage — the
   * exit-check-only pass that runs every tick between decisions. It is a
   * union member here rather than a `PipelineStage`, because the pipeline
   * lane view renders the DECISION chain and a tick-path pass occupies no
   * decision stage; but the in-flight indicator must still be able to say
   * "position check in progress", since after the tick/decision split that
   * is the most common in-flight state the system has.
   */
  stage: PipelineStage | 'position_check';
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

/**
 * How a debate resolved, wire-duplicated from the server-side
 * `DebateTermination` (`server/shared/types/records.ts`) — `contracts/` may
 * import from neither `server/` nor `client/` (same reasoning as
 * `TradingArmWire` below). Widen both sides together.
 */
export type DebateTerminationWire = 'converged' | 'non_converged' | 'latency_truncated';

/** Wire-duplicated `DebateTerminationCause`, same reasoning as the type above. */
export type DebateTerminationCauseWire = 'budget' | 'llm_failure';

/** One recent completed debate with per-analyst contributions (story 3). */
export interface DebateRow {
  debate_id: string;
  instrument: string;
  direction: Direction;
  rounds: number;
  created_at: string;
  /**
   * How this debate resolved (#1396) — absent for a row written before
   * migration 0041, where the server's own `termination` is genuinely
   * indeterminate rather than merely unprojected.
   */
  termination?: DebateTerminationWire;
  /**
   * Present only when `termination === 'latency_truncated'` and the row
   * postdates migration 0051 (#1396) — see `DebateTerminationCauseWire`.
   * Distinguishes an escaped LLM failure (#1380) from ordinary
   * latency-budget starvation, which land identically on `termination`
   * alone.
   */
  termination_cause?: DebateTerminationCauseWire;
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

/**
 * Which arm produced a trade (#753, migration 0033). Structurally identical to
 * the server-side `TradingArm` union (`server/shared/types/records.ts`) —
 * duplicated here for `CloseReason`'s reason below: `contracts/` may import from
 * neither `server/` nor `client/`. Widen both sides together.
 */
export type TradingArmWire = 'live' | 'control';

/**
 * One arm's performance over the comparison window (#971).
 *
 * **`max_drawdown_pct` is REQUIRED, and that is the point.** It mirrors the
 * server-side `ArmPerformance` (`server/pipeline/control-arm/arm-comparison.ts`),
 * whose required drawdown field makes a return-only view of an arm impossible to
 * construct — `docs/research/12-edge-hypothesis-critique.md` D4 rules out a
 * return-only comparison against a risk-targeted stream, and the wire is where a
 * "just show me the returns" panel would otherwise be born. A renderer cannot
 * ask the server for a row without the drawdown on it, because no such row
 * exists on this contract.
 */
export interface ArmPerformanceWire {
  arm: TradingArmWire;
  trade_count: number;
  realized_pnl_net: number;
  /** Fraction of `basis`, not a percentage — 0.0125 is 1.25%. */
  return_pct: number;
  /** Fraction of `basis`, peak-to-trough on this arm's realized-PnL series. */
  max_drawdown_pct: number;
  /**
   * Passes over this window (#1099) skipped by `control_arm_valuation_refused`
   * — invisible to `trade_count`, which only counts closed trades. `null` for
   * a row computed before migration 0057 (#1483) persisted the count, never a
   * fabricated `0`: `0` asserts "no refusals happened", which is not knowable
   * for those rows.
   */
  refused_pass_count: number | null;
  /**
   * How `trade_count` was SELECTED (#1546). A closed trade whose fees were
   * never brought onto the two arms' shared cost basis
   * (`modelled_cost_charged = 0`, #1121) is dropped before `trade_count` is
   * taken, and the two exit classes are dropped at different rates: a
   * protective close is priced by the entry submission's single best-effort
   * cost capture, a flatten needs that capture AND its own. The gap between
   * the two `dropped / (kept + dropped)` rates bounds how far this arm's
   * population is selected on exit type.
   *
   * `null` for a row computed before migration 0066 persisted the counts,
   * never an all-zero object: all-zero asserts "the Feedback Loop counted and
   * excluded nothing", which those rows never measured.
   */
  cost_basis_drops: ExitClassDropCountsWire | null;
}

/**
 * The exit classes the cost-basis exclusion is counted over (#1546).
 *
 * Structurally identical to the server-side `EXIT_CLASSES`/`ExitClass`
 * (`server/pipeline/control-arm/arm-comparison.ts`) and duplicated here for
 * `TradingArmWire`'s reason — `contracts/` may import from neither `server/`
 * nor `client/`. Widen both sides together; `snapshot.test.ts` holds a
 * compile-time parity check in both directions.
 */
export const EXIT_CLASSES_WIRE = ['protective', 'flatten'] as const;
export type ExitClassWire = (typeof EXIT_CLASSES_WIRE)[number];

export interface CostBasisDropCountWire {
  kept: number;
  dropped: number;
}

export type ExitClassDropCountsWire = Readonly<
  Record<ExitClassWire, Readonly<CostBasisDropCountWire>>
>;

/**
 * One Feedback Loop cycle's comparison of the two arms (#971).
 *
 * Both arms come off ONE window (`window_from`/`window_to`, half-open at the
 * start) and share ONE `basis` — doc 12 gate 4's exact-window requirement,
 * carried onto the wire rather than left as an assumption the panel makes.
 */
export interface ArmComparisonRow {
  /** The FL cycle instant, ISO-8601 UTC. */
  computed_at: string;
  window_from: string;
  window_to: string;
  /**
   * The denominator BOTH arms were divided by — the declared book in the
   * account's currency (`LIVE_BOOK_GBP * SIZING_USD_PER_GBP` today, #1180),
   * matching `realized_pnl_net` above it.
   */
  basis: number;
  live: ArmPerformanceWire;
  control: ArmPerformanceWire;
  diverged: boolean;
  /** The operator-facing sentence that was alerted. `null` exactly when `diverged` is false. */
  divergence_reason: string | null;
  /**
   * Closed trades EACH arm needed before dominance was even tested this cycle
   * (`ArmDivergenceThresholds.min_trades_per_arm` at compute time; the default is
   * `MIN_TRADES_PER_ARM_FOR_DIVERGENCE`, currently 5) — #982.
   *
   * `diverged: false` alone is ambiguous between "dominance was tested and the
   * control did not win" and "one or both arms were below this floor, so
   * dominance was never tested at all" — an absent verdict, not a passing one.
   * Without this field on the wire the panel could not tell those two states
   * apart and had to soften its copy to the honest-but-uninformative "a verdict
   * is issued only above a floor" rather than naming which state a given row is
   * in.
   *
   * Stored PER ROW rather than read live off the current policy constant, the
   * same choice `basis` makes on this same type and for the same reason (see
   * migration `0034_arm_comparison_samples.sql`): a row is a record of what FL
   * actually tested the verdict against at `computed_at`, and the trend list
   * below renders many historical rows at once — a snapshot-level "current
   * policy" field would render every older row against a floor it was never
   * evaluated with, the moment the constant next changes.
   */
  min_trades_per_arm: number;
}

/**
 * The outside benchmarks this system measures (#981). Mirrors the server-side
 * `OutsideBenchmarkId` — a closed union rather than a string, because #636
 * settled the set (SPY and 60/40) and #981's non-goals rule out reopening it.
 */
export type OutsideBenchmarkWire = 'spy' | 'sixty_forty';

/**
 * One Feedback Loop cycle's measurement of ONE outside benchmark (#981) — the
 * second half of #636, whose first half is `ArmComparisonRow` above.
 *
 * ## This type is SECONDARY, and it is shaped to stay that way
 *
 * Falsifier arm 2 is the primary matched control; an outside benchmark never
 * substitutes for it (CLAUDE.md Key Constraints; ADR-0014 amendment 2; ADR-0017
 * §Consequences). That is enforced by what this type does NOT have, rather than
 * by a convention the panel is trusted to follow:
 *
 *  - **no `diverged` and no `divergence_reason`** — a benchmark cannot produce a
 *    verdict, so no renderer can give it the arm panel's alert treatment;
 *  - **no `trade_count`** — SPY is held, not traded;
 *  - **no `realized_pnl_net` and no `basis`** — the benchmark has no account and
 *    made nobody any money, and carrying a basis would invite a cash figure to
 *    be multiplied out of a percentage nobody earned;
 *  - **no `arm`** — it is not a third arm.
 *
 * ## `buy_and_hold_return_pct`, NOT `return_pct`
 *
 * `ArmPerformanceWire.return_pct` is realized PnL as a fraction of the declared
 * book — a book that is FLAT OVERNIGHT and carries risk only while a trade is on
 * (ADR-0014's flat-by-close horizon). This is the return of a position fully
 * invested for the whole window, every day, including the nights the live book
 * is deliberately flat. Same units, different quantities.
 *
 * #636 names this exact trap — *"easy to lose in a per-arm metrics table with
 * one column per arm"* — so the field carries a different NAME rather than a
 * footnote a table author can skip. A component that wants to stack these in one
 * column has to rename something first, in code that reads as the mistake it is.
 * That is the same argument `ArmPerformanceWire` makes about drawdown, applied
 * to the denominator instead of the column.
 */
export interface OutsideBenchmarkRow {
  /** The FL cycle instant, ISO-8601 UTC. */
  computed_at: string;
  benchmark: OutsideBenchmarkWire;
  /**
   * The window, COPIED from the `ArmComparisonRow` computed in the same cycle —
   * never chosen independently. #636: *"Outside benchmarks computed on
   * approximate windows are not risk-adjusted comparisons, they are noise."*
   * Carried onto the wire so the panel can state the match rather than assume it.
   */
  window_from: string;
  window_to: string;
  /** Signed fraction of a fully-invested notional. See the type's header. */
  buy_and_hold_return_pct: number;
  /**
   * REQUIRED, exactly as on `ArmPerformanceWire` and for the same reason:
   * `docs/research/12-edge-hypothesis-critique.md` D4 rules out return-only
   * comparison against a risk-targeted stream, and CLAUDE.md applies it to the
   * outside benchmarks by name — they "report return AND drawdown together".
   * A positive fraction, taken on the BLENDED index for a multi-leg benchmark.
   */
  max_drawdown_pct: number;
  /**
   * Daily observations the figures were computed over. The benchmark's analogue
   * of `ArmPerformanceWire.trade_count`, and carried for the same reason: a
   * percentage over three observations and one over three hundred look
   * identical without it.
   */
  observation_count: number;
}

/**
 * Where `PnlHeadlineWire.rate_usd_per_gbp` came from (#1595). A plain union
 * with one member today rather than a bare `string` — the headline is
 * required to name its source, and a future second source (a live FX feed,
 * say) widens this type instead of silently making the existing literal
 * ambiguous.
 *
 * `'static_sizing_rate'` is the SAME conversion `ArmComparisonRow.basis`
 * already uses (`SIZING_USD_PER_GBP`, #1180) — not a second, independently
 * chosen rate that could disagree with it.
 */
export type PnlRateSource = 'static_sizing_rate';

/**
 * All-time P&L for one arm (#1595): every closed trade ever recorded for it,
 * plus the mark-to-market value of what it holds right now.
 *
 * **`max_drawdown_pct` is REQUIRED, for `ArmPerformanceWire`'s reason above.**
 * It is realized-only — computed from the closed-trade series alone
 * (`cumulativePnl`, control-arm/arm-comparison.ts) — while `net_gbp` is wider
 * and includes today's open unrealized PnL. The two are not the same
 * denominator: a headline with a positive `net_gbp` and a nonzero
 * `max_drawdown_pct` is not a contradiction, it is the ordinary case of an arm
 * that fell before recovering.
 *
 * **This reuses `cumulativePnl` but NOT its usual population (#1616).** The
 * Feedback Loop's arm-comparison panel (`ArmPerformanceWire` above) feeds
 * that same function rows that already passed `oneSizingRegime` and
 * `modelledCostCharged` (`sqlite-arm-comparison-source.ts`); this headline
 * feeds it every `closed_trades` row for the arm, unfiltered
 * (`getAllClosedTrades`, sqlite-query-store.ts). The two can therefore report
 * different `net_gbp`/`max_drawdown_pct` for the same arm and the same
 * window, and the divergence is not symmetric:
 *
 * - `modelledCostCharged` drops rows only on the live arm — a control fill is
 *   always priced by `SimulatedBrokerAdapter`, so `control` never loses a row
 *   to it (`countCostBasisDrops`'s doc). This asymmetry is one-directional —
 *   it only ever affects the live arm, never the control arm — but the SIGN
 *   of the resulting `net_gbp`/`max_drawdown_pct` difference is NOT
 *   established: a dropped row can itself be a loss, which would make this
 *   headline read WORSE than the panel, not better. `modelledCostCharged`
 *   carries its own "DIRECTION IS NOT ESTABLISHED" note for the same reason
 *   — do not restate this as "cost-optimistic" without redoing that math.
 * - `oneSizingRegime` can drop rows from BOTH arms (a pre-#1112-cutover
 *   `sizing_capital_ceiling = NULL` row), or make the panel throw outright on
 *   a window straddling two declared ceilings — an all-time population is, if
 *   anything, MORE likely to span two. This headline never throws only
 *   because it never calls `oneSizingRegime` at all, not because its
 *   population is somehow safer.
 *
 * Full parity would need this reader to also run `oneSizingRegime`, which
 * needs `sizing_capital_ceiling` on the row: present in the `closed_trades`
 * table (migration 0045) and so on what `getAllClosedTrades`'s `SELECT *`
 * already returns, but not on the `ClosedTrade`/`ClosedTradeRow` TYPE this
 * reader is typed against — a mapper/type addition, not a schema one.
 * Filtering on `modelled_cost_charged` alone, without it, would drop real
 * trades from `trade_count` without reproducing the panel's number, so this
 * type is deliberately left reading the wider, unfiltered population rather
 * than a partial, still-wrong one.
 */
export interface PnlOverallWire {
  /** Cumulative realized `realized_pnl_net` plus current open unrealized, in GBP. Signed. */
  net_gbp: number;
  /** `net_gbp` as a signed fraction of the £1,000 declared book (`LIVE_BOOK_GBP`) — 0.05 is 5%. */
  net_pct_of_book: number;
  /** Peak-to-trough fall of the REALIZED series only, as a positive fraction of the declared book. Zero when the series never fell below a prior peak. */
  max_drawdown_pct: number;
  /**
   * Every closed trade this arm has ever recorded, not windowed to
   * `closed_trades` above — AND, on the live arm, not filtered the way the
   * arm-comparison panel's `trade_count` is (#1616, see this interface's
   * header). This figure can exceed the panel's live `trade_count` for the
   * same window; that is not a bug to reconcile silently.
   */
  trade_count: number;
}

/**
 * One arm's P&L over the Europe/London calendar day (#1595) — BST-aware, so a
 * close just after midnight UTC during British Summer Time still counts on
 * the London day it happened on, not the UTC day.
 *
 * No `max_drawdown_pct`: a single day's realized-plus-unrealized figure is a
 * snapshot, not a series with a peak to fall from — the drawdown concept
 * belongs to `PnlOverallWire`'s all-time series, not to this window.
 *
 * `realized_gbp`/`costs_gbp`/`trade_count` are a same-day filter over the
 * SAME unfiltered `getAllClosedTrades` population as `PnlOverallWire`, not
 * the arm-comparison panel's — see that interface's header (#1616) for what
 * that means on the live arm.
 */
export interface PnlTodayWire {
  /** `realized_gbp + unrealized_gbp`, signed. */
  net_gbp: number;
  /** `net_gbp` as a signed fraction of the £1,000 declared book. */
  net_pct_of_book: number;
  /** Sum of `realized_pnl_net` for trades closed today, in GBP. Signed. */
  realized_gbp: number;
  /** Current open positions' mark-to-market PnL, in GBP. Signed — this arm's `net_gbp` above already includes it. */
  unrealized_gbp: number;
  /** Sum of `fees_total` for trades closed today, in GBP. Always non-negative. */
  costs_gbp: number;
  /** Trades closed today, this arm. */
  trade_count: number;
}

/**
 * The dashboard's server-computed P&L headline for one arm (#1595) — all-time
 * with drawdown, and today over the Europe/London calendar day, both in GBP.
 *
 * The conversion rate travels WITH the figures rather than being assumed by
 * the renderer, the same reason `ArmComparisonRow.basis` is carried rather
 * than recomputed client-side: a renderer that hard-coded the rate would keep
 * showing the old one the moment this changes.
 */
export interface PnlHeadlineWire {
  overall: PnlOverallWire;
  today: PnlTodayWire;
  /** USD per GBP — `SIZING_USD_PER_GBP` (`paper-profile.ts`), the same static rate `ArmComparisonRow.basis` is converted at. */
  rate_usd_per_gbp: number;
  rate_source: PnlRateSource;
}

/**
 * Why a lot closed. Structurally identical to the server-side
 * `ExitReason | 'stop' | 'target' | 'exit'` union
 * (`server/shared/types/records.ts`, `ClosedTrade.close_reason`) — duplicated
 * here rather than imported because `contracts/` may import from neither
 * `server/` nor `client/` (the boundary `contracts/boundary.test.ts`
 * enforces). Widen both sides together if a new reason is ever added.
 */
export type CloseReason =
  | 'stop'
  | 'target'
  | 'exit'
  | 'flatten'
  | 'signal_decay'
  | 'direction_flip';

/**
 * One realized round trip from `closed_trades` (#940) — the dashboard's only
 * view of a position AFTER it flattens. `positions` above is open lots only;
 * without this a trade that entered, filled and flattened left no trace
 * anywhere on the wire.
 *
 * `exit_price` is not a `closed_trades` column — the table has no such field.
 * `buildSnapshot` derives it, preferring the actual weighted price of this
 * trade's non-entry `fills` (real, but requires a fill row to exist) and
 * falling back to `realized_pnl_net`/`fees_total` arithmetic against `entry`
 * for a trade whose exit fills were not captured. Either way it is a single
 * number on the wire — the two cases are not distinguished here.
 */
export interface ClosedTradeRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  entry_price: number;
  /** Derived — see the interface doc above. Not a stored column. */
  exit_price: number;
  filled_size: number;
  realized_pnl_net: number;
  fees_total: number;
  opened_at: string;
  closed_at: string;
  close_reason: CloseReason;
}

/**
 * One `fills` row (#940) — the venue-side execution trail. `broker_fill_id`
 * is the nearest thing to a traceable order id a closed lot carries:
 * `open_positions.broker_order_ids` exists only while a lot is open and is
 * not preserved once it closes, so this is the identifier a completed trade
 * can still be traced by.
 */
export interface FillRow {
  idempotency_key: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: string;
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

/**
 * The comparators an invalidation condition may use, and the tri-state it
 * evaluates to. Structural twins of the server-side `InvalidationComparator`
 * and `InvalidationConditionState` (`server/pipeline/risk-manager/types.ts`),
 * duplicated for `TradingArmWire`'s reason — `contracts/` may import from
 * neither runtime. Widen both sides together.
 */
export type InvalidationComparatorWire = '<' | '<=' | '>' | '>=';
export type InvalidationConditionStateWire = 'breached' | 'not_breached' | 'unevaluable';

/**
 * The validator's drop reasons, mirroring the server's
 * `InvalidationDropReason`. Same duplication rule as the two unions above.
 */
export type InvalidationDropReasonWire =
  | 'unparseable'
  | 'unknown_observable'
  | 'unknown_indicator'
  | 'lookback_too_large'
  | 'threshold_out_of_range'
  | 'direction_incoherent'
  | 'over_cap';

/**
 * One invalidation condition as measured (#1066), flattened from the server's
 * `EvaluatedCondition` — the condition the critic proposed plus the fact
 * deterministic code measured about it.
 *
 * `observable` is a LABEL, not the server's `InvalidationObservable` union.
 * That union nests `IndicatorSpec` (indicator kind, params, lookback,
 * timeframe) and `BarWindow`, none of which the drawer renders: it shows what
 * was measured, and duplicating two deep server types onto the wire to
 * reconstruct one string in the browser would put the vocabulary in two places
 * and let them drift. `buildSnapshot` projects the label, using the same
 * `kind:name` words the `RiskDecision.reasons` audit lines use, so a screen and
 * a log line name the same observable.
 *
 * `observed` is `null` exactly when `state` is `unevaluable` — the read failed
 * or returned too little data. It is never rendered as `0`, which would be a
 * measurement that never happened.
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

/** A condition the validator refused, with its reason (#1066). `id` is null when the emission carried none. */
export interface DroppedConditionWire {
  id: string | null;
  /** What the model said, bounded server-side. Audit only. */
  raw: string;
  reason: InvalidationDropReasonWire;
}

/**
 * One recent Risk decision with its Risk Critic verdict attached (#1066) —
 * what the drawer's invalidation section renders, after #994 folded the
 * declined standalone stage's typed conditions into the critic.
 *
 * **Keyed by `(trace_id, instrument)`, which is `risk_log`'s primary key and
 * the pair the drawer already holds.** Not by `debate_id`, deliberately: a
 * retried tick mints a fresh `trace_id` but keeps its content-hashed
 * `debate_id` (migration 0015), and the drawer resolves its debate by
 * INSTRUMENT, so a `debate_id`-keyed row joined in the browser could render one
 * trace's binding constraint beside another trace's conditions — silently, both
 * rows real. The join happens server-side against the trace instead.
 *
 * Every critic-side field is nullable because the critic genuinely may not have
 * run: `binding_constraint` is null when no gate named one, and
 * `critic_verdict` / `reasoning` are null when the decision has no
 * `risk_critic_log` row at all (the critic was skipped, or the trace has no
 * `trader_log` row linking it to a debate).
 */
export interface RiskCriticRow {
  trace_id: string;
  instrument: string;
  /** The debate this decision attacked, from `trader_log`. Null when the trace links to none. */
  debate_id: string | null;
  /**
   * The gate that decided it, verbatim from `risk_log` — notably
   * `risk_critic:invalidated` (a measured breach) versus `risk_critic:reject`
   * (the critic's prose), which #997 Q2b keeps distinct precisely so an
   * operator can see the two disagree.
   */
  binding_constraint: string | null;
  critic_verdict: 'pass' | 'trim' | 'reject' | 'unavailable' | null;
  /** The critic's argument text (audit). */
  reasoning: string | null;
  /**
   * The measured conditions, or `null` when the row carries none — a pre-fold
   * row (migration 0040 backfilled nothing), an unreadable column, or no critic
   * row at all. Nullable and REQUIRED rather than optional: `JSON.stringify`
   * drops an `undefined` field, so an optional one would put "absent" and
   * "null" on the wire as the same bytes while the client still has to branch.
   *
   * `null` and `[]` render identically as `no_conditions` — the one "nothing
   * checkable came out" state, whatever the cause (#997 Q3) — but
   * `dropped_conditions` is its own surface and is shown either way.
   */
  conditions: EvaluatedConditionWire[] | null;
  dropped_conditions: DroppedConditionWire[] | null;
  created_at: string;
}

/** Per-analyst weight + rolling attribution (story 6). */
export interface AnalystPerformanceRow {
  analyst_id: string;
  weight: number;
  rolling_r: number;
  window_days: number;
}

/**
 * The Feedback Loop's daily MetricsSuite (story 7) — reported together,
 * never one number. NOT `MetricsSuite` verbatim (#1270): `profit_factor` is
 * replaced with `ProfitFactorWire`, since the domain field's `Infinity` (a
 * window with wins and no losses) has no `JSON.stringify` representation —
 * see `contracts/metrics.ts`'s `ProfitFactorWire` doc for the full boundary
 * argument. Every other field is unaffected and still a plain `number`.
 */
export type MetricsSuiteWire = Omit<MetricsSuite, 'profit_factor'> & {
  profit_factor: ProfitFactorWire;
};

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
  /**
   * The ceiling the enforcer is actually applying (ADR-0008), armed at boot by
   * the orchestrator's composition root.
   *
   * `null` here is AMBIGUOUS on its own (#1196) — it means either "armed
   * uncapped" (the operator deliberately left `llmBudgetUsd` unset) or "never
   * armed" (no row was ever written: the orchestrator never booted against
   * this database, or a wiring regression). Those are opposite situations on
   * a live-money surface: the first is a choice, the second means nothing may
   * be enforcing anything. Disambiguate with `cap_armed_at` — see there — and
   * never substitute a denominator for a `null` cap regardless of which case
   * it is. See `server/shared/store/sqlite-llm-spend-cap-store.ts` (#1140,
   * #1196).
   */
  cap_usd: number | null;
  /**
   * When the current cap (whatever `cap_usd` reads) was armed, or `null` if
   * no row has ever been written — the discriminator `cap_usd` alone cannot
   * carry (#1196).
   *
   * `null` here means "never armed": treat `cap_usd` as unknown, not as
   * "uncapped" — the client must not claim the operator chose "no ceiling"
   * when nobody has said anything at all. Non-null (a `toStoredTimestamp`
   * string) means a row exists — usually with `cap_usd` at that arming's
   * real value, `null` (uncapped) or a number (possibly `0`, the most
   * restrictive cap there is — a `0` must render as a stated cap, never as
   * "unconfigured"). The one exception: `SqliteLlmSpendCapStore.read()`
   * nullifies a non-finite stored `budget_usd` (a `REAL` column can hold a
   * value `arm()` never wrote) WHILE KEEPING `armed_at` — so a non-null
   * `cap_armed_at` alongside `cap_usd: null` can also mean "armed, but the
   * stored ceiling is corrupt", not only "armed, deliberately uncapped".
   * That corruption is reachable only by writing the row outside `arm()`
   * (both `production.ts` call sites pass a finite number or `null`), not by
   * any live path (#1196 review).
   */
  cap_armed_at: string | null;
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
  /**
   * The arm this snapshot's `positions`/`closed_trades` were read for (#1592).
   * Absent from a request means `'live'` — the server resolves that default,
   * never the client — and an unrecognised request value is refused with a
   * 400 before `buildSnapshot` runs, so this field is always one of the two
   * `TradingArmWire` literals, never a guess. Every other section below
   * (`debates`, `verdicts`, `risk_critics`, `analysts`, `metrics`,
   * `pipeline`, …) is unaffected by this field and still reads the live arm
   * only — #1594 tracks widening those reads to match.
   */
  arm: TradingArmWire;
  tick_status: TickStatus | null;
  positions: PositionRow[];
  /** Recent realized round trips (#940) — most-recently-closed first. */
  closed_trades: ClosedTradeRow[];
  /** Fills belonging to `closed_trades` above — every leg, entry through exit. */
  fills: FillRow[];
  debates: DebateRow[];
  verdicts: VerdictRow[];
  /**
   * Recent Risk decisions with their critic verdicts and invalidation
   * conditions (#1066), most recent first — the drawer's invalidation section.
   *
   * Required and an EMPTY ARRAY when nothing is recorded, matching
   * `arm_comparison`: an optional field would let a payload that simply never
   * read the table render identically to one whose window holds no decision,
   * and the section's whole job is to name which of those an operator is
   * looking at.
   */
  risk_critics: RiskCriticRow[];
  analysts: AnalystPerformanceRow[];
  metrics: MetricsSuiteWire;
  /**
   * The Feedback Loop's matched-control comparisons (#971, #913 surface 2),
   * most-recently-computed first — falsifier arm 2 against the live arm, on
   * FL's own cadence.
   *
   * Required, not optional, and an EMPTY ARRAY when FL has computed none. A
   * dashboard that could omit this field would render a book with no matched
   * control exactly like a book with one, which is the state ADR-0014
   * amendment 2 forbids and the thing the panel exists to make visible. Empty
   * means "no comparison computed yet" and the panel says so in those words —
   * it must never be drawn as zeros, which would read as "both arms flat, no
   * divergence".
   */
  arm_comparison: ArmComparisonRow[];
  /**
   * The Feedback Loop's outside benchmarks (#981), newest first — SPY and
   * 60/40, over the SAME window the `arm_comparison` rows above were measured
   * over, on the same cadence.
   *
   * Required and an EMPTY ARRAY when FL has measured none, matching
   * `arm_comparison` — but note the field is SECONDARY to it, and the panel is
   * laid out to say so. An outside benchmark is context for the matched
   * control's reading, never the thing to beat (CLAUDE.md Key Constraints;
   * ADR-0014 amendment 2; ADR-0017 §Consequences).
   *
   * Rows, not cycles: with two benchmarks measured per cycle, a cycle
   * contributes up to two entries. A cycle may contribute FEWER — a benchmark
   * whose series was unavailable is simply absent, because FL persists nothing
   * it could not measure and a zero row would be a fabricated benchmark. The
   * panel renders that absence as "not measured", never as 0.00%.
   */
  outside_benchmarks: OutsideBenchmarkRow[];
  /**
   * The server-computed P&L headline for `arm` above (#1595) — all-time with
   * drawdown, and today over the Europe/London calendar day, both converted to
   * GBP. See `PnlHeadlineWire`'s doc for why the rate travels with the figures
   * and why only the all-time half carries a drawdown.
   */
  pnl: PnlHeadlineWire;
  /**
   * Count of alert sends TO THE ESCALATION CHAT that exhausted retry and
   * were durably recorded in `alert_delivery_failures` in the TRAILING 24
   * HOURS (#1108, windowed by #1131) — the answer to "is the alert channel
   * down", so an operator reads a number instead of reading silence as calm.
   *
   * WINDOWED, NOT ALL-TIME (#1131). An earlier version of this field was an
   * unbounded-below count, so a single transient failure made the tile read
   * "degraded" forever with no way to tell it apart from a live outage. 24
   * hours is chosen against the mechanism, not copied from another field's
   * window: a row is written only when an escalation-chat send exhausts
   * retries, escalations fire across roughly twenty pipeline channels with no
   * rate floor between them, and the window has to outlast the expected gap
   * between escalations or a live outage's evidence would age out during a
   * quiet stretch. The trade is that one resolved blip can stay visible for
   * up to a day — see `alert-delivery-log.ts`'s `ALERT_DELIVERY_FAILURE_WINDOW_MS`
   * for the full reasoning.
   *
   * The lifetime total this field previously exposed is DROPPED, not moved
   * elsewhere on the wire: nothing consumed it, and keeping a second,
   * un-windowed number beside this one would risk exactly the
   * claim-stronger-than-mechanism failure #1299's review rounds were hunting
   * for. The same question is still answerable over the retention window by
   * reading `alert_delivery_failures` directly (`alert-delivery-log.ts`'s
   * `pruneOlderThan`, default 30-day retention) — bounded by that retention,
   * never a lifetime, and at the 2-day floor exactly 24 hours more than this
   * field. That reconstruction is
   * WHY the retention floor is 2 days and not 1: at `retention == window`
   * the table would stop outliving this field, and dropping the lifetime
   * total here would be dropping it outright. The ordering is not a
   * property of the floor on its own — 2 days is 48h against a 24h window,
   * and a later widening of `ALERT_DELIVERY_FAILURE_WINDOW_MS` past 48h
   * would make them equal. `alert-delivery-failure-retention.test.ts` holds
   * it, one assertion per direction; see
   * `alertDeliveryFailureRetentionDaysFromEnvironment` in `production.ts`
   * for the whole argument.
   *
   * Scoped to the escalation chat (`TELEGRAM_CHAT_ID`), not every row in the
   * table (#1108 third review pass): the same table durably records
   * heartbeat-chat delivery failures too (#342's isolation), and those would
   * otherwise falsely degrade a tile that is specifically about the
   * escalation channel. 0 when the escalation chat is not configured (no
   * known channel to answer the question about), not the unfiltered total —
   * and see `types.ts`'s `getAlertDeliveryFailureCount` doc for the full
   * trace of what a 0 or an absent tile can and cannot mean, including the
   * case this window adds: a quiet system with nothing worth escalating
   * reports 0 even if the channel is completely dead, because no send was
   * attempted against it recently.
   */
  alert_delivery_failures_24h: number;
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
  /**
   * The server's stamp of its own wire shape (#1316), compared by the client
   * on every poll (`useSnapshot.ts`) against the SAME constant its own build
   * computes. A mismatch means the served client bundle and the running
   * server were built from different `DashboardSnapshot` shapes — reachable
   * in both directions on this deployment, because `server.ts` serves
   * `dist/client/` per request with `Cache-Control: no-cache` rather than
   * resolving it once at boot: a `yarn build` while the process keeps running
   * serves new client code with no restart (new-client/old-server), and a
   * long-lived operator tab or a browser cache can just as easily hold an old
   * client against a server that has since restarted on new code
   * (old-client/new-server). Before this field, that skew was undetectable —
   * a renamed or dropped field just read as absent, and `AlertDeliveryBlock`'s
   * `?? 0` (the bug #1316 is named for) rendered that absence identical to a
   * healthy, zero-failure channel.
   *
   * Computed as `CONTRACT_VERSION` below, not hand-bumped: a hand-bumped
   * integer is exactly the kind of edit `docs/coding-standards.md`-style
   * "remember to also update X" conventions are prone to silently skipping.
   * This value is instead DERIVED from `DASHBOARD_SNAPSHOT_FIELD_NAMES`, whose
   * coverage of `keyof DashboardSnapshot` is enforced in BOTH directions at
   * `yarn typecheck` time (the two-part idiom `alert-transport.ts` uses for
   * `AlertChannelSlots`, after ten silent misses taught that lesson there):
   * `as const satisfies readonly (keyof DashboardSnapshot)[]` rejects a name
   * in the list that isn't a real field (catches a stale rename OF a listed
   * name), and `_assertDashboardSnapshotFieldNamesCoverAllKeys` below rejects
   * a real field that's missing FROM the list (catches an added-but-
   * unlisted field, and a field renamed to something not yet listed). Either
   * direction alone leaves a hole: `satisfies` alone cannot see a field that
   * was simply never added to the list, so a field could be added, later
   * renamed, and never once produce a stale literal — the exact composite
   * gap this pairing closes. A rename cannot be forgotten because forgetting
   * it does not compile.
   *
   * Deliberately shallow: the hash covers only this interface's OWN top-level
   * field names, not the shapes nested inside `providers`, `llm_spend`,
   * `DebateRow` and the rest — a rename inside one of those nested types does
   * NOT move this value. Extending the mechanism to nested shapes is
   * out of scope for #1316 (it would need per-type field lists or a
   * schema-walking codegen step, not a one-line addition); this field only
   * ever claims to detect skew in `DashboardSnapshot`'s own field set.
   */
  contract_version: string;
}

/**
 * `DashboardSnapshot`'s own field names, in declaration order — the input
 * `CONTRACT_VERSION` below is hashed from. `contract_version` is included: a
 * server that dropped or renamed the version field itself is exactly the
 * skew this mechanism must still be able to signal about, via the client's
 * own (different) compiled-in constant.
 *
 * This is the ONE place the list is written by hand — everywhere else derives
 * from it. `as const satisfies readonly (keyof DashboardSnapshot)[]` (not a
 * mutable `readonly (keyof DashboardSnapshot)[]` annotation — that widens
 * `(typeof …)[number]` back to the whole `keyof DashboardSnapshot` union,
 * which makes the exhaustiveness check below compare the union against
 * itself and pass unconditionally, catching nothing; confirmed by
 * temporarily adding `brand_new_field?: number` to `DashboardSnapshot` under
 * the old annotation and observing `yarn typecheck` pass with the hash
 * unchanged) keeps this a literal-string tuple, so TypeScript can reject a
 * listed name that ISN'T a real key. It cannot, by itself, catch a real key
 * that's simply missing from the list — see
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
 * The other half of the exhaustiveness check (mirrors `alert-transport.ts`'s
 * `ALL_ALERT_CHANNEL_FIELDS_COVERED`, adopted here after a reviewer proved
 * the single-list version above was vacuous — `satisfies` alone can reject a
 * bad name but not detect an added-and-never-listed one, so a field could be
 * added without touching the list, later renamed with no stale literal to
 * catch it, and `CONTRACT_VERSION` would never move). If
 * `DASHBOARD_SNAPSHOT_FIELD_NAMES` (exported so a test can re-derive
 * `CONTRACT_VERSION` from it independently, rather than only comparing the
 * constant to itself) stops covering every key of
 * `DashboardSnapshot`, the mapped type below gains a required key for each
 * missing field name, so `{}` no longer satisfies it and `yarn typecheck`
 * fails, naming the missing key(s) in the error.
 *
 * Verified non-vacuous the same way: with `brand_new_field?: number` added
 * to `DashboardSnapshot` and NOT added here, `yarn typecheck` fails on this
 * line with:
 *   Property 'brand_new_field' is missing in type '{}' but required in type
 *   '{ brand_new_field: never; }'.
 */
type _MissingDashboardSnapshotFieldNames = Exclude<
  keyof DashboardSnapshot,
  (typeof DASHBOARD_SNAPSHOT_FIELD_NAMES)[number]
>;
const _assertDashboardSnapshotFieldNamesCoverAllKeys: {
  [K in _MissingDashboardSnapshotFieldNames]: never;
} = {};

/**
 * FNV-1a, 32-bit, hex-encoded. Chosen over `node:crypto` because this file is
 * bundled into the browser client too (`contracts/` is imported by both
 * runtimes, CLAUDE.md) — `node:crypto` is not available there. FNV-1a is not
 * cryptographic and does not need to be: the only property this mechanism
 * needs is "the field list changing changes the output", which a 32-bit
 * non-cryptographic hash already gives with a collision risk irrelevant at
 * this input size (21 short field names).
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Exported (not just `CONTRACT_VERSION` below) so a test can prove this
 * mechanism is actually content-sensitive — hash a field list that differs
 * from the real one and assert the output differs — without touching the
 * `DashboardSnapshot` interface itself to do it (mutation evidence, #1316).
 */
export function contractVersionOf(fieldNames: readonly string[]): string {
  return fnv1aHex(fieldNames.join(','));
}

/**
 * The server's stamp of its own wire shape, and the client's own point of
 * comparison (`useSnapshot.ts`) — both computed by this SAME function from
 * the SAME source list, since both runtimes import `contracts/`. See
 * `DashboardSnapshot.contract_version`'s doc comment for what a mismatch
 * means and why this is derived rather than hand-bumped.
 */
export const CONTRACT_VERSION = contractVersionOf(DASHBOARD_SNAPSHOT_FIELD_NAMES);
