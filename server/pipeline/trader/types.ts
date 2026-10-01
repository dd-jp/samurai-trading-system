import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type {
  AssetClass,
  Clock,
  InstrumentSubclass,
  OpenPosition,
  SetupStore,
  TradingArm,
} from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';
import { DEFAULT_EARLY_EXIT_CONFIG, type EarlyExitConfig } from './early-exit.js';
import { ADR_0018_SUBCLASS_BRACKETS, type SubclassBracketTable } from './subclass-bracket.js';

export type { AssetClass };

export interface TraderConfig {
  conviction_floor: number;
  flatten_before_close_ms: number;
  flatten_after_close_ms: number;
  max_risk_per_trade: number;
  asset_class_risk_multiplier: Record<AssetClass, number>;
  subclass_brackets: SubclassBracketTable;
  subclass_of: Readonly<Record<string, InstrumentSubclass>>;
  atr_timeframe: string;
  atr_lookback: number;
  atr_k: number;
  vol_floor_fraction: number;
  non_converged_haircut: number;
  reward_risk_multiple: number;
  min_viable_notional: number;
  whole_share_sizing: boolean;
  time_in_force: Record<'crypto' | 'stocks', string>;
  scale_in_conviction_delta: number;
  early_exit: EarlyExitConfig;
}

export const DEFAULT_TRADER_CONFIG: TraderConfig = {
  conviction_floor: 0.55,
  max_risk_per_trade: 0.01,
  subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
  subclass_of: {},
  asset_class_risk_multiplier: {
    crypto: 0.5,
    stocks: 1.0,
  },
  atr_timeframe: '1h',
  atr_lookback: 14,
  atr_k: 2.0,
  vol_floor_fraction: 0.002,
  non_converged_haircut: 0.5,
  reward_risk_multiple: 2.0,
  min_viable_notional: 10,
  whole_share_sizing: false,
  time_in_force: { crypto: 'gtc', stocks: 'day' },
  scale_in_conviction_delta: 0.1,
  flatten_before_close_ms: 5 * 60 * 1_000,
  flatten_after_close_ms: 5 * 60 * 1_000,
  early_exit: DEFAULT_EARLY_EXIT_CONFIG,
};

export function assertTraderConfigSound(config: TraderConfig): void {
  if (!(config.flatten_before_close_ms > 0)) {
    throw new Error(
      `traderConfig.flatten_before_close_ms must be > 0 (got ${config.flatten_before_close_ms}); ` +
        `a non-positive window disables flat-by-close, which ADR-0014 requires`,
    );
  }
  if (!(config.flatten_after_close_ms > 0)) {
    throw new Error(
      `traderConfig.flatten_after_close_ms must be > 0 (got ${config.flatten_after_close_ms}); ` +
        'a non-positive grace restores the forward-only flatten window #1389 removed',
    );
  }
}

export interface TraderInput {
  trace_id: string;
  arm?: TradingArm;
  instrument: string;
  debate: DebateResult;
  clock: Clock;
  marketData: MarketDataService;
  equity: () => Promise<number>;
  config: TraderConfig;
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  positionState: () => Promise<OpenPosition[]>;
  exitFillSizes: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>;
  unresolvedFlattens: () => Promise<readonly UnresolvedFlatten[]>;
  setupStore: SetupStore;
  onUnpricedFlatten?: (report: UnpricedFlattenReport) => void;
}

export interface UnresolvedFlatten {
  readonly instrument: string;
}

interface UnpricedFlattenReport {
  instrument: string;
  reason: string;
}

export type TraderSkipReason =
  | 'neutral_direction_while_flat'
  | 'below_conviction_floor'
  | 'session_closing'
  | 'below_min_notional'
  | 'holding_neutral_or_non_converged'
  | 'scale_in_conviction_delta_not_met'
  | 'exit_no_filled_size'
  | 'exit_held_quantity_diverged'
  | 'flatten_in_flight'
  | 'no_open_position'
  | 'signal_still_supports_position'
  | 'early_exit_signal_unavailable'
  | 'atr_insufficient_bars'
  | 'atr_not_finite'
  | 'mark_not_finite'
  | 'stop_distance_not_positive'
  | 'size_not_finite'
  | 'rounds_to_zero_shares'
  | 'control_arm_valuation_refused';

export interface TraderReasonDetail {
  compared_value: number;
  threshold: number;
}

export type TraderDiagnosticKind =
  | 'session_end_absent_on_non_crypto'
  | 'atr_not_finite'
  | 'control_arm_valuation_refused'
  | 'lot_carried_past_session_close';
