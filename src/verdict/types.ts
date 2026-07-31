/**
 * Domain types for the Verdict (Stage 5) core gate sequence.
 * See docs/specs/verdict-spec.md ("Key Interfaces", "Module: Gate Sequence",
 * "Module: Human-in-the-Loop") and docs/specs/cross-spec-contracts.md.
 * Implementation tickets #79 (gate sequence) and #80 (HITL automation dial
 * + flag routing).
 */

import type { MarketDataService, TradingCalendar } from '../market-data-service/index.js';
import type { BreakerState, RiskDecision } from '../risk-manager/index.js';
import type { Clock, OrderIntent } from '../shared/index.js';

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
 * timers live; no-op auto-approve in backtest) so `Verdict.decide` stays a
 * plain await — deterministic and clock-injectable.
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
  /** Max tolerated |current price - entry| before no-go. */
  drift_tolerance: number;
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
  /** backtest bypasses HITL (auto-approve), recording would_require_approval; paper behaves like live. */
  mode: 'live' | 'paper' | 'backtest';
  approvals: ApprovalChannel;
}

export interface VerdictDecision {
  status: 'go' | 'no_go';
  /** Present iff go. */
  order: OrderIntent | null;
  no_go_reason:
    | 'staleness'
    | 'drift'
    | 'dedup'
    | 'market_closed'
    | 'breaker'
    | 'timeout'
    | 'human_rejected'
    | null;
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
