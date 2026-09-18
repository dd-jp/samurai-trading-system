
import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock, OrderIntent } from '../../shared/index.js';
import type { BreakerState, RiskDecision } from '../risk-manager/index.js';

export interface PositionStore {
  findByKey(idempotency_key: string): Promise<boolean>;
}

export interface ApprovalRequest {
  order_intent: OrderIntent;
  risk_decision: RiskDecision;
  trace_id: string;
  timeout_ms: number;
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout';

export interface ApprovalChannel {
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

export interface VerdictConfig {
  automation_level: Record<'crypto' | 'stocks', 'manual' | 'semi_auto' | 'auto'>;
  max_signal_age: Record<'crypto' | 'stocks', number>;
  max_mark_age: Record<'crypto' | 'stocks', number>;
  drift_tolerance_pct: Record<'crypto' | 'stocks', number>;
  human_timeout: number;
  allow_extended_hours: boolean;
  flag_thresholds: {
    size_over: number;
  };
}

export interface VerdictInput {
  trace_id: string;
  risk_decision: RiskDecision;
  clock: Clock;
  marketData: MarketDataService;
  tradingCalendar: TradingCalendar;
  positionStore: PositionStore;
  breakers: BreakerState;
  config: VerdictConfig;
  mode: 'live' | 'paper' | 'backtest';
  approvals: ApprovalChannel;
}

export interface VerdictDecision {
  status: 'go' | 'no_go';
  order: OrderIntent | null;
  no_go_reason:
    | 'staleness'
    | 'stale_feed'
    | 'drift'
    | 'dedup'
    | 'market_closed'
    | 'breaker'
    | 'timeout'
    | 'human_rejected'
    | null;
  no_go_detail: { measured_ms: number; bound_ms: number } | null;
  approval_path: 'automated' | 'human' | 'human_timeout';
  would_require_approval: boolean;
  idempotency_key: string;
  timestamp: Date;
}

export interface Verdict {
  decide(input: VerdictInput): Promise<VerdictDecision>;
}
