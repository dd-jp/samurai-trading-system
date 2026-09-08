/**
 * The checked-in **paper starting profile** (ticket #323) — the eight
 * per-stage config objects `REQUIRED_INJECTED_CONFIG` demands, so that
 * `yarn orchestrator` reaches a running tick loop instead of throwing at the
 * seams guard — plus, since #366, the optional ninth: the Feedback Loop's
 * `FeedbackConfig`.
 *
 * The ninth is here for the same reason as the eight and no other. It was left
 * out of #323 as "optional", which in practice meant nothing supplied it and
 * stage 6 of a 6-stage pipeline never ran: a paper soak (#238) produced trades
 * and fills for 14 days and attributed no weight, tuned no dial and evaluated
 * no kill-line. `ProductionConfig.feedback`'s own doc named the reason —
 * "`FeedbackConfig`'s values are tuned in paper trading" — which is the exact
 * rationale that puts the other eight in this file. See `buildFeedbackConfig`
 * for what does and does not actually move during a soak.
 *
 * ## These are STARTING POINTS, not tuned values
 *
 * Every stage spec says its thresholds are "config, tuned in paper trading"
 * and puts exact values out of scope (risk-manager-spec.md "Out of Scope:
 * Exact limit values"; verdict-spec.md "Out of Scope: Exact thresholds";
 * cost-model-backtest-spec.md "Out of Scope: Exact values"). That instruction
 * is circular as long as nothing can boot: no paper run has ever produced an
 * observation to tune against. This file breaks the circle by checking in a
 * first, deliberately conservative set — **not** by claiming they are right.
 *
 * Each value below carries its provenance in a comment, in one of three
 * kinds, and the distinction is the point:
 *
 * - **`SPEC`** — the number (or the range it was picked from) is stated in
 *   `docs/`. Cited by file and section.
 * - **`DERIVED`** — no doc states it, but it is forced by a relationship to a
 *   value that is stated (a fraction of the drawdown limit, an ordering
 *   constraint between two caps, a unit the code fixes).
 * - **`UNSOURCED`** — nothing in the repo pins it. Chosen conservatively with
 *   the reasoning written out, and first in line to be replaced by real paper
 *   observations. Treat every one of these as an open question.
 *
 * ## What is inert in paper mode
 *
 * Three of the eight never execute on the paper hot path, which is why their
 * values carry less weight than their presence:
 *
 * - `costConfig` and `executionConfig.simulated` — consumed by
 *   `SimulatedBrokerAdapter` only ("Consumed by the Simulated adapter only —
 *   real adapters never call it", execution/types.ts). Paper runs against
 *   `AlpacaBrokerAdapter`.
 * - `breakerConfig.auto_rearm.max_days_tripped` — backtest-only by
 *   construction (risk-manager/breakers.ts). Its sibling
 *   `recovery_drawdown_pct` is NOT inert and was moved off this list by #634:
 *   ADR-0013 removed the operator who used to clear the hard drawdown
 *   breaker, so recovery is now the live and paper re-arm path too.
 * - `ciiConsumerConfig` is live, but the provider behind it is not: the
 *   composition root defaults `ciiScoreProvider` to `ParkedCiiScoreProvider`
 *   (always `null`, ADR-0002 — live WorldMonitor wiring is parked for cost
 *   reasons during paper trading), so `riskConfig.cii_threshold` is never
 *   compared against a real score either.
 *
 * ## Values, one factory, and no transports
 *
 * This profile supplies config values and opens nothing — no database, no
 * socket, no file. The single exception since #379 is `feedback.metrics.source`,
 * which is a FACTORY: the kill-line detector's source needs the shared SQLite
 * handle, so this file names the class and the decision and the composition
 * root, which owns the handle, constructs it. Nothing here runs at import time
 * either way; see `buildDailyMetrics`.
 *
 * Transports are a different matter, and deliberately absent. That is not the
 * same as leaving them unwired:
 * [#322](https://github.com/dd-jp/samurai-trading-system/issues/322) resolves
 * the three outbound alert channels (`heartbeatChannel`, `orphanAlerts`,
 * `unpricedFillAlerts`) from `SAMURAI_ALERTS` in `startFromEnvironment`, so a
 * paper run started with `SAMURAI_ALERTS=telegram` pushes them to a phone —
 * which is what makes the unattended soak (#238) unattended. Putting that
 * decision here instead would have hard-coded one operator's posture into a
 * checked-in file; it is a deployment choice, not a tuning value.
 *
 * `approvals` is the exception and is still a log-only stand-in: it is an
 * inbound HITL round trip rather than an alert, and wiring it through Telegram
 * is #275's remaining half. See `verdictConfig.automation_level` below for
 * what that means for the `manual` setting in practice.
 *
 * The Feedback Loop's `LoosenNotificationChannel` is emphatically NOT that
 * exception: it returns `void` and collects no answer, so #366 resolved it
 * from `SAMURAI_ALERTS` like the outbound four and the `feedback` block below
 * names no transport either. #736 renamed it from `LoosenApprovalChannel` once
 * ADR-0013 Decision 2 removed the gate it was named for — it announces an
 * applied loosening now rather than requesting one.
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
// cycle — see that function's doc comment).
export { subclassOfUniverse };

/** The header's three-value provenance taxonomy, as data. */
export type ValueProvenance = 'SPEC' | 'DERIVED' | 'UNSOURCED';

/**
 * The machine-readable index of the taxonomy the per-value comments below
 * apply (review 2026-08-06 D4) — greppable and assertable; the comments keep
 * the WHY, this map keeps the CLASSIFICATION.
 *
 * Keys are dot-paths of leaf values as they appear in the object
 * `paperStartingProfile()` returns. Walk semantics, pinned by
 * `paper-profile-provenance.test.ts`:
 *
 * - Arrays (`universe`) and empty objects (`feedback.config.strategy_params`,
 *   whose emptiness IS the labeled decision) are single leaves.
 * - Function-valued members (`feedback.metrics.source`, a factory) and `mode`
 *   (the caller's own argument echoed back, not a tuning value) carry no
 *   provenance and are not indexed.
 *
 * Where a comment uses a variant label, the mapping here is the nearest of
 * the three: `SPEC`-adjacent / `SPEC`-by-absence -> `SPEC`; "DECIDED (ADR-000x)"
 * -> `SPEC` (the ADR is the doc that states it); the dual-labeled
 * "UNSOURCED — DERIVED from ..." daily-loss values -> `UNSOURCED` (their own
 * comment closes "a starting point to be measured, not a derived constant").
 * `riskConfig.portfolio_gross_cap_fraction_of_equity` follows its own field comment (`DERIVED`)
 * over the block-level "UNSOURCED (all five caps)".
 */
