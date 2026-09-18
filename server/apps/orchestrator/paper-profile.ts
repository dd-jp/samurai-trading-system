import type { RateLimitConfig } from '../../pipeline/debate-engine/index.js';
import type { ExecutionConfig } from '../../pipeline/execution/index.js';
import type { FeedbackConfig, TunableDial } from '../../pipeline/feedback-loop/index.js';
import type {
  BreakerConfig,
  CorrelationConfig,
  RiskConfig,
  SubclassDeploymentCap,
} from '../../pipeline/risk-manager/index.js';
import {
  D5_INDEX_ETP_DEPLOYMENT_FRACTION,
  D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
  DEFAULT_TRADER_CONFIG,
  type TraderConfig,
} from '../../pipeline/trader/index.js';
import type { VerdictConfig } from '../../pipeline/verdict/index.js';
import { londonEntryWindow } from '../../providers/market-data-service/index.js';
import type { CiiConsumerConfig } from '../../providers/market-intelligence/index.js';
import type { InstrumentSubclass } from '../../shared/index.js';
import { type CostConfig, SAXO_COMMISSION_RATE } from '../../tools/backtest/index.js';
import { LIVE_MONEY_GATE_SUMMARY } from './live-money-gates.js';
import { toCapitalCeilingUsd } from './production/capital-ceiling.js';
import { type DailyMetricsConfig, type ProductionConfig } from './production/config.js';
import { SqliteDailyEquityMetricsSource } from './production/daily-equity-metrics-source.js';
import { WORST_CASE_LLM_CALLS_PER_DEBATE } from './production/debate-adapter.js';
import { DEFAULT_FEEDBACK_INTERVAL_MS } from './production/defaults.js';
import { DEFAULT_UNIVERSE } from './scheduler.js';
import { SqliteDailyEquityStore } from './sqlite-daily-equity-store.js';
import type { UniverseInstrument } from './types.js';
import { subclassOfUniverse } from './types.js';

export { subclassOfUniverse };

export type ValueProvenance = 'SPEC' | 'DERIVED' | 'UNSOURCED';

