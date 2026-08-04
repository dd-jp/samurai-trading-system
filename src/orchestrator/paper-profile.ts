/**
 * The checked-in **paper starting profile** (ticket #323) — the eight
 * per-stage config objects `REQUIRED_INJECTED_CONFIG` demands, so that
 * `yarn orchestrator` reaches a running tick loop instead of throwing at the
 * seams guard.
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
 * ## Transports are NOT here
 *
 * This profile supplies config values only. The alert transports
 * (`heartbeatChannel`, `approvals`, `orphanAlerts`, `unpricedFillAlerts`)
 * are deliberately left to the composition root's log-only defaults — wiring
 * the real `TelegramBotApiClient` (#275) at the composition root is
 * [#322](https://github.com/dd-jp/samurai-trading-system/issues/322), not
 * this ticket. Until #322 lands, every "alert" this process raises is a log
 * line, which is enough for a supervised smoke run and explicitly not enough
 * for the unattended soak (#238).
 */
import type { CostConfig } from '../cost-model-backtest/index.js';
import type { ExecutionConfig } from '../execution/index.js';
import type { CiiConsumerConfig } from '../market-intelligence/index.js';
import type { BreakerConfig, CorrelationConfig, RiskConfig } from '../risk-manager/index.js';
import { DEFAULT_TRADER_CONFIG, type TraderConfig } from '../trader/index.js';
import type { VerdictConfig } from '../verdict/index.js';
import type { ProductionConfig } from './production.js';

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
 * makes this a calibrated number instead of a placeholder.
 */
const UNCALIBRATED_VOLATILITY_BASELINE = 1_000_000;

/**
 * The eight required config objects. Not exported directly — callers go
 * through `paperStartingProfile(mode)` so the live-mode refusal cannot be
 * bypassed by importing the values, and so each call gets its own copy.
 */
function buildProfileConfigs(): Pick<
  ProductionConfig,
  | 'traderConfig'
  | 'riskConfig'
  | 'verdictConfig'
  | 'executionConfig'
  | 'correlationConfig'
  | 'breakerConfig'
  | 'costConfig'
  | 'ciiConsumerConfig'
