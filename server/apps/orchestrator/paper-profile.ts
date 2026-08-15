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
 * - `breakerConfig.auto_rearm` — "Consulted only in 'backtest' mode; live and
 *   paper always require a manual reArm() call" (risk-manager/breakers.ts).
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
 * The Feedback Loop's `LoosenApprovalChannel` is emphatically NOT that
 * exception, despite the similar name: it returns `void` and collects no
 * answer, so #366 resolved it from `SAMURAI_ALERTS` like the outbound four and
 * the `feedback` block below names no transport either.
 */
import type { RateLimitConfig } from '../../pipeline/debate-engine/index.js';
import type { ExecutionConfig } from '../../pipeline/execution/index.js';
import type { FeedbackConfig, TunableDial } from '../../pipeline/feedback-loop/index.js';
import type {
  BreakerConfig,
  CorrelationConfig,
  RiskConfig,
} from '../../pipeline/risk-manager/index.js';
import { DEFAULT_TRADER_CONFIG, type TraderConfig } from '../../pipeline/trader/index.js';
import type { VerdictConfig } from '../../pipeline/verdict/index.js';
import type { CiiConsumerConfig } from '../../providers/market-intelligence/index.js';
import type { CostConfig } from '../../tools/backtest/index.js';
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
 * `riskConfig.portfolio_gross_cap` follows its own field comment (`DERIVED`)
 * over the block-level "UNSOURCED (all five caps)".
 */
export const PAPER_PROFILE_PROVENANCE = {
  llmBudgetUsd: 'SPEC',
  tickIntervalMs: 'DERIVED',
  universe: 'SPEC',
  'traderConfig.conviction_floor': 'SPEC',
  // #668. SPEC rather than DERIVED: close − 5 minutes is not calculated from
  // anything here, it is the value #657 resolved on 2026-08-09 and ADR-0014's
  // flat-by-close horizon is what makes it binding.
  'traderConfig.flatten_before_close_ms': 'SPEC',
  'traderConfig.max_risk_per_trade': 'SPEC',
  'traderConfig.asset_class_risk_multiplier.crypto': 'SPEC',
  'traderConfig.asset_class_risk_multiplier.stocks': 'SPEC',
  'traderConfig.atr_timeframe': 'SPEC',
  'traderConfig.atr_lookback': 'SPEC',
  'traderConfig.atr_k': 'SPEC',
  'traderConfig.vol_floor_fraction': 'SPEC',
  'traderConfig.non_converged_haircut': 'SPEC',
  'traderConfig.reward_risk_multiple': 'SPEC',
  'traderConfig.min_viable_notional': 'SPEC',
  'traderConfig.time_in_force.crypto': 'SPEC',
  'traderConfig.time_in_force.stocks': 'SPEC',
  'traderConfig.scale_in_conviction_delta': 'SPEC',
  'riskConfig.max_position_size': 'UNSOURCED',
  'riskConfig.per_asset_cap': 'UNSOURCED',
  'riskConfig.per_asset_class_cap.crypto': 'UNSOURCED',
  'riskConfig.per_asset_class_cap.stocks': 'UNSOURCED',
  'riskConfig.portfolio_gross_cap': 'DERIVED',
  'riskConfig.concentration.cap': 'DERIVED',
  'riskConfig.concentration.threshold': 'UNSOURCED',
  'riskConfig.min_viable_size': 'DERIVED',
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
  'correlationConfig.window.timeframe': 'UNSOURCED',
  'correlationConfig.window.lookback': 'UNSOURCED',
  'correlationConfig.min_bars': 'UNSOURCED',
  'breakerConfig.daily_loss_pct': 'UNSOURCED',
  'breakerConfig.daily_loss_pct_by_class.crypto': 'UNSOURCED',
  'breakerConfig.daily_loss_pct_by_class.stocks': 'UNSOURCED',
  'breakerConfig.max_drawdown_pct': 'SPEC',
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
  'feedback.config.risk_thresholds.max_position_size.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.max_position_size.floor': 'DERIVED',
  'feedback.config.risk_thresholds.max_position_size.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.max_position_size.tighten_is': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_cap.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_cap.floor': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_cap.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_cap.tighten_is': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_crypto.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_crypto.floor': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_crypto.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_crypto.tighten_is': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_stocks.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_stocks.floor': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_stocks.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.per_asset_class_cap_stocks.tighten_is': 'DERIVED',
  'feedback.config.risk_thresholds.portfolio_gross_cap.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.portfolio_gross_cap.floor': 'DERIVED',
  'feedback.config.risk_thresholds.portfolio_gross_cap.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.portfolio_gross_cap.tighten_is': 'DERIVED',
  'feedback.config.risk_thresholds.concentration_cap.max_step': 'DERIVED',
  'feedback.config.risk_thresholds.concentration_cap.floor': 'DERIVED',
  'feedback.config.risk_thresholds.concentration_cap.ceiling': 'DERIVED',
  'feedback.config.risk_thresholds.concentration_cap.tighten_is': 'DERIVED',
  'feedback.config.kill_thresholds.max_pbo': 'SPEC',
  'feedback.config.kill_thresholds.min_oos_sharpe': 'SPEC',
  'feedback.config.kill_thresholds.min_deflated_sharpe': 'SPEC',
  'feedback.config.kill_thresholds.max_live_backtest_divergence': 'UNSOURCED',
  'feedback.metrics.backtest_reference_sharpe': 'SPEC',
} as const satisfies Record<string, ValueProvenance>;