export const PAPER_PROFILE_PROVENANCE = {
  llmBudgetUsd: 'SPEC',
  tickIntervalMs: 'DERIVED',
  maxConcurrentInstruments: 'DERIVED',
  universe: 'SPEC',
  capitalCeilingUsd: 'DERIVED',
  capitalCeilingUsdPerGbp: 'SPEC',
  'traderConfig.conviction_floor': 'SPEC',
  'traderConfig.flatten_before_close_ms': 'SPEC',
  'traderConfig.flatten_after_close_ms': 'UNSOURCED',
  'traderConfig.max_risk_per_trade': 'SPEC',
  'traderConfig.asset_class_risk_multiplier.crypto': 'SPEC',
  'traderConfig.asset_class_risk_multiplier.stocks': 'DERIVED',
  'traderConfig.atr_timeframe': 'SPEC',
  'traderConfig.atr_lookback': 'SPEC',
  'traderConfig.atr_k': 'SPEC',
  'traderConfig.vol_floor_fraction': 'SPEC',
  'traderConfig.subclass_of': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.take_profit_pct': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.stop_pct': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.deployment_fraction': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.round_trip_cost_pct': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.headroom_reserve_fraction': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.take_profit_pct': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.stop_pct': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.deployment_fraction': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.round_trip_cost_pct': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.headroom_reserve_fraction': 'SPEC',
  'traderConfig.subclass_brackets.crypto': 'SPEC',
  'traderConfig.non_converged_haircut': 'SPEC',
  'traderConfig.reward_risk_multiple': 'SPEC',
  'traderConfig.min_viable_notional': 'SPEC',
  'traderConfig.whole_share_sizing': 'SPEC',
  'traderConfig.time_in_force.crypto': 'SPEC',
  'traderConfig.time_in_force.stocks': 'SPEC',
  'traderConfig.scale_in_conviction_delta': 'SPEC',
  'traderConfig.early_exit.momentum_release_at': 'SPEC',
  'riskConfig.max_position_size_fraction_of_equity': 'UNSOURCED',
  'riskConfig.per_asset_cap_fraction_of_equity': 'UNSOURCED',
  'riskConfig.per_asset_class_cap_fraction_of_equity.crypto': 'UNSOURCED',
  'riskConfig.per_asset_class_cap_fraction_of_equity.stocks': 'UNSOURCED',
  'riskConfig.portfolio_gross_cap_fraction_of_equity': 'DERIVED',
  'riskConfig.concentration.cap_fraction_of_equity': 'DERIVED',
  'riskConfig.concentration.threshold': 'UNSOURCED',
  'riskConfig.min_viable_size': 'DERIVED',
  'riskConfig.whole_share_sizing': 'SPEC',
  'riskConfig.cii_threshold': 'UNSOURCED',
  'riskConfig.max_mark_age.crypto': 'UNSOURCED',
  'riskConfig.max_mark_age.stocks': 'UNSOURCED',
  'verdictConfig.automation_level.crypto': 'SPEC',
  'verdictConfig.automation_level.stocks': 'SPEC',
  'verdictConfig.max_signal_age.crypto': 'UNSOURCED',
  'verdictConfig.max_signal_age.stocks': 'UNSOURCED',
  'verdictConfig.max_mark_age.crypto': 'UNSOURCED',
  'verdictConfig.max_mark_age.stocks': 'UNSOURCED',
  'verdictConfig.drift_tolerance_pct.crypto': 'UNSOURCED',
  'verdictConfig.drift_tolerance_pct.stocks': 'UNSOURCED',
  'verdictConfig.human_timeout': 'UNSOURCED',
  'verdictConfig.allow_extended_hours': 'DERIVED',
  'verdictConfig.flag_thresholds.size_over': 'DERIVED',
  'executionConfig.simulated.volatility_indicator.indicator': 'SPEC',
  'executionConfig.simulated.volatility_indicator.params.period': 'SPEC',
  'executionConfig.simulated.volatility_indicator.timeframe': 'SPEC',
  'executionConfig.simulated.volatility_indicator.lookback': 'SPEC',
  'executionConfig.simulated.adv_window.timeframe': 'UNSOURCED',
  'executionConfig.simulated.adv_window.lookback': 'UNSOURCED',
  'executionConfig.simulated.venue': 'SPEC',
  'correlationConfig.window.timeframe': 'UNSOURCED',
  'correlationConfig.window.lookback': 'UNSOURCED',
  'correlationConfig.min_bars': 'UNSOURCED',
  'breakerConfig.daily_loss_pct': 'UNSOURCED',
  'breakerConfig.daily_loss_pct_by_class.crypto': 'UNSOURCED',
  'breakerConfig.daily_loss_pct_by_class.stocks': 'UNSOURCED',
  'breakerConfig.max_drawdown_pct': 'DERIVED',
  'breakerConfig.max_consecutive_losses': 'UNSOURCED',
  'breakerConfig.volatility.baseline.crypto': 'UNSOURCED',
  'breakerConfig.volatility.baseline.stocks': 'UNSOURCED',
  'breakerConfig.volatility.multiplier': 'UNSOURCED',
  'breakerConfig.auto_rearm.recovery_drawdown_pct': 'DERIVED',
  'breakerConfig.auto_rearm.max_days_tripped': 'DERIVED',
  'costConfig.crypto.spreadVolatilityCoefficient': 'UNSOURCED',
  'costConfig.crypto.commissionRate': 'SPEC',
  'costConfig.crypto.slippageCoefficient': 'UNSOURCED',
  'costConfig.crypto.impactK': 'UNSOURCED',
  'costConfig.stocks.spreadVolatilityCoefficient': 'UNSOURCED',
  'costConfig.stocks.commissionRate': 'SPEC',
  'costConfig.stocks.slippageCoefficient': 'UNSOURCED',
  'costConfig.stocks.impactK': 'UNSOURCED',
  'costConfig.venues.saxo.commissionRate': 'SPEC',
  'ciiConsumerConfig.pollIntervalMs': 'SPEC',
  'rateLimiterConfig.default.windowMs': 'DERIVED',
  'rateLimiterConfig.default.maxDebates': 'DERIVED',
  'rateLimiterConfig.default.maxLlmCalls': 'DERIVED',
  'rateLimiterConfig.perAssetClass.crypto.windowMs': 'DERIVED',
  'rateLimiterConfig.perAssetClass.crypto.maxDebates': 'DERIVED',
  'rateLimiterConfig.perAssetClass.crypto.maxLlmCalls': 'DERIVED',
  'rateLimiterConfig.perAssetClass.stocks.windowMs': 'DERIVED',
  'rateLimiterConfig.perAssetClass.stocks.maxDebates': 'DERIVED',
  'rateLimiterConfig.perAssetClass.stocks.maxLlmCalls': 'DERIVED',
  'feedback.config.attribution_window_ms': 'DERIVED',
  'feedback.config.weights.max_step': 'DERIVED',
  'feedback.config.weights.floor': 'DERIVED',
  'feedback.config.weights.ceiling': 'DERIVED',
  'feedback.config.weights.tighten_is': 'DERIVED',
  'feedback.config.strategy_params': 'DERIVED',
  'feedback.config.risk_thresholds.max_position_size_fraction_of_equity.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.max_position_size_fraction_of_equity.floor': 'DERIVED',
  'feedback.config.risk_thresholds.max_position_size_fraction_of_equity.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.max_position_size_fraction_of_equity.tighten_is': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_cap_fraction_of_equity.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_cap_fraction_of_equity.floor': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_cap_fraction_of_equity.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_cap_fraction_of_equity.tighten_is': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_fraction_of_equity_crypto.max_step':
    'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_fraction_of_equity_crypto.floor': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_fraction_of_equity_crypto.ceiling':
    'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_fraction_of_equity_crypto.tighten_is':
    'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_fraction_of_equity_stocks.max_step':
    'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_fraction_of_equity_stocks.floor': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_fraction_of_equity_stocks.ceiling':
    'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_fraction_of_equity_stocks.tighten_is':
    'DERIVED',
  'feedback.config.risk_thresholds.portfolio_gross_cap_fraction_of_equity.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.portfolio_gross_cap_fraction_of_equity.floor': 'DERIVED',
  'feedback.config.risk_thresholds.portfolio_gross_cap_fraction_of_equity.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.portfolio_gross_cap_fraction_of_equity.tighten_is': 'DERIVED',
  'feedback.config.risk_thresholds.concentration_cap_fraction_of_equity.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.concentration_cap_fraction_of_equity.floor': 'DERIVED',
  'feedback.config.risk_thresholds.concentration_cap_fraction_of_equity.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.concentration_cap_fraction_of_equity.tighten_is': 'DERIVED',
  'feedback.config.kill_thresholds.max_pbo': 'SPEC',
  'feedback.config.kill_thresholds.min_oos_sharpe': 'SPEC',
  'feedback.config.kill_thresholds.min_deflated_sharpe': 'SPEC',
  'feedback.config.kill_thresholds.max_live_backtest_divergence': 'UNSOURCED',
  'feedback.metrics.backtest_reference_sharpe': 'SPEC',
} as const satisfies Record<string, ValueProvenance>;

