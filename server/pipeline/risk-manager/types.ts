/** Domain types for the Risk Manager (Stage 4) check pipeline. `PortfolioView` and breaker-trip computation are consumed here as pre-built inputs (#77/#78), not computed. */
import type { BarWindow, IndicatorSpec } from '../../providers/market-data-service/index.js';
import type { Clock, InstrumentSubclass, OrderIntent } from '../../shared/index.js';

/**
 * Pre-computed breaker trip state (#77) — the pipeline only reads the current armed/tripped state and
 * halts new entries accordingly. Exits are never gated by breakers.
 */
export interface BreakerState {
  portfolio_tripped: boolean;
  asset_class_tripped: {
    crypto: boolean;
    stocks: boolean;
  };
  /** Human/audit-facing names of every currently armed breaker, e.g. 'portfolio_drawdown_hard'. */
  armed_breakers: string[];
}

/**
 * Crash-restart-safe row shape for the sticky breakers (#203) — unlike `BreakerState` (a derived,
 * timestamp-less view), this is lossless: `CircuitBreakers` reconstructs from it exactly after a restart.
 */
export interface PersistedBreakerState {
  tier: 'portfolio_drawdown' | 'kill_switch';
  tripped: boolean;
  tripped_at: Date | null;
  reset_at: Date | null;
  reason: string | null;
}

/**
 * Session-scoped daily PnL as a fraction, or explicit "not known" (#332) — a discriminated union, NOT
 * `number | null`: `null <= -config.daily_loss_pct` coerces to a real comparison and would read an
 * unknown figure as flat, silently leaving the loss breaker un-tripped through a real loss.
 */
export type DailyPnl =
  | { readonly known: true; readonly pct: number }
  | { readonly known: false; readonly reason: string };

/**
 * Daily PnL per session boundary (#332): crypto from 00:00 UTC, stocks from prior 16:00 ET close,
 * portfolio from 00:00 UTC — each against its own boundary equity. They do NOT sum to one another.
 */
export interface DailyPnlByClass {
  readonly crypto: DailyPnl;
  readonly stocks: DailyPnl;
  readonly portfolio: DailyPnl;
}

/** Accounting view over the shared store (#78), consumed read-only — the pipeline never computes exposure/drawdown itself. */
export interface PortfolioView {
  equity: number;
  peak_equity: number;
  drawdown_pct: number;
  exposure_by_instrument: Record<string, number>;
  exposure_by_class: { crypto: number; stocks: number };
  gross_exposure: number;
  /**
   * Notional of SUBMITTED-not-yet-filled orders, at mark (#1019) — distinct from `exposure_by_instrument`
   * (filled only). Never folded into `gross_exposure`/`equity`/`drawdown_pct`/`BreakerEvalInput` (would
   * double-count); released only by broker truth (fill/terminalization), never by a time-based age-out.
   */
  reserved_exposure_by_instrument: Record<string, number>;
  reserved_exposure_by_class: { crypto: number; stocks: number };
  reserved_gross_exposure: number;
  /** Replaces the former `daily_pnl_pct: number`, which was Alpaca's blended `last_equity` on an unverified boundary (GAP-8, #332). */
  daily_pnl: DailyPnlByClass;
  consecutive_losses: number;
  /**
   * Held instruments this view could NOT value (#841) — required, not optional, because an optional field
   * would let a partial view reach the entry gate as `undefined` and read as fully valued. Non-empty is
   * reachable only on the EXIT path (`unvaluable_marks: 'exclude'`), never on entry.
   */
  unvalued_instruments: readonly string[];
}

/**
 * What the account layer knows about one session's starting point (#332). Account provider owns the
 * durable snapshot/realized sum; `computePortfolioView` owns the unrealized term since it already has the marks.
 */
export type SessionBasis =
  | {
      readonly known: true;
      /** Portfolio equity at this class's session open — the denominator */
      readonly open_equity: number;
      /** Realized PnL net of fees, for this class, since that open */
      readonly realized_pnl: number;
    }
  | { readonly known: false; readonly reason: string };

export interface SessionBasisByClass {
  readonly crypto: SessionBasis;
  readonly stocks: SessionBasis;
  readonly portfolio: SessionBasis;
}

/**
 * Pairwise correlation of one instrument against every other held instrument with sufficient history (#50).
 * An absent pair means "not correlated" (the warm-up fallback); `insufficient_history` (#303) names WHY
 * it's absent, distinguishing "measured no correlation" from "could not measure".
 */