/**
 * The equity the notional caps below are expressed against.
 *
 * `UNSOURCED` as a repo fact; `SPEC`-adjacent as a venue fact: an Alpaca paper
 * account is provisioned with $100,000 of simulated buying power by default,
 * and CLAUDE.md's MVP path is Alpaca paper trading. Every `riskConfig` cap is
 * written as an explicit fraction of this anchor rather than as a bare number,
 * so re-scaling to a differently-funded paper account is one edit here rather
 * than five unrelated ones — and so the intent (5% of equity, 20% of equity)
 * survives in the source instead of being lost in a rounded literal.
 *
 * If your paper account is not funded at $100k, change this. The caps are
 * meaningless in absolute terms.
 */
export const PAPER_ACCOUNT_EQUITY_ANCHOR = 100_000;

/**
 * The guardrail band for every `risk_thresholds` dial (#433), as fractions of
 * the cap this profile ships. See `capDial` for why the ceiling is the shipped
 * value and the floor is not zero.
 */
export const PAPER_RISK_THRESHOLD_FLOOR_FRACTION = 0.25;
export const PAPER_RISK_THRESHOLD_STEP_FRACTION = 0.1;

/**
 * The notional caps as FRACTIONS of whatever equity anchor a profile declares
 * (#433, generalised by #511).
 *
 * The fractions are the decision; the dollars are arithmetic. Keeping them in
 * that order is what lets the live profile (live-profile.ts) express the same
 * ladder against a declared capital ceiling instead of a $100,000 paper
 * account, without a second copy of six numbers that would drift the first
 * time either profile moved.
 *
 * Each fraction's justification stays at its `riskConfig` field, not here.
 */
export const RISK_CAP_EQUITY_FRACTIONS = {
  max_position_size: 0.05,
  per_asset_cap: 0.1,
  per_asset_class_cap_crypto: 0.2,
  per_asset_class_cap_stocks: 0.4,
  portfolio_gross_cap: 0.5,
  concentration_cap: 0.2,
} as const;

/** The six caps, in account currency. */
export type RiskCaps = Record<keyof typeof RISK_CAP_EQUITY_FRACTIONS, number>;

/**
 * The notional caps for one equity anchor, derived once (#433).
 *
 * They are consumed in two places that must not drift: `riskConfig` below (the
 * values a run starts from, and the seed for the `risk_thresholds` table) and
 * `feedback.config.risk_thresholds` (the guardrail band those values may move
 * within). Written as literals in both, an edit to one would silently leave
 * the other bounding a cap that no longer exists — with the dial's ceiling
 * then sitting above or below the value it is supposed to bound. So both read
 * this.
 */
