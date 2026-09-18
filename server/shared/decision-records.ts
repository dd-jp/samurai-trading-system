import type { ExitReason } from './types.js';

export interface TraderDecisionRecord {
  trace_id: string;
  instrument: string;
  debate_id: string;
  intent_type: 'entry' | 'scale_in' | 'exit' | null;
  exit_reason: ExitReason | null;
  skip_reason: string | null;
  decision_class: string | null;
  reason_detail: { compared_value: number; threshold: number } | null;
  sizing: {
    base_risk_fraction: number;
    conviction_multiplier: number;
    vol_floor_factor: number;
    non_converged_haircut: number;
    cosine_multiplier: number;
  } | null;
  cosine_precedent: {
    neighbor_count: number;
    weighted_mean_r: number | null;
    no_precedent: boolean;
  } | null;
  atr: number | null;
  entry: number | null;
  stop: number | null;
  size: number | null;
  created_at: Date;
}

export interface RiskDecisionRecord {
  trace_id: string;
  instrument: string;
  status: 'approved' | 'rejected' | 'error';
  binding_constraint: string | null;
  reasons: string[];
  original_size: number | null;
  final_size: number | null;
  stop_tightened: boolean;
  breakers: {
    portfolio_tripped: boolean;
    crypto_tripped: boolean;
    stocks_tripped: boolean;
    armed_breakers: string[];
  };
  portfolio: {
    equity: number;
    drawdown_pct: number;
    gross_exposure: number;
    consecutive_losses: number;
    daily_pnl_portfolio_pct: number | null;
    daily_pnl_crypto_pct: number | null;
    daily_pnl_stocks_pct: number | null;
    daily_pnl_unknown_reason: string | null;
  };
  created_at: Date;
}

export interface TraderLogStore {
  write(record: TraderDecisionRecord): void;
}

export interface RiskLogStore {
  write(record: RiskDecisionRecord): void;
}
