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
 * ## Transports are NOT here
 *
 * This profile supplies config values only, and deliberately names no
 * transport. That is not the same as leaving them unwired:
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
import type { CostConfig } from '../cost-model-backtest/index.js';
import type { ExecutionConfig } from '../execution/index.js';
import type { FeedbackConfig, TunableDial } from '../feedback-loop/index.js';
import type { CiiConsumerConfig } from '../market-intelligence/index.js';
import type { BreakerConfig, CorrelationConfig, RiskConfig } from '../risk-manager/index.js';
import { DEFAULT_TRADER_CONFIG, type TraderConfig } from '../trader/index.js';
import type { VerdictConfig } from '../verdict/index.js';
import { SqliteDailyEquityMetricsSource } from './production/daily-equity-metrics-source.js';
import {
  DEFAULT_FEEDBACK_INTERVAL_MS,
  type FeedbackCycleConfig,
  type ProductionConfig,
} from './production.js';
import { SqliteDailyEquityStore } from './sqlite-daily-equity-store.js';

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
 *   weights at debate time; that is a recorded decision, not an oversight —
 *   see the `weights` dial below.
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
function buildFeedbackConfig(): FeedbackConfig {
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
     * fractions of `PAPER_ACCOUNT_EQUITY_ANCHOR` instead of rounded literals:
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

  return {
    attribution_window_ms,
    weights,
    /**
     * `UNSOURCED` — spec story 3 asks only for "small" shadow credit. 0.1 is
     * read on `influence_score`'s own 0.0-1.0 scale (`computeInfluenceScore`,
     * debate-engine/analyst-contribution.ts): the term is
     * `shadow_credit * correctness` against an influence term of
     * `influence_score * correctness`, so this says a quietly-correct analyst
     * is credited as if it had held 0.1 of the debate's influence.
     *
     * Worth knowing before tuning it: `computeInfluenceScore` is a
     * stance-CHANGE metric, and scores 0 for an analyst that never shifted
     * position across rounds — the common case. So in practice this term, not
     * the influence-weighted one, carries most of the attribution signal in a
     * paper soak. It is upside-only (attribution.ts), so it cannot deepen a
     * wrong analyst's penalty; the risk of raising it is that a quiet correct
     * call counts for as much as a loud one.
     */
    shadow_credit: 0.1,
    /**
     * `UNSOURCED` — the `influence_score` at or below which an analyst counts
     * as "quiet". 0.2 on the same 0.0-1.0 scale, i.e. an analyst that shifted
     * stance in at most one round transition in five. Deliberately near the
     * bottom: shadow credit exists so a quietly-correct analyst can climb
     * back, and a generous ceiling would hand it to analysts that did sway the
     * debate and are already paid for it by the influence term.
     */
    shadow_influence_ceiling: 0.2,
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
    risk_thresholds: {},
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
function buildDailyMetrics(): NonNullable<FeedbackCycleConfig['metrics']> {
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
 * The eight required config objects, plus the optional ninth seam (#366). Not
 * exported directly — callers go through `paperStartingProfile(mode)` so the
 * live-mode refusal cannot be bypassed by importing the values, and so each
 * call gets its own copy.
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
  | 'feedback'
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
     * wired (#275's remaining half — #322 wired the outbound alert channels,
     * which are a different seam), the composition root falls back to
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
     * synchronously; it becomes load-bearing the moment a real approval
     * channel is wired (#275's remaining half — #322 wired the outbound alerts
     * only). 15 min is a coffee-break response window, and the gate is
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
     * A FRACTION, not a percentage: `PortfolioView.daily_pnl.portfolio.pct` is
     * `(realized + unrealized) / session-open equity` since 00:00 UTC (#332 —
     * orchestrator/sqlite-session-equity-store.ts, risk-manager/portfolio-view.ts),
     * and the comparison is `pct <= -daily_loss_pct`. A `5` here would mean
     * 500% and never trip.
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
    /**
     * The ninth seam (#366), and the only optional one here.
     *
     * Values only, exactly like the other eight: no `approvals` transport and
     * no `intervalMs`, so the composition root's `SAMURAI_ALERTS`-selected
     * channel and its 24h default apply.
     */
    feedback: {
      config: buildFeedbackConfig(),
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
    | 'feedback'
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