export const PAPER_PROFILE_PROVENANCE = {
  llmBudgetUsd: 'SPEC',
  tickIntervalMs: 'DERIVED',
  // #1013 — derived from `rateLimiterConfig.perAssetClass.stocks`'s budget,
  // #1012's measured per-call latency, and today's universe size. See the
  // field's own comment for the arithmetic.
  maxConcurrentInstruments: 'DERIVED',
  universe: 'SPEC',
  // #1112: `LIVE_BOOK_GBP` itself — ADR-0015's 2026-08-18 amendment's £1,000
  // book, the same literal the arm comparison's `basis` (production.ts,
  // smoke-run.ts) is stated against. Not DERIVED: nothing here computes it,
  // it is pinned to the one already-decided figure.
  capitalCeilingUsd: 'SPEC',
  'traderConfig.conviction_floor': 'SPEC',
  // #668. SPEC rather than DERIVED: close − 5 minutes is not calculated from
  // anything here, it is the value #657 resolved on 2026-08-09 and ADR-0014's
  // flat-by-close horizon is what makes it binding.
  'traderConfig.flatten_before_close_ms': 'SPEC',
  'traderConfig.max_risk_per_trade': 'SPEC',
  'traderConfig.asset_class_risk_multiplier.crypto': 'SPEC',
  // #1112 follow-up — DERIVED, not SPEC: 1.9x is computed from
  // D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION and #1112's own logged MU
  // deployment measurement, not stated directly by an ADR. See the
  // assignment site's comment for the arithmetic.
  'traderConfig.asset_class_risk_multiplier.stocks': 'DERIVED',
  'traderConfig.atr_timeframe': 'SPEC',
  'traderConfig.atr_lookback': 'SPEC',
  'traderConfig.atr_k': 'SPEC',
  'traderConfig.vol_floor_fraction': 'SPEC',
  // ADR-0018 D3's frozen brackets and D5's deployment fractions (#739). SPEC
  // rather than DERIVED throughout: every one of these is a measured level the
  // ADR states, not a value computed here. `subclass_of` is a single leaf
  // because it is empty — the emptiness IS the decision, exactly as
  // `feedback.config.strategy_params`'s is: `DEFAULT_UNIVERSE` declares no
  // subclass, so the regime is unarmed until the pool file classifies its rows.
  'traderConfig.subclass_of': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.take_profit_pct': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.stop_pct': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.deployment_fraction': 'SPEC',
  'traderConfig.subclass_brackets.index_etp_3x.round_trip_cost_pct': 'SPEC',
  // #897. SPEC: ADR-0018's 2026-09-03 amendment declares the reserve and its
  // arithmetic; nothing here computes it from another config value.
  'traderConfig.subclass_brackets.index_etp_3x.headroom_reserve_fraction': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.take_profit_pct': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.stop_pct': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.deployment_fraction': 'SPEC',
  'traderConfig.subclass_brackets.single_stock_etp_3x.round_trip_cost_pct': 'SPEC',
  // #897, as above.
  'traderConfig.subclass_brackets.single_stock_etp_3x.headroom_reserve_fraction': 'SPEC',
  // `crypto: null` — "ADR-0018 sets no bracket here" — is a leaf value like any
  // other and carries the same provenance: it is the ADR's own answer.
  'traderConfig.subclass_brackets.crypto': 'SPEC',
  'traderConfig.non_converged_haircut': 'SPEC',
  'traderConfig.reward_risk_multiple': 'SPEC',
  'traderConfig.min_viable_notional': 'SPEC',
  // #941. SPEC by the same reading `time_in_force` is: a venue constraint the
  // venue itself states, here by refusing — `422 42210000 fractional orders
  // must be simple orders`, measured against the paper API rather than assumed
  // from documentation. Not DERIVED: nothing here computes it.
  'traderConfig.whole_share_sizing': 'SPEC',
  'traderConfig.time_in_force.crypto': 'SPEC',
  'traderConfig.time_in_force.stocks': 'SPEC',
  'traderConfig.scale_in_conviction_delta': 'SPEC',
  // #748: the indicator-based early exit's decay criterion. SPEC, like every
  // other Trader threshold — `DEFAULT_EARLY_EXIT_CONFIG` is spread in unchanged
  // and its default is argued at its definition, not fitted here.
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
export const PAPER_RISK_THRESHOLD_FLOOR_FRACTION = 0.25;
export const PAPER_RISK_THRESHOLD_STEP_FRACTION = 0.1;

/**
 * The six notional caps, as FRACTIONS OF EQUITY (#886) — resolved against
 * `portfolio.equity` at evaluate time (`risk-manager/index.ts`'s
 * `ENTRY_CAP_GATES`), not multiplied against a frozen anchor or ceiling at
 * profile-build time. Keyed identically to `RISK_THRESHOLD_KEYS`
 * (risk-manager/risk-thresholds.ts) on purpose: these are the same six
 * numbers the `risk_thresholds` table seeds and tunes, under one shared
 * vocabulary rather than two that could drift.
 *
 * Until #886 these were multiplied by an assumed equity anchor once at boot
 * (`riskCapsFor`, deleted) — static cash that stayed put while D5's own
 * fraction (`per_subclass_deployment_cap`) resolved against live equity every
 * decision. That mismatch meant which cap bound depended on the gap between
 * live equity and the anchor rather than being statically decidable (#886).
 * All six now share D5's pattern: the fraction is the decision, and it is
 * multiplied by equity at the one place equity is actually known — the
 * decision itself, in every profile (paper AND live) alike.
 *
 * Each fraction's justification stays at its `riskConfig` field, not here.
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
 * ADR-0015's book, as decided by David on 2026-08-18: **£1,000, all equity.**
 *
 * There is no longer a leg to be a fraction OF. Crypto left scope on
 * 2026-08-16 (#705) and the book was re-based from £1,500-split-in-two to a
 * single £1,000 equity book, so ADR-0018 D5's "fraction of the equity leg" and
 * "fraction of the account" are now the same quantity. The `0.5` scaler this
 * replaces encoded the two-leg book and is deleted rather than set to 1.0: a
 * constant that can only ever be 1 is the kind of thing #800 was filed to
 * remove, not to preserve.
 *
 * Recorded here because the number is load-bearing twice over — it is what
 * D5's published cash figures were calibrated against, and it is the base the
 * drawdown envelope of #798 is a fraction of. It is NOT the live account
 * balance: the gate resolves against `portfolio.equity` on every decision
 * (#739), clamped to this figure — see the next paragraph — and this is the
 * inception figure the ADR names.
 *
 * **#888 resolved: this IS load-bearing now, not documentation-only.**
 * Until #888, nothing in the runtime read this constant — the deleted
 * `EQUITY_LEG_FRACTION_OF_CAPITAL` used to scale the gate, and deleting it
 * left NOTHING bounding D5's fractions to the declared book, correct only
 * while funded equity happened to equal it exactly. Above it, the same
 * fractions authorised proportionally more cash than the book was sized for
 * (£1,500 funded resolved £525 at the 0.35 fraction, not £350) — asserted at
 * the time as the one exposure #885 knowingly left open. `d5EnvelopeFor`
 * below now passes this figure as `SubclassDeploymentCap.equity_ceiling.book`,
 * so `perSubclassDeploymentCap` (risk-manager/index.ts) clamps its equity
 * read to it, and REFUSES the entry outright once funded equity exceeds it
 * by more than `D5_BOOK_REFUSE_ABOVE_TOLERANCE`. The book is still bounded by
 * what the account is funded with — this constant is what stops that funding
 * level, if it drifts, from silently reaching every position's sizing too.
 *
 * **`liveStartingProfile` is the only caller that passes this constant
 * through.** `d5EnvelopeFor` takes the book as an optional parameter rather
 * than reading this constant directly, because the ceiling is a statement
 * about the LIVE account specifically — `paperStartingProfile` runs against
 * Alpaca's simulated ~$100,000 balance, and clamping a classified paper
 * universe to a £1,000 ceiling would refuse every entry rather than test
 * anything. See `d5EnvelopeFor`'s docstring for the paper-soak failure mode
 * an earlier, unconditional version of this wiring would have caused.
 *
 * **And that is the assumption the unscaled fraction form rests on.** The old
 * 0.5 was an ACCOUNT -> LEG conversion, because `RiskPortfolioView.equity` is
 * the whole account while D5's fractions are of the leg. Deleting it in #885
 * was correct exactly while the funded equity read EQUALS the book; #888's
 * `equity_ceiling` is the live `book / equity` conversion #885's own body
 * named as the repair, resolved at evaluate time rather than as a
 * re-introduced static constant.
 */
export const LIVE_BOOK_GBP = 1_000;

/**
 * #888's backstop: how far funded equity may drift above `LIVE_BOOK_GBP`
 * before `perSubclassDeploymentCap` refuses a D5-classified entry outright,
 * rather than merely clamping its equity read to the book.
 *
 * Chosen as "a few percent" per the issue's own framing — small enough that
 * routine drift (a pending dividend credit, a stray fee, a top-up mid-cycle)
 * does not halt trading, but small enough that a materially overfunded
 * account (the £1,000 -> £1,500 scenario #888 was filed against) still
 * refuses rather than silently sizing on the wider figure. Not a Feedback
 * Loop dial for the same reason D5's fractions themselves are not one (see
 * `D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG`): this bounds how far the ACCOUNT
 * may drift from a number the operator declared, not a risk parameter the
 * loop has any business tuning.
 */
export const D5_BOOK_REFUSE_ABOVE_TOLERANCE = 0.05;

/**
 * ADR-0018 D5 — max deployment per subclass, as a fraction of the EQUITY LEG.
 *
 * At the £750 leg D5 was WRITTEN against these reproduce the ADR's own
 * illustrative figures: 0.35 x 750 = £262.50 ("~£260") and 0.25 x 750 =
 * £187.50 ("~£190"). That reproduction is the check that the base is right —
 * any other base produces numbers no document contains — and it is kept as a
 * provenance check even though the book is now £1,000 all-equity
 * (`LIVE_BOOK_GBP`), where the same fractions resolve to £350 and £250. The
 * FRACTIONS did not change on 2026-08-18; only what they are a fraction of.
 * The CASH figures are illustrative either way:
 * D5's sizing amendment settles the rule as a fraction resolved against
 * current equity, which is what `subclassDeploymentCapFractionsOfEquity`
 * hands the gate.
 *
 * The two fractions are the Trader's named D5 constants, imported rather than
 * restated (`trader/subclass-bracket.ts`), so the envelope the Risk Manager
 * caps at and the envelope the Trader sizes to cannot drift apart — and so
 * the single-stock row's overshoot citation exists in exactly one place. That
 * overshoot is ~17 pp, not D5's published ~1.2 pp; see the constant.
 *
 * `crypto` is `null` — "D5 measured no envelope here" — not a number waiting
 * to be guessed. See `SubclassDeploymentCap.cap_fraction_of_equity`.
 */
export const D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG: Readonly<
  Record<InstrumentSubclass, number | null>
> = {
  index_etp_3x: D5_INDEX_ETP_DEPLOYMENT_FRACTION,
  single_stock_etp_3x: D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
  crypto: null,
};

/**
 * ADR-0018 D5's envelope as fractions of TOTAL account equity — the form the
 * gate resolves against `portfolio.equity` on every decision (#739).
 *
 * D5's fractions are of the EQUITY LEG, and since 2026-08-18 the equity leg
 * IS the whole book (`LIVE_BOOK_GBP`), so no scaling happens here at all —
 * the identity is why this function still exists rather than callers reading
 * the table directly. It previously multiplied by an
 * `EQUITY_LEG_FRACTION_OF_CAPITAL = 0.5` that encoded ADR-0015's £750/£750
 * split; David's ruling on #800 dissolved the split, so that factor is gone.
 *
 * **This DOUBLES the resolved cap** (index 0.175 -> 0.35 of account,
 * single-stock 0.125 -> 0.25) and it is meant to: 0.25 unscaled is exactly the
 * `f` ADR-0018 D5 published and measured. It also puts the single-stock
 * subclass back at the ~41.8% measured drawdown of D5's #729 note, ~17 pp
 * above `CONTEXT.md`'s 20-25% tolerance — which is #798's whole subject, is
 * accepted-not-sized-away per the named constant, and does not fire today
 * because no universe declares a subclass yet.
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
 * subclasses at all.
 *
 * **The gate arms itself off the universe, and that is the whole design.** The
 * subclass dimension is sourced from C1's LSE-ETP pool file (#703); until one
 * exists, `DEFAULT_UNIVERSE` carries no subclasses, this returns `undefined`,
 * and the gate is inert — which is correct, because ADR-0018 prices leveraged
 * ETPs and the default universe holds none of them. Declaring the field with
 * an empty `subclass_of` would instead make every entry throw.
 *
 * A universe that is PARTLY classified still arms it, and the unclassified
 * names then throw at sizing time. That is intended: a half-populated pool
 * file is a mistake to surface, not one to size around.
 *
 * **`equity_ceiling` is set here (#888) only when a book is supplied — LIVE
 * ONLY, not unconditionally.** D5's fractions were measured against
 * `LIVE_BOOK_GBP`, a declaration about the live account, not about whatever
 * balance the account this gate observes happens to hold. An earlier version
 * of this function set the ceiling unconditionally for every caller,
 * reasoning that it was harmless because `DEFAULT_UNIVERSE` carries no
 * subclasses today — but the moment a universe IS classified (C1's LSE-ETP
 * pool file, #703), that reasoning inverts: `paperStartingProfile` runs
 * against Alpaca's simulated ~$100,000 balance, ~100x `LIVE_BOOK_GBP`, so an
 * unconditional ceiling would REFUSE every classified paper entry, forever —
 * failing closed and silently blocking the very soak (#238) live money is
 * gated on. Threading the book through as a parameter, supplied only by
 * `liveStartingProfile` (live-profile.ts), keeps the fix scoped to the
 * account it is actually a statement about. `buildStartingProfileConfigs` is
 * still the one shared builder (a copy would drift) — only the book argument
 * differs between the two callers, the same way the capital ceiling already
 * does.
 *
 * A fixture in `per-subclass-deployment-cap.test.ts` that builds a bare
 * `SubclassDeploymentCap` by hand gets no ceiling either, and resolves
 * against raw `portfolio.equity` exactly as before.
 */
export function d5EnvelopeFor(
  universe: readonly UniverseInstrument[],
  /**
   * The declared book this envelope's fractions resolve against, in GBP —
   * `LIVE_BOOK_GBP` for the live profile, `undefined` for paper (and for
   * backtest/tests that build no book at all). `undefined` means "no ceiling
   * at all": the fraction resolves against raw `portfolio.equity`, same as
   * before #888.
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
 * `breakerConfig.volatility.baseline` is an **absolute ATR reading in price
 * units**, not a ratio: `MarketDataVolatilityReadingProvider` aggregates
 * `marketData.getIndicator(instrument, atr(14), now)` per asset class, and ATR
 * is denominated in the instrument's own currency. A BTC-USD hourly ATR is
 * therefore a number in the hundreds of dollars, while an equity's is a couple
 * of dollars — one baseline genuinely cannot serve both, and no value in the
 * repo has ever been observed against a live feed.
 *
 * `UNSOURCED`, and worse: *unobservable* until a paper run produces ATR
 * samples. So this is set deliberately high enough to be **inert**, and that
 * choice is the conservative one here rather than the reckless one:
 *
 * - The failure mode of a too-LOW baseline is that the volatility tier trips
 *   on tick 1 and halts every entry for the whole run. A run that boots and
 *   then trades nothing is "indistinguishable at a glance from a clean run
 *   that decided not to trade" (`SMOKE_TEST_UNIVERSE`'s doc comment) — it
 *   would burn the soak window and produce no observations to tune with.
 * - The failure mode of a too-HIGH baseline is that one *soft* entry halt is
 *   inert on paper money, while the tiers that actually bound loss (hard
 *   drawdown, daily loss, consecutive losses) and the notional caps all stay
 *   live.
 *
 * Finite on purpose. `MarketDataVolatilityReadingProvider` folds a failed or
 * non-finite indicator read in as `Infinity` so a flaky instrument trips the
 * breaker conservatively; a baseline of `Infinity` — or one large enough that
 * `baseline * multiplier` overflows to `Infinity` — would make that sentinel's
 * `reading > baseline * multiplier` comparison false and silently disable the
 * fail-closed path. This value leaves ~4 orders of magnitude of headroom.
 *
 * **First thing to replace with real data.** A paper run's ATR distribution
 * makes this a calibrated number instead of a placeholder — and since #381
 * widened the universe to `DEFAULT_UNIVERSE`, a soak finally produces the
 * STOCKS half of that distribution too. Until now the equity baseline was not
 * merely uncalibrated but unmeasurable: with no stock in the universe,
 * `MarketDataVolatilityReadingProvider` had no instrument to aggregate and
 * warned that the breaker read 0 (inert) for the class on every start. That
 * warning is gone, and the tier is now genuinely armed for both classes —
 * still inert at this baseline, but inert by CHOICE rather than by absence.
 *
 * ## The gap this note used to describe, now CLOSED
 *
 * [#386](https://github.com/dd-jp/samurai-trading-system/issues/386): the
 * equity ATR read used to THROW while the US session was shut, and for roughly
 * the first three hours after the open — `atr(14) needs 15 bars but received
 * 12`, because the bar-count guarantee was enforced on the RAW wire payload
 * and normalization then dropped the out-of-session bars. See
 * `NormalizingDataSource.fetchBars` for the mechanism. What it cost THIS
 * profile: overnight the soft `volatility_halt:stocks` tier was armed for ~16
 * hours a day and four `error` lines were logged per tick, ~5,700 a day.
 *
 * Fixed in two halves, both #386, and note which one carries the correctness:
 * `NormalizingDataSource.fetchBars` now enforces the count on the COMPLETED,
 * IN-SESSION bars — widening the raw request until it holds, or throwing
 * `InSessionUnderfetchError` — and `MarketDataVolatilityReadingProvider` no
 * longer reads a class whose venue is shut. The second removes the overnight
 * noise; only the first fixes the Trader's near-open sizing, which reads the
 * same ATR DURING the session where no calendar gate can help it.
 *
 * Not fixed under #381 deliberately: the broken guarantee was a
 * market-data-service contract with its own test surface, and that ticket's
 * scope was the profile's dials and the universe. Guessing at a bar-count
 * contract from inside a config file is how a risk gate ends up wrong.
 */
const UNCALIBRATED_VOLATILITY_BASELINE = 1_000_000;

/**
 * The analyst-weight band (#366).
 *
 * `DERIVED`, and the derivation is `impliedWeight`'s (feedback-loop/attribution.ts):
 * a cycle's target is `midpoint + halfBand * tanh(meanCredit)`, so the band's
 * MIDPOINT is what an analyst with a genuinely even record is pulled toward.
 * Centring the band on 1.0 is therefore the only choice under which "no
 * evidence either way" means "no re-weighting" — a weight is a multiplier, and
 * a band of, say, `[0.1, 0.9]` would quietly drag every analyst toward 0.5 on
 * an even record and call it attribution.
 *
 * Half a multiple either side satisfies the spec's two-sided bound directly
 * (story 4: no analyst "swings wildly, drops to zero permanently, or
 * dominates") — the worst-performing lens keeps half its say, the best gets
 * half again, and neither can be silenced or take over.
 */
const PAPER_ANALYST_WEIGHT_FLOOR = 0.5;
const PAPER_ANALYST_WEIGHT_CEILING = 1.5;

/**
 * How many consecutive daily cycles it must take to move a weight across the
 * whole band — the number `weights.max_step` is derived from, rather than a
 * step size chosen first and rationalised after.
 *
 * `DERIVED` from the soak window: 20 > the 14 days of #238, so no soak-length
 * run can produce a weight trajectory decided by its first few trades. Stated
 * as a count of cycles because that is the property spec story 4 is about
 * ("no analyst swings wildly"); the step size is the arithmetic consequence.
 */
const PAPER_ANALYST_WEIGHT_TRAVERSE_CYCLES = 20;

/**
 * `FeedbackConfig` for the paper soak (#366) — Stage 6's starting values, in
 * the same file and under the same convention as the other eight.
 *
 * ## What actually moves during a soak, and what does not
 *
 * Being precise about this matters more here than anywhere else in the file,
 * because #366 exists to stop the Feedback Loop *looking* alive while learning
 * nothing. With this block wired, the daily cycle runs, but only one of its
 * three dials has a populated store behind it today:
 *
 * - **Analyst weights** — attribution's own dial, and the one that now moves
 *   (#371). `runDailyCycle` steps only analysts that already have an
 *   `analyst_weights` row ("seeding it is the weight store's job, not a tuning
 *   cycle's", daily-cycle.ts); the composition root seeds one neutral row per
 *   analyst it builds at startup (`seedAnalystWeights`, called from
 *   production.ts), idempotently, so a soak restart cannot flatten what the
 *   loop has learned. With that row present the cycle reads real closed trades
 *   and real debate rows (#364 gave `debate_log` a writer), attributes them,
 *   and steps the weight — recorded in `dial_adjustments` as an
 *   `analyst_weight` row. What still does NOT happen is anything reading those
 *   weights at debate time.
 *
 *   That used to be recorded here as a settled decision. It no longer is:
 *   David resolved #377 on 2026-08-06 the other way — the Debate Engine
 *   SHOULD read `analyst_weights` — and debate-engine-spec.md now carries a
 *   "Module: Weighted Debates" section saying so. The reader is #435, still
 *   open, deliberately: attribution runs over near-empty samples, so weights
 *   barely leave their seeds across a whole soak, and a mechanism fed noise is
 *   indistinguishable from one that works (#430). So this is a KNOWN GAP
 *   awaiting a cadence that produces trades, not a decision that weights are
 *   unread by design. See the `weights` dial below for what does move them.
 *
 *   Note the tick cadence is NOT the lever here, and reading it as one was the
 *   error #617 exposed. Debates are keyed to 1h bars, so the sample size that
 *   starves attribution is set by the bar and the trade count, not by τ —
 *   stepping 15 min -> 2 min (#670) produces exactly as many debates as before.
 *   What starves it is #625's ceiling: 96 debates, 0 trades.
 * - **Strategy params / risk thresholds** — moved only by `proposals`, and the
 *   profile supplies none, because nothing in the repo produces one. See the
 *   two empty records below for why they are empty rather than pre-declared.
 *
 * What #366 does buy immediately is that the timer runs, the cycle is
 * exercised daily against real data, and every dial's bounds are now checked in
 * and reviewable rather than absent. That is the difference between a stage
 * that is wired and idle and a stage that does not exist.
 *
 * `computeMetrics` is no longer the exception either — see `buildDailyMetrics`
 * (#379) for what arming it does and does not mean during a soak.
 */
function buildFeedbackConfig(caps: typeof RISK_CAP_EQUITY_FRACTIONS): FeedbackConfig {
  /**
   * `DERIVED` from `DEFAULT_FEEDBACK_INTERVAL_MS` (24h), which is why it is
   * written as a multiple of it: two cadences, not "48 hours".
   *
   * Longer than the cadence on purpose, and this is the one value here whose
   * failure mode is silent data loss. The cycle attributes `(now − window,
   * now]` (daily-cycle.ts), and its timer is a plain `setInterval` started at
   * process start — so a restart re-phases the schedule. With `window ===
   * interval`, a process restarted 5h into a cycle leaves a 5h hole that no
   * later cycle ever covers: those trades are never attributed to anyone. A
   * two-cadence window absorbs a re-phasing of up to one full cadence, which
   * is every single-restart case.
   *
   * It does NOT fix the neighbouring problem, and this value should not be
   * read as claiming to: `setInterval` fires no cycle at t=0, so a process
   * that restarts more often than once a day never completes a cycle at all,
   * and no window length changes that. Widening the window is the wrong lever
   * for it — an immediate-first-run or a persisted last-cycle timestamp is the
   * right one, and neither exists yet.
   *
   * Overlap is safe, which is what makes the trade one-sided: attribution
   * computes a TARGET from the window's mean credit and steps toward it
   * (`impliedWeight`), it does not accumulate an increment — so re-reading
   * yesterday's trades today is a two-day rolling average, not double-counting.
   * The 14-day soak's low trade count (#238, `SMOKE_TEST_UNIVERSE` is BTC-USD
   * alone) argues the same way: a 24h window would be empty on most days.
   */
  const attribution_window_ms = 2 * DEFAULT_FEEDBACK_INTERVAL_MS;

  /**
   * ## Who reads these weights — a decision, recorded (#371)
   *
   * **Nothing applies an analyst weight at debate time, and this ticket
   * deliberately did not add it.** The loop seeds, attributes, steps, bounds
   * and audits the dial; the number is real and it moves. It just has no
   * consumer in the decision path yet, and the dashboard's display is the only
   * place it is read.
   *
   * That is a gap against feedback-loop-spec.md story 5 ("As the Debate
   * Engine, I want to read the updated weights when applying them
   * downstream"). It is stated here rather than quietly closed with an
   * invented mechanism — but the gap is TWO questions with two different
   * statuses, and they must not be blurred into one:
   *
   * 1. **The transport is DECIDED and unbuilt.** analysts-spec.md story 27 and
   *    its "Decision: analysts are stateless per tick (from #42)" say the
   *    orchestrator "reads the weights map at tick start and passes it through
   *    in `AnalystRunResult.weights`", analysts staying weight-blind;
   *    feedback-loop-spec.md's cross-spec note even asserts it as done
   *    ("Analyst weights already follow this pattern — orchestrator reads at
   *    tick start, #42"). It is not done: `AnalystRunResult` has no `weights`
   *    field (analysts/types.ts records this), and `AnalystOrchestrator` never
   *    touches the tuning store. A REAL, spec-pinned gap, and this file is not
   *    where it is closed.
   * 2. **The application is UNDECIDED.** debate-engine-spec.md lists "Weighted
   *    debates (some analysts have more influence based on track record)"
   *    under **Future Extensions — not in this spec**, and its scope section
   *    says the Debate Engine "provides the data (per-analyst contributions,
   *    influence scores) that enables weight adjustment, but the adjustment
   *    logic itself is out of scope". No round-orchestration rule, conviction
   *    formula or mediator step takes a weight as an input anywhere in it.
   *
   * (2) is why (1) was left alone here rather than built as the pass-through
   * it is specified as. Scaling an analyst's `confidence`, weighting a vote
   * count at termination, biasing the mediator's prompt and scaling
   * `influence_score` are four different trading systems, and each changes the
   * direction and size of real orders from the day it ships; a guessed
   * mechanism distorting every debate of a 14-day soak — where its effect is
   * indistinguishable from the market's — is worse than an honest gap, the
   * same standard #327 and #366 were held to. And shipping the pipe alone
   * moves the dead end one stage along: a `weights` field nothing applies,
   * plus a store read on every tick, is the "wired and learning nothing" shape
   * this ticket exists to stop repeating.
   *
   * What the soak now produces is exactly what deciding (2) needs: which
   * analyst the loop promotes or demotes, by how much, and off which trades.
   * That decision is a wayfinder one (CLAUDE.md Standing Pipeline Rule 1)
   * against a debate-engine map + spec amendment; (1) then follows it in the
   * same change, which is the point at which the transport earns its keep.
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
   * A guardrail band for one notional cap (#433), expressed relative to the
   * FRACTION this profile ships (#886 — `shipped` is one of
   * `RISK_CAP_EQUITY_FRACTIONS`'s values, not a cash figure derived from an
   * anchor). Since every profile now ships the identical fractions — paper
   * and live no longer diverge on an anchor vs. a declared ceiling — the band
   * is the same in both, which was not true before #886.
   *
   * `ceiling` is the shipped value itself, and that asymmetry is the safety
   * posture, not an oversight: a kill-line breach may tighten a cap far below
   * what the profile chose, and a loosening `TuningProposal` — bounded by
   * `max_step`, clamped to `[floor, ceiling]` — could walk it back up to —
   * never past — the value a human already reviewed here. That path has no
   * producer today (see the empty `strategy_params` declaration below for
   * why), so the walk-back is a capability the dial reserves, not a
   * mechanism running now. Loosening beyond the checked-in profile is a
   * config change, not a tuning step.
   *
   * `floor` at a quarter keeps the dial from tightening to zero: a cap of 0
   * rejects every intent, which is indistinguishable from a broken pipeline
   * and is the wrong way for a *tuning* mechanism to stop trading. Nobody
   * owns a kill/rework call on the breach alert; killing the run has no
   * primitive here at all.
   */
  function capDial(shipped: number): TunableDial {
    return {
      // A tenth of the shipped cap, so a full ceiling-to-floor traverse needs
      // at least 7.5 consecutive breaching cycles. Same reasoning as `weights`:
      // no dial may be dominated by the first few days of a soak.
      max_step: PAPER_RISK_THRESHOLD_STEP_FRACTION * shipped,
      floor: PAPER_RISK_THRESHOLD_FLOOR_FRACTION * shipped,
      ceiling: shipped,
      tighten_is: 'decrease',
    };
  }

  return {
    attribution_window_ms,
    weights,
    /*
     * `shadow_credit` / `shadow_influence_ceiling` are gone (#370). Both were
     * `influence_score` compensation knobs, and attribution no longer reads
     * `influence_score`: a stance-CHANGE metric that scores 0 for an analyst
     * that never shifted — the common case — was weighting every analyst by a
     * constant, with shadow credit quietly carrying the whole signal at a
     * tenth of its magnitude. Credit is now correctness alone.
     */
    /**
     * `DERIVED` — empty, and empty is a decision rather than an omission.
     *
     * A dial here is consulted for exactly one thing: routing a
     * `TuningProposal`. Nothing in the repo produces one (the only proposer
     * the spec names is #93's defensive auto-tighten, which is
     * `computeMetrics`' own path and does not go through `proposals`), and
     * this profile supplies none. `strategy_params` is also unwritten by any
     * component, so a declared dial would find no current value to step from.
     *
     * Pre-declaring bounds for plausible-sounding names would be worse than
     * useless: `runDailyCycle` throws on a proposal whose dial is undeclared
     * — "an unbounded dial cannot be tuned" — and that fail-loud is the
     * guardrail. Names invented here would silently satisfy it for a proposer
     * that has not been written, against a keyspace no writer has agreed to.
     */
    strategy_params: {},
    /**
     * `DERIVED` — empty, for `strategy_params`' reason plus one of its own.
     *
     * `computeMetrics`' `autoTighten` iterates THIS record on a kill-threshold
     * breach, so an empty one means a breach tightens nothing. Since #379
     * `computeMetrics` DOES run — but the `risk_thresholds` table still has no
     * writer, so `autoTighten` would skip every dial declared here as
     * `current === undefined` regardless. Declaring names against a store
     * nothing populates would buy an audit trail of no-ops.
     *
     * It remains the thing to fix first. The blocker is a naming
     * contract, not a number: the spec's own cross-spec note ("Consumers must
     * read live from the store") records that the Risk Manager still reads
     * static `RiskConfig`, so which `risk_thresholds` key corresponds to which
     * `RiskConfig` field has never been fixed by any writer. Guessing that
     * mapping here would put safety-limit bounds under keys nothing honours.
     */
    /**
     * `DERIVED` from `riskConfig`'s own caps — and no longer empty (#433).
     *
     * The blocker recorded here was a naming contract, not a number: nothing
     * had ever fixed which `risk_thresholds` key drives which `RiskConfig`
     * field, so declaring bounds "would put safety-limit bounds under keys
     * nothing honours". `RISK_THRESHOLD_KEYS` (server/pipeline/risk-manager/risk-thresholds.ts)
     * is that contract, the composition root seeds the table from these same
     * caps, and `RiskManagerImpl` reads them live at `evaluate()`. All three
     * ends now agree, so the dials are declarable.
     *
     * `caps` here is `RISK_CAP_EQUITY_FRACTIONS` itself (#886) — its keys are
     * `RISK_THRESHOLD_KEYS` verbatim, so a row this seeds and a row
     * `resolveRiskConfig` later reads name the same field with no lookup
     * between them. Bounds come from `capDial`, relative to the shipped
     * FRACTION rather than a cash figure — the same six fractions every
     * profile ships (paper and live no longer differ here, #886).
     */
    risk_thresholds: Object.fromEntries(
      Object.entries(caps).map(([name, shipped]) => [name, capDial(shipped)]),
    ),
    kill_thresholds: {
      /**
       * `SPEC` — feedback-loop-spec.md story 13 states the line literally
       * ("PBO > 0.05"), CONTEXT.md's overfitting note repeats it ("kill if PBO
       * > 0.05"), and `PboVerdict`'s own reject line in
       * cost-model-backtest/validation-types.ts is the same 0.05. This is FL's
       * copy of a number three places already agree on.
       */
      max_pbo: 0.05,
      /** `SPEC` — feedback-loop-spec.md story 13: "OOS/paper Sharpe < 0.5". */
      min_oos_sharpe: 0.5,
      /**
       * `SPEC`-adjacent — story 13 says "DSR insignificant" and leaves the
       * significance level to config. The Deflated Sharpe is a probability
       * that the observed Sharpe survives multiple-testing deflation, so
       * "insignificant" is the complement of a confidence level: 0.95 is the
       * conventional 5% one, and matches how DSR is reported in the
       * literature the validation library follows.
       */
      min_deflated_sharpe: 0.95,
      /**
       * `UNSOURCED` — story 13 names "live-vs-backtest divergence" without a
       * fraction. A FRACTIONAL DROP, not a Sharpe difference:
       * `liveBacktestDivergence` returns `(reference − live) / reference`
       * (feedback-loop/metrics.ts), so 0.5 breaches when live Sharpe has
       * halved against the frozen backtest reference. Halving is a defensible
       * reading of "the edge may be gone" and is well outside the sampling
       * noise of a short window, which a tighter line would sit inside.
       *
       * Inert for now regardless, and loudly so: the check needs
       * `metrics.backtest_reference_sharpe`, and #345 did NOT source it —
       * see #375. #345 sourced only the live half of the comparison
       * (`daily_equity`, ADR-0006); the frozen backtest baseline still has no
       * persisted record, because Stage 2 has never run against a real
       * strategy. `computeMetrics` records the line in `not_evaluated` and the
       * orchestrator warns once per process.
       */
      max_live_backtest_divergence: 0.5,
    },
  };
}

/**
 * The kill-line detector's input (#379) — what makes `computeMetrics` have a
 * production caller at all.
 *
 * ## The decision, and why it is taken here
 *
 * #345 (PR #378) built the daily equity series, `SqliteDailyEquityMetricsSource`
 * and the 60-observation gate, then deliberately left this unset: `autoTighten`
 * WRITES every risk threshold and appends to the `AdjustmentLog`, so arming a
 * detector deserved an explicit decision rather than arriving as a side effect
 * of a ticket about persistence. [#379](https://github.com/dd-jp/samurai-trading-system/issues/379)
 * is that decision, and it is to wire it.
 *
 * The reasoning is the pattern this repo keeps hitting — a fully-implemented,
 * fully-tested mechanism that nothing calls (#327 `computeMetrics`, #364
 * `debate_log`, #366 the daily cycle, #371 `analyst_weights`, #374
 * `enforceLatencyBudget`). Left unset, this is the sixth: the startup warn
 * would fire for the whole soak and every soak after it, and an operator would
 * correctly read the run as one where the kill-lines are dead.
 *
 * **The safety control is the gate, not the omission.** ADR-0006 §5 sets it at
 * 60 returns with a stated statistical argument (a near-flat account over 9
 * returns reports an annualized Sharpe of 20.9), and
 * `SqliteDailyEquityMetricsSource` refuses to have it lowered. That keeps every
 * kill-line inert for roughly a calendar quarter whether or not this is wired —
 * longer than any planned soak (#238) — so wiring it exercises the whole path
 * in production without acting on noise, which beats an unexercised path
 * someone arms later under time pressure. On paper money, an `autoTighten` after
 * a genuine 60-session drawdown is the system working.
 *
 * ## A factory, because this file holds no stores
 *
 * The source needs the shared SQLite handle and this function returns values.
 * `DailyMetricsSourceFactory` (production.ts) is the seam: the profile names
 * the class and the decision, the composition root — which owns the handle —
 * calls it once at construction and passes its own `ClosedTradeStore` in.
 */
function buildDailyMetrics(): DailyMetricsConfig {
  return {
    source: ({ db, trades, logger }) =>
      new SqliteDailyEquityMetricsSource({
        // The series this process samples every tick on the portfolio's UTC-day
        // boundary (ADR-0006 §2) — capture was already unconditional; this
        // reads it.
        equity: new SqliteDailyEquityStore(db),
        // The root's own instance, not a second one over the same handle.
        trades,
        logger,
        // `minReturnObservations` deliberately not overridden: the default IS
        // ADR-0006 §5's floor, and the class refuses anything lower. Raising it
        // toward 365 is the only defensible edit here, and it is one to make on
        // evidence rather than in advance.
      }),
    /**
     * `SPEC`-by-absence — 0, meaning INERT, and that is the whole point.
     *
     * `liveBacktestDivergence` refuses to manufacture a breach off a
     * non-positive reference, so `live_backtest_divergence_over_max` is never
     * evaluated; `computeMetrics` records it in `not_evaluated` and the
     * orchestrator warns about it once at startup.
     *
     * Left that way per [#375](https://github.com/dd-jp/samurai-trading-system/issues/375),
     * and this is NOT tidiness: there is no persisted backtest Sharpe to freeze
     * because Stage 2 has never run against a real strategy
     * (stage2-validation-execution-spec.md). A plausible-looking number here
     * would arm a detector that writes risk thresholds against a reference
     * nobody measured. The other three kill-lines are unaffected — they gate on
     * a revalidation snapshot, not on this.
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

/** Five minutes — see `rateLimiterConfig`'s comment for why not one. */
const LLM_BUDGET_WINDOW_MS = 300_000;

/**
 * Debates per window, per asset class. Named because `rateLimiterConfig`'s
 * `default` is computed from them (`Math.min`) rather than restating one of
 * them — see that field's comment. Crypto's is ~3x #385's measured cadence and
 * is unexercised (crypto left scope, ADR-0015's 2026-08-16 amendment).
 *
 * **Stocks raised 15 -> 24 when `DEFAULT_UNIVERSE` widened 3 -> 20 names.**
 * Not headroom-for-its-own-sake — the old value would have silently starved the
 * wider universe, and the failure is invisible in the metric an operator reads:
 *
 * - Debates are keyed to the BAR, not the tick (`DEBATE_BAR_TIMEFRAME_MS` = 1h,
 *   #617). So the first `tickIntervalMs` tick after each hourly close finds a
 *   fresh bar for EVERY instrument at once: the load is a burst of `N` debates,
 *   not a smooth rate.
 * - The burst completes inside one window. At #1013's width 6 and #1012's ~61s
 *   mean debate latency, 20 names walk in `ceil(20 / 6) = 4` groups, ~4.1 min —
 *   under `LLM_BUDGET_WINDOW_MS` (5 min), so all 20 reservations land in the
 *   same window rather than spreading across two.
 * - A refused reservation is DROPPED, not deferred. `buildDebateStep`
 *   (debate-adapter.ts) returns `rateLimitedDebateResult` and the tick
 *   short-circuits at Trader with `no_trade`; nothing re-queues it on the next
 *   tick, and the bar is gone by the next hour. At 15 the last 5 names of every
 *   burst would never debate — and would report as a quiet market, not as a
 *   misconfiguration. That adapter's own warn text names this: "persistent
 *   refusals mean rateLimiterConfig is sized under the universe's real debate
 *   rate, not that the market is quiet."
 *
 * So the floor is one full universe pass per window — 20, not 15. 24 carries
 * ~20% over that for the case where a straggler from the previous burst is
 * still inside the window when the next one opens. `maxLlmCalls` follows
 * automatically through `llmBudget()`, so the call budget needs no separate
 * edit. **Re-derive this against `DEFAULT_UNIVERSE.length` whenever the
 * universe changes; it is not a constant that tolerates being assumed.**
 *
 * This does NOT raise spend risk: `SqliteSpendCap` (ADR-0008's $50/14d) is the
 * dollar control and is untouched. The limiter bounds rate, not total.
 */
const CRYPTO_MAX_DEBATES_PER_WINDOW = 20;
const STOCKS_MAX_DEBATES_PER_WINDOW = 24;

/**
 * `maxConcurrentInstruments` (#1013) — see that field's comment, on the
 * returned profile below, for the full derivation. Named here so the number
 * is defined once, next to the budgets it is checked against.
 */
const MAX_CONCURRENT_INSTRUMENTS = 6;

/**
 * The eight required config objects, plus the optional ninth seam (#366).
 *
 * **No longer parameterised by an equity anchor or capital ceiling (#886).**
 * Before #886 this took one as its first argument and multiplied the six
 * notional caps against it once, here, at profile-build time — the paper
 * profile's assumed $100,000 balance, or the live profile's declared
 * ceiling. That is exactly the "frozen cash, computed once" shape #886
 * retired: the caps below are FRACTIONS now (`RISK_CAP_EQUITY_FRACTIONS`),
 * resolved against `portfolio.equity` at evaluate time
 * (`risk-manager/index.ts`), so this function no longer needs to know an
 * anchor to build them.
 *
 * **Exported for exactly one caller: `liveStartingProfile` (live-profile.ts,
 * #511).** The live profile is specified as "the same shape" — so it must be
 * the SAME builder, not a copy. A copy is how the two would silently
 * disagree about a dial the day either one is retuned, and the live one is
 * the copy nobody exercises.
 *
 * That sharing is also the honest statement of what a live run inherits:
 * every value here is inherited UNCHANGED and UNTUNED. See live-profile.ts's
 * header for the enumerated list.
 *
 * `paperStartingProfile(mode)` remains the paper entry point, so the live-mode
 * refusal there cannot be bypassed by importing the values, and each call gets
 * its own copy.
 */
export function buildStartingProfileConfigs(
  /**
   * The universe this profile's gates are keyed to AND the list the run ticks
   * — one argument, because they must not be two lists (#739).
   *
   * Parameterised rather than pinned so the ADR-0018 arming can be exercised
   * against a CLASSIFIED universe. With `DEFAULT_UNIVERSE` hardcoded, every
   * assertion that the classification reaches the Trader compares `{}` with
   * `{}` and passes whether or not the wiring exists at all — a tautology, and
   * this repo's dominant defect shape wearing a test.
   */
  universe: readonly UniverseInstrument[] = DEFAULT_UNIVERSE,
  /**
   * #888 — the declared book (GBP) D5's fractions resolve against once
   * equity drifts past it, passed through to `d5EnvelopeFor` unchanged.
   * `undefined` for paper (Alpaca's simulated balance is not the book);
   * `liveStartingProfile` (live-profile.ts) is the one caller that supplies
   * `LIVE_BOOK_GBP`. See `d5EnvelopeFor`'s docstring for why this is not
   * unconditional.
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
  // `Required`, not another `Pick` member: each of these is optional on
  // `ProductionConfig` (they have documented fallbacks for a programmatic
  // caller), but the profile's whole job is to leave nothing to a fallback
  // nobody chose — so the type says this profile always carries them.
  // `llmBudgetUsd` and `tickIntervalMs` joined `rateLimiterConfig` here under
  // ADR-0008: a soak that inherited the 60s default interval, or no ceiling at
  // all, would silently cost ~13x its budget.
  //
  // `stocksTradingWindow` joined them under #706 for the same reason and one
  // more: the fallback when it is absent is `?? true` (`scheduler.ts:74`) —
  // i.e. the whole LSE session, which is the OPPOSITE of the constraint. A
  // profile that dropped it would tick 08:00-16:30 and look healthy doing it.
  //
  // `maxConcurrentInstruments` joined them under #1013: the fallback when it
  // is absent is `?? 1` (`production.ts:2701`), which is what actually ran —
  // the universe walked one instrument at a time regardless of how many
  // workers `runTickPlan` could otherwise use. A profile that dropped it
  // would silently go back to serial, not to some documented default width.
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
  // ADR-0018 D5. The gate's classification and the list the run actually ticks
  // MUST be the same universe: a cap keyed to one list while another is traded
  // sizes unclassified names with no envelope, or throws on every entry.
  //
  // Naming `DEFAULT_UNIVERSE` twice — once here and once at the `universe` field
  // below — made that a convention held by matching identifiers. One parameter,
  // read by both, makes it hold by construction: the D5 gate's classification,
  // the Trader's `subclass_of` and the ticked list are the same list or none of
  // them are.
  const subclassCap = d5EnvelopeFor(universe, bookCeilingGbp);

  const traderConfig: TraderConfig = {
    // SPEC — `DEFAULT_TRADER_CONFIG` (server/pipeline/trader/types.ts) is the one set of
    // sizing constants already checked in and already justified against
    // docs/research/02-staged-deployment-plan.md ("half- or quarter-Kelly,
    // never full Kelly; quarter-Kelly or less in fat-tailed markets"):
    // `max_risk_per_trade: 0.01` with `asset_class_risk_multiplier.crypto:
    // 0.5` puts a crypto entry at 0.5% of equity at maximum conviction.
    // Spread by reference, never copied — a second copy of these numbers
    // would drift from the trader's own default the first time either moves.
    ...DEFAULT_TRADER_CONFIG,
    // ADR-0018 D3/D5 (#739) — the SAME classification the Risk Manager's D5
    // gate caps against, from the same universe and the same derivation, so
    // the stage that sizes a position and the stage that bounds it cannot
    // disagree about what subclass an instrument is. `DEFAULT_UNIVERSE`
    // declares no subclasses today, so this is empty and the frozen bracket is
    // unarmed until the LSE-ETP pool file (#703 C1) classifies its rows —
    // exactly the state `subclassCap` above is in, and for the same reason.
    subclass_of: subclassOfUniverse(universe),
    // #941 — ON here and OFF in `DEFAULT_TRADER_CONFIG`, which is the opposite
    // arrangement to `time_in_force` below, deliberately. Both are venue
    // constraints, but time-in-force is inert in simulation while flooring
    // changes the fill size, so a global default would silently move every
    // backtest and fixture result. The flag therefore lives with the profiles
    // that actually submit to a venue.
    //
    // Alpaca refuses a bracket at any fractional quantity and refuses a
    // fractional short outright; ADR-0018 D5 sizes by cash and so produces
    // fractional quantities for nearly every entry. Two of this soak's three
    // entries were rejected at submission before this was set. Safe for this
    // profile specifically because `DEFAULT_UNIVERSE` is equities-only since
    // ADR-0015's 2026-08-16 amendment — a crypto instrument ticked under this
    // flag would floor to zero and never trade. See the field's own comment.
    whole_share_sizing: true,
    // `time_in_force` is no longer overridden here (#381). It used to be
    // pinned to `gtc` for BTC-USD because the field was a single string and
    // the profile's universe was crypto-only; widening to `DEFAULT_UNIVERSE`
    // made that override actively wrong for the four equities, which need
    // `day`. The field is now per-asset-class on `TraderConfig` itself, and
    // `DEFAULT_TRADER_CONFIG` carries the correct value for BOTH classes —
    // so the venue constraint lives with the venue-shaped default rather
    // than being re-stated by every profile that happens to hold crypto.
  };

  const riskConfig: RiskConfig = {
    // UNSOURCED (all five caps) — risk-manager-spec.md "Out of Scope: Exact
    // limit values" refuses to pin them. Chosen as an ordered ladder of
    // equity fractions so that each cap in the pipeline can actually bind
    // (per-trade -> per-asset -> per-asset-class -> portfolio, spec "Check
    // Pipeline"), and so `binding_constraint` names the step an operator
    // would expect. Every one is well inside what an Alpaca paper account
    // could take, deliberately: the first run is testing wiring, not size.
    //
    // #886: read straight off `RISK_CAP_EQUITY_FRACTIONS` rather than a
    // `caps` object multiplied against an anchor here — the fraction IS the
    // value now, resolved against `portfolio.equity` at evaluate time.
    /** 5% of equity — the Trader's own 0.5-1% *risk* budget becomes a much larger *notional* once divided by a ~1-2% ATR stop, so this is the cap that actually binds first on BTC-USD. Skipped entirely for a D5-classified instrument (#886) — see the field's own doc comment. */
    max_position_size_fraction_of_equity:
      RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity,
    /** 10% — one instrument may hold at most two max-size entries' worth. Skipped entirely for a D5-classified instrument (#932, extending #886's ruling to this cap) — see the field's own doc comment. */
    per_asset_cap_fraction_of_equity: RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity,
    /**
     * 20% crypto / 40% stocks. Asymmetric for the same reason
     * `asset_class_risk_multiplier` is (docs/research/02-staged-deployment-plan.md:
     * quarter-Kelly or less in fat-tailed markets) — the crypto bucket is
     * held to half the equity share of the stock bucket.
     */
    per_asset_class_cap_fraction_of_equity: {
      crypto: RISK_CAP_EQUITY_FRACTIONS.per_asset_class_cap_fraction_of_equity_crypto,
      stocks: RISK_CAP_EQUITY_FRACTIONS.per_asset_class_cap_fraction_of_equity_stocks,
    },
    /**
     * 50% gross. DERIVED, not arbitrary: anything above 100% is leverage,
     * which nothing in the docs asks for on a first paper run, and half of
     * equity leaves the account able to absorb the full 20% drawdown limit
     * below without the caps and the breaker fighting each other.
     */
    portfolio_gross_cap_fraction_of_equity:
      RISK_CAP_EQUITY_FRACTIONS.portfolio_gross_cap_fraction_of_equity,
    concentration: {
      /**
       * DERIVED — equal to the crypto asset-class cap: a cluster of
       * mutually-correlated instruments should not be able to exceed what a
       * single asset class may hold, which is the whole point of the check
       * (risk-manager-spec.md step 6).
       */
      cap_fraction_of_equity: RISK_CAP_EQUITY_FRACTIONS.concentration_cap_fraction_of_equity,
      /**
       * UNSOURCED — 0.7 is the conventional |r| boundary for "strongly
       * correlated". **No longer inert (#381):** it was dead only because the
       * check needs at least one *other* held instrument and the universe
       * held one. `DEFAULT_UNIVERSE` makes it load-bearing, and it will bind
       * — SPY/QQQ are routinely correlated well above 0.7, as are BTC-USD and
       * ETH-USD, so the concentration `cap` below is now a cap two clusters
       * can actually reach. That is the intended behaviour, not a regression:
       * a portfolio that is four ways long the same beta is the thing the
       * check exists to notice. Still cheap to start strict and loosen on
       * evidence.
       */
      threshold: 0.7,
    },
    /**
     * DERIVED — matched to `traderConfig.min_viable_notional` (10). These are
     * the same floor viewed from two stages; if Risk's were the higher of the
     * two, every intent the Trader considered viable would be trimmed to fit
     * a cap and then hard-rejected as dust, and the run would boot and never
     * trade. Also above Alpaca's ~$10 crypto order minimum.
     */
    min_viable_size: DEFAULT_TRADER_CONFIG.min_viable_notional,
    // Same venue constraint as traderConfig.whole_share_sizing, at the second
    // site that sets a size (#941): the cap gates trim a notional and re-derive
    // the quantity, so a whole-share entry comes back fractional if any gate binds.
    whole_share_sizing: true,
    /**
     * UNSOURCED — risk-manager-spec.md calls the CII threshold "an unpinned
     * config value, tuned in paper trading". 70 on WorldMonitor's 0-100
     * country-instability scale. Inert during paper trading regardless: the
     * composition root defaults to `ParkedCiiScoreProvider`, which always
     * answers `null` (ADR-0002 — live wiring parked for cost), so no score is
     * ever compared against this. The signal is advisory-only in v1 and can
     * never change a decision (spec "CII Soft Signal").
     */
    cii_threshold: 70,
    /**
     * UNSOURCED (milliseconds) — the bound past which `computePortfolioView`
     * refuses to value a held position at all (#640).
     *
     * **Set to the same two numbers as `verdictConfig.max_mark_age`, in a
     * separate field on purpose.** They answer different questions and will
     * diverge the moment either has real data behind it: Verdict's bound
     * decides whether to place ONE order, this one decides whether the system
     * can compute its own exposure. The second failure is strictly worse — a
     * stale valuation freezes the drawdown and daily-loss breakers at their
     * last reading, so the mechanism meant to stop a bad run stops updating
     * during exactly the conditions that produce one.
     *
     * A shared constant was rejected for that reason: it would make the two
     * bounds look interchangeable and invite someone loosening the trading
     * gate to loosen the valuation gate with it. Same starting values, two
     * dials, and the soak's observed mark-age distribution is what separates
     * them.
     *
     * `crypto` is dead weight, not a live bound: crypto left Samurai's scope
     * entirely (ADR-0015's 2026-08-16 amendment), so no crypto position is
     * ever valued against it. Kept only because `RiskConfig.max_mark_age` is
     * typed `Record<'crypto' | 'stocks', number>` — the key stays required
     * whether or not the value means anything.
     */
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    /**
     * SPEC (ADR-0018 D5) — the deployment envelope, armed off the universe.
     *
     * Conditionally spread rather than set to `undefined`, under
     * `exactOptionalPropertyTypes` and matching the `capitalCeilingUsd` idiom
     * at production.ts. On `DEFAULT_UNIVERSE` this is OMITTED: no instrument
     * carries a subclass yet, because ADR-0018 prices leveraged ETPs and the
     * default universe is SPY/QQQ/AAPL/TSLA/BTC/ETH. It arms itself the moment
     * C1's pool file supplies one.
     *
     * **The `per_trade_size_cap`-vs-D5 conflict this comment used to record
     * here is retired by #886, not merely re-scaled.** Before #886,
     * `max_position_size` was 5% of whatever anchor a profile declared,
     * always tighter than D5's 35%/25%, so `per_trade_size_cap` trimmed a
     * classified instrument first every time regardless of anchor — the
     * finding #886 (née #885) was filed over. `per_trade_size_cap` now skips
     * a D5-classified instrument entirely
     * (`isD5ArmedWithNumericFraction`, risk-manager/index.ts), so once this
     * arms, D5's own fraction sizes the position, not the generic cap.
     *
     * **#886 alone did not close this — #932 finished it.** #886's own
     * acceptance-criteria test, written at a realistic (not full-envelope)
     * ask size, surfaced that `per_asset_cap_fraction_of_equity` (10%) was
     * NOT exempted and is tighter than both D5 fractions (35% index / 25%
     * single-stock), so a full-envelope D5 ask still trimmed at the
     * asset-exposure gate even after #886 shipped. #932 extends the same
     * exemption to `per_asset_cap` — D5 is now the sole per-instrument
     * drawdown authority for a classified instrument on both axes. See
     * `d5-trader-cap-agreement.test.ts`'s "#886 fixed per_trade_size_cap for
     * D5 instruments; #932 fixed per_asset_cap" describe block for the test
     * that pins this.
     */
    ...(subclassCap === undefined ? {} : { per_subclass_deployment_cap: subclassCap }),
    /**
     * #888 review fix-up — armed whenever a book is supplied, WITHOUT
     * depending on `subclassCap`/universe classification at all. This is
     * what makes the account-level refusal work on `DEFAULT_UNIVERSE`
     * (no subclasses yet, so `subclassCap` above is `undefined` on the
     * actual shipped live path) — see `RiskConfig['live_book_ceiling']`'s
     * doc comment (risk-manager/types.ts) for why the per-subclass
     * `equity_ceiling` alone does not arm here.
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
    /**
     * DECIDED (David, 2026-08-06) — `auto` for both classes, in **paper and
     * live**. See ADR-0007. This deliberately overrides verdict-spec.md's
     * "Notes & Rationale" staging ("start `manual` ..., then `auto` once live
     * KPIs hold"); that sentence has been amended rather than left to
     * contradict this value.
     *
     * **The reason was throughput when this was written, and the width has
     * since moved — the conclusion has not.** `runTickPlan` ran instruments at
     * `max_concurrent_instruments`, which was `1` at the time ADR-0007 argued
     * this; #1013 set it to `6` explicitly (paper and live both — see that
     * field's comment below), and `VerdictImpl.decide` *awaits*
     * `approvals.requestApproval` inside the instrument pass. At width 1 a
     * single pending approval blocked EVERY other instrument for up to
     * `human_timeout`; at width 6 it blocks only the one worker holding that
     * instrument's pass, not the whole universe — the throughput argument as
     * ADR-0007 originally stated it is weaker than it was. **It is moot in
     * practice, not merely weaker**, because `automation_level` below is
     * `auto` for both classes: `shouldEngageHitl` short-circuits to `false`
     * before `isFlagged` is ever consulted, so `approvals.requestApproval` is
     * never reached at either width, and the human-approval gate cannot block
     * anything, one instrument or six. A human in this loop is a serialization
     * point, not a safety net — that framing survives the width change even
     * though the specific "blocks every other instrument" arithmetic no
     * longer does.
     *
     * **What this removes, stated plainly.** The HITL gate (6) is now
     * unreachable: the dial short-circuits `shouldEngageHitl` to `false`
     * before `isFlagged` is consulted, so no trade is ever routed to a
     * human, and `ProductionConfig.approvals` is never called.
     * `flag_thresholds` and `human_timeout` below are inert by
     * construction — kept, with the flag plumbing, so that turning the dial
     * back is a config edit rather than a re-implementation.
     *
     * **What must therefore hold before LIVE capital, and does not yet.** With
     * no human gate the circuit breakers and the notional caps are the *only*
     * stop.
     *
     * **No list of open bug numbers belongs here.** One lived here and went
     * stale unnoticed; a checkable claim that is wrong is worse than none,
     * because the next reader trusts it. `live-money-gates.ts` is the single
     * dated list, rendered by `paperStartingProfile`'s live refusal — the one
     * place an operator reads before going live.
     *
     * The reason that does not go stale, and why this dial is safe on paper and
     * not on real money: no 14-day soak (#238) has run, so every `UNSOURCED`
     * value above is still a guess, and a guessed cap with no human gate behind
     * it is the only thing standing between a bad debate and the account.
     */
    automation_level: { crypto: 'auto', stocks: 'auto' },
    /**
     * UNSOURCED (milliseconds; spec puts exact thresholds out of scope).
     *
     * Sized against the right clock, which is the trap here — and **this note
     * was left stale by #616 and is corrected here (#687)**. It used to read:
     * "`decision_timestamp` is `mark.observed_at` (trader/decide.ts) — the
     * *quote's own* timestamp, deliberately not `clock.now()` … It is
     * emphatically NOT the ATR bar's close time: were it, a 5-minute bound
     * under a `'1h'` `atr_timeframe` would no-go every trade on staleness
     * forever."
     *
     * `decision_timestamp` has NOT been the quote timestamp since #616. It is
     * the DECISION BAR — floored onto `DEBATE_BAR_TIMEFRAME_MS` (1h), which is
     * what made the idempotency key stable within a bar — and since #687 it is
     * the debate's bar, inherited rather than re-floored. So the sentence above
     * describes the hazard correctly and then denies it applies: the
     * `staleness` gate (1) now measures how far into the BAR the tick is, not
     * how old the quote is. At a
     * 15-minute cadence a crypto tick at bar+15/30/45 already reads 15/30/45
     * minutes of "signal age" against a 5-minute bound.
     *
     * The values below are deliberately NOT changed here — re-sizing a live
     * gate is a product decision, not a side effect of a keying fix — but they
     * are no longer measuring what this note said they measured, and #687's PR
     * files that separately. After #687 a straddling intent can also carry a
     * `decision_timestamp` a full bar behind, which this gate refuses; refusing
     * a late intent is the fail-safe direction and is the intended outcome.
     *
     * 5 min crypto / 15 min stocks, with several tick intervals
     * (`DEFAULT_TICK_INTERVAL_MS`, 60s) of headroom either way. The asymmetry
     * is the same one every other per-asset-class knob here carries: crypto
     * re-prices 24/7, equities move in session structure — and an equity mark
     * is "legitimately old when the session is shut"
     * (`NormalizingDataSource.fetchMark`), which the market-open gate catches
     * first anyway.
     *
     * ## The market-open interaction, re-checked (#381)
     *
     * The earlier note here said widening to equities "should re-check that
     * interaction rather than assume it". Done, and the assumption was WRONG
     * in its ordering while right in its safety:
     *
     * - **Nothing is waved through.** The `staleness` gate (1) runs *before*
     *   the `market_closed` gate (4) (market-open), so when both would fire —
     *   an equity signal decided in yesterday's session, evaluated against a
     *   shut market — the staleness bound is what rejects it, at ~17 hours
     *   against a 15-minute bound. The market-open gate never gets the
     *   chance to be the one that catches it. Both answers are `no_go`; only
     *   the recorded `no_go_reason` differs.
     * - **So the reason code is the thing to read carefully in a soak log,**
     *   and it is pinned by test rather than left to be rediscovered:
     *   `market_closed` appears only for the narrow case where the mark is
     *   FRESH but the session shut between the decision and the gate — a tick
     *   that started at 15:59 ET and reached Verdict after the close. That is
     *   the case the `market_closed` gate (4) uniquely catches, and it is
     *   the case that matters, because a fresh mark is exactly the input a
     *   staleness bound cannot reject.
     * - **15 minutes is not tight against the pipeline that produces the
     *   signal.** `LATENCY_BUDGET_MS.stocks` bounds one debate at 60s, and
     *   `decision_timestamp` is the quote's `observed_at`, not the tick start
     *   — so the budget, not the bound, is what a slow equity debate hits
     *   first. The headroom is roughly an order of magnitude.
     *
     * `UniverseScheduler` is what keeps this rare rather than routine: stock
     * instruments are filtered out of the `TickPlan` entirely while the
     * calendar reports the session shut, so an equity mark is not normally
     * fetched during a closed session at all.
     */
    max_signal_age: { crypto: 5 * 60_000, stocks: 15 * 60_000 },
    /**
     * UNSOURCED (milliseconds) — the FEED-staleness bound (#641), i.e. how
     * long ago the market last printed, as distinct from `max_signal_age`
     * above, which bounds how long ago we decided.
     *
     * **Crypto: 2 minutes.** Crypto prints continuously on a venue that never
     * closes, so silence is anomalous rather than structural. Set below the
     * 5-minute signal bound on purpose: a crypto decision may legitimately be
     * up to 5 minutes old, but the price it is judged against should not be —
     * and the pass's own mark is re-fetched at gate time, so a fresh fetch
     * that comes back 2 minutes stale means the source itself is behind.
     *
     * **Stocks: 15 minutes**, matching the signal bound rather than sitting
     * under it, and that asymmetry is deliberate. ADR-0016's LSE leveraged
     * ETPs are thin: a genuine multi-minute gap between prints inside a live
     * session is normal for them, not a fault. A tight equity bound would
     * therefore no-go on ordinary illiquidity and read, in a soak log, as a
     * broken feed — the failure mode that makes an operator stop trusting the
     * gate. Set wide enough that firing means something is actually wrong,
     * because the case this must catch is not "thin" but "stopped": a halted
     * or delisted name whose last trade keeps being served indefinitely.
     *
     * Both numbers are first-soak starting points and both are UNSOURCED in
     * the strict sense — no measurement in this repo bounds inter-print gaps
     * on the live universe. The soak produces exactly that data: the honest
     * way to set these is to log observed mark ages for a fortnight and read
     * the tail off the distribution. Until then they are set to fire on
     * "stopped", not on "thin", which is the conservative direction for a
     * gate whose false positives halt trading.
     *
     * `crypto` above describes a venue Samurai no longer trades: it left
     * scope entirely (ADR-0015's 2026-08-16 amendment). The key stays only
     * because `VerdictConfig.max_mark_age` is typed
     * `Record<'crypto' | 'stocks', number>`, and no crypto order can reach
     * this gate to read it.
     */
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    /**
     * UNSOURCED, and formerly "the value most likely to be wrong" — the
     * absolute `drift_tolerance: 500`, sized for a six-figure BTC-USD and
     * equal to 250% of a $200 equity, i.e. a staleness gate that could never
     * fire on a stock. #381 replaced the field rather than the number; see
     * `VerdictConfig.drift_tolerance_pct` for why fractional beat
     * per-asset-class absolutes and why the name changed.
     *
     * **0.5% for crypto is a re-expression, not a re-guess.** It is what the
     * checked-in 500 evaluated to at a ~$100,000 BTC-USD, so the one
     * instrument with any paper history at all keeps the calibration it was
     * given — and now keeps it as BTC's price moves, which the absolute
     * form did not (500 is 0.5% at $100k and 0.25% at $200k, silently
     * tightening the gate as the market rose).
     *
     * **Stocks starts equal to crypto deliberately, and that is the honest
     * answer rather than a lazy one.** There is no equity observation in the
     * repo to derive a second number from, and inventing one would be exactly
     * the guessed risk gate this ticket exists to remove. What the
     * per-asset-class SHAPE buys is that separating them later is a value
     * edit rather than another type change — and there is a real reason to
     * expect them to separate: tolerable drift pairs with the staleness
     * window behind it, and `max_signal_age` already runs 5 min crypto
     * against 15 min stocks, so an equity bracket is allowed to be three
     * times older before it is judged. First thing to re-derive from soak
     * data, alongside the volatility baseline.
     *
     * Sanity check on the magnitude in both directions, since neither is
     * sourced: 0.5% is roughly 6x a minute's typical move in either class
     * (S&P names and BTC-USD land within a factor of two of each other at
     * per-minute horizon), so it is wide enough not to no-go every tick, and
     * far tighter than the moves that make a bracket genuinely stale.
     */
    drift_tolerance_pct: { crypto: 0.005, stocks: 0.005 },
    /**
     * UNSOURCED (milliseconds). Inert today: ADR-0007's `auto` automation dial
     * short-circuits Verdict's HITL gate (6) before this value is ever read,
     * for every asset class. It becomes load-bearing only if the dial is
     * turned back to `manual`/`semi_auto` with a real approval channel wired
     * (#275's remaining half — #322 wired the outbound alerts only). 15 min
     * is a coffee-break response window, and the gate is fail-safe either
     * way — verdict-spec.md "Timeout -> no-go".
     */
    human_timeout: 15 * 60_000,
    /**
     * DERIVED — `false` is the conservative side of a gate that only applies
     * to stocks. It stops being hypothetical with `DEFAULT_UNIVERSE` (#381):
     * four equities now reach the `market_closed` gate (4), and `false` is
     * what makes `tradingCalendar.isOpen(now)` authoritative for them.
     * Extended-hours liquidity is exactly the regime the cost model is
     * least calibrated for.
     */
    allow_extended_hours: false,
    flag_thresholds: {
      /**
       * DERIVED — `size_over` is compared against `order.size` in
       * *instrument units* (verdict/index.ts), which is unit-incommensurable
       * across BTC and AAPL, so no single meaningful number exists. `0` flags
       * every positive size, which is both unit-independent and consistent
       * with `automation_level: 'manual'` (under which flags are not consulted
       * at all — every trade is gated regardless). It only starts to matter
       * if the dial is turned to `semi_auto`, at which point it must be set
       * deliberately rather than inherited from here.
       *
       * **Re-confirmed inert after widening the universe (#381), and left
       * that way on purpose.** The incommensurability got worse, not better —
       * one `order.size` threshold now spans fractional BTC-USD and
       * whole-share SPY — but the widening does not make it reachable:
       * `shouldEngageHitl` short-circuits on `automation_level === 'manual'`
       * *before* `isFlagged` is called, for both classes. Making it
       * "meaningful" would mean inventing per-asset-class *notional* bounds
       * for a routing decision no run can currently take, so the correct move
       * is to leave it visibly inert and let the `semi_auto` change that
       * needs it be the change that sets it. Pinned by test so the
       * short-circuit cannot quietly stop holding.
       */
      size_over: 0,
    },
  };

  const executionConfig: ExecutionConfig = {
    // Inert in paper: `SimulatedAdapterConfig` is consumed by
    // `SimulatedBrokerAdapter` only (execution/types.ts: "Consumed by the
    // Simulated adapter only — real adapters never call it"). Present because
    // `ExecutionConfig` requires it; correct so a backtest run over this same
    // profile is not silently misconfigured.
    simulated: {
      /**
       * SPEC — the same ATR(14) spec `DEFAULT_VOLATILITY_INDICATOR`
       * (production.ts) already justifies, including the `lookback: 15`
       * detail: `atr()` spends the first bar seeding `previousClose`, so N
       * bars yield N-1 true ranges and a 14-period ATR needs 15.
       */
      volatility_indicator: {
        indicator: 'atr',
        params: { period: 14 },
        // The breaker's realized-vol reading, on the same 1h bars every other
        // indicator in the system uses (#315).
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
       * `costConfig.venues.saxo` rather than at Alpaca's paper book.
       */
      venue: 'saxo',
    },
  };

  const correlationConfig: CorrelationConfig = {
    /**
     * UNSOURCED — risk-manager-spec.md step 6 specifies "point-in-time
     * pairwise Pearson correlation over trailing returns" and no window. 30
     * daily bars yields 29 returns, the conventional monthly correlation
     * window; `min_bars: 20` then omits any pair without roughly a month of
     * overlap rather than trusting a thin estimate (correlation.ts treats an
     * omitted pair as "not correlated" — the documented warm-up fallback).
     *
     * ## Live from day 1 of a widened universe, and what #303 does about it
     *
     * This was inert while the universe held one instrument. It is not any
     * more (#381), and the accompanying worry was
     * [#303](https://github.com/dd-jp/samurai-trading-system/issues/303) — an
     * under-`min_bars` pair is omitted, therefore reads as *uncorrelated* to
     * the concentration check, and a warming-up portfolio looks perfectly
     * diversified.
     *
     * **#303 landed first, in #383**, so this profile carries its fix rather
     * than a decision about it: `insufficient_history` now names the dropped
     * pairs and `evaluate()` raises a `correlation_warmup:` advisory per
     * uncovered pair. No limit moved, so nothing here needed re-tuning.
     *
     * ## One correction, because it changes how the soak is read
     *
     * #383's rationale states that "on day 1 all fifteen pairs are under
     * `min_bars`". **Measured against the live Alpaca paper account
     * (read-only, 2026-08-05), that is not what happens**: all six
     * `DEFAULT_UNIVERSE` instruments return a full 30 daily bars on the very
     * first request, i.e. 29 overlapping returns against `min_bars: 20`.
     *
     * The reason is that the window is not accumulated locally.
     * `MarketDataServiceImpl.getBars` calls `DataSource.fetchBars` on every
     * request and persists the result (service.ts), so a cold first tick pulls
     * the whole window straight from Alpaca's archive — and every instrument
     * here has traded for years. A genuine day-1 warm-up gap needs an
     * instrument younger than ~30 trading days, which is a universe decision
     * rather than a soak-timing one.
     *
     * This does not make #383 pointless — distinguishing "absent" from
     * "measured at zero" is right regardless, and `RiskDecision.warnings` had
     * no production reader at all before it. It does mean the expected volume
     * of `correlation_warmup:` lines in a soak is **near zero, not fifteen per
     * tick**. Worth stating precisely: an operator told to expect a flood
     * would read a genuine warm-up warning as noise, which is the failure the
     * ticket was trying to prevent.
     */
    window: { timeframe: '1d', lookback: 30 },
    min_bars: 20,
  };

  const breakerConfig: BreakerConfig = {
    /**
     * UNSOURCED — DERIVED from the drawdown limit below: a fifth of it, so
     * five consecutive maximally-bad days reach the hard stop. Soft and
     * stateless, so it auto-resets the moment the metric recovers
     * (risk-manager-spec.md "soft breakers auto-reset").
     *
     * A FRACTION, not a percentage: `PortfolioView.daily_pnl.portfolio.pct` is
     * `(realized + unrealized) / session-open equity` since 00:00 UTC (#332 —
     * orchestrator/sqlite-session-equity-store.ts, risk-manager/portfolio-view.ts),
     * and the comparison is `pct <= -daily_loss_pct`. A `5` here would mean
     * 500% and never trip.
     */
    daily_loss_pct: 0.05,
    /**
     * UNSOURCED — DERIVED from `daily_loss_pct` above: the same 5%, per class.
     *
     * Equal to the portfolio figure rather than a fraction of it, and that is
     * the point of decision 4 (#329): all three daily figures share ONE
     * denominator, portfolio equity, so a 5% per-class loss and a 5% portfolio
     * loss are the same number of dollars. What differs is only which trades
     * are counted and over which session. Setting the per-class tier lower
     * would halt a class before the account-wide floor it is measured on the
     * same scale as, which is a tuning choice this profile has no evidence for.
     *
     * The tier still bites first in the case it exists for: one class down 5%
     * while the other is up 4% leaves the portfolio at −1% and trading, and
     * halts only the class that is bleeding. Same fraction convention as above.
     *
     * Values are paper-trading tuning (risk-manager-spec.md, "Out of Scope:
     * Exact limit values") — this is a starting point to be measured, not a
     * derived constant.
     */
    daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
    /**
     * DERIVED — owner ruling on #634, sited against ADR-0018's measured
     * drawdown envelope. At today's fixed-fraction sizing (~35% of the leg for
     * index ETPs, ~25% for single-stock ETPs) ADR-0018 holds max drawdown at
     * **26.2%** (index) and **41.8%** (single-stock), re-measured 2026-08-17
     * by #729 at the neutral brackets D3 actually declares and accepted as
     * the operative tolerance by David 2026-08-26 (#798) — this replaces the
     * older 23.1%/26.2% pair, measured at the pre-neutral SLS grid. A breaker
     * inside that band would fire on the strategy working as designed, so
     * the trip sits ABOVE the envelope — it means "reality has exceeded what
     * we sized for", not "we are having a bad week".
     *
     * **Re-sited 2026-08-31 (David's approval of #925) from 0.30 to 0.44.**
     * 0.30 sat INSIDE the newly-accepted 41.8% single-stock tolerance — it
     * would have fired on the single-stock leg operating exactly as #798 now
     * says is normal, defeating the breaker's purpose. 0.44 sits 2.2
     * percentage points above the 41.8% envelope (41.8% is a point estimate
     * off a drift-removed simulation; a 1-2pp margin is inside that
     * measurement's own noise, so the margin needed room) and 1 percentage
     * point below the 0.45 hard ceiling (`threshold-bounds.ts`) — the
     * ceiling and the trip are deliberately not equal, so the ceiling still
     * functions as a bound rather than a restatement of this config. There
     * is very little room between the accepted envelope and the ceiling
     * David approved (3.2pp total); see the PR body for #925 for that
     * tension flagged explicitly.
     *
     * This replaces the earlier 0.2, which read CONTEXT.md's "~20-25% target"
     * as a breaker level. That range is a *design target for the envelope* —
     * ADR-0018 §"Target state" says so explicitly ("what the 20-25% number
     * means operationally") — and the two ends of a designed envelope cannot
     * also be the halt line without halting on the design. The 20-25% figure
     * still binds: it is now the RE-ARM edge (see `auto_rearm` below).
     *
     * A fraction — `drawdown_pct` is `(peak - equity) / peak`
     * (risk-manager/portfolio-view.ts).
     *
     * Hard and sticky, but no longer human-cleared: ADR-0013 removed the
     * operator, so `auto_rearm` clears it on recovery in every mode (#634).
     */
    max_drawdown_pct: 0.44,
    /**
     * UNSOURCED — spec story 15 names the breaker, not the count. 5 is a
     * streak unlikely enough at any plausible win rate to be signal rather
     * than noise, and it is soft/auto-resetting, so the cost of it being a
     * little tight is a pause rather than a halt.
     */
    max_consecutive_losses: 5,
    volatility: {
      // See UNCALIBRATED_VOLATILITY_BASELINE: absolute ATR price units, no
      // observation to calibrate against yet, deliberately inert rather than
      // deliberately trip-happy.
      baseline: {
        crypto: UNCALIBRATED_VOLATILITY_BASELINE,
        stocks: UNCALIBRATED_VOLATILITY_BASELINE,
      },
      /**
       * UNSOURCED — risk-manager-spec.md asks the halt to fire when vol
       * "spikes abnormally above a baseline". 3x a calibrated baseline is a
       * defensible reading of "abnormally"; it means nothing until the
       * baseline is real.
       */
      multiplier: 3,
    },
    /**
     * DERIVED — LIVE IN PAPER as of #634, where it used to be inert. ADR-0013
     * removed the operator who would have called `reArm()`, so this is the
     * only thing that can clear a trip outside backtest.
     *
     * `recovery_drawdown_pct: 0.2` is the owner ruling on #634 and the lower
     * edge of the band whose upper edge is `max_drawdown_pct: 0.44` above. It
     * is deliberately the top of CONTEXT.md's "~20-25%" design envelope: the
     * book resumes taking entries once it is back inside the drawdown it was
     * sized for, not merely once it has stopped falling.
     *
     * RECONSIDERED against the widened envelope, 2026-08-31 (#925), and left
     * UNCHANGED. Unlike `max_drawdown_pct`, this value has no obligation to
     * sit near the 41.8% envelope — the opposite: `threshold-bounds.ts`'s
     * ceiling requires it to sit AT OR BELOW the envelope (a re-arm edge
     * above it would resume trading while the book was still outside its own
     * sizing assumption), and 0.2 clears that with room whether the envelope
     * is 26.2% or 41.8%. Raising it toward the new envelope would re-arm at
     * a larger residual drawdown, shortening the halt after a real trip —
     * the LESS safe direction, so the widened envelope is no reason to
     * raise it. Leaving it low keeps the halt in force longer, which is the
     * safe direction (see `threshold-bounds.ts`'s `recovery_drawdown_pct`
     * bound). CONTEXT.md's "~20-25%" design target is unrelated to the
     * accepted-tolerance question #798 settled, so it still governs here.
     * The band is now 24 points wide (0.44 − 0.2) rather than 10; the
     * original 10-point band was sized so "a single mark cannot flip the
     * breaker back and forth across it" — a wider band only strengthens that.
     *
     * `max_days_tripped: 5` is backtest-only by construction — see the field's
     * docblock. Its job is stopping a multi-year replay from dead-ending on
     * its first hit (spec story 21); in paper or live it would resume entries
     * on elapsed time alone, having recovered nothing.
     */
    auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
  };

  const costConfig: CostConfig = {
    // Inert in paper (Simulated adapter only), and every value is above
    // `CostModelImpl`'s structural 1bp spread/commission floor — a config at
    // or under the floor would be silently replaced by it (Principle 1: "no
    // config can construct a frictionless fill").
    crypto: {
      /**
       * UNSOURCED — cost-model-backtest-spec.md OPEN-GAP-A specifies the
       * *mechanism* (`fallback_spread = volatility * coefficient`) and not the
       * coefficient. Crypto is the wider of the two per story 4 ("crypto
       * wider spreads / taker fees").
       */
      spreadVolatilityCoefficient: 0.1,
      /**
       * SPEC-adjacent — spec story 4 names the crypto term as a "taker fee".
       * 26bp is the venue-typical top-of-book taker rate (Kraken/Coinbase
       * Advanced entry tier, the long-term crypto venues in CLAUDE.md's
       * broker plan), and pessimistic against Alpaca's own crypto fee.
       */
      commissionRate: 0.0026,
      /** UNSOURCED — `slippage = volatility * coefficient` (spec §3, deterministic mode); crypto's API latency (~100-200ms per spec) is the wider of the two. */
      slippageCoefficient: 0.05,
      /** UNSOURCED — the `k` in `impact = k * volatility * sqrt(size / adv)` (spec §4, Almgren-style). Higher for the thinner book. */
      impactK: 0.5,
    },
    stocks: {
      /** UNSOURCED — half the crypto coefficient; US large-cap spreads are materially tighter. */
      spreadVolatilityCoefficient: 0.05,
      /**
       * SPEC — cost-model-backtest-spec.md §Commission: "Chan's ~5 bps
       * ex-commission for S&P names is the sanity anchor for the stock
       * defaults."
       */
      commissionRate: 0.0005,
      /** UNSOURCED — as crypto's, scaled down for a tighter, faster venue. */
      slippageCoefficient: 0.02,
      /** UNSOURCED — as crypto's `impactK`, scaled down for a deeper book. */
      impactK: 0.3,
    },
    /**
     * SPEC — ADR-0015:201, Saxo Classic tier: 8bps per side, no minimum.
     * Binds only on a `MarketState` stamped `venue: 'saxo'`, which
     * `executionConfig.simulated.venue` below does (#1032 item 2); the
     * `stocks.commissionRate` above stays the un-keyed anchor.
     */
    venues: { saxo: { commissionRate: SAXO_COMMISSION_RATE } },
  };

  const ciiConsumerConfig: CiiConsumerConfig = {
    /**
     * SPEC — ADR-0002 §2: the WorldMonitor adapter polls on "its own
     * decoupled cadence (5-15 min), independent of Samurai's trading-tick
     * loop". 10 min is the midpoint of the stated range.
     *
     * The cadence is all this config carries; the feed behind it is parked.
     * `ProductionConfig.ciiScoreProvider` is left unset on purpose so the
     * composition root's `ParkedCiiScoreProvider` default applies — it
     * answers `null` (a documented value on the port, meaning "WorldMonitor
     * has no score"), makes no network call, and therefore spends nothing.
     * Wiring a live provider is explicitly NOT part of a paper run.
     */
    pollIntervalMs: 10 * 60_000,
  };

  return {
    /**
     * DECIDED (David, 2026-08-06) — the 14-day soak may spend **$50 total** on
     * LLM calls. See ADR-0008. Enforced by `SqliteSpendCap` over the
     * cumulative `llm_spend` total; it does not refill.
     *
     * This is a hard ceiling *behind* the cadence choice below, not instead of
     * it. Cadence is sized to land under the budget; the cap is what makes the
     * figure a guarantee rather than a forecast, because the only spend
     * estimate this repo has is indicative and the cycle arithmetic
     * (`pass duration + interval`) makes proportional scaling an upper bound
     * on the saving, not a promise. It also covers what cadence cannot: a
     * retry storm, a debate running more rounds than expected, or a price
     * change at the provider.
     */
    llmBudgetUsd: 50,
    /**
     * DERIVED — **2 minutes, down from 15** (#670, whose trigger has fired).
     *
     * ### Why 15 was right, and why it stopped being right
     *
     * The old value was derived against spend that scaled with tick rate.
     * While #617 was open the debate re-ran on every tick *within* a bar, so
     * cost was strictly proportional to 1/τ, and
     * `docs/research/41-tick-latency-economics.md` solved the trade-off:
     *
     *     T(τ) = C/τ + B·√τ        τ* = (2C/B)^(2/3) = 21.8 min
     *
     * — with τ = 15 already on the expensive side of optimal. #670 recorded
     * the ruling as "hold at 15m, step to 2m with #617".
     *
     * **#617 is closed (`7d68fa0`).** One run per bar now, so `C` collapses to
     * ~0, the LLM term vanishes from the objective, and `T(τ) = B·√τ` is
     * monotonically increasing — the optimum jumps to the smallest τ the pass
     * duration allows (doc 41's conclusion, line 106).
     *
     * ### Why 2 and not 1
     *
     * Doc 41 computes the unconstrained optimum as τ = 1 min against a ~13s
     * pass and `production.ts`'s dropped-tick guard. 2 min is #670's recorded
     * step and leaves ~9x headroom over the measured ~13s pass (120/13) where
     * τ = 1 would leave ~4.6x (60/13), which matters because the pass duration
     * is a measurement of the system as it was, and section B widens the
     * analyst's indicator set.
     *
     * ### What this buys, given entries are still bar-gated
     *
     * Entries are gated by `DEBATE_BAR_TIMEFRAME_MS` (1h), not by τ — a faster
     * tick does not produce more debates. What it buys is **exit resolution**:
     * the bracket is evaluated every tick, and doc 41 Result 2 measures the
     * conditional tail as `g(D) = 0.525%·√D` on a 3x equity ETP. At τ = 15 a
     * stop overshoots by ≈-1.97% in the worst 5% of exits; at τ = 2 that falls
     * to ≈-0.72%. On a -2.16% stop that is the difference between a stop that
     * means what it says and one that does not.
     *
     * **Both figures are at D = τ — the WORST delay, not the mean.** A stop is
     * breached at some instant and noticed at the next tick, so the delay is
     * uniform on (0, τ) and the worst case is a full interval. Doc 41's own
     * "Solving" section instead uses the mean, D = τ/2, because it is costing
     * an average day rather than bounding a single exit; `paper-profile.test.ts`
     * quotes ~0.53% at τ = 2 on that convention (`g(1)`). Same measured result,
     * two questions — stated here because the two numbers look contradictory
     * side by side, and a reader reconciling them by "correcting" one would
     * lose whichever question it was answering.
     *
     * ### Cost
     *
     * ~0, and that is the whole point: post-#617 spend is keyed to the debate
     * bar, so `llmBudgetUsd: 50` above is untouched by this change. Doc 41's
     * "independent hard floor" of τ ≥ 3.69 min does **not** survive #617 — it
     * was derived as `0.878 × 15 × 14 / 50`, i.e. from spend scaling with 1/τ,
     * which is exactly the assumption #617 removed.
     *
     * ### Unchanged
     *
     * **This is still NOT #400's decision.** David chose crypto 2 min / stocks
     * 5 min there; those are per-asset-class cadences needing #397's Phase 1,
     * which is not built — there is one base interval for every instrument.
     *
     * No dial needs retuning to go faster, for the same reason it needed none
     * to go slower: #400 established that `max_signal_age` and
     * `drift_tolerance_pct` both measure WITHIN-pass intervals, so the tick
     * interval never enters either gate's arithmetic.
     */
    tickIntervalMs: 2 * 60_000,
    /**
     * Concurrent instrument passes within one tick (#1013) — SET EXPLICITLY
     * rather than left to `buildProductionOrchestrator`'s `config.maxConcurrentInstruments
     * ?? 1` fallback (`production.ts:2701`), which is what actually ran: a
     * worker pool of width 1, walking the universe one instrument at a time —
     * SPY at 19:56:42, QQQ at 19:57:07, TSLA at 19:58:02 (the issue's own
     * measurement; it did not report AAPL's timestamp), ~25-55s apart —
     * against the `tickIntervalMs: 2 * 60_000` two lines up. The pool itself
     * (`runTickPlan`, tick-loop.ts) was never the gap; only the config value
     * feeding it was.
     *
     * **Worked from the rate limiter's actual budget and #1012's measured
     * latency, not by feel — the issue's own instruction:**
     *
     * - `rateLimiterConfig.perAssetClass.stocks` below admits
     *   `STOCKS_MAX_DEBATES_PER_WINDOW = 15` debates per `LLM_BUDGET_WINDOW_MS
     *   = 300_000` (5 min) — a sustained 3/min. `DEFAULT_UNIVERSE` today is
     *   FOUR stocks-only instruments (SPY/QQQ/AAPL/TSLA; crypto left scope,
     *   ADR-0015's 2026-08-16 amendment). At `maxDebates: 15`, four
     *   instruments debating once each in the same window is nowhere near
     *   it — but "at most 4" is not actually the bound: #743's
     *   `DebateBarDecisionGate` admits one debate attempt per instrument per
     *   bar, and #785 lets a THROWING pass retry up to
     *   `DEFAULT_MAX_DECISION_RETRIES_PER_BAR = 5` further times in that same
     *   bar. **Corrected here (#1013 fix-up L2) — the original `4 x (1 + 5) =
     *   24` figure overstated both what re-triggers a retry and how many can
     *   land in one window.** A retry only re-hits `RateLimiter.reserve` if
     *   the DEBATE STEP ITSELF fails before persisting: `debate-adapter.ts`
     *   writes the `debate_log` row as soon as a debate completes, converged
     *   or not (`persistDebateLog`), and any later attempt in the same bar
     *   that finds a replayable row for that `debate_id` short-circuits via
     *   `replayedDebateResult` — no LLM call, no re-reservation. So
     *   "something downstream throws" AFTER a debate that already persisted
     *   does not compound admission attempts; only the narrower case of the
     *   debate step itself throwing pre-persist, on every attempt, does. Even
     *   then, retries land on SUBSEQUENT TICKS (`tickIntervalMs: 2 * 60_000`
     *   below), not instantly: five retries at a 2-minute cadence span up to
     *   10 minutes — crossing rate-limit window boundaries (`windowMs:
     *   300_000` below) — so at most ~3 attempts per instrument (one first
     *   try plus two retries), not six, can land inside any SINGLE 5-minute
     *   window: `4 x 3 = 12` in one window, under the 15 ceiling. The full
     *   `4 x (1 + 5) = 24` is real only as a per-BAR total spread across
     *   several windows, never as a single-window burst. What actually holds
     *   the line either way is `RateLimiter.reserve` itself: it is TOTAL and
     *   never throws (its own doc comment), so any attempt past whichever
     *   ceiling actually binds in a given window is simply refused —
     *   `granted: false`, logged, degrades that pass to `no_trade` — rather
     *   than retried further (a refusal is not a throw, so #785 never sees it
     *   as one to retry). The width this field sets does not change any of
     *   that arithmetic: it only affects how many instruments' FIRST attempt
     *   in a bar can start in parallel, not how many attempts each can
     *   eventually make.
     * - #1012 measured the debate LLM call itself at 6,441ms mean / 28,340ms
     *   max, ~9-10 calls serially per one debate (`WORST_CASE_LLM_CALLS_PER_DEBATE`
     *   below reserves for exactly 10) — a mean debate of ~61s (matching the
     *   ~50s/instrument this ticket measured), a worst case of ~4.7 min.
     *   Neither figure is gated by THIS dial. **Corrected here (#1013 fix-up
     *   M1) — `RateLimiter.reserve` does NOT book the worst-case call count up
     *   front**; it only increments `debatesUsed` by one, synchronously, and
     *   CHECKS (does not reserve) that `llmCallsUsed + worstCaseLlmCalls`
     *   still fits `maxLlmCalls` at that instant (`rate-limiter.ts`).
     *   `llmCallsUsed` itself is only incremented later, per real call, by
     *   `recordCall` (`production/rate-limited-llm-client.ts`). The real
     *   safety property is `maxLlmCalls = maxDebates x
     *   WORST_CASE_LLM_CALLS_PER_DEBATE` (`llmBudget` above, pinned by
     *   `rate-limit-wiring.test.ts`'s "carries a per-asset-class budget with
     *   the call budget tied to the worst case"): `debatesUsed` is capped at
     *   `maxDebates` synchronously and atomically (no await between check and
     *   increment), so as long as no single debate exceeds its own worst-case
     *   call allowance, the window's aggregate `llmCallsUsed` cannot exceed
     *   `maxLlmCalls` either — the ceiling holds by construction of the two
     *   numbers, not by `reserve` pre-booking calls it has not yet made. A
     *   slow debate still only spends its own call budget, never another
     *   instrument's debate-count budget — a debate's duration and how many
     *   debates a window admits are separate quantities here.
     * - `6` was originally chosen to clear a 4-instrument universe with a spare
     *   worker, which made the tick loop's own per-instrument reentrancy guard
     *   (#669, `production.ts` — never more than one in-flight pass per
     *   instrument) the binding constraint at `min(6, universe.length) = 4`.
     *   **That is no longer the case: `DEFAULT_UNIVERSE` is 20 names, so
     *   `min(6, universe.length) = 6` and THIS dial binds.** See "Revisited at
     *   20 names" below for why it stays at 6 anyway.
     * - `6` also reuses, rather than re-derives, #388's own headroom check two
     *   screens down (`rateLimiterConfig`'s comment): raising this to 6 was
     *   already shown there to roughly double the stock debate rate to
     *   ~1.6/min, comfortably under the 3/min budget above.
     *
     * **Effect on staleness.** The issue's own timestamps (SPY 19:56:42, QQQ
     * 19:57:07, TSLA 19:58:02) show ~80s of staleness on the span it actually
     * timestamped — corrected here (#1013 fix-up L1) from an earlier "~2 min"
     * that did not match the quoted timestamps. That span is two gaps if only
     * SPY/QQQ/TSLA are counted (~40s/gap), but `DEFAULT_UNIVERSE`'s walk order
     * is SPY/QQQ/AAPL/TSLA, so AAPL's debate almost certainly ran between
     * QQQ's and TSLA's timestamps even though the issue never reported it —
     * meaning the 80s span most likely covers three gaps across all four
     * instruments (~27s/gap), not two. Either way the per-gap figure the data
     * itself supports is in the ~27-40s range, not the "~50s/instrument" an
     * earlier draft of this comment invented and then wrongly called "that
     * same" figure when extrapolating (#1013 fix-up L1, second correction).
     * Rather than lean on a number this small a sample can't really pin down,
     * the extrapolation below instead uses #1012's separately-measured ~61s
     * MEAN debate latency (a different, independently-sourced figure, not a
     * refinement of the 80s span) as a deliberately conservative per-instrument
     * estimate: at width 1 the last instrument in a pass decides on data as
     * old as every other instrument's combined debate time ahead of it in the
     * walk, so up to ~3 debates deep at ~61s each puts the full 4-instrument
     * `DEFAULT_UNIVERSE`'s last instrument on the order of ~3 min stale (not
     * itself measured — #1012's figure is a per-call/per-debate benchmark, not
     * a walk-order measurement on this universe). At width 6 (>= 4), every
     * instrument in `DEFAULT_UNIVERSE` starts its pass in the same tick
     * instant — one worker per instrument — so the whole pass's staleness
     * spread collapses to the spread of the instruments' OWN debate latencies
     * (seconds to low tens of seconds, #1012's mean-to-tail range) rather than
     * the sum of the instruments ahead of it in a serial walk.
     *
     * **Revisited at 20 names, and deliberately left at 6.** The tripwire below
     * says to revisit this dial rather than assume it when the universe widens
     * past it; the universe widened 3 -> 20 for the paper soak, so here is the
     * revisit rather than a silent inheritance.
     *
     * The width-6 collapse argument in the paragraph above no longer holds: it
     * rests on EVERY instrument starting its pass in the same tick instant, and
     * 20 names at width 6 walk in `ceil(20 / 6) = 4` groups instead. The last
     * group therefore decides on data up to ~3 debates deep — at #1012's ~61s
     * mean, on the order of ~3 min, the same figure the width-1 serial walk
     * produced for the old 4-name universe. That is a STALENESS regression, not
     * a safety one, and it is gated rather than tolerated: `max_signal_age` and
     * `max_mark_age` for stocks are both 15 min, comfortably above the ~4.1 min
     * worst-case full pass, so the tail of the walk is well inside the freshness
     * bounds Verdict enforces. If either of those two gates is ever tightened
     * below the pass duration, the tail gets refused at Verdict and this dial
     * has to rise with it.
     *
     * Raising it now would trade that measured, gated staleness for #692's
     * overlapping-pass multiplication and a wider same-tick window for #1019's
     * race — both unmeasured. The staleness is bounded and checked; the other
     * two are not. So: unchanged, on evidence.
     *
     * **NOT sized for the ~30-name live LSE ETP pool (#895).** A universe that
     * wide makes `maxConcurrentInstruments x passes in flight` (#692) actually
     * multiply — a wider universe than this cap gives a second, overlapping
     * pass NEW instruments to claim rather than none — which is a materially
     * different safety question this comment does not answer. Revisit this
     * dial, not assume it, when the universe widens past it. See the tripwire
     * comment on #895 itself and #1019 (next paragraph) for what else arms at
     * the same time.
     *
     * **Same-tick concurrency also opens a portfolio-cap race, filed as #1019
     * rather than fixed here (#1013 fix-up H3).** `computePortfolioView`
     * values a position at `filled_size * mark`, never `requested_size`
     * (`portfolio-view.ts`), so a just-submitted order reads as ZERO exposure
     * to every sibling instrument's Risk evaluation in the same tick until a
     * fill poll (`DEFAULT_FILL_POLL_INTERVAL_MS = 15_000`) catches up — at
     * width 6, unlike the old serial walk, no poll typically intervenes
     * between sibling submissions. This makes `perSubclassDeploymentCap`'s
     * cross-instrument netting (`risk-manager/index.ts`) structurally unable
     * to net same-tick concurrent exposure. **Bounded today**: `DEFAULT_UNIVERSE`
     * has no `subclass_of` entries, so `perSubclassDeploymentCap` is inert and
     * the per-name gates (`perTradeSizeCap`, `perAssetExposureCap`) still bind
     * independently. The 3 -> 20 widening keeps that bound deliberately: every
     * new row is an UNCLASSIFIED US cash equity or index ETF with no
     * `subclass`, so the widening does not arm the race. Do not classify
     * these rows until #1019 is closed. **It disappears the moment a
     * D5-classified subclass with
     * a numeric fraction arms** (`isD5ArmedWithNumericFraction`,
     * `risk-manager/index.ts`) — expected once #895's pool file lands — which
     * nulls out both per-name gates and leaves only the gate that cannot net
     * same-tick submissions. See #1019 for the full mechanism and the two
     * related gaps (no submit-time cash reservation; a breaker-state
     * audit-fidelity note) it also covers.
     *
     * **`backtest` is not this value.** This `6` is what `mode` resolves to
     * for `paper` and `live`; the return statement below overrides
     * `backtest` back to an explicit `1` for replay determinism (#1013
     * fix-up H1) — see the comment there and
     * `failover-data-source.ts`'s replay-determinism note.
     */
    maxConcurrentInstruments: MAX_CONCURRENT_INSTRUMENTS,
    /**
     * `SPEC` — equities are entered only inside the LSE/US overlap (#706).
     *
     * Set HERE rather than defaulted in `buildProductionOrchestrator`, because
     * the composition root is where a run's policy belongs — and set at all,
     * rather than left as an available seam, because a mechanism nothing calls
     * is this repo's dominant defect class.
     *
     * 14:30-15:45 London. For ~49 weeks of the year that is 09:30-10:45 ET,
     * i.e. the first 75 minutes of the US cash session — which is deliberately
     * the same span R2's entry-offset grid measures (t0 in {0..120} minutes
     * past the US open), so the soak and the study describe the same hours.
     *
     * **For the other ~3 weeks it is 10:30-11:45 ET, and that is a real gap,
     * not a rounding note.** The UK and US DST transitions disagree twice a
     * year — the US springs forward on the 2nd Sunday of March and falls back
     * on the 1st Sunday of November, the UK on the last Sundays of March and
     * October — so for roughly two weeks in March and one in late Oct/early
     * Nov the London/New York offset is 4 hours rather than 5. The window is
     * anchored to LONDON wall-clock (the venue and the book are GBP, ADR-0015),
     * so in those weeks it slides an hour later against the US tape: entries
     * open 60 minutes past the US cash open and close 135 minutes past it,
     * with the last 15 minutes falling OUTSIDE R2's t0 in {0..120} grid.
     *
     * Recorded rather than corrected, because both available corrections are
     * product decisions and not this step's to take: re-anchoring to the US
     * open would make an LSE-venue rule depend on a foreign calendar, and
     * narrowing to the intersection would cost 15 minutes of entry time for 49
     * weeks to buy exactness in 3. `trading-window.test.ts` pins the divergence
     * so it is a characterised property rather than a surprise in the soak
     * record. Worth an ADR line if a March or November soak is ever read as
     * evidence about entry timing.
     *
     * **What this costs, stated rather than discovered:** it cuts the equity
     * tick window from 6.5 hours to 75 minutes. It does NOT cut debates by the
     * same factor — debates are keyed to 1h bars, so this goes from ~7 entry
     * decisions per name per session to 2 (the 14:00 bar entered from 14:30,
     * and the 15:00 bar). Fewer, better-evidenced entries is the design, not a
     * side effect. Exits are unaffected: the bracket is evaluated every tick,
     * and a position opened in the window is still flattened at close minus 5.
     */
    stocksTradingWindow: londonEntryWindow(),
    /**
     * `SPEC` — the universe a paper run trades (#381). ADR-0001 names this
     * exact set ("default universe SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD",
     * CLAUDE.md's broker plan), orchestrator-spec.md story 3 makes it the
     * scheduler's default, and #238's first acceptance criterion is running it
     * before the soak starts. `DEFAULT_UNIVERSE` (scheduler.ts) is the checked-in
     * copy; spread by reference so a second list cannot drift from it.
     *
     * A tuning decision of the same kind as everything else in this file, not
     * a deployment one like the alert transports: it is what the risk caps,
     * the drift tolerances and the volatility baselines above are set
     * *against*. `ProductionConfig.universe` still defaults to
     * `SMOKE_TEST_UNIVERSE`, so a programmatic caller inherits nothing by
     * omission and the smoke run's explicit override (smoke-run.ts) still
     * wins.
     *
     * **Not a member of `REQUIRED_INJECTED_CONFIG`** (orchestrator/index.ts),
     * which still lists the eight tuning objects and nothing else. That list
     * is a guard against a caller forgetting a config the process cannot
     * invent; a universe it CAN default. So a bespoke composition root that
     * satisfies the guard field by field, rather than spreading this profile,
     * silently keeps `SMOKE_TEST_UNIVERSE` — deliberate (the narrow default is
     * the safe one) but worth knowing before wondering why a run trades one
     * instrument.
     *
     * ## What six instruments cost per day, and why it is not 6x (DERIVED)
     *
     * > **STALE SINCE ADR-0008 (2026-08-06), and kept because ADR-0008 cites
     * > it as its own source.** Everything below is computed at the 60s
     * > `DEFAULT_TICK_INTERVAL_MS`, so the ~$45/day figure is a BEFORE number.
     * >
     * > **Doubly stale since #617 closed (`7d68fa0`), and this is the more
     * > important correction.** Every figure below — including ADR-0008's own
     * > 15-minute derivation — assumes spend scales with the tick rate. It no
     * > longer does: `debate-adapter.ts` short-circuits the same bar ahead of
     * > the spend cap and every LLM call, so **spend is keyed to the 1h debate
     * > bar and is independent of τ**. That is what let #670 step the cadence
     * > to 2 min for free, and it is why the measured soak figure was $0.878/day
     * > against ADR-0008's $3.00/day estimate (doc 41 — a 3.4x overestimate).
     * >
     * > The *reasoning* below is what survived both changes, and it is why the
     * > cap exists rather than a promise: no arithmetic here can promise a
     * > dollar figure, which is precisely why `llmBudgetUsd` fails closed.
     *
     * The naive reading is that six instruments is six times the debate spend
     * of one. It is closer to **1.6x**, and the reason is worth writing down
     * because it also answers whether the tick loop can keep up:
     * `startTickLoop` is a `setTimeout` CHAIN, not a fixed-cadence
     * `setInterval`. **Both halves of the next sentence, as this passage
     * originally wrote them, are now false and are corrected here (#1013
     * fix-up H2) rather than left to mislead the next reader:**
     *
     * The next tick is re-armed BEFORE the current pass runs, not once it
     * finishes (#669, `production.ts`'s tick-loop doc) — chaining on
     * completion made the real period `interval + passDuration`, which #669
     * removed specifically because one slow debate was pushing back every
     * instrument's next tick. So the cadence is the fixed interval, not
     * interval-plus-duration, independent of this dial.
     *
     * And at `maxConcurrentInstruments: 6` (#1013; it was `1` when this
     * passage was written) a pass runs its instruments CONCURRENTLY, up to
     * the configured width, not sequentially — so "widening the universe
     * stretches the effective cadence" no longer holds at today's width
     * either. Passes from DIFFERENT ticks can now also legitimately overlap
     * (#669 re-arms ahead of completion), bounded only per-instrument: the
     * #669 reentrancy guard never lets two passes be in flight for the same
     * instrument, but distinct instruments across overlapping passes are not
     * bounded by this field at all — see `production.ts`'s "`maxConcurrentInstruments`
     * is a per-pass bound" note. The "tick skipped: previous tick still
     * running" warn this passage used to say "stays unreachable" does not
     * merely stay unreachable: #669 deleted the global in-flight guard that
     * logged it, so that message no longer exists anywhere in the code.
     *
     * Arithmetic, at `LATENCY_BUDGET_MS` (crypto 30s, stocks 60s — #581) and
     * `DEFAULT_TICK_INTERVAL_MS` (60s):
     *
     * - Session hours (6.5h): a pass is 4x60s + 2x30s = 300s, so a cycle is
     *   ~360s -> ~65 cycles -> ~390 debates.
     * - Outside the session (17.5h): a pass is 2x30s = 60s, cycle ~120s ->
     *   ~525 cycles -> ~1,050 debates.
     * - Weekday total ~1,400 debates; a weekend day is crypto-only, ~1,450.
     *
     * At the debate role's default model (`anthropic/claude-haiku-4.5`,
     * $0.80/M in and $4.00/M out through Nous — ADR-0009) and 3 LLM calls per
     * round — crypto capped at 1 round, stocks 1-3 rounds
     * (`MAX_ROUNDS_BY_ASSET_CLASS`, early exit on convergence) — a debate
     * is roughly $0.008-$0.036. So **~$30/day, with a defensible range of
     * $20-$72, and ~$400 over the 14-day soak** — which is why the cap and the
     * cadence below both bind.
     *
     * That is the arithmetic BEFORE ADR-0008's 15-minute cadence, which is
     * what the numbers above are drawn against; the cadence was chosen when a
     * debate cost roughly 8x this. ADR-0009 therefore reopens cadence as a
     * lever — it does not pull it. Changing the interval is its own decision
     * with its own evidence, not a side effect of a provider swap.
     *
     * **That decision has since been taken, on its own evidence, and it
     * removed the lever rather than pulling it.** #617 keyed spend to the 1h
     * debate bar instead of the tick, so cadence stopped being a cost lever at
     * all; doc 41 then measured what a minute of delay actually costs and #670
     * stepped the interval to 2 min. Per-run units are $0.0060 measured, not
     * the $0.008-$0.036 estimated above.
     *
     * **The debate is no longer the only unit under `llmBudgetUsd` (#969).**
     * Everything above prices the DEBATE leg. With
     * `SAMURAI_SENTIMENT_RETRIEVAL=on` the market-intelligence leg runs a
     * server-side `x_search` call per instrument per 2h bucket, and search
     * results ride in the PROMPT: ~$0.02 at the default 3 results, a measured
     * $0.089 at 10.
     *
     * Two multipliers set the call count. Buckets are SESSION-derived:
     * `UniverseScheduler` returns an empty instrument list whenever the
     * calendar says closed, so the refresh never fires outside the session and
     * a 6.5h US session touches 4 two-hour buckets, not 12. And the universe
     * is the 20 names above (#1051). A soak is therefore 20 x 4 x 10 = ~800
     * calls: **~$16** at the default 3 results and **~$71** at 10, against
     * this profile's $50 `llmBudgetUsd` shared with #1051's ~$8.40 debate leg.
     *
     * So the cap BINDS the sentiment leg, and at 3 results that leg is the
     * LARGER of the two — the first thing under this budget to outweigh the
     * debate. `SAMURAI_X_MAX_RESULTS` is clamped to 10, but that clamp bounds
     * an operator typo rather than the budget: 10 on 20 names does not fit,
     * and `SpendCap` failing closed turns the overshoot into a soak that goes
     * dark partway through. Re-derive the default when the universe width
     * changes. Retrieval is OFF by default, so the arithmetic above still
     * describes an unflagged run. ADR-0008 §2's 2026-09-03 amendment and ADR-0020 carry the regime;
     * treat the retrieval figures as a range until reconciled against the
     * provider invoice.
     *
     * Two things that make the range wide rather than the estimate precise,
     * both stated rather than smoothed over: debates that complete FASTER than
     * the budget cost more per day, not less (a shorter pass means more
     * cycles), and no soak has yet produced a real per-debate token
     * distribution — `llm_spend` (#367) is what will replace this arithmetic
     * with a measurement.
     *
     * The rate-limit posture used to rest entirely on this: with
     * `maxConcurrentInstruments: 1` at most one LLM call is ever outstanding
     * no matter how many instruments are in the plan, and `RateLimiter`
     * (debate-engine/rate-limiter.ts) was built, tested and never constructed
     * in production. **#388 closed that**: `rateLimiterConfig` below is now
     * wired at the composition root and every debate is admitted through it,
     * so raising `maxConcurrentInstruments` no longer removes the only
     * throttle. The arithmetic in this comment is unchanged — the concurrency
     * cap still governs the SHAPE of the spend; the limiter is the ceiling
     * underneath it.
     */
    // The argument, not the constant (#739).
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
     * The LLM budget every debate is admitted against (#388) — the component
     * that closes the gap the `universe` comment above describes, where the
     * only throttle in the system was `maxConcurrentInstruments: 1`.
     *
     * **What this is for.** It is a CEILING, not a scheduler. Ordinary spend is
     * paced by the tick cadence; this exists so that a misconfiguration (the
     * obvious one being raising `maxConcurrentInstruments`), a stuck retry
     * loop, or a universe widened again cannot turn into unbounded billing
     * before anyone notices. Sized to sit clear of normal operation and to
     * bite well before the day's cost multiplies.
     *
     * **It is a COST ceiling, not a transcription of Anthropic's rate limits,
     * and the difference is worth stating plainly.** #388 asks to "confirm the
     * venue-side limits it is configured against are real"; that was done for
     * the broker side, where each figure is cited by URL in
     * `shared/http/venue-pacing.ts`. It was NOT done here: Anthropic's
     * per-tier requests-per-minute and tokens-per-minute limits vary by
     * account and spend history, and no figure for THIS account was
     * established. So these numbers are derived from #385's measured cadence
     * and $/call, and nothing in them should be read as "Anthropic permits
     * this rate". The provider's own 429 is still handled where it always was
     * — `AnthropicLlmClient`'s retry/`LlmRateLimitError` path — and remains
     * the authority on the provider's limit. Establishing the account's real
     * tier figures and reconciling them with this budget is open work.
     *
     * **`windowMs: 300_000` — DERIVED.** Five minutes rather than one.
     * `RateLimiter` uses a FIXED window, not a sliding one, so at the counts
     * involved here (single digits per minute) a 60s window would refuse
     * legitimate debates purely on where a boundary happened to fall. Five
     * minutes holds enough events for the boundary to stop mattering while
     * still catching a runaway within minutes rather than hours.
     *
     * **`maxDebates` — DERIVED from #385's measured cadence**, at roughly 3x
     * headroom over it, per asset class.
     *
     * > **The cadence these were derived from is 2x faster than the one this
     * > profile now runs** (`tickIntervalMs` 60s -> 15 min under ADR-0008, then
     * > back to 2 min under #670 once #617 made cadence free). Left unchanged
     * > through both moves, deliberately: this budget is a RUNAWAY guard, and
     * > an oversized ceiling is permissive rather than wrong — it refuses only
     * > pathological rates, which is exactly its job. Retuning it to track the
     * > cadence would make it a second, redundant cost control and put it in
     * > conflict with `llmBudgetUsd`, which is the actual budget. Read the
     * > arithmetic below as "the rate at which something has gone wrong", not
     * > as a description of the soak's cadence.
     * >
     * > Note the step back to 2 min moved the *ticks*, not the debates: #617's
     * > same-bar short-circuit means a faster tick issues no extra LLM calls,
     * > so the headroom this guard leaves is unchanged in the units it counts.
     *
     * - crypto (BTC-USD, ETH-USD; trades 24/7) peaks OUTSIDE the equity
     *   session, where a pass is 2x15s and a cycle ~90s — 2 debates per 90s =
     *   1.33/min. `20` per 5 minutes is 4/min, ~3x that.
     * - stocks (SPY, QQQ, AAPL, TSLA; session hours only) run one 330s cycle
     *   of 4 debates = 0.73/min. `15` per 5 minutes is 3/min, ~4x that.
     *
     * The extra headroom is deliberate and is what makes this survive the
     * change that motivated #388: raising `maxConcurrentInstruments` to 6
     * collapses a stock pass from 270s to ~60s, roughly doubling the stock
     * debate rate to ~1.6/min — still comfortably under 3/min, so the dial can
     * be raised for latency without the ceiling firing, and cannot be raised
     * far enough to remove it.
     *
     * **#1013 acted on this.** `maxConcurrentInstruments` below is now set to
     * exactly the `6` this paragraph analyzed, rather than left at the
     * `?? 1` fallback that made every pass walk the universe serially — see
     * that field's own comment for the full derivation, current-universe fit,
     * and the explicit non-claim about the wider ~30-name LSE pool.
     *
     * **`maxLlmCalls = maxDebates * WORST_CASE_LLM_CALLS_PER_DEBATE` —
     * DERIVED, and deliberately redundant.** `reserve` admits a debate only if
     * its worst case (3 rounds x 3 persona calls + 1 disagreement call = 10)
     * still fits, so setting the call budget to exactly that product makes
     * `maxDebates` the single binding dial: an operator changes one number and
     * gets the behaviour they expected. Sizing the call budget any LOWER would
     * make it bind first, refusing debates while `ReserveResult.reason` blamed
     * the wrong budget; sizing it higher would leave it unable to bind at all.
     * The money ceiling this implies is what matters:
     * `maxDebates * 10 calls * ~$0.004/call`, i.e. under $1 per 5-minute
     * window per class in the worst case, against ~$45/day measured.
     *
     * **`default` — DERIVED, not chosen.** No third asset class exists
     * (`AssetClass` is `crypto | stocks`), so this is unreachable today. The
     * rule it encodes is that an unrecognised asset class should be the most
     * constrained thing in the system, not the least — and `RateLimiter`'s
     * `configFor` falls back to it for any class with no entry, so it really
     * would govern a new one.
     *
     * COMPUTED with `Math.min` rather than written out and asserted to match
     * (PR #390 review). "This mirrors the tighter class" is precisely the kind
     * of invariant that stops being true the moment someone tunes one budget:
     * raise `STOCKS_MAX_DEBATES` above crypto's and a hand-written `default`
     * silently becomes the LOOSEST entry — the exact inversion of the rule it
     * claims to follow, with the comment still swearing otherwise. Deriving it
     * makes the claim structural.
     *
     * **That hypothetical is now the actual case, and the derivation absorbed
     * it exactly as designed.** The 20-name widening raised
     * `STOCKS_MAX_DEBATES_PER_WINDOW` past crypto's 20, so `default` moved from
     * `min(20, 15) = 15` to `min(20, 24) = 20` — it now mirrors CRYPTO rather
     * than stocks. Stated rather than left to be rediscovered, because the
     * number moving is a real consequence of that edit. It changes no behaviour
     * today: `configFor` reads `default` only for an asset class with no
     * `perAssetClass` entry, `AssetClass` is `crypto | stocks`, and both are
     * declared below — so nothing resolves to it, and the widened universe is
     * stocks-only besides. It stays the most-constrained-of-the-two by
     * construction, which is the rule; only which class supplies that bound
     * changed.
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
 * The profile the shipped entrypoint starts with, for the mode the operator
 * asked for — and a hard refusal to be the profile a **live** process runs on.
 *
 * The refusal is not belt-and-braces caution; it follows from what these
 * values are. The volatility breaker's baseline is uncalibrated to the point
 * of being inert, `drift_tolerance` is sized for one instrument, and its
 * cadence and LLM budget are sized for a $50 paper soak rather than for a run
 * that is trying to make money. Each of those is a fine trade for a paper run
 * and none of them is acceptable against real money — the more so since
 * ADR-0007, which removed the human gate that used to sit behind them.
 *
 * **Since #886 the notional caps are no longer this list's reason** — they
 * are fractions of live equity, resolved at evaluate time, identical in
 * every profile. The refusal is about the OTHER untuned values above, not
 * about a paper-account assumption the caps no longer carry.
 *
 * This does not make live unreachable — it makes it explicit.
 * `startFromEnvironment(injected)` still accepts any `ProductionConfig` a live
 * operator supplies, which is exactly the point: going live should mean
 * passing values somebody tuned, not inheriting the ones nobody has.
 *
 * `backtest` is allowed: it spends no money, and `auto_rearm` above exists
 * precisely for that path.
 */
export function paperStartingProfile(
  mode: ProductionConfig['mode'],
): Pick<ProductionConfig, 'mode'> &
  Pick<
    ProductionConfig,
    | 'universe'
    | 'traderConfig'
    | 'riskConfig'
    | 'verdictConfig'
    | 'executionConfig'
    | 'capitalCeilingUsd'
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

  const configs = buildStartingProfileConfigs();

  return {
    ...configs,
    mode,
    // #1112: `paper` sizes against a simulated Alpaca account whose funded
    // equity (~$100,000) has nothing to do with the declared book
    // (`LIVE_BOOK_GBP`) both the arm comparison's `return_pct` basis (below,
    // and production.ts/smoke-run.ts) and `perTradeSizeCap`'s uncapped gates
    // are stated against. Without this, `sizingEquity` (direct-bind.ts) never
    // clamps in paper mode (`capitalCeilingUsd` was `undefined`), so the
    // Trader sizes off the simulated balance directly — ~100x the book —
    // which is the defect #1112 reports. `capitalCeilingUsd` is the SAME
    // clamp `liveStartingProfile()` sets from `SAMURAI_LIVE_MAX_CAPITAL_USD`;
    // here it is pinned to `LIVE_BOOK_GBP` itself rather than to an
    // independently-configured value, so paper's sizing denominator and the
    // arm comparison's `basis` are provably the same literal, not two
    // constants that happen to agree.
    //
    // `buildControlArmWiring` (control-arm-wiring.ts) spreads the live arm's
    // `TraderStepDeps` verbatim into the control arm's, so this one line
    // reaches both arms — no separate control-arm override is needed or
    // wanted (a second knob that has to be kept in sync is exactly what
    // framing (2) below rejects).
    //
    // Scoped to `paper` only, not `backtest`: backtest's cost-model
    // calibration and Stage-2 tooling read `portfolio.equity` unclamped today
    // and #1112 does not ask that path to change; widening the blast radius
    // there is a separate decision.
    //
    // **#949, carried into paper by this line: `capitalCeilingUsd` is a GBP
    // value here, unconverted.** `LIVE_BOOK_GBP` is £1,000; `sizingEquity`
    // (direct-bind.ts) does `Math.min(ceiling, equity)` against `equity` as
    // the paper Alpaca account (USD) reports it, with no FX step — the same
    // gap `live-profile.ts` already documents for `SAMURAI_LIVE_MAX_CAPITAL_USD`
    // against a real USD account, now also live on THIS path. The practical
    // effect: paper's declared "£1,000" book clamps at $1,000, which is
    // roughly £790 at a ~1.27 USD/GBP rate — about 21% under the book this
    // profile claims to size against. Left unconverted deliberately, same as
    // #949: there is no FX-rate provider in this codebase, and paper's
    // purpose is proving the clamp reaches the Trader at all (#1112), not
    // proving it reaches the exact right number. Fixing the rate is #949's
    // job, not this ticket's.
    ...(mode === 'paper' ? { capitalCeilingUsd: LIVE_BOOK_GBP } : {}),
    // #1112 follow-up — DERIVED from ADR-0018 D5, paper only: `backtest`
    // keeps `configs.traderConfig` verbatim, same scoping rationale as
    // `capitalCeilingUsd` above (backtest's cost-model calibration reads
    // `portfolio.equity` unclamped and never hits `whole_share_sizing`'s
    // floor the way a real paper fill can). `live` is untouched by
    // construction — this key only exists in `paperStartingProfile`'s
    // return, never in `liveStartingProfile`'s.
    //
    // `DEFAULT_UNIVERSE` carries no `subclass_of` entries, so every stocks
    // entry sizes on `decide.ts`'s generic ATR path (`bracket === null`),
    // not D5's frozen per-subclass bracket — that path has no deployment
    // fraction of its own to retune; the only lever is the RISK fraction
    // `max_risk_per_trade * asset_class_risk_multiplier.stocks` gets divided
    // by a live ATR-based stop. #1112 corrected `capitalCeilingUsd` from the
    // simulated broker's ~$99,876.86 funded equity to the declared $1,000
    // book (paper's `sizingEquity` is unconverted GBP-as-USD, #949) — at
    // that basis, `whole_share_sizing` (#941, mandatory: Alpaca 422s
    // fractional brackets) floors several real `DEFAULT_UNIVERSE` names to
    // zero shares (MU, GOOGL logged in #1112).
    //
    // Deployment fraction (`size * entry / equity`) on this path is
    // proportional to `asset_class_risk_multiplier.stocks` and otherwise
    // scale-invariant to equity, so #1112's own logged pre-fix risk-stage
    // figure for a real MU entry is valid evidence post-fix — but the two
    // numbers in that log line are NOT from the same tick. `trimmed notional
    // from 12939.225 to 5284.256672816591` is the Risk Manager's own record
    // for a 14:03:54Z evaluation; 99876.86 is #1112's separately-quoted
    // SESSION-OPEN equity, an earlier read. Dividing the first tick's
    // notional by a different tick's equity conflates the two and cannot be
    // trusted as the deployment fraction at either one.
    //
    // What the trim line DOES pin, without needing the equity at that tick:
    // `per_trade_size_cap`'s fraction is `RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity`
    // (0.05), and `capDial`'s `ceiling: shipped` means the feedback loop can
    // only tighten it from there, never widen it past 0.05 — so the fraction
    // live at that trim was `f <= 0.05`. A binding cap trims to exactly
    // `f * equity`, so `f * equity = 5284.256672816591`, giving
    // `equity >= 5284.256672816591 / 0.05 = 105685.13`. The Trader's
    // untrimmed ask on that SAME tick was 12939.225, so the true deployment
    // fraction is bounded — not measured — at
    // `12939.225 / 105685.13 <= 12.243%`, tighter than the 12.96% an
    // equity-conflated division gives.
    //
    // Scaling that bound by D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION (0.25,
    // the single-stock ETP cap D5 states for a DIFFERENT sizing path) shows
    // BOTH 1.9x and 2.0x clear it on this reference tick: 1.9x bounds
    // deployment at <=23.26%, and 2.0x at <=24.49% — under 0.25, not over
    // it. D5's cap does not force 1.9x over 2.0x; the real reason 1.9x is
    // chosen is conservatism, not the cap: the bound above comes from an
    // inequality on an unobserved equity, not a direct measurement, and the
    // "Caveat" paragraph below shows this path has no code-enforced ceiling
    // at all once conviction and precedent multiplier move off this
    // reference tick's values — so the smaller of two cap-clearing
    // candidates is preferred, leaving more of that unenforced margin
    // unspent. Rejected: reusing D5's frozen single-stock `stop_pct` (6.25%)
    // as a stand-in for this path's stop fraction (giving
    // 0.015625 / 0.01 = 1.5625x) — that stop is calibrated for a
    // 3x-leveraged ETP, materially more volatile than an unlevered stock's
    // realized ATR, so it understates the multiplier needed to reach the
    // same cap.
    //
    // Caveat this does not fix: this path has no code-enforced ceiling at
    // D5's 25%. At the `vol_floor_fraction` edge (the tightest stop the ATR
    // floor allows) and full conviction plus the cosine precedent's
    // MAX_MULTIPLIER (1.5, cosine-precedent.ts), deployment is
    // `max_risk_per_trade * asset_class_risk_multiplier.stocks * 1.5 /
    // (atr_k * vol_floor_fraction)` = 712.5% of equity at 1.9x (already 375%
    // at the shipped 1.0x) — a pre-existing gap this retune does not create
    // and does not close (#1135 tracks the Risk Manager caps that should
    // backstop it but currently read unclamped equity). 1.9x keeps the
    // reference tick's BOUNDED deployment under the cap; a higher-conviction
    // entry at the same realized ATR is not prevented from exceeding it.
    //
    // Structurally unreachable regardless of this multiplier: any name whose
    // share price exceeds D5's ~$250 single-stock per-position cash (25% of
    // the $1,000 book) cannot be entered in whole shares at any deployment at
    // or under that cap — e.g. MU (~$996) and GOOGL (~$342). This is
    // arithmetic, not a tuning failure, and is exactly what ADR-0016
    // anticipates: `DEFAULT_UNIVERSE`'s SPY/QQQ/AAPL/TSLA-style names are not
    // the tradeable product; LSE leveraged ETPs are. See the follow-up issue
    // this PR links for the fuller census of excluded names.
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
    // `backtest` keeps `maxConcurrentInstruments: 1` explicitly (#1013 fix-up
    // H1) rather than inheriting `buildStartingProfileConfigs()`'s `6` —
    // `tick-loop.ts`'s determinism-rationale comment is specific about why: a
    // cap of 1 makes the interleaving of stage calls across instruments
    // deterministic (outcomes come back in plan order regardless of the cap,
    // but log-insertion order and stage-call interleaving do not, at width >
    // 1). `smoke-run.ts` has always pinned this separately and explicitly for
    // the same reason; `backtest` inheriting the paper/live width of 6 here
    // WAS this PR's own regression until this override — the walk-forward
    // replay path is sequential-mode's whole reason to exist, and this keeps
    // it that way rather than making the case (option (b) considered and
    // rejected) that log-order determinism turns out not to matter to any
    // Stage-2/backtest tooling. Nobody has audited that claim, so the cheap
    // and certain fix is preserving the original guarantee, not arguing it
    // away.
    ...(mode === 'backtest' ? { maxConcurrentInstruments: 1 } : {}),
  };
}
