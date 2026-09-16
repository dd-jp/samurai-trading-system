/**
 * The checked-in paper starting profile (#323): the config objects
 * `REQUIRED_INJECTED_CONFIG` demands so `npm run orchestrator` boots.
 *
 * Every value below carries a provenance comment, one of three kinds:
 * `SPEC` (stated in `docs/`, cited by file/section), `DERIVED` (forced by a
 * relationship to a stated value), or `UNSOURCED` (no doc pins it — chosen
 * conservatively, an open question until real paper observations replace it).
 *
 * `costConfig`/`executionConfig.simulated` and
 * `breakerConfig.auto_rearm.max_days_tripped` are inert on the paper hot path
 * (paper runs against `AlpacaBrokerAdapter`, not the simulated pricer).
 * `ciiConsumerConfig` is live but its provider is `ParkedCiiScoreProvider`
 * (always `null`, ADR-0002), so `riskConfig.cii_threshold` compares against nothing.
 *
 * This profile supplies values and opens no transports — `SAMURAI_ALERTS`
 * wires the outbound alert channels in `startFromEnvironment` instead, and
 * `approvals` deliberately has no default: `UnwiredApprovalChannel` throws if
 * the HITL gate is reached, since there's no answer a stand-in could fabricate.
 */
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
import { SqliteDailyEquityMetricsSource } from './production/daily-equity-metrics-source.js';
import { WORST_CASE_LLM_CALLS_PER_DEBATE } from './production/debate-adapter.js';
import {
  type DailyMetricsConfig,
  DEFAULT_FEEDBACK_INTERVAL_MS,
  type ProductionConfig,
} from './production.js';
import { DEFAULT_UNIVERSE } from './scheduler.js';
import { SqliteDailyEquityStore } from './sqlite-daily-equity-store.js';
import type { UniverseInstrument } from './types.js';
import { subclassOfUniverse } from './types.js';

// Re-exported for existing importers (#739's "ONE derivation" moved to
// `types.ts` in #752 to break a `production.ts` <-> `paper-profile.ts` import
// cycle — see that function's doc comment)
export { subclassOfUniverse };

export type ValueProvenance = 'SPEC' | 'DERIVED' | 'UNSOURCED';

/**
 * Dot-path index of `paperStartingProfile()`'s leaf values to their
 * provenance, pinned by `paper-profile-provenance.test.ts`. Arrays and empty
 * objects are single leaves; function-valued members and `mode` aren't indexed.
 */