export interface CorrelationEstimate {
  /** Keyed by the OTHER instrument; value is its correlation with the intent's instrument */
  correlations: Record<string, number>;
  /**
   * Held instruments dropped from `correlations` because the PAIR's overlapping history was too short (#303) —
   * a statement about the pair, not the named instrument (the thin side may be the intent's own instrument).
   * Advisory only: never an input to a trim.
   */
  insufficient_history: string[];
}

/** Static, config-driven thresholds the pipeline trims/rejects against — the shape, not the tuned numbers (risk-manager-spec.md). */
export interface RiskConfig {
  /**
   * Max single-trade notional as a FRACTION OF EQUITY resolved at evaluate time (#886), not a frozen cash
   * amount. Skipped entirely for a D5-classified instrument with a numeric `per_subclass_deployment_cap`
   * fraction — David's #886 ruling: D5's own fraction is the sole drawdown authority once classified.
   */
  max_position_size_fraction_of_equity: number;
  /**
   * Max total notional exposure to one instrument, as a FRACTION OF EQUITY resolved at evaluate time (#886).
   * Skipped entirely for a D5-classified instrument (#932, extending #886) — `per_subclass_deployment_cap`
   * becomes the sole per-instrument deployment bound once classified; the correlation-based concentration cap still applies.
   */
  per_asset_cap_fraction_of_equity: number;
  /** Max total notional exposure per asset-class bucket, as a FRACTION OF EQUITY resolved at evaluate time (#886) */
  per_asset_class_cap_fraction_of_equity: { crypto: number; stocks: number };
  /** Max total gross notional exposure across the portfolio, as a FRACTION OF EQUITY resolved at evaluate time (#886) */
  portfolio_gross_cap_fraction_of_equity: number;
  /** v2 dynamic concentration check (#50) — caps combined exposure across the intent's instrument and every instrument correlated with it */
  concentration: {
    /** Max combined notional exposure across the intent's instrument and everything correlated with it, as a FRACTION OF EQUITY resolved at evaluate time (#886) */
    cap_fraction_of_equity: number;
    /** |correlation| at/above which another instrument counts as concentrated risk with this one */
    threshold: number;
  };
  /** Below this notional, a trimmed intent is dust and must be rejected */
  min_viable_size: number;
  /**
   * Quantise an APPROVED entry size to whole shares (#941). Must match `TraderConfig.whole_share_sizing` —
   * the Trader's floor alone is insufficient since a cap gate re-derives notional/entry and can produce a
   * fractional share again, which Alpaca rejects with a 422.
   */
  whole_share_sizing: boolean;
  /** CII soft signal (#205): absolute WorldMonitor CII level (0-100) above which a warning fires. Unpinned, tuned in paper trading. */
  cii_threshold: number;
  /**
   * Max age of a mark used to VALUE a held position, per asset class, before `computePortfolioView` refuses
   * to produce a view at all (#640) — every risk figure derives from these marks, so a frozen price freezes
   * every limit reading it. `evaluate()` itself stays sync and never reads this directly.
   */
  max_mark_age: Record<'crypto' | 'stocks', number>;
  /**
   * ADR-0018 D5's volatility-aware deployment envelope — the record's only drawdown protection on the
   * intraday product. Optional and off by default: absent means the gate doesn't apply; present means ARMED,
   * and an instrument missing from `subclass_of` then throws rather than sizing unbounded.
   */
  per_subclass_deployment_cap?: SubclassDeploymentCap;
  /**
   * Declared book ceiling (#888), armed independently of universe classification. Currency-mismatch guarded (#949):
   * `book` is GBP, `portfolio.equity` is often USD unconverted, so `same_currency_verified` must come from a real
   * same-currency balance read (#1509) — a configured FX rate (#1180) must NEVER set it; staleness could flip refusal.
   */
  live_book_ceiling?: {
    /** The declared book (`LIVE_BOOK_GBP`), in GBP */
    book: number;
    /** Same semantics as `SubclassDeploymentCap['equity_ceiling'].refuse_above_tolerance` */
    refuse_above_tolerance: number;
    /** See the currency-mismatch paragraph above. Absent/`false` refuses to arm outright. */
    same_currency_verified?: boolean;
  };
  /**
   * #1511, David's 2026-09-14 decision: long-only book — instruments a non-exit `sell` is refused on, i.e.
   * `saxoTradeableUniverse()`. Deliberately NOT `asset_class === 'stocks'`: that also caught the Alpaca
   * paper universe and measured removing ~2/3 of entry intents from a running soak. Absent means the gate doesn't apply.
   */
  long_only_instruments?: ReadonlySet<string>;
}

/**
 * ADR-0018 D5, as config: fixed deployment fractions per subclass, measured drift-removed with zero edge
 * assumed — must never become a Feedback-Loop-tunable dial (see its absence from `RISK_THRESHOLD_KEYS`).
 * The single-stock fraction (0.25) knowingly overshoots CONTEXT.md's 20-25% drawdown band (~41.8% measured);
 * it stays fixed regardless — re-sizing it would be an unrecorded re-selection (D4).
 */
