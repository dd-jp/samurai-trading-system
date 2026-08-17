/**
 * Domain types for the Risk Manager (Stage 4) core check pipeline.
 * See docs/specs/risk-manager-spec.md ("Key Interfaces", "Module: Check
 * Pipeline") and docs/specs/cross-spec-contracts.md. Implementation ticket
 * #76 — the pipeline only. `PortfolioView` computation is #78; breaker-trip
 * computation is #77 — both are consumed here as pre-built inputs.
 */
import type { Clock, InstrumentSubclass, OrderIntent } from '../../shared/index.js';

/**
 * Pre-computed breaker trip state, tiered per risk-manager-spec.md
 * ("Module: Circuit Breakers"). Computing *when* a breaker trips is #77;
 * the pipeline here only reads the current armed/tripped state and halts
 * new entries accordingly. Exits are never gated by breakers.
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
 * Crash-restart-safe row shape for the sticky breakers (hard drawdown +
 * kill-switch) — one row per tier, matching the `breaker_state` table in
 * shared-sqlite-store-spec.md (ticket #203). Unlike `BreakerState` (a
 * derived, per-evaluate-call view with no timestamps), this shape is
 * lossless: `CircuitBreakers` can be reconstructed from it exactly,
 * which is what makes trip state survive a process restart.
 */
export interface PersistedBreakerState {
  tier: 'portfolio_drawdown' | 'kill_switch';
  tripped: boolean;
  tripped_at: Date | null;
  reset_at: Date | null;
  reason: string | null;
}

/**
 * Session-scoped daily PnL, as a fraction (-0.05 is a 5% loss) — or an
 * explicit "not known" (#332).
 *
 * A discriminated union, NOT `number | null`, and deliberately so. The daily
 * loss breaker's test is `pct <= -config.daily_loss_pct`; JavaScript coerces
 * both `null` and `undefined` in that comparison (`null <= -0.05` evaluates
 * `0 <= -0.05` → `false`), so a nullable number would read an unknown figure as
 * *flat* and silently leave the breaker un-tripped through a real loss. With a
 * tagged union there is no numeric coercion path at all: `pct` is unreachable
 * until `known` has been narrowed, which makes "unknown treated as zero" a
 * compile error at every consumer rather than a runtime near-miss.
 *
 * `reason` is operator-facing — it names why the figure is absent, so a halted
 * session is diagnosable without reading code.
 */
export type DailyPnl =
  | { readonly known: true; readonly pct: number }
  | { readonly known: false; readonly reason: string };

/**
 * Daily PnL per session boundary (#332). The three figures are measured from
 * DIFFERENT boundaries — crypto from 00:00 UTC, stocks from the prior 16:00 ET
 * close, portfolio from 00:00 UTC — each against its own class's equity at that
 * boundary.
 *
 * They therefore do NOT sum to one another, by design, and no invariant should
 * be asserted between them: `crypto + stocks === portfolio` is false whenever a
 * stock trade closes between Friday 16:00 ET and Saturday 00:00 UTC.
 */
export interface DailyPnlByClass {
  readonly crypto: DailyPnl;
  readonly stocks: DailyPnl;
  readonly portfolio: DailyPnl;
}

/**
 * Accounting view over the shared store (#78). Consumed here read-only —
 * the pipeline never computes exposure/drawdown itself.
 */
export interface PortfolioView {
  equity: number;
  peak_equity: number;
  drawdown_pct: number;
  exposure_by_instrument: Record<string, number>;
  exposure_by_class: { crypto: number; stocks: number };
  gross_exposure: number;
  /**
   * Replaces the former single `daily_pnl_pct: number`, which was Alpaca's
   * blended `last_equity` figure on an unverified boundary (GAP-8, #332).
   */
  daily_pnl: DailyPnlByClass;
  consecutive_losses: number;
}

/**
 * What the account layer knows about one session's starting point (#332), fed
 * to `computePortfolioView` so it can finish the division.
 *
 * The split of labour is deliberate: the account provider owns the durable
 * snapshot and the realized sum (it has the store and the calendars);
 * `computePortfolioView` owns the unrealized term, because it has already
 * fetched the marks and must not fetch them a second time.
 */