export const PAPER_PROFILE_PROVENANCE = {
  llmBudgetUsd: 'SPEC',
  tickIntervalMs: 'DERIVED',
  // #1013 — derived from rateLimiterConfig.perAssetClass.stocks's budget, #1012's latency, and universe size
  maxConcurrentInstruments: 'DERIVED',
  universe: 'SPEC',
  // #1112/#1180 — DERIVED: LIVE_BOOK_GBP multiplied by SIZING_USD_PER_GBP since equity is USD-denominated
  capitalCeilingUsd: 'DERIVED',
  // #1180 — SPEC: a chosen figure, not computed here; see SIZING_USD_PER_GBP for provenance
  capitalCeilingUsdPerGbp: 'SPEC',
  'traderConfig.conviction_floor': 'SPEC',
  // #668/#657 — SPEC: close − 5 minutes is the value #657 resolved, not computed here
  'traderConfig.flatten_before_close_ms': 'SPEC',
  // #1389 — UNSOURCED: 5 min chosen, well inside verdictConfig.max_mark_age.stocks (15 min)
  'traderConfig.flatten_after_close_ms': 'UNSOURCED',
  'traderConfig.max_risk_per_trade': 'SPEC',
  'traderConfig.asset_class_risk_multiplier.crypto': 'SPEC',
  // #1112 — DERIVED: 1.9x computed from D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION and #1112's measured MU deployment
  'traderConfig.asset_class_risk_multiplier.stocks': 'DERIVED',
  'traderConfig.atr_timeframe': 'SPEC',
  'traderConfig.atr_lookback': 'SPEC',
  'traderConfig.atr_k': 'SPEC',
  'traderConfig.vol_floor_fraction': 'SPEC',
  // ADR-0018 D3/D5 (#739) — SPEC throughout; subclass_of is empty because DEFAULT_UNIVERSE declares no subclass
  'traderConfig.subclass_of': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.take_profit_pct': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.stop_pct': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.deployment_fraction': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.round_trip_cost_pct': 'SPEC',
  // #897 — SPEC: ADR-0018's 2026-09-03 amendment declares the reserve directly
  'traderConfig.subclass_brackets.index_etp_3x.headroom_reserve_fraction': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.take_profit_pct': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.stop_pct': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.deployment_fraction': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.round_trip_cost_pct': 'SPEC',
  // #897, as above
  'traderConfig.subclass_brackets.single_stock_etp_3x.headroom_reserve_fraction': 'SPEC',
  // crypto: null — ADR-0018 sets no bracket here; that is itself the ADR's answer
  'traderConfig.subclass_brackets.crypto': 'SPEC',
  'traderConfig.non_converged_haircut': 'SPEC',
  'traderConfig.reward_risk_multiple': 'SPEC',
  'traderConfig.min_viable_notional': 'SPEC',
  // #941 — SPEC: venue-stated by refusing (422 fractional orders must be simple orders), measured not assumed
  'traderConfig.whole_share_sizing': 'SPEC',
  'traderConfig.time_in_force.crypto': 'SPEC',
  'traderConfig.time_in_force.stocks': 'SPEC',
  'traderConfig.scale_in_conviction_delta': 'SPEC',
  // #748 — SPEC: DEFAULT_EARLY_EXIT_CONFIG spread in unchanged, argued at its own definition not here
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

/**
 * The guardrail band for every `risk_thresholds` dial (#433), as fractions of
 * the cap this profile ships. See `capDial` for why the ceiling is the shipped
 * value and the floor is not zero.
 */
const PAPER_RISK_THRESHOLD_FLOOR_FRACTION = 0.25;
const PAPER_RISK_THRESHOLD_STEP_FRACTION = 0.1;

/**
 * The six notional caps, as FRACTIONS OF EQUITY (#886) — resolved against
 * `portfolio.equity` at evaluate time, not a frozen anchor at profile-build
 * time. Keyed identically to `RISK_THRESHOLD_KEYS`
 * (risk-manager/risk-thresholds.ts) so the shipped defaults and the tuned
 * `risk_thresholds` table share one vocabulary rather than two that could drift.
 */
export const RISK_CAP_EQUITY_FRACTIONS = {
  max_position_size_fraction_of_equity: 0.05,
  per_asset_cap_fraction_of_equity: 0.1,
  per_asset_class_cap_fraction_of_equity_crypto: 0.2,
  per_asset_class_cap_fraction_of_equity_stocks: 0.4,
  portfolio_gross_cap_fraction_of_equity: 0.5,
  concentration_cap_fraction_of_equity: 0.2,
} as const;

/**
 * ADR-0015's book, decided by David 2026-08-18: £1,000, all equity (#800).
 * NOT the live balance — `d5EnvelopeFor` clamps D5's fractions to it via
 * `equity_ceiling.book` (#888). Only `liveStartingProfile` passes it through;
 * paper runs against Alpaca's ~$100,000 simulated balance.
 */
export const LIVE_BOOK_GBP = 1_000;

/**
 * USD per GBP — converts `LIVE_BOOK_GBP` before comparison against a
 * USD-denominated `portfolio.equity` (#1180). A configured constant, not a
 * feed: migration 0045's backfill needs a literal shipped in the same commit,
 * so changing this value owes its own backfill migration (see `oneSizingRegime`).
 */
export const SIZING_USD_PER_GBP = 1.27;

/**
 * `LIVE_BOOK_GBP` in the currency `portfolio.equity` is denominated in
 * (#1180). Exactly 1,270 in IEEE-754, which is what lets migration 0052
 * normalize the stamped ceiling with an equality predicate.
 */
export const LIVE_BOOK_SIZING_USD = LIVE_BOOK_GBP * SIZING_USD_PER_GBP;

/**
 * #888's backstop: how far funded equity may drift above `LIVE_BOOK_GBP`
 * before `perSubclassDeploymentCap` refuses a D5-classified entry outright,
 * instead of just clamping its equity read to the book. "A few percent" per
 * the issue's framing — tolerates routine drift, refuses a materially
 * overfunded account. Not a Feedback Loop dial: it bounds the account against
 * an operator-declared number, not a risk parameter the loop should tune.
 */
const D5_BOOK_REFUSE_ABOVE_TOLERANCE = 0.05;

/**
 * ADR-0018 D5 — max deployment per subclass, as a fraction of the EQUITY LEG.
 * The fractions are unchanged since 2026-08-18; only what they are a fraction
 * of changed (`LIVE_BOOK_GBP`). Imported from the Trader's named D5 constants
 * (`trader/subclass-bracket.ts`) rather than restated, so the Risk Manager's
 * cap and the Trader's sizing cannot drift apart. `crypto: null` — D5
 * measured no envelope here, not a number waiting to be guessed.
 */
export const D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG: Readonly<
  Record<InstrumentSubclass, number | null>
> = {
  index_etp_3x: D5_INDEX_ETP_DEPLOYMENT_FRACTION,
  single_stock_etp_3x: D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
  crypto: null,
};

/**
 * ADR-0018 D5's envelope as fractions of TOTAL account equity (#739). Since
 * 2026-08-18 the equity leg IS the whole book, so no scaling happens here —
 * the old `EQUITY_LEG_FRACTION_OF_CAPITAL = 0.5` split is gone (#800). This
 * doubles the resolved cap vs. the old £750/£750 split (single-stock 0.125 ->
 * 0.25), putting that subclass back at the ~41.8% drawdown #798 tracks.
 */
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

/**
 * D5's config for a universe, or `undefined` when the universe declares no
 * subclasses (`DEFAULT_UNIVERSE` today — the pool file is C1's #703). A
 * partly-classified universe still arms it; unclassified names then throw at
 * sizing time, which is intended.
 *
 * `equity_ceiling` is set (#888) only when a book is supplied — live only.
 * D5's fractions are measured against `LIVE_BOOK_GBP`; setting it
 * unconditionally would refuse every classified entry on paper, which runs
 * against Alpaca's ~$100,000 simulated balance. Only `liveStartingProfile`
 * supplies the book.
 */
export function d5EnvelopeFor(
  universe: readonly UniverseInstrument[],
  /**
   * The declared book this envelope's fractions resolve against, in GBP —
   * `LIVE_BOOK_GBP` for live, `undefined` for paper/backtest/tests, meaning
   * "no ceiling": the fraction resolves against raw `portfolio.equity`.
   */
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

/**
 * `breakerConfig.volatility.baseline` is an absolute ATR reading in price
 * units, not a ratio — one baseline cannot serve both BTC-USD and an equity.
 * `UNSOURCED` and unobservable until a paper run produces ATR samples, so set
 * high enough to be inert: a too-low baseline halts every entry for the whole
 * run. Finite on purpose — an infinite baseline would silently disable
 * `MarketDataVolatilityReadingProvider`'s fail-closed comparison.
 */
const UNCALIBRATED_VOLATILITY_BASELINE = 1_000_000;

/**
 * The analyst-weight band (#366), DERIVED from `impliedWeight`'s target
 * (feedback-loop/attribution.ts: `midpoint + halfBand * tanh(meanCredit)`).
 * Centred on 1.0 so "no evidence either way" means "no re-weighting" — a
 * weight is a multiplier, so an off-centre band would drag an even record
 * toward its midpoint and call it attribution.
 */
const PAPER_ANALYST_WEIGHT_FLOOR = 0.5;
const PAPER_ANALYST_WEIGHT_CEILING = 1.5;

/**
 * How many consecutive daily cycles it takes to move a weight across the
 * whole band — `weights.max_step` is derived from this, not the reverse.
 * DERIVED from the soak window: 20 > the 14 days of #238, so no soak-length
 * run can produce a trajectory decided by its first few trades.
 */
const PAPER_ANALYST_WEIGHT_TRAVERSE_CYCLES = 20;

/**
 * `FeedbackConfig` for the paper soak (#366) — Stage 6's starting values.
 *
 * Of the three dials, only analyst weights have a populated store (#371):
 * `runDailyCycle` steps analysts with a seeded `analyst_weights` row,
 * attributing real closed trades and debate rows. Nothing yet reads those
 * weights at debate time — #435, open deliberately, since attribution runs
 * over near-empty samples (#430). Strategy params / risk thresholds move only
 * via `proposals`, which the profile supplies none of.
 */
function buildFeedbackConfig(caps: typeof RISK_CAP_EQUITY_FRACTIONS): FeedbackConfig {
  /**
   * DERIVED as a multiple of `DEFAULT_FEEDBACK_INTERVAL_MS` (24h), not "48
   * hours" literally. Wider than the cadence so a restart mid-cycle (plain
   * `setInterval`, re-phases on restart) doesn't leave an unattributed gap —
   * overlap is safe since attribution steps toward a target rather than
   * accumulating. Does NOT fix a process restarting more than once a day,
   * which never completes a cycle at all; that needs a persisted timestamp,
   * not a wider window.
   */
  const attribution_window_ms = 2 * DEFAULT_FEEDBACK_INTERVAL_MS;

  /**
   * Nothing applies an analyst weight at debate time (#371) — a real gap
   * against feedback-loop-spec.md story 5, left open deliberately rather than
   * closed with a guessed mechanism: HOW a weight should apply (scale
   * confidence? bias the mediator?) is undecided in debate-engine-spec.md,
   * and guessing would distort every debate of the soak. The dashboard is the
   * only current reader.
   */
  const weights: TunableDial = {
    /**
     * `DERIVED` from the band, and written as the derivation rather than as
     * the 0.05 it evaluates to — the same reason `riskConfig`'s caps are
     * fractions of the profile's equity anchor instead of rounded literals:
     * re-scaling the band must not silently change how many cycles a traverse
     * takes.
     *
     * A twentieth of the band, so crossing it end to end needs at least
     * `PAPER_ANALYST_WEIGHT_TRAVERSE_CYCLES` consecutive cycles — one per day,
     * so longer than the 14-day soak (#238) itself. That is the intended
     * relationship, not a coincidence: spec story 4 asks that "no analyst
     * swings wildly", and the soak must not be able to produce a weight
     * trajectory dominated by its first few trades.
     */
    max_step:
      (PAPER_ANALYST_WEIGHT_CEILING - PAPER_ANALYST_WEIGHT_FLOOR) /
      PAPER_ANALYST_WEIGHT_TRAVERSE_CYCLES,
    floor: PAPER_ANALYST_WEIGHT_FLOOR,
    ceiling: PAPER_ANALYST_WEIGHT_CEILING,
    /**
     * `DERIVED` — descriptive only for a weight. A weight carries no safety
     * semantics ("tune freely within bounds"), so this only labels the
     * `Adjustment.direction` written to the audit log and never decides
     * whether a move is announced — only a risk threshold's loosening is.
     * `decrease` because less influence for a lens is the safer direction, the
     * same reading `TunableDial`'s doc gives for `max_position_size`.
     */
    tighten_is: 'decrease',
  };

  /**
   * A guardrail band for one notional cap (#433), relative to the FRACTION
   * this profile ships (`RISK_CAP_EQUITY_FRACTIONS`), so paper and live share
   * one band (#886). `ceiling` is the shipped value itself — a loosening
   * proposal can walk a tightened cap back up to, never past, the reviewed
   * value. `floor` at a quarter keeps the dial from tightening to zero, which
   * would be indistinguishable from a broken pipeline.
   */
  function capDial(shipped: number): TunableDial {
    return {
      // A tenth of the shipped cap: full traverse needs 7.5 consecutive breaching cycles
      max_step: PAPER_RISK_THRESHOLD_STEP_FRACTION * shipped,
      floor: PAPER_RISK_THRESHOLD_FLOOR_FRACTION * shipped,
      ceiling: shipped,
      tighten_is: 'decrease',
    };
  }

  return {
    attribution_window_ms,
    weights,
    /**
     * `DERIVED` — empty, and empty is a decision rather than an omission.
     * Nothing in the repo produces a `TuningProposal`, and `strategy_params`
     * is unwritten by any component, so a declared dial would find no value
     * to step from. `runDailyCycle` fails loud on an undeclared dial;
     * inventing plausible names here would silently satisfy that guardrail
     * for a proposer that doesn't exist.
     */
    strategy_params: {},
    /**
     * `DERIVED` from `riskConfig`'s own caps (#433). `RISK_THRESHOLD_KEYS`
     * (risk-manager/risk-thresholds.ts) is the naming contract between this
     * table and `RiskConfig`; `caps` is `RISK_CAP_EQUITY_FRACTIONS` (#886)
     * itself, keyed identically, so the seeded row and the row
     * `resolveRiskConfig` reads name the same field with no lookup between them.
     */
    risk_thresholds: Object.fromEntries(
      Object.entries(caps).map(([name, shipped]) => [name, capDial(shipped)]),
    ),
    kill_thresholds: {
      // SPEC — feedback-loop-spec.md story 13 ("PBO > 0.05"), matches CONTEXT.md and PboVerdict's own reject line
      max_pbo: 0.05,
      /** SPEC — feedback-loop-spec.md story 13: "OOS/paper Sharpe < 0.5" */
      min_oos_sharpe: 0.5,
      // SPEC-adjacent — story 13 leaves the significance level to config; 0.95 is the conventional 5% level
      min_deflated_sharpe: 0.95,
      /**
       * UNSOURCED — story 13 names "live-vs-backtest divergence" without a
       * fraction; 0.5 is a fractional drop (halved Sharpe), a defensible
       * reading of "the edge may be gone". Inert today: #345 never sourced
       * `metrics.backtest_reference_sharpe` (see #375), since Stage 2 has
       * never run against a real strategy.
       */
      max_live_backtest_divergence: 0.5,
    },
  };
}

/**
 * The kill-line detector's input (#379) — what makes `computeMetrics` have a
 * production caller. ADR-0006 §5's 60-observation gate keeps every kill-line
 * inert for roughly a calendar quarter regardless, so wiring it exercises the
 * whole path without acting on noise. `DailyMetricsSourceFactory`
 * (production.ts) is the seam: the composition root owns the SQLite handle
 * and calls this once at construction.
 */
function buildDailyMetrics(): DailyMetricsConfig {
  return {
    source: ({ db, trades, logger }) =>
      new SqliteDailyEquityMetricsSource({
        equity: new SqliteDailyEquityStore(db),
        trades,
        logger,
        // minReturnObservations not overridden: the default IS ADR-0006 §5's floor
      }),
    /**
     * SPEC-by-absence — 0, meaning INERT (#375). `liveBacktestDivergence`
     * refuses to manufacture a breach off a non-positive reference, since
     * there is no persisted backtest Sharpe to freeze — Stage 2 has never run
     * against a real strategy.
     */
    backtest_reference_sharpe: 0,
  };
}

/**
 * One asset class's LLM budget, expressed in the only unit an operator should
 * have to think about: debates per window. The call budget follows from it (see
 * `rateLimiterConfig`'s comment for why they are tied rather than independent).
 */
function llmBudget(maxDebates: number): RateLimitConfig {
  return {
    windowMs: LLM_BUDGET_WINDOW_MS,
    maxDebates,
    maxLlmCalls: maxDebates * WORST_CASE_LLM_CALLS_PER_DEBATE,
  };
}

/** Five minutes — see `rateLimiterConfig`'s comment for why not one */
const LLM_BUDGET_WINDOW_MS = 300_000;

/**
 * Debates per window, per asset class — `rateLimiterConfig.default` is
 * computed from these (`Math.min`) rather than restating one. Stocks raised
 * 15 -> 24 when `DEFAULT_UNIVERSE` widened 3 -> 20 names: debates are keyed
 * to the hourly bar not the tick, so each close bursts one debate per
 * instrument at once, and a refused reservation is DROPPED rather than
 * requeued (#617). Floor is one full universe pass per window (20); 24 keeps
 * ~20% margin. Re-derive against `DEFAULT_UNIVERSE.length` whenever the
 * universe changes.
 */
const CRYPTO_MAX_DEBATES_PER_WINDOW = 20;
const STOCKS_MAX_DEBATES_PER_WINDOW = 24;

/**
 * `maxConcurrentInstruments` (#1013) — see that field's comment below for the
 * full derivation. Named here so the number is defined once.
 */
const MAX_CONCURRENT_INSTRUMENTS = 6;

/**
 * The eight required config objects, plus the optional ninth seam (#366). No
 * longer parameterised by an equity anchor (#886) — the caps below are
 * FRACTIONS, resolved against `portfolio.equity` at evaluate time. Exported
 * for exactly one caller, `liveStartingProfile` (#511): it must be the SAME
 * builder, not a copy, or the two profiles could silently disagree about a
 * retuned dial.
 */
export function buildStartingProfileConfigs(
  /**
   * The universe this profile's gates are keyed to AND the list the run
   * ticks — one argument, so they cannot become two lists (#739).
   */
  universe: readonly UniverseInstrument[] = DEFAULT_UNIVERSE,
  /**
   * #888 — the declared book (GBP) D5's fractions resolve against, passed to
   * `d5EnvelopeFor` unchanged. `undefined` for paper (Alpaca's simulated
   * balance is not the book); `liveStartingProfile` supplies `LIVE_BOOK_GBP`.
   */
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
  // `Required`, not another `Pick`: each field is optional on `ProductionConfig`
  // with a fallback, but this profile must leave nothing to a fallback nobody
  // chose. `stocksTradingWindow` falls back to `?? true` (whole LSE session,
  // scheduler.ts:74) if dropped; `maxConcurrentInstruments` falls back to `?? 1`
  // (serial walk, production.ts:2701) — both silent regressions, not documented defaults.
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
  // ADR-0018 D5 — the gate's classification and the ticked list MUST be the
  // same universe (one parameter, not two matched identifiers), or unclassified
  // names get no envelope or throw on every entry
  const subclassCap = d5EnvelopeFor(universe, bookCeilingGbp);

  const traderConfig: TraderConfig = {
    // SPEC — DEFAULT_TRADER_CONFIG justified against docs/research/02-staged-deployment-plan.md
    // (quarter-Kelly sizing). Spread by reference so a copy cannot drift from the trader's own default
    ...DEFAULT_TRADER_CONFIG,
    // ADR-0018 D3/D5 (#739) — same classification the Risk Manager's D5 gate
    // caps against; empty until the LSE-ETP pool file (#703 C1) classifies rows
    subclass_of: subclassOfUniverse(universe),
    // #941 — ON here, OFF in DEFAULT_TRADER_CONFIG: Alpaca refuses a fractional
    // bracket/short, and D5's cash sizing produces fractional quantities for
    // nearly every entry. Safe only because DEFAULT_UNIVERSE is equities-only
    // (ADR-0015 2026-08-16) — a crypto instrument would floor to zero and never trade
    whole_share_sizing: true,
    // time_in_force no longer overridden here (#381) — now per-asset-class on
    // DEFAULT_TRADER_CONFIG itself, correct for both classes
  };

  const riskConfig: RiskConfig = {
    // UNSOURCED (all five caps) — risk-manager-spec.md "Out of Scope: Exact
    // limit values" refuses to pin them. Ordered ladder of equity fractions so
    // each cap can actually bind (per-trade -> per-asset -> per-asset-class ->
    // portfolio), read straight off RISK_CAP_EQUITY_FRACTIONS (#886)
    /** 5% of equity — the cap that binds first once a ~0.5-1% risk budget is divided by a ~1-2% ATR stop. Skipped for a D5-classified instrument (#886). */
    max_position_size_fraction_of_equity:
      RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity,
    /** 10% — one instrument may hold at most two max-size entries' worth. Skipped for a D5-classified instrument (#932). */
    per_asset_cap_fraction_of_equity: RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity,
    // 20% crypto / 40% stocks — asymmetric per docs/research/02-staged-deployment-plan.md
    // (quarter-Kelly in fat-tailed markets): crypto held to half the stock bucket's share
    per_asset_class_cap_fraction_of_equity: {
      crypto: RISK_CAP_EQUITY_FRACTIONS.per_asset_class_cap_fraction_of_equity_crypto,
      stocks: RISK_CAP_EQUITY_FRACTIONS.per_asset_class_cap_fraction_of_equity_stocks,
    },
    // 50% gross. DERIVED: above 100% is leverage nothing asks for, and half of
    // equity leaves room to absorb the 20% drawdown limit without caps and breaker fighting
    portfolio_gross_cap_fraction_of_equity:
      RISK_CAP_EQUITY_FRACTIONS.portfolio_gross_cap_fraction_of_equity,
    concentration: {
      // DERIVED — equal to the crypto asset-class cap: a correlated cluster
      // should not exceed what a single asset class may hold (spec step 6)
      cap_fraction_of_equity: RISK_CAP_EQUITY_FRACTIONS.concentration_cap_fraction_of_equity,
      // UNSOURCED — 0.7 is the conventional |r| boundary for "strongly correlated".
      // No longer inert (#381): DEFAULT_UNIVERSE gives it a second held instrument to compare against
      threshold: 0.7,
    },
    // DERIVED — matched to traderConfig.min_viable_notional (10); if Risk's floor
    // were higher, every viable Trader intent would be trimmed then rejected as dust
    min_viable_size: DEFAULT_TRADER_CONFIG.min_viable_notional,
    // Same venue constraint as traderConfig.whole_share_sizing, at the second
    // site that sets a size (#941): cap gates trim a notional and re-derive the quantity
    whole_share_sizing: true,
    // UNSOURCED — risk-manager-spec.md: "unpinned, tuned in paper trading". 70 on
    // WorldMonitor's 0-100 scale. Inert: ParkedCiiScoreProvider always answers null (ADR-0002)
    cii_threshold: 70,
    /**
     * UNSOURCED (milliseconds) — bound past which `computePortfolioView`
     * refuses to value a held position at all (#640). Deliberately a separate
     * field from `verdictConfig.max_mark_age` despite the same starting
     * values: a stale valuation here freezes the drawdown/daily-loss breakers
     * at their last reading, which is strictly worse than blocking one order.
     * `crypto` is dead weight since crypto left scope (ADR-0015 2026-08-16);
     * kept only because the type requires the key.
     */
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    /**
     * SPEC (ADR-0018 D5) — the deployment envelope, armed off the universe.
     * Omitted on `DEFAULT_UNIVERSE` (no subclass yet); conditionally spread
     * under `exactOptionalPropertyTypes`. `per_trade_size_cap` and
     * `per_asset_cap` both skip a D5-classified instrument entirely
     * (`isD5ArmedWithNumericFraction`, #886/#932) so D5 alone sizes it — see
     * `d5-trader-cap-agreement.test.ts`.
     */
    ...(subclassCap === undefined ? {} : { per_subclass_deployment_cap: subclassCap }),
    /**
     * #888 — armed whenever a book is supplied, independent of `subclassCap`.
     * This is what makes the account-level refusal work while `subclassCap`
     * is still `undefined` (no subclasses classified yet).
     */
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
    // DECIDED (David, 2026-08-06) — `auto` for both classes, paper and live (ADR-0007),
    // overriding verdict-spec.md's manual-then-auto staging. shouldEngageHitl short-circuits
    // before isFlagged is consulted, so the HITL gate is unreachable and flag_thresholds/human_timeout
    // below are inert. With no human gate, the breakers and notional caps are the only stop —
    // safe on paper only because no 14-day soak (#238) has run to source the UNSOURCED caps
    automation_level: { crypto: 'auto', stocks: 'auto' },
    // UNSOURCED (ms) — the gate reads OrderIntent.decided_at (#1190), a wall-clock
    // timestamp read at intent-build time, not the bar-floored decision_timestamp — so
    // bar position no longer affects measured signal age (fixed a #616/#687 staleness bug).
    // 5 min crypto / 15 min stocks: crypto re-prices 24/7, equities move in session
    // structure and are caught by the market_closed gate first when stale overnight
    max_signal_age: { crypto: 5 * 60_000, stocks: 15 * 60_000 },
    // UNSOURCED (ms) — the FEED-staleness bound (#641): how long ago the market last
    // printed, distinct from max_signal_age's "how long ago we decided". Stocks matches
    // the signal bound rather than sitting under it because ADR-0016's LSE leveraged ETPs
    // are thin — a tight bound would no-go on ordinary illiquidity, not just a dead feed
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    // UNSOURCED — 0.5% re-expresses the old absolute drift_tolerance (500) at BTC-USD's
    // price (#381 changed absolute to fractional so it doesn't silently tighten as price
    // moves). Stocks starts equal to crypto for lack of an equity observation to derive from
    drift_tolerance_pct: { crypto: 0.005, stocks: 0.005 },
    // UNSOURCED (ms) — inert today since automation_level short-circuits the HITL gate
    // before this is read; load-bearing only if the dial returns to manual/semi_auto
    human_timeout: 15 * 60_000,
    // DERIVED — false is the conservative side; DEFAULT_UNIVERSE's equities now reach
    // the market_closed gate, and extended-hours liquidity is what the cost model is least calibrated for
    allow_extended_hours: false,
    flag_thresholds: {
      // DERIVED — order.size is unit-incommensurable across BTC and AAPL, so 0 flags every
      // positive size. Inert regardless: automation_level: 'auto' short-circuits before isFlagged
      size_over: 0,
    },
  };

  const executionConfig: ExecutionConfig = {
    // No fill is priced off this in paper (`AlpacaBrokerAdapter`, not the
    // Simulated one); only the #1001 submit snapshot reads it, best-effort
    // Correct so a backtest run over this same profile is not silently
    // misconfigured
    simulated: {
      /**
       * SPEC — the same ATR(14) spec `DEFAULT_VOLATILITY_INDICATOR`
       * (production.ts) already justifies, including the `lookback: 15`
       * detail: `atr()` spends the first bar seeding `previousClose`, so N
       * bars yield N-1 true ranges and a 14-period ATR needs 15
       */
      volatility_indicator: {
        indicator: 'atr',
        params: { period: 14 },
        // The breaker's realized-vol reading, on the same 1h bars every other
        // indicator in the system uses (#315)
        timeframe: '1h',
        lookback: 15,
      },
      /**
       * UNSOURCED — cost-model-backtest-spec.md sources `MarketState.adv`
       * from "an MDS ADV helper (bars-volume aggregation)" without pinning a
       * window. 20 daily bars is the conventional one-trading-month ADV.
       */
      adv_window: { timeframe: '1d', lookback: 20 },
      /**
       * SPEC — ADR-0015's 2026-08-30 amendment: the live equity venue is
       * Saxo, so every modelled fill (the control arm's Simulated adapter
       * and the submit-time snapshot, #1001) prices at Saxo's economics via
       * `costConfig.venues.saxo` rather than at Alpaca's paper book
       */
      venue: 'saxo',
    },
  };

  const correlationConfig: CorrelationConfig = {
    // UNSOURCED — risk-manager-spec.md step 6 specifies pairwise Pearson correlation
    // over trailing returns, no window. 30 daily bars is the conventional monthly
    // window; min_bars: 20 omits any pair without ~a month of overlap (#303/#383 —
    // an omitted pair reads as uncorrelated, so insufficient_history now names the gap)
    window: { timeframe: '1d', lookback: 30 },
    min_bars: 20,
  };

  const breakerConfig: BreakerConfig = {
    // UNSOURCED — DERIVED from the drawdown limit below: a fifth of it, so five
    // consecutive maximally-bad days reach the hard stop. A FRACTION: PortfolioView.daily_pnl.portfolio.pct
    // is (realized+unrealized)/session-open equity, compared as pct <= -daily_loss_pct
    daily_loss_pct: 0.05,
    // UNSOURCED — DERIVED from daily_loss_pct: same 5%, same equity denominator per decision 4 (#329),
    // so a per-class and portfolio-wide loss are the same dollar figure; still bites first when one class bleeds
    daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
    /**
     * DERIVED — owner ruling on #634/#798/#925, sited against ADR-0018's
     * measured drawdown envelope (26.2% index / 41.8% single-stock). Trip
     * sits ABOVE the envelope (not inside it, which would fire on the
     * strategy working as designed): 0.44 is 2.2pp above the 41.8% envelope
     * and 1pp below the 0.45 hard ceiling (`threshold-bounds.ts`). Hard and
     * sticky but no longer human-cleared — ADR-0013 removed the operator, so
     * `auto_rearm` clears it on recovery (#634). `drawdown_pct` is
     * `(peak - equity) / peak`.
     */
    max_drawdown_pct: 0.44,
    // UNSOURCED — spec story 15 names the breaker, not the count; 5 is unlikely
    // enough at any plausible win rate to be signal, and it's soft/auto-resetting
    max_consecutive_losses: 5,
    volatility: {
      // See UNCALIBRATED_VOLATILITY_BASELINE: deliberately inert, not deliberately trip-happy
      baseline: {
        crypto: UNCALIBRATED_VOLATILITY_BASELINE,
        stocks: UNCALIBRATED_VOLATILITY_BASELINE,
      },
      // UNSOURCED — 3x a calibrated baseline is a defensible "abnormal spike"; meaningless until the baseline is real
      multiplier: 3,
    },
    /**
     * DERIVED — LIVE IN PAPER as of #634: ADR-0013 removed the human operator
     * who would have called `reArm()`, so this is the only thing that clears
     * a trip outside backtest. `recovery_drawdown_pct: 0.2` is CONTEXT.md's
     * "~20-25%" design envelope's top edge, unchanged since #925 — it must
     * sit at or below the drawdown envelope, and raising it would shorten the
     * halt after a real trip. `max_days_tripped: 5` is backtest-only (see the
     * field's docblock) so a multi-year replay doesn't dead-end on its first hit.
     */
    auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
  };

  const costConfig: CostConfig = {
    // Inert in paper (Simulated adapter only); every value is above CostModelImpl's
    // structural 1bp floor, which would silently replace anything at or under it
    crypto: {
      // UNSOURCED — cost-model-backtest-spec.md OPEN-GAP-A specifies the mechanism, not the coefficient; crypto is the wider per story 4
      spreadVolatilityCoefficient: 0.1,
      // SPEC-adjacent — story 4's "taker fee"; 26bp is the venue-typical top-of-book taker rate, pessimistic vs. Alpaca's own
      commissionRate: 0.0026,
      /** UNSOURCED — `slippage = volatility * coefficient` (spec §3, deterministic mode); crypto's API latency (~100-200ms per spec) is the wider of the two */
      slippageCoefficient: 0.05,
      /** UNSOURCED — the `k` in `impact = k * volatility * sqrt(size / adv)` (spec §4, Almgren-style). Higher for the thinner book. */
      impactK: 0.5,
    },
    stocks: {
      /** UNSOURCED — half the crypto coefficient; US large-cap spreads are materially tighter */
      spreadVolatilityCoefficient: 0.05,
      /**
       * SPEC — cost-model-backtest-spec.md §Commission: "Chan's ~5 bps
       * ex-commission for S&P names is the sanity anchor for the stock
       * defaults."
       */
      commissionRate: 0.0005,
      /** UNSOURCED — as crypto's, scaled down for a tighter, faster venue */
      slippageCoefficient: 0.02,
      /** UNSOURCED — as crypto's `impactK`, scaled down for a deeper book */
      impactK: 0.3,
    },
    // SPEC — ADR-0015:201, Saxo Classic tier: 8bps per side, no minimum. Binds only on
    // a MarketState stamped venue: 'saxo' (executionConfig.simulated.venue, #1032 item 2)
    venues: { saxo: { commissionRate: SAXO_COMMISSION_RATE } },
  };

  const ciiConsumerConfig: CiiConsumerConfig = {
    // SPEC — ADR-0002 §2: WorldMonitor polls its own 5-15 min cadence; 10 min is the
    // midpoint. Feed is parked: ciiScoreProvider defaults to ParkedCiiScoreProvider,
    // which answers null and makes no network call, so this spends nothing
    pollIntervalMs: 10 * 60_000,
  };

  return {
    // DECIDED (David, 2026-08-06) — the 14-day soak may spend $50 total on LLM calls
    // (ADR-0008), enforced by SqliteSpendCap over cumulative llm_spend; does not refill.
    // A hard ceiling behind the cadence choice below, not instead of it — covers what
    // cadence cannot (a retry storm, extra debate rounds, a provider price change)
    llmBudgetUsd: 50,
    /**
     * DERIVED — 2 minutes, down from 15 (#670). 15 was optimal in
     * `docs/research/41-tick-latency-economics.md`'s T(τ) = C/τ + B·√τ
     * trade-off while #617 made LLM spend scale with tick rate; #617 closed
     * (one debate per bar) collapsed C to ~0, so the optimum drops to the
     * smallest τ the pass duration allows. 2 min leaves ~9x headroom over the
     * ~13s measured pass. Entries stay bar-gated (unaffected); this only
     * tightens exit-bracket resolution, and cost is untouched since spend is
     * keyed to the debate bar, not the tick. NOT #400's per-asset-class
     * cadence decision — one base interval for every instrument.
     */
    tickIntervalMs: 2 * 60_000,
    /**
     * DERIVED (#1013) — worker-pool width, set explicitly rather than left to
     * the `?? 1` fallback that produced a serial walk in production. Sized
     * from `rateLimiterConfig.perAssetClass.stocks`'s budget (15
     * debates/5min) and #1012's measured per-debate latency; still under
     * `min(6, universe.length)` at today's 20-name universe, so this dial
     * binds. Widening it trades measured staleness (a wider universe walks in
     * more groups) for #692's unmeasured overlapping-pass multiplication —
     * HUMAN TRIPWIRE: re-derive here, don't assume, if either the rate-limit
     * budget or the universe size changes again. `backtest` overrides this
     * back to `1` for replay determinism (#1013 fix-up H1).
     */
    maxConcurrentInstruments: MAX_CONCURRENT_INSTRUMENTS,
    // SPEC — equities enter only inside the LSE/US overlap (#706): 14:30-15:45
    // London, the first 75 min of the US session (matching R2's entry-offset grid).
    // UK/US DST transitions disagree ~3 weeks/year, sliding this an hour later
    // against the US tape (trading-window.test.ts pins it, not corrected — see ADR
    // note if it matters). Cuts entries per session (~7 to 2) but not exits, which
    // run every tick regardless
    stocksTradingWindow: londonEntryWindow(),
    // SPEC — the universe a paper run trades (#381), matching ADR-0001's default set;
    // DEFAULT_UNIVERSE is the checked-in copy, spread by reference. Debate spend is
    // keyed to the 1h debate bar, not the tick (#617), so a wider universe is not a
    // proportional cost multiplier; rateLimiterConfig (#388), not this array's size
    // or maxConcurrentInstruments, is the actual throttle on concurrent LLM calls
    universe,
    traderConfig,
    riskConfig,
    verdictConfig,
    executionConfig,
    correlationConfig,
    breakerConfig,
    costConfig,
    ciiConsumerConfig,
    /**
     * The LLM budget every debate is admitted against (#388) — closes the gap
     * where `maxConcurrentInstruments: 1` used to be the only throttle. A
     * runaway CEILING, not a scheduler and not a transcription of Anthropic's
     * real rate limits (those aren't established for this account) —
     * `maxDebates` is derived from #385's measured cadence at ~3x headroom,
     * deliberately left unchanged as `tickIntervalMs` moved since retuning it
     * to track cadence would make it a second, conflicting cost control.
     * `default` is `Math.min` of the two classes rather than hand-written, so
     * it structurally always mirrors whichever class is tighter.
     */
    rateLimiterConfig: {
      default: llmBudget(Math.min(CRYPTO_MAX_DEBATES_PER_WINDOW, STOCKS_MAX_DEBATES_PER_WINDOW)),
      perAssetClass: {
        crypto: llmBudget(CRYPTO_MAX_DEBATES_PER_WINDOW),
        stocks: llmBudget(STOCKS_MAX_DEBATES_PER_WINDOW),
      },
    },
    /**
     * The ninth seam (#366), and the only optional one here.
     *
     * Values only, exactly like the other eight: no `approvals` transport and
     * no `intervalMs`, so the composition root's `SAMURAI_ALERTS`-selected
     * channel and its 24h default apply.
     */
    feedback: {
      config: buildFeedbackConfig(RISK_CAP_EQUITY_FRACTIONS),
      metrics: buildDailyMetrics(),
    },
  };
}

/**
 * The profile the shipped entrypoint starts with — and a hard refusal to be
 * the profile a **live** process runs on, since #886 the notional caps
 * (equity-relative, identical in every profile) are no longer why: the
 * volatility baseline is uncalibrated, drift_tolerance is sized for one
 * instrument, and cadence/budget are sized for a $50 soak, with no human gate
 * behind any of it since ADR-0007. `startFromEnvironment` still accepts a
 * tuned config for a real live run; `backtest` is allowed since it spends nothing.
 */
export function paperStartingProfile(
  mode: ProductionConfig['mode'],
  /**
   * The universe this profile's gates are keyed to AND the list the run ticks
   * — `buildStartingProfileConfigs`' one argument, forwarded (#739).
   *
   * Omitted is `DEFAULT_UNIVERSE`, which is every shipped Alpaca run: an
   * absent argument reproduces the profile byte for byte, so the paper path
   * is unchanged by this parameter existing. `SAMURAI_BROKER=saxo` is the one
   * caller that supplies it, with the LSE ETP pool's tradeable set (#1400) —
   * and it has to arrive HERE rather than being spread over the returned
   * profile, or `subclass_of` and D5's envelope arm against a universe the
   * run does not trade. See `startingProfileForMode` (index.ts).
   */
  universe?: readonly UniverseInstrument[],
  /**
   * The currency the account this profile sizes against actually reports, and
   * therefore the currency `capitalCeilingUsd` must be stated in (#1400 round
   * 1). Omitted is `'USD'` — every shipped Alpaca run — so an absent argument
   * reproduces the profile byte for byte.
   *
   * `SAMURAI_BROKER=saxo` is the one caller that supplies `'GBP'`: its
   * `accountState` is a GBP-native read (#949 refuses anything else), so the
   * converted ceiling would clamp the declared £1,000 book at £1,270.
   */
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
    // #1112: paper sizes against a simulated Alpaca account (~$100,000 funded
    // equity) unrelated to the declared book — without this clamp, sizingEquity
    // never bounds paper sizing to LIVE_BOOK_GBP, ~100x over. Stated in the
    // account's own currency (#1180): USD for the Alpaca account (LIVE_BOOK_SIZING_USD,
    // converted, with the rate carried alongside in capitalCeilingUsdPerGbp so
    // the two can't be read apart) or GBP raw for a GBP-native account (#1400).
    // Scoped to paper only — backtest reads portfolio.equity unclamped by design
    ...(mode === 'paper'
      ? bookCurrency === 'GBP'
        ? { capitalCeilingUsd: toCapitalCeilingUsd(LIVE_BOOK_GBP, 'LIVE_BOOK_GBP') }
        : {
            capitalCeilingUsd: toCapitalCeilingUsd(LIVE_BOOK_SIZING_USD, 'LIVE_BOOK_SIZING_USD'),
            capitalCeilingUsdPerGbp: SIZING_USD_PER_GBP,
          }
      : {}),
    // #1112 follow-up — DERIVED from ADR-0018 D5, paper only: `backtest`
    // keeps `configs.traderConfig` verbatim, same scoping rationale as
    // DERIVED (#1112/#1137) — stocks risk multiplier retuned to 1.9x for the
    // generic ATR sizing path (DEFAULT_UNIVERSE has no D5 subclass entries),
    // targeting D5's 25%/$250 single-stock reference at one measured tick.
    // Paper only — this key does not exist on liveStartingProfile's return.
    // CAVEAT (#1136 measured, still open): this path has NO code-enforced
    // deployment ceiling — at full conviction and the tightest ATR-floor
    // stop, deployment can reach ~712% of equity at 1.9x. 1.9x bounds only
    // the one reference tick, not the general case; #1604 owns the fallout
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
    // backtest keeps maxConcurrentInstruments: 1 explicitly (#1013 fix-up H1)
    // rather than inheriting paper/live's 6 — width 1 makes stage-call
    // interleaving and log-insertion order deterministic, which the
    // walk-forward replay path depends on
    ...(mode === 'backtest' ? { maxConcurrentInstruments: 1 } : {}),
    // #1511 — long-only book, gated to the actual Saxo-tradeable set (the one
    // caller supplying both bookCurrency: 'GBP' and this universe)
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