export interface SubclassDeploymentCap {
  /**
   * Instrument -> subclass ADR-0018 prices it under, sourced from the universe at the composition root —
   * never derived from the ticker string (nothing in "3LAP" says single-stock).
   */
  subclass_of: Readonly<Record<string, InstrumentSubclass>>;
  /**
   * Subclass -> max notional deployed, as a FRACTION OF CURRENT EQUITY (#739) — not frozen cash, so exposure
   * shrinks after a loss rather than growing as a fraction of a smaller book. `null` means D5 measured no
   * envelope for that subclass (today only `crypto`) — not a placeholder for a number to be filled in later.
   */
  cap_fraction_of_equity: Readonly<Record<InstrumentSubclass, number | null>>;
  /**
   * The DECLARED BOOK (#888) this cap's fractions are fractions OF, resolved against it rather than raw
   * `portfolio.equity` — a blended figure with no per-leg accounting that would otherwise authorise
   * proportionally more cash once equity drifts above the book. Optional so tests can omit a book entirely.
   */
  equity_ceiling?: {
    /** The declared book (`LIVE_BOOK_GBP`) this cap's fractions resolve against, in place of `portfolio.equity` once equity has drifted past it. GBP — see the currency-mismatch note below. */
    book: number;
    /**
     * Fractional headroom above `book` before REFUSING the entry outright rather than merely capping at
     * `book` (#888) — an account funded far past the declared book invalidates every other sizing
     * assumption (breaker baselines, D5's drawdown envelope), so past this tolerance it refuses entirely.
     */
    refuse_above_tolerance: number;
    /**
     * Currency-mismatch guard (#949), same mechanism as `RiskConfig.live_book_ceiling.same_currency_verified` —
     * `book` is GBP, `portfolio.equity` often USD unconverted. Must be set only from a real same-currency
     * balance read (`armSameCurrencyCeilings`, #1509); #1180's configured FX rate deliberately never sets it.
     */
    same_currency_verified?: boolean;
  };
}

/**
 * What an invalidation condition is measured against (#994's fold of `devils-advocate-spec.md` into the
 * Risk Critic) — exactly the three deterministic reads the Risk step already performs. `mi_context` is
 * deliberately absent: the Risk step holds no MI store. Anything else is dropped, never evaluated.
 */
export type InvalidationObservable =
  | { kind: 'indicator'; spec: IndicatorSpec }
  | { kind: 'mark' }
  /** Latest bar's volume over the mean of the preceding bars in the window */
  | { kind: 'bars'; window: BarWindow; measure: 'volume_ratio' };

/**
 * One falsifying predicate the critic PROPOSED — a model can only construct this, never an
 * `EvaluatedCondition`, making "LLM names what to check, code does the checking" a type-level property.
 * No severity/weight/confidence: nothing model-assigned may reach sizing or enforcement.
 */
export type InvalidationComparator = '<' | '<=' | '>' | '>=';

export interface InvalidationCondition {
  id: string;
  observable: InvalidationObservable;
  comparator: InvalidationComparator;
  threshold: number;
  /** Why this falsifies the thesis. Free text, audit only — never machine-read. */
  rationale: string;
}

/** Tri-state, derived MECHANICALLY. `unevaluable` means the read failed/returned too little data — never a judgement, and it must not block a trade. */
type InvalidationConditionState = 'breached' | 'not_breached' | 'unevaluable';

/** A condition plus the measured fact about it. `observed` is null iff `unevaluable`. */
export interface EvaluatedCondition {
  condition: InvalidationCondition;
  state: InvalidationConditionState;
  observed: number | null;
}

/** Why the deterministic validator refused a proposed condition — persisted (not discarded) so a systematically malformed prompt doesn't hide for a month. */
export type InvalidationDropReason =
  /** Not a readable condition object: blank id, non-finite threshold, unknown comparator, no rationale */
  | 'unparseable'
  /** The `kind` is not one the Risk step can read deterministically at decision time */
  | 'unknown_observable'
  /** The named indicator is not in the Market Data Service's `INDICATOR_KINDS` registry */
  | 'unknown_indicator'
  /** `spec.lookback` (indicator) or `window.lookback` (bars) exceeds `MAX_INVALIDATION_LOOKBACK` — refused before it can trigger an unbounded market-data read (#994 review, PR #1067) */
  | 'lookback_too_large'
  /** The threshold is outside the observable's declared range, so the predicate is permanently true or permanently false */
  | 'threshold_out_of_range'
  /** The condition would fire when the thesis is WORKING rather than failing */
  | 'direction_incoherent'
  /** Beyond the 5-condition ceiling. Only the ceiling is enforced — a short list is recorded, never dropped. */
  | 'over_cap';