const PAPER_RISK_THRESHOLD_FLOOR_FRACTION = 0.25;
const PAPER_RISK_THRESHOLD_STEP_FRACTION = 0.1;

export const RISK_CAP_EQUITY_FRACTIONS = {
  max_position_size_fraction_of_equity: 0.05,
  per_asset_cap_fraction_of_equity: 0.1,
  per_asset_class_cap_fraction_of_equity_crypto: 0.2,
  per_asset_class_cap_fraction_of_equity_stocks: 0.4,
  portfolio_gross_cap_fraction_of_equity: 0.5,
  concentration_cap_fraction_of_equity: 0.2,
} as const;

export const LIVE_BOOK_GBP = 1_000;

export const SIZING_USD_PER_GBP = 1.27;

export const LIVE_BOOK_SIZING_USD = LIVE_BOOK_GBP * SIZING_USD_PER_GBP;

const D5_BOOK_REFUSE_ABOVE_TOLERANCE = 0.05;

export const D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG: Readonly<
  Record<InstrumentSubclass, number | null>
> = {
  index_etp_3x: D5_INDEX_ETP_DEPLOYMENT_FRACTION,
  single_stock_etp_3x: D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
  crypto: null,
};

export function subclassDeploymentCapFractionsOfEquity(): Record<
  InstrumentSubclass,
  number | null