export type SessionBasis =
  | {
      readonly known: true;
      /** Portfolio equity at this class's session open — the denominator. */
      readonly open_equity: number;
      /** Realized PnL net of fees, for this class, since that open. */
      readonly realized_pnl: number;
    }
  | { readonly known: false; readonly reason: string };

export interface SessionBasisByClass {
  readonly crypto: SessionBasis;
  readonly stocks: SessionBasis;
  readonly portfolio: SessionBasis;
}

/**
 * Point-in-time pairwise correlation of one instrument against every other
 * held instrument with sufficient return history (ticket #50, v2 of the
 * concentration check — replaces the v1 static `ConcentrationBucket` list).
 * Computed outside `evaluate()` by `computeCorrelationEstimate` (correlation.ts)
 * and consumed here as pre-built data, mirroring `PortfolioView`/`BreakerState`.
 *
 * An instrument pair with insufficient overlapping history is still absent
 * from `correlations` rather than assigned a value — that omission IS the
 * warm-up fallback: the pipeline treats an absent entry as "not correlated"
 * rather than guessing. What #303 adds is that the omission is now NAMED, in
 * `insufficient_history`, so "we measured no correlation" and "we could not
 * measure" stop being the same observation to the caller. The fallback
 * behaviour is unchanged; only its visibility is.
 */
export interface CorrelationEstimate {
  /** Keyed by the OTHER instrument; value is its correlation with the intent's instrument. */
  correlations: Record<string, number>;
  /**
   * Held instruments dropped from `correlations` because the PAIR's
   * overlapping return history was under `CorrelationConfig.min_bars` (#303).
   *
   * A statement about the pair, not about the named instrument: overlap is
   * `min(target, other)`, so the thin side may be the intent's own instrument
   * — a brand-new listing being sized against a portfolio of long-established
   * holdings names every one of them here. Read an entry as "correlation with
   * X is unmeasurable", never as "X is new".
   *
   * Advisory only: the concentration check still cannot bind on these pairs,
   * so an entry here is a statement about what is UNKNOWN, never an input to
   * a trim. Present-but-empty means every held pair was measurable.
   */
  insufficient_history: string[];
}

/**
 * Static, config-driven thresholds the pipeline trims/rejects against.
 * Exact values are tuned in paper trading (risk-manager-spec.md "Out of
 * Scope: Exact limit values") — this is the shape, not the numbers.
 */
export interface RiskConfig {
  /** Max notional exposure for a single trade. */
  max_position_size: number;
  /** Max total notional exposure to one instrument. */
  per_asset_cap: number;
  /** Max total notional exposure per asset-class bucket. */
  per_asset_class_cap: { crypto: number; stocks: number };
  /** Max total gross notional exposure across the portfolio. */
  portfolio_gross_cap: number;
  /** v2 dynamic concentration check (#50) — caps combined exposure across the intent's instrument and every instrument correlated with it. */
  concentration: {
    /** Max combined notional exposure across the intent's instrument and everything correlated with it. */
    cap: number;
    /** |correlation| at/above which another instrument counts as concentrated risk with this one. */
    threshold: number;
  };
  /** Below this notional, a trimmed intent is dust and must be rejected. */
  min_viable_size: number;
  /** CII soft signal (#205): absolute WorldMonitor CII level (0-100) above which a warning fires. Unpinned, tuned in paper trading. */
  cii_threshold: number;
  /**
   * #640: max age of a mark used to VALUE a held position, per asset class,
   * before `computePortfolioView` refuses to produce a view at all.
   *
   * A risk bound rather than a data-service one. Every number the Risk
   * Manager gates on — gross exposure, per-class exposure, drawdown, daily
   * PnL — is computed from these marks, so a frozen price does not degrade
   * the view, it freezes every limit that reads it. The spec bills this stage
   * as "trusted absolutely under stress"; that claim needs the marks under it
   * to be current, and nothing checked until this field existed.
   *
   * `evaluate()` itself stays pure and synchronous and does NOT read this —
   * it never touches the data service. The bound binds where the reads
   * actually happen, which is `computePortfolioView`.
   */
  max_mark_age: Record<'crypto' | 'stocks', number>;
  /**
   * ADR-0018 D5's volatility-aware deployment envelope — the record's only
   * drawdown protection on the intraday product, and until this field existed,
   * unbuilt.
   *
   * Optional, and the optionality is the design. Absent means the gate does
   * not apply at all (`perSubclassDeploymentCap` returns `null`, exactly as
   * `concentrationCorrelationCap` does on an uncorrelated book), which is the
   * correct reading for the backtest harness and every test that predates
   * subclasses. Present means it is ARMED, and an instrument missing from
   * `subclass_of` then throws rather than sizing unbounded — off by default,
   * fails loud once declared.
   */
  per_subclass_deployment_cap?: SubclassDeploymentCap;
}