/** A refused condition, kept for audit. `id` is null when the emission was too malformed to carry one. */
export interface DroppedCondition {
  id: string | null;
  /** What the model said, bounded. Audit only. */
  raw: string;
  reason: InvalidationDropReason;
}

/**
 * The red-team critic's verdict on one gated `OrderIntent` (ADR-0003, #204), produced outside `evaluate()`.
 * `unavailable` is what a failed call PERSISTS (fail-open) — never handed to `evaluate()` itself, which sees
 * `undefined` and records an explicit `risk_critic: skipped` reason instead.
 */
export interface RiskCriticVerdict {
  verdict: 'pass' | 'trim' | 'reject' | 'unavailable';
  /** Only meaningful for `trim`: the notional the critic argues this intent should be capped at */
  max_notional: number | null;
  /** The critic's argument text (audit). Surfaces on `RiskDecision.reasons`. */
  reasoning: string;
  /**
   * The invalidation half (#994 fold). OPTIONAL, and absent-or-empty is ONE state — `no_conditions` —
   * regardless of cause, so a pre-fold row replays to the same decision it always reached. A malformed
   * conditions half NEVER voids the prose verdict (#997 Q2a) — that would make the system less safe.
   */
  conditions?: EvaluatedCondition[];
  /** What the validator refused, with reasons. Surfaced on `RiskDecision.reasons` and persisted. */
  dropped_conditions?: DroppedCondition[];
}

/** Persisted critic row, keyed by `debate_id` — joined with `debate_log` and `cosine_setups` (#162) */
export interface RiskCriticLog {
  debate_id: string;
  verdict: RiskCriticVerdict;
  created_at: Date;
}

/** Port for the `debate_id`-keyed critic log. `SqliteRiskCriticStore` is durable/cross-process (ADR-0003 §2 replay-from-log); `InMemoryRiskCriticStore` serves tests. */
export interface RiskCriticStore {
  writeVerdict(entry: RiskCriticLog): void;
  getByDebateId(debate_id: string): RiskCriticLog | undefined;
}

export interface RiskInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data */
  trace_id: string;
  intent: OrderIntent;
  clock: Clock;
  portfolio: PortfolioView;
  breakers: BreakerState;
  /** Lossless sticky-breaker rows (#203) — `evaluate()` only echoes this onto `RiskDecision.next_breaker_state`, never derives or mutates it. */
  next_breaker_state: PersistedBreakerState[];
  /** Pairwise correlation of the intent's instrument vs held instruments (#50); pre-computed by correlation.ts */
  correlation: CorrelationEstimate;
  /** WorldMonitor CII soft signal (#205), pre-fetched on its own cadence. An absent country has no known score — not zero risk (see `CiiConsumer.getScores`). */
  cii: Record<string, number>;
  /** Red-team critic verdict (#204), pre-fetched. Absent is NOT silently a pass — an explicit `risk_critic: skipped` reason is recorded, so the mechanical steps remain the safety net. */
  critic?: RiskCriticVerdict;
  /** Consumed by `CircuitBreakers.evaluate` (#77), not this pipeline. Since #634 selects only whether `auto_rearm.max_days_tripped` (the elapsed-time arm) is honoured — backtest-only. */
  mode: 'live' | 'paper' | 'backtest';
}

export interface RiskDecision {
  status: 'approved' | 'rejected';
  /** Possibly trimmed; present iff approved */
  order_intent: OrderIntent | null;
  modifications: {
    original_size: number;
    final_size: number;
    stop_tightened: boolean;
  } | null;
  /** Which check step trimmed/killed the intent, e.g. 'per_asset_class_cap', 'circuit_breaker:portfolio'. */
  binding_constraint: string | null;
  /** Machine tags + human text (audit) */
  reasons: string[];
  /** Advisory-only tags, e.g. `macro_risk_flag:RU` (#205) — never trims, rejects, or affects `status`/`order_intent`/`binding_constraint`. */
  warnings: string[];
  risk_snapshot: {
    /** Per instrument / class / portfolio */
    exposure: Record<string, number>;
    drawdown_pct: number;
    armed_breakers: string[];
  };
  /** Echo of `RiskInput.next_breaker_state` (#203) — the caller persists this to the `breaker_state` table so a restart survives a tripped breaker */
  next_breaker_state: PersistedBreakerState[];
}

/** Single test seam. Fully deterministic given its inputs. */
export interface RiskManager {
  evaluate(input: RiskInput): RiskDecision;
}