> {
  return Object.fromEntries(
    Object.entries(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG).map(([subclass, fraction]) => [
      subclass,
      fraction,
    ]),
  ) as Record<InstrumentSubclass, number | null>;
}

export function d5EnvelopeFor(
  universe: readonly UniverseInstrument[],
  bookCeilingGbp?: number,
): SubclassDeploymentCap | undefined {
  const subclass_of = subclassOfUniverse(universe);
  if (Object.keys(subclass_of).length === 0) return undefined;

  return {
    subclass_of,
    cap_fraction_of_equity: subclassDeploymentCapFractionsOfEquity(),
    ...(bookCeilingGbp === undefined
      ? {}
      : {
          equity_ceiling: {
            book: bookCeilingGbp,
            refuse_above_tolerance: D5_BOOK_REFUSE_ABOVE_TOLERANCE,
          },
        }),
  };
}

const UNCALIBRATED_VOLATILITY_BASELINE = 1_000_000;

const PAPER_ANALYST_WEIGHT_FLOOR = 0.5;
const PAPER_ANALYST_WEIGHT_CEILING = 1.5;

const PAPER_ANALYST_WEIGHT_TRAVERSE_CYCLES = 20;

function buildFeedbackConfig(caps: typeof RISK_CAP_EQUITY_FRACTIONS): FeedbackConfig {
  const attribution_window_ms = 2 * DEFAULT_FEEDBACK_INTERVAL_MS;

  const weights: TunableDial = {
    max_step:
      (PAPER_ANALYST_WEIGHT_CEILING - PAPER_ANALYST_WEIGHT_FLOOR) /
      PAPER_ANALYST_WEIGHT_TRAVERSE_CYCLES,
    floor: PAPER_ANALYST_WEIGHT_FLOOR,
    ceiling: PAPER_ANALYST_WEIGHT_CEILING,
    tighten_is: 'decrease',
  };

  function capDial(shipped: number): TunableDial {
    return {
      max_step: PAPER_RISK_THRESHOLD_STEP_FRACTION * shipped,
      floor: PAPER_RISK_THRESHOLD_FLOOR_FRACTION * shipped,
      ceiling: shipped,
      tighten_is: 'decrease',
    };
  }

  return {
    attribution_window_ms,
    weights,
    strategy_params: {},
    risk_thresholds: Object.fromEntries(
      Object.entries(caps).map(([name, shipped]) => [name, capDial(shipped)]),
    ),
    kill_thresholds: {
      max_pbo: 0.05,
      min_oos_sharpe: 0.5,
      min_deflated_sharpe: 0.95,
      max_live_backtest_divergence: 0.5,
    },
  };
}

function buildDailyMetrics(): DailyMetricsConfig {
  return {
    source: ({ db, trades, logger }) =>
      new SqliteDailyEquityMetricsSource({
        equity: new SqliteDailyEquityStore(db),
        trades,
        logger,
      }),
    backtest_reference_sharpe: 0,
  };
}

function llmBudget(maxDebates: number): RateLimitConfig {
  return {
    windowMs: LLM_BUDGET_WINDOW_MS,
    maxDebates,
    maxLlmCalls: maxDebates * WORST_CASE_LLM_CALLS_PER_DEBATE,
  };
}

const LLM_BUDGET_WINDOW_MS = 300_000;

const CRYPTO_MAX_DEBATES_PER_WINDOW = 20;
const STOCKS_MAX_DEBATES_PER_WINDOW = 24;

const MAX_CONCURRENT_INSTRUMENTS = 6;

export function buildStartingProfileConfigs(
  universe: readonly UniverseInstrument[] = DEFAULT_UNIVERSE,
  bookCeilingGbp?: number,
): Pick<
  ProductionConfig,
  | 'universe'
  | 'traderConfig'
  | 'riskConfig'
  | 'verdictConfig'
  | 'executionConfig'
  | 'correlationConfig'
  | 'breakerConfig'
  | 'costConfig'
  | 'ciiConsumerConfig'
  | 'feedback'
