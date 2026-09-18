import type { BarWindow, IndicatorSpec } from '../../providers/market-data-service/index.js';
import type { Clock, InstrumentSubclass, OrderIntent } from '../../shared/index.js';

export interface BreakerState {
  portfolio_tripped: boolean;
  asset_class_tripped: {
    crypto: boolean;
    stocks: boolean;
  };
  armed_breakers: string[];
}

export interface PersistedBreakerState {
  tier: 'portfolio_drawdown' | 'kill_switch';
  tripped: boolean;
  tripped_at: Date | null;
  reset_at: Date | null;
  reason: string | null;
}

export type DailyPnl =
  | { readonly known: true; readonly pct: number }
  | { readonly known: false; readonly reason: string };

export interface DailyPnlByClass {
  readonly crypto: DailyPnl;
  readonly stocks: DailyPnl;
  readonly portfolio: DailyPnl;
}

export interface PortfolioView {
  equity: number;
  peak_equity: number;
  drawdown_pct: number;
  exposure_by_instrument: Record<string, number>;
  exposure_by_class: { crypto: number; stocks: number };
  gross_exposure: number;
  reserved_exposure_by_instrument: Record<string, number>;
  reserved_exposure_by_class: { crypto: number; stocks: number };
  reserved_gross_exposure: number;
  daily_pnl: DailyPnlByClass;
  consecutive_losses: number;
  unvalued_instruments: readonly string[];
}

export type SessionBasis =
  | {
      readonly known: true;
      readonly open_equity: number;
      readonly realized_pnl: number;
    }
  | { readonly known: false; readonly reason: string };

export interface SessionBasisByClass {
  readonly crypto: SessionBasis;
  readonly stocks: SessionBasis;
  readonly portfolio: SessionBasis;
}

export interface CorrelationEstimate {
  correlations: Record<string, number>;
  insufficient_history: string[];
}

export interface RiskConfig {
  max_position_size_fraction_of_equity: number;
  per_asset_cap_fraction_of_equity: number;
  per_asset_class_cap_fraction_of_equity: { crypto: number; stocks: number };
  portfolio_gross_cap_fraction_of_equity: number;
  concentration: {
    cap_fraction_of_equity: number;
    threshold: number;
  };
  min_viable_size: number;
  whole_share_sizing: boolean;
  cii_threshold: number;
  max_mark_age: Record<'crypto' | 'stocks', number>;
  per_subclass_deployment_cap?: SubclassDeploymentCap;
  live_book_ceiling?: {
    book: number;
    refuse_above_tolerance: number;
    same_currency_verified?: boolean;
  };
  long_only_instruments?: ReadonlySet<string>;
}

export interface SubclassDeploymentCap {
  subclass_of: Readonly<Record<string, InstrumentSubclass>>;
  cap_fraction_of_equity: Readonly<Record<InstrumentSubclass, number | null>>;
  equity_ceiling?: {
    book: number;
    refuse_above_tolerance: number;
    same_currency_verified?: boolean;
  };
}

export type InvalidationObservable =
  | { kind: 'indicator'; spec: IndicatorSpec }
  | { kind: 'mark' }
  | { kind: 'bars'; window: BarWindow; measure: 'volume_ratio' };

export type InvalidationComparator = '<' | '<=' | '>' | '>=';

export interface InvalidationCondition {
  id: string;
  observable: InvalidationObservable;
  comparator: InvalidationComparator;
  threshold: number;
  rationale: string;
}

type InvalidationConditionState = 'breached' | 'not_breached' | 'unevaluable';

export interface EvaluatedCondition {
  condition: InvalidationCondition;
  state: InvalidationConditionState;
  observed: number | null;
}

export type InvalidationDropReason =
  | 'unparseable'
  | 'unknown_observable'
  | 'unknown_indicator'
  | 'lookback_too_large'
  | 'threshold_out_of_range'
  | 'direction_incoherent'
  | 'over_cap';

export interface DroppedCondition {
  id: string | null;
  raw: string;
  reason: InvalidationDropReason;
}

export interface RiskCriticVerdict {
  verdict: 'pass' | 'trim' | 'reject' | 'unavailable';
  max_notional: number | null;
  reasoning: string;
  conditions?: EvaluatedCondition[];
  dropped_conditions?: DroppedCondition[];
}

export interface RiskCriticLog {
  debate_id: string;
  verdict: RiskCriticVerdict;
  created_at: Date;
}

export interface RiskCriticStore {
  writeVerdict(entry: RiskCriticLog): void;
  getByDebateId(debate_id: string): RiskCriticLog | undefined;
}

export interface RiskInput {
  trace_id: string;
  intent: OrderIntent;
  clock: Clock;
  portfolio: PortfolioView;
  breakers: BreakerState;
  next_breaker_state: PersistedBreakerState[];
  correlation: CorrelationEstimate;
  cii: Record<string, number>;
  critic?: RiskCriticVerdict;
  mode: 'live' | 'paper' | 'backtest';
}

export interface RiskDecision {
  status: 'approved' | 'rejected';
  order_intent: OrderIntent | null;
  modifications: {
    original_size: number;
    final_size: number;
    stop_tightened: boolean;
  } | null;
  binding_constraint: string | null;
  reasons: string[];
  warnings: string[];
  risk_snapshot: {
    exposure: Record<string, number>;
    drawdown_pct: number;
    armed_breakers: string[];
  };
  next_breaker_state: PersistedBreakerState[];
}

export interface RiskManager {
  evaluate(input: RiskInput): RiskDecision;
}