/**
 * ADR-0018 D5, as config.
 *
 * D5 deploys a fixed fraction of the EQUITY LEG per subclass — ~35% to a 3x
 * index ETP, ~25% to a 3x single-stock ETP — holding measured max drawdown at
 * 23.1% and 26.2% respectively. Two properties of that envelope have to
 * survive into the code, because both are easy to round off:
 *
 * 1. **It is measured drift-removed with zero edge assumed.** The envelope
 *    therefore binds REGARDLESS of how good the signal turns out to be. It is
 *    not contingent on the indicator work or the threshold studies passing,
 *    and it must never become a dial the Feedback Loop can widen — see the
 *    deliberate absence from `RISK_THRESHOLD_KEYS` (risk-thresholds.ts), the
 *    allow-list backing the `risk_thresholds` table.
 * 2. **The single-stock fraction knowingly overshoots, and by more than D5
 *    published.** D5's rows were measured at the pre-neutral `SLS = {1.5, 3}`
 *    grid rather than at the brackets D3 declares and #724 froze; re-measured
 *    at the declared stops the envelope is ~26.2% (index, 35%) and ~41.8%
 *    (single-stock, 25%), so the recorded ~1.2 pp overshoot of CONTEXT.md's
 *    20-25% band is really ~17 pp (D5's #729 verification note, 2026-08-17).
 *    The fractions stay at 0.35 / 0.25 regardless: that note "records the
 *    measurement only", and re-sizing to the f ~= 0.332 / 0.142 that would
 *    hold the tolerance is an amendment nobody has made. Tightening either
 *    number here would be an unrecorded re-selection, which D4 forbids.
 */
export interface SubclassDeploymentCap {
  /**
   * Instrument -> the subclass ADR-0018 prices it under, sourced from the
   * universe at the composition root (the same place `assetClassOf` is built,
   * production/defaults.ts) rather than derived from the ticker string. There
   * is nothing in "3LAP" that says single-stock; only the pool file knows.
   */
  subclass_of: Readonly<Record<string, InstrumentSubclass>>;
  /**
   * Subclass -> max notional deployed to that subclass, as a FRACTION OF
   * CURRENT EQUITY resolved at evaluation time (#739) — not a frozen cash
   * amount, which is what this field carried until ADR-0018's sizing
   * amendment settled the basis.
   *
   * **The fractional form is what makes the drawdown bound keep bounding.** A
   * fixed £262 is 34.9% of a £750 book, 43.7% of £600 and 58.2% of £450, so
   * under a frozen amount exposure rises as a fraction of equity exactly as
   * equity falls and the envelope stops binding at the first loss. Because
   * exposure now shrinks after a loss, cumulative loss under this rule is
   * strictly smaller than under the fixed-cash deployment doc 18's rows
   * describe — D5's envelope figures are UPPER BOUNDS for what is implemented
   * here, not estimates of it.
   *
   * Each fraction is `EQUITY_LEG_FRACTION_OF_CAPITAL x` D5's own per-subclass
   * fraction (paper-profile.ts), because D5 deploys a fraction of the EQUITY
   * LEG and `RiskPortfolioView.equity` is the whole account.
   *
   * Total over `InstrumentSubclass` so a new subclass is a compile error here
   * rather than a silent absence, which on this gate would read as "no cap".
   * `null` is the explicit "D5 measured no envelope for this one" — it is not
   * a placeholder to be filled with a plausible number later. Today only
   * `crypto` is `null`: doc 18's study covers the two leveraged-ETP subclasses
   * and nothing else, and the crypto leg is parked out of the tick loop
   * (#705). `per_asset_class_cap.crypto` still bounds it.
   */
  cap_fraction_of_equity: Readonly<Record<InstrumentSubclass, number | null>>;
}