> &
  Required<
    Pick<
      ProductionConfig,
      | 'rateLimiterConfig'
      | 'llmBudgetUsd'
      | 'tickIntervalMs'
      | 'stocksTradingWindow'
      | 'maxConcurrentInstruments'
    >
  > {
  const subclassCap = d5EnvelopeFor(universe, bookCeilingGbp);

  const traderConfig: TraderConfig = {
    ...DEFAULT_TRADER_CONFIG,
    subclass_of: subclassOfUniverse(universe),
    whole_share_sizing: true,
  };

  const riskConfig: RiskConfig = {
    max_position_size_fraction_of_equity:
      RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity,
    per_asset_cap_fraction_of_equity: RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity,
    per_asset_class_cap_fraction_of_equity: {
      crypto: RISK_CAP_EQUITY_FRACTIONS.per_asset_class_cap_fraction_of_equity_crypto,
      stocks: RISK_CAP_EQUITY_FRACTIONS.per_asset_class_cap_fraction_of_equity_stocks,
    },
    portfolio_gross_cap_fraction_of_equity:
      RISK_CAP_EQUITY_FRACTIONS.portfolio_gross_cap_fraction_of_equity,
    concentration: {
      cap_fraction_of_equity: RISK_CAP_EQUITY_FRACTIONS.concentration_cap_fraction_of_equity,
      threshold: 0.7,
    },
    min_viable_size: DEFAULT_TRADER_CONFIG.min_viable_notional,
    whole_share_sizing: true,
    cii_threshold: 70,
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    ...(subclassCap === undefined ? {} : { per_subclass_deployment_cap: subclassCap }),
    ...(bookCeilingGbp === undefined
      ? {}
      : {
          live_book_ceiling: {
            book: bookCeilingGbp,
            refuse_above_tolerance: D5_BOOK_REFUSE_ABOVE_TOLERANCE,
          },
        }),
  };

  const verdictConfig: VerdictConfig = {
    automation_level: { crypto: 'auto', stocks: 'auto' },
    max_signal_age: { crypto: 5 * 60_000, stocks: 15 * 60_000 },
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    drift_tolerance_pct: { crypto: 0.005, stocks: 0.005 },
    human_timeout: 15 * 60_000,
    allow_extended_hours: false,
    flag_thresholds: {
      size_over: 0,
    },
  };

  const executionConfig: ExecutionConfig = {
    simulated: {
      volatility_indicator: {
        indicator: 'atr',
        params: { period: 14 },
        timeframe: '1h',
        lookback: 15,
      },
      adv_window: { timeframe: '1d', lookback: 20 },
      venue: 'saxo',
    },
  };

  const correlationConfig: CorrelationConfig = {
    window: { timeframe: '1d', lookback: 30 },
    min_bars: 20,
  };

  const breakerConfig: BreakerConfig = {
    daily_loss_pct: 0.05,
    daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
    max_drawdown_pct: 0.44,
    max_consecutive_losses: 5,
    volatility: {
      baseline: {
        crypto: UNCALIBRATED_VOLATILITY_BASELINE,
        stocks: UNCALIBRATED_VOLATILITY_BASELINE,
      },
      multiplier: 3,
    },
    auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
  };

  const costConfig: CostConfig = {
    crypto: {
      spreadVolatilityCoefficient: 0.1,
      commissionRate: 0.0026,
      slippageCoefficient: 0.05,
      impactK: 0.5,
    },
    stocks: {
      spreadVolatilityCoefficient: 0.05,
      commissionRate: 0.0005,
      slippageCoefficient: 0.02,
      impactK: 0.3,
    },
    venues: { saxo: { commissionRate: SAXO_COMMISSION_RATE } },
  };

  const ciiConsumerConfig: CiiConsumerConfig = {
    pollIntervalMs: 10 * 60_000,
  };

  return {
    llmBudgetUsd: 50,
    tickIntervalMs: 2 * 60_000,
    maxConcurrentInstruments: MAX_CONCURRENT_INSTRUMENTS,
    stocksTradingWindow: londonEntryWindow(),
    universe,
    traderConfig,
    riskConfig,
    verdictConfig,
    executionConfig,
    correlationConfig,
    breakerConfig,
    costConfig,
    ciiConsumerConfig,
    rateLimiterConfig: {
      default: llmBudget(Math.min(CRYPTO_MAX_DEBATES_PER_WINDOW, STOCKS_MAX_DEBATES_PER_WINDOW)),
      perAssetClass: {
        crypto: llmBudget(CRYPTO_MAX_DEBATES_PER_WINDOW),
        stocks: llmBudget(STOCKS_MAX_DEBATES_PER_WINDOW),
      },
    },
    feedback: {
      config: buildFeedbackConfig(RISK_CAP_EQUITY_FRACTIONS),
      metrics: buildDailyMetrics(),
    },
  };
}