export function riskCapsFor(equityAnchorUsd: number): RiskCaps {
  return Object.fromEntries(
    Object.entries(RISK_CAP_EQUITY_FRACTIONS).map(([name, fraction]) => [
      name,
      fraction * equityAnchorUsd,
    ]),
  ) as RiskCaps;
}

export const PAPER_RISK_CAPS: RiskCaps = riskCapsFor(PAPER_ACCOUNT_EQUITY_ANCHOR);

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
 *   open, deliberately: at ADR-0008's 15-minute cadence attribution runs over
 *   near-empty samples, so weights barely leave their seeds across a whole
 *   soak, and a mechanism fed noise is indistinguishable from one that works
 *   (#430). So this is a KNOWN GAP awaiting a cadence that produces trades,
 *   not a decision that weights are unread by design. See the `weights` dial
 *   below for what does move them.
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
function buildFeedbackConfig(caps: RiskCaps): FeedbackConfig {
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
     * `DERIVED` — descriptive only for a weight. `runDailyCycle` passes
     * `gate_loosening: false` for weights (they "tune freely within bounds"),
     * so this only labels the `Adjustment.direction` written to the audit log.
     * `decrease` because less influence for a lens is the safer direction, the
     * same reading `TunableDial`'s doc gives for `max_position_size`.
     */
    tighten_is: 'decrease',
  };

  /**
   * A guardrail band for one notional cap (#433), expressed relative to the
   * value this profile ships — so the band re-scales with the profile's equity
   * anchor instead of pinning absolute dollars that silently mean something
   * different on a differently-funded account. Since #511 that matters twice
   * over: the same builder produces a live profile anchored to a declared
   * capital ceiling, where a band left pinned to $100,000 would bound a $2,000
   * run's cap at fifty times the cap itself.
   *
   * `ceiling` is the shipped value itself, and that asymmetry is the safety
   * posture, not an oversight: a kill-line breach may tighten a cap far below
   * what the profile chose, and a human-approved recovery may walk it back UP
   * to — never past — the value a human already reviewed here. Loosening
   * beyond the checked-in profile is a config change, not a tuning step.
   *
   * `floor` at a quarter keeps the dial from tightening to zero: a cap of 0
   * rejects every intent, which is indistinguishable from a broken pipeline
   * and is the wrong way for a *tuning* mechanism to stop trading. Killing the
   * run is the operator's call on the breach alert.
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
     * Bounds come from `capDial`, relative to the shipped cap rather than
     * absolute, so they re-scale with the profile's equity anchor — the paper
     * account's assumed balance here, a declared capital ceiling in the live
     * profile (#511). `caps` is the same object `riskConfig` above was built
     * from, so the two cannot describe different numbers.
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
 * them — see that field's comment. Both are ~3x #385's measured cadence.
 */
const CRYPTO_MAX_DEBATES_PER_WINDOW = 20;
const STOCKS_MAX_DEBATES_PER_WINDOW = 15;

/**
 * The eight required config objects, plus the optional ninth seam (#366),
 * expressed against a declared equity anchor.
 *
 * **Exported for exactly one caller: `liveStartingProfile` (live-profile.ts,
 * #511).** The live profile is specified as "the same shape, but every figure
 * the paper profile pins to a $100,000 assumption derived from a declared
 * capital ceiling instead" — so it must be the SAME builder with a different
 * anchor, not a copy. A copy is how the two would silently disagree about a
 * dial the day either one is retuned, and the live one is the copy nobody
 * exercises.
 *
 * That sharing is also the honest statement of what a live run inherits: every
 * value here that is not anchored to equity is inherited UNCHANGED and
 * UNTUNED. See live-profile.ts's header for the enumerated list.
 *
 * `paperStartingProfile(mode)` remains the paper entry point, so the live-mode
 * refusal there cannot be bypassed by importing the values, and each call gets
 * its own copy.
 */
export function buildStartingProfileConfigs(equityAnchorUsd: number): Pick<
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
  Required<Pick<ProductionConfig, 'rateLimiterConfig' | 'llmBudgetUsd' | 'tickIntervalMs'>> {
  const caps = riskCapsFor(equityAnchorUsd);

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
    /** 5% of equity — the Trader's own 0.5-1% *risk* budget becomes a much larger *notional* once divided by a ~1-2% ATR stop, so this is the cap that actually binds first on BTC-USD. */
    max_position_size: caps.max_position_size,
    /** 10% — one instrument may hold at most two max-size entries' worth. */
    per_asset_cap: caps.per_asset_cap,
    /**
     * 20% crypto / 40% stocks. Asymmetric for the same reason
     * `asset_class_risk_multiplier` is (docs/research/02-staged-deployment-plan.md:
     * quarter-Kelly or less in fat-tailed markets) — the crypto bucket is
     * held to half the equity share of the stock bucket.
     */
    per_asset_class_cap: {
      crypto: caps.per_asset_class_cap_crypto,
      stocks: caps.per_asset_class_cap_stocks,
    },
    /**
     * 50% gross. DERIVED, not arbitrary: anything above 100% is leverage,
     * which nothing in the docs asks for on a first paper run, and half of
     * equity leaves the account able to absorb the full 20% drawdown limit
     * below without the caps and the breaker fighting each other.
     */
    portfolio_gross_cap: caps.portfolio_gross_cap,
    concentration: {
      /**
       * DERIVED — equal to the crypto asset-class cap: a cluster of
       * mutually-correlated instruments should not be able to exceed what a
       * single asset class may hold, which is the whole point of the check
       * (risk-manager-spec.md step 6).
       */
      cap: caps.concentration_cap,
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
     */
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
  };

  const verdictConfig: VerdictConfig = {
    /**
     * DECIDED (David, 2026-08-06) — `auto` for both classes, in **paper and
     * live**. See ADR-0007. This deliberately overrides verdict-spec.md's
     * "Notes & Rationale" staging ("start `manual` ..., then `auto` once live
     * KPIs hold"); that sentence has been amended rather than left to
     * contradict this value.
     *
     * **The reason is throughput, and it is a measured one, not a preference.**
     * `runTickPlan` runs instruments at `max_concurrent_instruments`, which is
     * `1` (tick-loop.ts, and see `maxConcurrentInstruments` in production.ts
     * for why raising it is not free), and `VerdictImpl.decide` *awaits*
     * `approvals.requestApproval` inside the instrument pass. So a single
     * pending approval blocks every other instrument for up to
     * `human_timeout`. At the soak's cadence one un-answered tap costs the
     * whole universe a full cycle. A human in this loop is a serialization
     * point, not a safety net.
     *
     * **What this removes, stated plainly.** Gate 6 is now unreachable: the
     * dial short-circuits `shouldEngageHitl` to `false` before `isFlagged` is
     * consulted, so no trade is ever routed to a human, and
     * `ProductionConfig.approvals` is never called. `flag_thresholds` and
     * `human_timeout` below are inert by construction — kept, with the flag
     * plumbing, so that turning the dial back is a config edit rather than a
     * re-implementation.
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
     * Sized against the right clock, which is the trap here. Gate 1 measures
     * `now - order.decision_timestamp`, and `decision_timestamp` is
     * `mark.observed_at` (trader/decide.ts) — the *quote's own* timestamp
     * (`AlpacaDataSource.fetchLiveObservation`), deliberately not
     * `clock.now()`, so a crash-restart re-deciding the same bar keeps its
     * idempotency key. It is emphatically NOT the ATR bar's close time: were
     * it, a 5-minute bound under a `'1h'` `atr_timeframe` would no-go every
     * trade on staleness forever. For BTC-USD, which quotes continuously,
     * `observed_at` lands within seconds of the decision.
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
     * - **Nothing is waved through.** Gate 1 (staleness) runs *before* gate 4
     *   (market-open), so when both would fire — an equity signal decided in
     *   yesterday's session, evaluated against a shut market — the staleness
     *   bound is what rejects it, at ~17 hours against a 15-minute bound. The
     *   market-open gate never gets the chance to be the one that catches it.
     *   Both answers are `no_go`; only the recorded `no_go_reason` differs.
     * - **So the reason code is the thing to read carefully in a soak log,**
     *   and it is pinned by test rather than left to be rediscovered:
     *   `market_closed` appears only for the narrow case where the mark is
     *   FRESH but the session shut between the decision and the gate — a tick
     *   that started at 15:59 ET and reached Verdict after the close. That is
     *   the case gate 4 uniquely catches, and it is the case that matters,
     *   because a fresh mark is exactly the input a staleness bound cannot
     *   reject.
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
     * UNSOURCED (milliseconds). Inert while `ConsoleApprovalChannel` resolves
     * synchronously; it becomes load-bearing the moment a real approval
     * channel is wired (#275's remaining half — #322 wired the outbound alerts
     * only). 15 min is a coffee-break response window, and the gate is
     * fail-safe either way — verdict-spec.md "Timeout -> no-go".
     */
    human_timeout: 15 * 60_000,
    /**
     * DERIVED — `false` is the conservative side of a gate that only applies
     * to stocks. It stops being hypothetical with `DEFAULT_UNIVERSE` (#381):
     * four equities now reach gate 4, and `false` is what makes
     * `tradingCalendar.isOpen(now)` authoritative for them. Extended-hours
     * liquidity is exactly the regime the cost model is least calibrated for.
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
     * SPEC — CONTEXT.md "Drawdown": "Live system target: max ~20-25%";
     * risk-manager-spec.md "Module: Circuit Breakers" ("~20-25% target per
     * CONTEXT.md"); docs/research/02-staged-deployment-plan.md's proceed
     * criteria ("drawdown < ~20-25%"). The conservative end of the stated
     * range. Again a fraction — `drawdown_pct` is `(peak - equity) / peak`
     * (risk-manager/portfolio-view.ts).
     *
     * Hard and sticky: re-arming requires a deliberate `reArm()` call in
     * paper and live alike (spec story 16).
     */
    max_drawdown_pct: 0.2,
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
     * Inert in paper — "Consulted only in 'backtest' mode; live and paper
     * always require a manual reArm() call" (risk-manager/breakers.ts).
     * DERIVED for the backtest path: re-arm once drawdown has halved back
     * from the 20% hard limit, or after 5 days, whichever comes first (spec
     * story 21 — so a backtest does not halt forever on its first hit).
     */
    auto_rearm: { recovery_drawdown_pct: 0.1, max_days_tripped: 5 },
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
     * DERIVED from the budget above — 15 minutes, up from the 60s
     * `DEFAULT_TICK_INTERVAL_MS`.
     *
     * The arithmetic, from #400's resolution comment (which counted
     * instrument-passes/day at 60s as 2 × 1,440 crypto + 4 × 390 stocks =
     * 4,440, against the ~$45/day estimate in this file):
     *
     *   60s   -> 4,440 passes/day -> ~$45/day  -> ~$630 / 14d
     *   15min ->   296 passes/day -> ~$3.0/day -> ~$42  / 14d
     *
     * 15 min rather than the ~12.6 min the budget divides to exactly: the
     * saving is an upper bound (see `llmBudgetUsd`), so the margin is
     * deliberate, and a round number is easier to reason about in a soak log.
     *
     * **This is NOT #400's decision, and does not overturn it.** David chose
     * crypto 2 min / stocks 5 min there, for a run whose budget is a live
     * budget. Those are per-asset-class cadences and the gating that makes
     * them expressible is #397's Phase 1, which is not built — today there is
     * one base interval for every instrument. So this single value is what a
     * $50 paper soak reduces to on the machinery that exists. A live run
     * supplies its own `tickIntervalMs` (and, once #397 lands, its own
     * per-class cadences) from a composition root with a live budget.
     *
     * No dial needs retuning to go slower: #400 established that
     * `max_signal_age` and `drift_tolerance_pct` both measure WITHIN-pass
     * intervals (`decision_timestamp` is the pass's own `mark.observed_at`,
     * and `getMark` re-fetches unconditionally with no TTL cache), so the tick
     * interval never enters either gate's arithmetic.
     */
    tickIntervalMs: 15 * 60_000,
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
     * > `DEFAULT_TICK_INTERVAL_MS`. This profile now sets
     * > `tickIntervalMs: 15 * 60_000`, so the ~$45/day figure is the BEFORE
     * > number, not what a soak on this profile costs — that is ~$3/day, ~$42
     * > over 14 days, and it is capped at $50 by `llmBudgetUsd` regardless.
     * > The *reasoning* below is what survived the change and is why the cap
     * > exists: the cycle is `pass duration + interval`, so spend does not
     * > scale linearly with cadence and no arithmetic here can promise a
     * > dollar figure.
     *
     * The naive reading is that six instruments is six times the debate spend
     * of one. It is closer to **1.6x**, and the reason is worth writing down
     * because it also answers whether the tick loop can keep up:
     * `startTickLoop` is a `setTimeout` CHAIN, not a fixed-cadence
     * `setInterval` — the next tick is scheduled only once the previous pass
     * has finished. With `maxConcurrentInstruments: 1` a pass runs its
     * instruments sequentially, so widening the universe stretches the
     * effective cadence instead of multiplying the tick count. Nothing stacks,
     * nothing is skipped, and the "tick skipped: previous tick still running"
     * warn stays unreachable.
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
    universe: DEFAULT_UNIVERSE,
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
     * > **The cadence these were derived from is 15x faster than the one this
     * > profile now runs (ADR-0008: `tickIntervalMs` 60s -> 15 min).** Left
     * > unchanged deliberately: this budget is a RUNAWAY guard, and an
     * > oversized ceiling is permissive rather than wrong — it refuses only
     * > pathological rates, which is exactly its job. Retuning it down to the
     * > new cadence would make it a second, redundant cost control and put it
     * > in conflict with `llmBudgetUsd`, which is the actual budget. Read the
     * > arithmetic below as "the rate at which something has gone wrong", not
     * > as a description of the soak's cadence.
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
      config: buildFeedbackConfig(caps),
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
 * of being inert, every notional cap is a fraction of an *assumed* paper
 * account balance, `drift_tolerance` is sized for one instrument, and its
 * cadence and LLM budget are sized for a $50 paper soak rather than for a run
 * that is trying to make money. Each of those is a fine trade for a paper run
 * and none of them is acceptable against real money — the more so since
 * ADR-0007, which removed the human gate that used to sit behind them.
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
    | 'correlationConfig'
    | 'breakerConfig'
    | 'costConfig'
    | 'ciiConsumerConfig'
    | 'feedback'
  > &
  Required<Pick<ProductionConfig, 'rateLimiterConfig' | 'llmBudgetUsd' | 'tickIntervalMs'>> {
  if (mode === 'live') {
    throw new Error(
      'Orchestrator cannot start: SAMURAI_MODE=live was requested against the PAPER STARTING ' +
        'PROFILE (server/apps/orchestrator/paper-profile.ts) — a set of deliberately untuned starting ' +
        'values. Its volatility breaker baseline is uncalibrated and effectively inert, its ' +
        'exposure caps assume a $100,000 paper account, its drift tolerance is a fraction ' +
        'nobody has yet observed against a real fill, and its cadence and LLM budget are sized ' +
        'for a $50 paper soak rather than for a run trying to make money. Since ADR-0007 it ' +
        'also runs with NO human gate at all (automation_level: auto for both classes), which ' +
        'makes the circuit breakers and the notional caps the only stop. None of that may ' +
        'decide a real-money trade. ' +
        LIVE_MONEY_GATE_SUMMARY +
        ' The live path is liveStartingProfile() in server/apps/orchestrator/live-profile.ts, which ' +
        'derives its caps from SAMURAI_LIVE_MAX_CAPITAL_USD instead of a paper balance; or ' +
        'call startFromEnvironment() from your own composition root with a config you have ' +
        'tuned against paper results — see ProductionConfig in server/apps/orchestrator/production.ts.',
    );
  }

  return { ...buildStartingProfileConfigs(PAPER_ACCOUNT_EQUITY_ANCHOR), mode };
}