/** The red-team critic's verdict on one gated `OrderIntent` (ADR-0003, #204). Produced *outside* `evaluate()` by critic.ts and consumed here as pre-built data.
 *
 * `unavailable` is what a failed live critic call persists (fail-open, per ADR-0003 §Consequences): the mechanical steps remain the safety net. */
export interface RiskCriticVerdict {
  verdict: 'pass' | 'trim' | 'reject' | 'unavailable';
  /** Only meaningful for `trim`: the notional the critic argues this intent should be capped at. */
  max_notional: number | null;
  /** The critic's argument text (audit). Surfaces on `RiskDecision.reasons`. */
  reasoning: string;
}

/** Persisted critic row, keyed by `debate_id` — joined with `debate_log` and `cosine_setups` (#162). */
export interface RiskCriticLog {
  debate_id: string;
  verdict: RiskCriticVerdict;
  created_at: Date;
}

/** Port for the `debate_id`-keyed critic log. In-memory implementation in critic-store.ts; SQLite-backed store deferred repo-wide. */
export interface RiskCriticStore {
  writeVerdict(entry: RiskCriticLog): void;
  getByDebateId(debate_id: string): RiskCriticLog | undefined;
}

export interface RiskInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  intent: OrderIntent;
  clock: Clock;
  portfolio: PortfolioView;
  breakers: BreakerState;
  /**
   * Lossless sticky-breaker rows for this call, pre-computed by
   * `CircuitBreakers.getPersistedState()` (#203) — `evaluate()` only echoes
   * this onto `RiskDecision.next_breaker_state`; it never derives or
   * mutates it. The caller persists it to the `breaker_state` table after
   * each call so a restart can reconstruct `CircuitBreakers` exactly.
   */
  next_breaker_state: PersistedBreakerState[];
  /** Pairwise correlation of the intent's instrument vs held instruments (#50); pre-computed by correlation.ts. */
  correlation: CorrelationEstimate;
  /**
   * WorldMonitor CII soft signal (#205), keyed by country/region code.
   * Pre-fetched by `CiiConsumer` (market-intelligence/worldmonitor-adapter/cii-consumer.ts)
   * on its own decoupled cadence, not read live inside `evaluate()`. A country
   * absent from this record has no known score (not zero risk) — see
   * `CiiConsumer.getScores`.
   */
  cii: Record<string, number>;
  /** Red-team critic verdict (#204), pre-fetched by critic.ts. Absent = pass; mechanical steps are the safety net. */
  critic?: RiskCriticVerdict;
  /**
   * Consumed by #77 (`CircuitBreakers.evaluate`), not by this pipeline. It no
   * longer selects manual vs auto re-arm for the hard breaker — since #634 the
   * re-arm policy runs in every mode (ADR-0013) — it now selects only whether
   * `auto_rearm.max_days_tripped`, the elapsed-time arm, is honoured, which is
   * backtest-only.
   */
  mode: 'live' | 'paper' | 'backtest';
}

export interface RiskDecision {
  status: 'approved' | 'rejected';
  /** Possibly trimmed; present iff approved. */
  order_intent: OrderIntent | null;
  modifications: {
    original_size: number;
    final_size: number;
    stop_tightened: boolean;
  } | null;
  /** Which check step trimmed/killed the intent, e.g. 'per_asset_class_cap', 'circuit_breaker:portfolio'. */
  binding_constraint: string | null;
  /** Machine tags + human text (audit). */
  reasons: string[];
  /**
   * Advisory-only tags, e.g. 'macro_risk_flag:RU' from the CII soft signal
   * (#205, ADR-0002). Never trims, rejects, or otherwise affects `status`,
   * `order_intent`, or `binding_constraint` — see "Module: CII Soft Signal".
   */
  warnings: string[];
  risk_snapshot: {
    /** Per instrument / class / portfolio. */
    exposure: Record<string, number>;
    drawdown_pct: number;
    armed_breakers: string[];
  };
  /** Echo of `RiskInput.next_breaker_state` (#203) — the caller persists this to the `breaker_state` table so a restart survives a tripped breaker. */
  next_breaker_state: PersistedBreakerState[];
}

/** Single test seam. Fully deterministic given its inputs. */
export interface RiskManager {
  evaluate(input: RiskInput): RiskDecision;
}