export function paperStartingProfile(
  mode: ProductionConfig['mode'],
  universe?: readonly UniverseInstrument[],
  bookCurrency: 'USD' | 'GBP' = 'USD',
): Pick<ProductionConfig, 'mode'> &
  Pick<
    ProductionConfig,
    | 'universe'
    | 'traderConfig'
    | 'riskConfig'
    | 'verdictConfig'
    | 'executionConfig'
    | 'capitalCeilingUsd'
    | 'capitalCeilingUsdPerGbp'
    | 'correlationConfig'
    | 'breakerConfig'
    | 'costConfig'
    | 'ciiConsumerConfig'
    | 'feedback'
  > &
  Required<
    Pick<
      ProductionConfig,
      | 'rateLimiterConfig'
      | 'llmBudgetUsd'
      | 'tickIntervalMs'
      | 'stocksTradingWindow'
      | 'maxConcurrentInstruments'
    >
  > {
  if (mode === 'live') {
    throw new Error(
      'Orchestrator cannot start: SAMURAI_MODE=live was requested against the PAPER STARTING ' +
        'PROFILE (server/apps/orchestrator/paper-profile.ts) — a set of deliberately untuned starting ' +
        'values. Its volatility breaker baseline is uncalibrated and effectively inert, its ' +
        'drift tolerance is a fraction nobody has yet observed against a real fill, and its ' +
        'cadence and LLM budget are sized for a $50 paper soak rather than for a run trying to ' +
        'make money. Since ADR-0007 it also runs with NO human gate at all (automation_level: ' +
        'auto for both classes), which makes the circuit breakers and the notional caps the ' +
        'only stop. None of that may decide a real-money trade. ' +
        LIVE_MONEY_GATE_SUMMARY +
        ' The live path is liveStartingProfile() in server/apps/orchestrator/live-profile.ts, ' +
        'gated on the declared ceiling SAMURAI_LIVE_MAX_CAPITAL_USD (the six caps ' +
        "themselves are the same equity-relative fractions as this profile's; the ceiling bounds " +
        "only the Trader's ask); or call startFromEnvironment() from your own composition root " +
        'with a config you have tuned against paper results — see ProductionConfig in ' +
        'server/apps/orchestrator/production.ts.',
    );
  }

  const configs =
    universe === undefined ? buildStartingProfileConfigs() : buildStartingProfileConfigs(universe);

  return {
    ...configs,
    mode,
    ...(mode === 'paper'
      ? bookCurrency === 'GBP'
        ? { capitalCeilingUsd: toCapitalCeilingUsd(LIVE_BOOK_GBP, 'LIVE_BOOK_GBP') }
        : {
            capitalCeilingUsd: toCapitalCeilingUsd(LIVE_BOOK_SIZING_USD, 'LIVE_BOOK_SIZING_USD'),
            capitalCeilingUsdPerGbp: SIZING_USD_PER_GBP,
          }
      : {}),
    ...(mode === 'paper'
      ? {
          traderConfig: {
            ...configs.traderConfig,
            asset_class_risk_multiplier: {
              ...configs.traderConfig.asset_class_risk_multiplier,
              stocks: 1.9,
            },
          },
        }
      : {}),
    ...(mode === 'backtest' ? { maxConcurrentInstruments: 1 } : {}),
    ...(mode === 'paper' && bookCurrency === 'GBP' && universe !== undefined
      ? {
          riskConfig: {
            ...configs.riskConfig,
            long_only_instruments: new Set(universe.map((instrument) => instrument.asset)),
          },
        }
      : {}),
  };
}
