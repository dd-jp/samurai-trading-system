/**
 * Domain types for the Verdict (Stage 5) core gate sequence.
 * See docs/specs/verdict-spec.md ("Key Interfaces", "Module: Gate Sequence",
 * "Module: Human-in-the-Loop") and docs/specs/cross-spec-contracts.md.
 * Implementation tickets #79 (gate sequence) and #80 (HITL automation dial
 * + flag routing).
 */

import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock, OrderIntent } from '../../shared/index.js';
import type { BreakerState, RiskDecision } from '../risk-manager/index.js';

/**
 * Dedup seam over the shared store's order/fill records, keyed on
 * `idempotency_key`. Execution (#82) is the store's real owner and sole
 * writer (docs/specs/execution-spec.md "Module: Idempotency &
 * Crash-Restart") — Verdict consumes it read-only, like Risk consumes
 * `PortfolioView`/`BreakerState` as pre-built inputs.
 */
export interface PositionStore {
  /** True if an order or fill already exists under this idempotency key. */
  findByKey(idempotency_key: string): Promise<boolean>;
}

export interface ApprovalRequest {
  order_intent: OrderIntent;
  risk_decision: RiskDecision;
  trace_id: string;
  /** Elapsed time after which a non-response resolves as 'timeout'. */
  timeout_ms: number;
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout';

/**
 * Telegram/Discord trade-channel gate (docs/specs/verdict-spec.md "Module:
 * Human-in-the-Loop"). The channel owns timeout mechanics itself (real
 * timers live) so `Verdict.decide` stays a plain await — deterministic and
 * clock-injectable. Backtest mode does not skip the call or auto-approve;
 * it overrides gate 6's outcome after the channel answers (see
 * `VerdictInput.mode` below).
 */
export interface ApprovalChannel {
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

/**
 * Static, config-driven thresholds the gate sequence checks against. Exact
 * values are tuned in paper trading (verdict-spec.md "Out of Scope: Exact
 * thresholds") — this is the shape, not the numbers.
 */
export interface VerdictConfig {
  /**
   * HITL automation dial, per asset class (verdict-spec.md "Module:
   * Human-in-the-Loop"). `manual` engages HITL for every trade, `auto`
   * never engages it, `semi_auto` engages it only for flagged trades.
   */
  automation_level: Record<'crypto' | 'stocks', 'manual' | 'semi_auto' | 'auto'>;
  /** Staleness bound: max signal age before no-go, per asset class. */
  max_signal_age: Record<'crypto' | 'stocks', number>;
  /**
   * FEED staleness bound (#641): max `now - Mark.observed_at`, per asset
   * class, before the `stale_feed` no-go.
   *
   * Distinct from `max_signal_age` above, and deliberately a second field
   * rather than a reuse of it. That one measures how long ago WE decided
   * (`decision_timestamp`); this measures how long ago the MARKET last spoke
   * (`observed_at`). A four-second-old decision priced off yesterday's close
   * passes the first gate cleanly — which is the exact trade this field
   * exists to stop. Collapsing the two would restore that hole under a name
   * that reads as if it were closed.
   *
   * Per asset class because the classes genuinely differ: crypto prints
   * continuously and a minute of silence is already anomalous, while an LSE
   * leveraged ETP (ADR-0016) is thin enough to go minutes between prints
   * inside a normal session. One number would either fire constantly on
   * equities or never fire on crypto.
   */
  max_mark_age: Record<'crypto' | 'stocks', number>;
  /**
   * Drift bound as a **fraction of the bracket's own entry price**, per asset
   * class: the gate fires when `|mark.price - entry| > entry * this`. So
   * `0.005` is "half a percent away from where we decided to enter",
   * whatever the instrument costs.
   *
   * ## Why fractional, and why this field was renamed (#381)
   *
   * This replaces `drift_tolerance`, which was an **absolute price distance**
   * in the instrument's own currency. That shape cannot be set correctly for
   * more than one instrument at a time, and the failure is asymmetric in the
   * dangerous direction: a value sized for a six-figure BTC-USD (500, i.e.
   * ~0.5%) is 250% of a $200 equity, so the gate could never fire and Verdict
   * would execute on an arbitrarily stale bracket.
   *
   * Per-asset-class **absolute** values were the other candidate and were
   * rejected: they only move the same bug one level down. A single absolute
   * number for `stocks` is still incommensurable *within* the equity class —
   * `SMOKE_TEST_UNIVERSE`'s successor holds SPY (~$600) alongside names an
   * order of magnitude cheaper, and one dollar figure cannot be half a percent
   * of both. A fraction is the only shape that is correct for an instrument
   * whose price the config author never saw, which is the property a universe
   * that changes without a code change (`DEFAULT_UNIVERSE`) actually needs.
   *
   * **Renamed rather than reinterpreted, deliberately.** Had the fractional
   * reading been given to the old `drift_tolerance` name, a config still
   * carrying the checked-in `500` would have meant 50,000% — a gate that
   * silently never fires, which is exactly the hazard being fixed. The rename
   * makes such a config a compile error instead.
   *
   * Kept per-asset-class rather than collapsed to one fraction because the
   * tolerable drift is paired with the staleness window it sits behind, and
   * `max_signal_age` already differs by class. The two dials are read
   * together.
   */
  drift_tolerance_pct: Record<'crypto' | 'stocks', number>;
  /** HITL response window; a non-response past this defaults to no-go. */
  human_timeout: number;
  /** Stocks-only: closed session still passes the market-open gate. */
  allow_extended_hours: boolean;
  /**
   * What "flagged" means under `semi_auto` (verdict-spec.md "Module:
   * Human-in-the-Loop"). Non-converged, no-precedent, and near-limit flags
   * are read directly from `order.metadata` / `risk_decision.modifications`
   * and need no threshold.
   */
  flag_thresholds: {
    size_over: number;
  };
}

export interface VerdictInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  /** Approved only — Verdict trusts Risk's approval and only adds final gates. */
  risk_decision: RiskDecision;
  clock: Clock;
  marketData: MarketDataService;
  tradingCalendar: TradingCalendar;
  positionStore: PositionStore;
  breakers: BreakerState;
  config: VerdictConfig;
  /**
   * backtest overrides gate 6's outcome to `go` once `approvals` answers
   * (recording `would_require_approval`), rather than skipping the call — a
   * channel that throws instead of answering still refuses; paper behaves
   * like live.
   */
  mode: 'live' | 'paper' | 'backtest';
  approvals: ApprovalChannel;
}

export interface VerdictDecision {
  status: 'go' | 'no_go';
  /** Present iff go. */
  order: OrderIntent | null;
  no_go_reason:
    | 'staleness'
    /** #641: the FEED is stale — `Mark.observed_at` older than the bound, or ahead of our clock. */
    | 'stale_feed'
    | 'drift'
    | 'dedup'
    | 'market_closed'
    | 'breaker'
    | 'timeout'
    | 'human_rejected'
    | null;
  /**
   * What the gate that fired actually MEASURED, for the two gates whose
   * refusal is a number against a bound (#1111): `staleness` (signal age vs
   * `max_signal_age`) and `stale_feed` (mark age at the read instant vs
   * `max_mark_age`, or — when negative — the mark stamped ahead of us vs the
   * receipt tolerance).
   *
   * Null for every other reason and for every `go`. A reason alone cannot say
   * whether a refusal was a near miss or an order of magnitude out, and the
   * two staleness-family gates measure different quantities under names that
   * read alike; recovering either meant correlating timestamps across
   * `debate_log` and the run log by hand.
   *
   * Two numbers rather than a formatted string, mirroring #1109's
   * `reason_detail_compared_value`/`reason_detail_threshold` on `trader_log`:
   * a soak asking "how many missed by under a second" can filter on a column
   * and cannot filter on prose.
   *
   * `measured_ms` carries `classifyMarkFreshness`'s sign: positive for a
   * `stale` refusal (the feed went quiet), NEGATIVE for an `ahead` one (the
   * mark is stamped ahead of the read instant). `bound_ms` is always
   * positive. A query written as `measured_ms > bound_ms` — the natural
   * "missed by how much" filter — therefore matches every `stale` row and
   * silently matches NONE of the `ahead` rows; a caller that wants both must
   * branch on the sign of `measured_ms` (or compare `Math.abs(measured_ms)`).
   */
  no_go_detail: { measured_ms: number; bound_ms: number } | null;
  approval_path: 'automated' | 'human' | 'human_timeout';
  /** Recorded even when the gate is bypassed (backtest) or never reached (earlier no-go). */
  would_require_approval: boolean;
  idempotency_key: string;
  timestamp: Date;
}

/** Single test seam. Deterministic given inputs; HITL is injected (auto in backtest). */
export interface Verdict {
  decide(input: VerdictInput): Promise<VerdictDecision>;
}