> {
  const traderConfig: TraderConfig = {
    // SPEC — `DEFAULT_TRADER_CONFIG` (src/trader/types.ts) is the one set of
    // sizing constants already checked in and already justified against
    // docs/research/02-staged-deployment-plan.md ("half- or quarter-Kelly,
    // never full Kelly; quarter-Kelly or less in fat-tailed markets"):
    // `max_risk_per_trade: 0.01` with `asset_class_risk_multiplier.crypto:
    // 0.5` puts a crypto entry at 0.5% of equity at maximum conviction.
    // Spread by reference, never copied — a second copy of these numbers
    // would drift from the trader's own default the first time either moves.
    ...DEFAULT_TRADER_CONFIG,
    // DERIVED — venue constraint, not a tuning knob. `SMOKE_TEST_UNIVERSE` is
    // BTC-USD (ADR-0004 §4), and Alpaca's crypto venue accepts `gtc`/`ioc`
    // only; `day` (DEFAULT_TRADER_CONFIG's value, an equities default) is
    // rejected at submission. Overriding here rather than changing the
    // trader default keeps `day` correct for the equity universe this
    // profile does not yet cover.
    time_in_force: 'gtc',
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
    max_position_size: 0.05 * PAPER_ACCOUNT_EQUITY_ANCHOR,
    /** 10% — one instrument may hold at most two max-size entries' worth. */
    per_asset_cap: 0.1 * PAPER_ACCOUNT_EQUITY_ANCHOR,
    /**
     * 20% crypto / 40% stocks. Asymmetric for the same reason
     * `asset_class_risk_multiplier` is (docs/research/02-staged-deployment-plan.md:
     * quarter-Kelly or less in fat-tailed markets) — the crypto bucket is
     * held to half the equity share of the stock bucket.
     */
    per_asset_class_cap: {
      crypto: 0.2 * PAPER_ACCOUNT_EQUITY_ANCHOR,
      stocks: 0.4 * PAPER_ACCOUNT_EQUITY_ANCHOR,
    },
    /**
     * 50% gross. DERIVED, not arbitrary: anything above 100% is leverage,
     * which nothing in the docs asks for on a first paper run, and half of
     * equity leaves the account able to absorb the full 20% drawdown limit
     * below without the caps and the breaker fighting each other.
     */
    portfolio_gross_cap: 0.5 * PAPER_ACCOUNT_EQUITY_ANCHOR,
    concentration: {
      /**
       * DERIVED — equal to the crypto asset-class cap: a cluster of
       * mutually-correlated instruments should not be able to exceed what a
       * single asset class may hold, which is the whole point of the check
       * (risk-manager-spec.md step 6).
       */
      cap: 0.2 * PAPER_ACCOUNT_EQUITY_ANCHOR,
      /**
       * UNSOURCED — 0.7 is the conventional |r| boundary for "strongly
       * correlated". Inert on today's single-instrument universe (the check
       * needs at least one *other* held instrument), so it costs nothing to
       * start strict and loosen on evidence.
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
  };

  const verdictConfig: VerdictConfig = {
    /**
     * SPEC — verdict-spec.md "Notes & Rationale": "start `manual` (human
     * confirms every real-money trade during paper / tiny-live), move to
     * `semi_auto` ..., then `auto` once live KPIs hold and trust is earned."
     *
     * Worth being explicit about what `manual` means *today*, because it is
     * not what the spec sentence implies: with no real approval transport
     * wired (#275/#322), the composition root falls back to
     * `ConsoleApprovalChannel`, which auto-approves and logs a `warn` naming
     * the trade and stating that no human reviewed it. So `manual` currently
     * buys an exercised HITL code path and an audit trail of machine consent
     * — not consent. It is still the right setting: it is what a real channel
     * will slot into unchanged, and `ConsoleApprovalChannel` refuses to be
     * constructed in live mode at all.
     */
    automation_level: { crypto: 'manual', stocks: 'manual' },
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
     * first anyway. No stock is in `SMOKE_TEST_UNIVERSE`; widening to
     * equities should re-check that interaction rather than assume it.
     */
    max_signal_age: { crypto: 5 * 60_000, stocks: 15 * 60_000 },
    /**
     * UNSOURCED, and the value most likely to be wrong: `drift_tolerance` is
     * an **absolute price distance** (`|mark.price - order.entry|`,
     * verdict/index.ts gate 2), not a fraction, so one number cannot serve
     * BTC-USD and a $200 equity. 500 is sized for BTC-USD, the only
     * instrument in `SMOKE_TEST_UNIVERSE` — roughly half a percent at a
     * six-figure BTC, i.e. wider than a 60s tick's ordinary movement but
     * still a real gate against firing on a stale bracket.
     *
     * **Widening the universe to equities requires revisiting this**, and
     * probably requires the field to become per-asset-class or fractional.
     */
    drift_tolerance: 500,
    /**
     * UNSOURCED (milliseconds). Inert while `ConsoleApprovalChannel` resolves
     * synchronously; it becomes load-bearing the moment #322 wires a real
     * channel. 15 min is a coffee-break response window, and the gate is
     * fail-safe either way — verdict-spec.md "Timeout -> no-go".
     */
    human_timeout: 15 * 60_000,
    /**
     * DERIVED — `false` is the conservative side of a gate that only applies
     * to stocks, and the smoke universe holds none. Extended-hours liquidity
     * is exactly the regime the cost model is least calibrated for.
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
      volatility_indicator: { indicator: 'atr', params: { period: 14 }, lookback: 15 },
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
     * Inert on a single-instrument universe: correlation is computed against
     * *other* held instruments, of which there are none.
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
     * A FRACTION, not a percentage: `PortfolioView.daily_pnl_pct` is
     * `(equity - last_equity) / last_equity` (production/account-state.ts),
     * and the comparison is `daily_pnl_pct <= -daily_loss_pct`. A `5` here
     * would mean 500% and never trip.
     */
    daily_loss_pct: 0.05,
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
    traderConfig,
    riskConfig,
    verdictConfig,
    executionConfig,
    correlationConfig,
    breakerConfig,
    costConfig,
    ciiConsumerConfig,
  };
}

/**
 * The profile the shipped entrypoint starts with, for the mode the operator
 * asked for — and a hard refusal to be the profile a **live** process runs on.
 *
 * The refusal is not belt-and-braces caution; it follows from what these
 * values are. The volatility breaker's baseline is uncalibrated to the point
 * of being inert, every notional cap is a fraction of an *assumed* paper
 * account balance, `drift_tolerance` is sized for one instrument, and the HITL
 * gate resolves through a channel that fabricates consent. Each of those is a
 * fine trade for a supervised paper run and none of them is acceptable against
 * real money.
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
    | 'traderConfig'
    | 'riskConfig'
    | 'verdictConfig'
    | 'executionConfig'
    | 'correlationConfig'
    | 'breakerConfig'
    | 'costConfig'
    | 'ciiConsumerConfig'
  > {
  if (mode === 'live') {
    throw new Error(
      'Orchestrator cannot start: SAMURAI_MODE=live was requested, but the shipped entrypoint ' +
        'runs on the PAPER STARTING PROFILE (src/orchestrator/paper-profile.ts) — a set of ' +
        'deliberately untuned starting values. Its volatility breaker baseline is uncalibrated ' +
        'and effectively inert, its exposure caps assume a $100,000 paper account, its drift ' +
        'tolerance is sized for BTC-USD alone, and its HITL gate resolves through a channel that ' +
        'auto-approves. None of that may decide a real-money trade. To trade live, call ' +
        'startFromEnvironment() from your own composition root with a config you have tuned ' +
        'against paper results — see ProductionConfig in src/orchestrator/production.ts.',
    );
  }

  return { ...buildProfileConfigs(), mode };
}
