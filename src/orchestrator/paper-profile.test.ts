/**
 * Tests for the checked-in paper starting profile (#323).
 *
 * The profile's job is narrow: satisfy `REQUIRED_INJECTED_CONFIG` with values
 * that are internally consistent, so `yarn orchestrator` boots to a tick loop
 * instead of throwing at the seams guard. These tests pin the properties that
 * make it *usable* rather than merely *present* — a profile that boots and
 * then rejects or halts everything is indistinguishable, at a glance, from a
 * clean run that decided not to trade (`SMOKE_TEST_UNIVERSE`'s doc comment).
 */
import { InMemoryDebateLogStore, LATENCY_BUDGET_MS } from '../debate-engine/index.js';
import {
  InMemoryClosedTradeStore,
  InMemoryTuningStore,
  runDailyCycle,
} from '../feedback-loop/index.js';
import { SimulatedClock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { DEFAULT_TRADER_CONFIG } from '../trader/index.js';
import { REQUIRED_INJECTED_CONFIG } from './index.js';
import { PAPER_ACCOUNT_EQUITY_ANCHOR, paperStartingProfile } from './paper-profile.js';
import { SqliteDailyEquityMetricsSource } from './production/daily-equity-metrics-source.js';
import { DEFAULT_FEEDBACK_INTERVAL_MS } from './production.js';

describe('paperStartingProfile', () => {
  it('supplies every dependency REQUIRED_INJECTED_CONFIG demands', () => {
    const profile = paperStartingProfile('paper');

    for (const key of REQUIRED_INJECTED_CONFIG) {
      expect(profile[key]).toBeDefined();
    }
  });

  /**
   * #381 — the profile now names the universe it was tuned for, and the five
   * dials that were only ever correct for one crypto instrument.
   */
  describe('the full ADR-0001 universe', () => {
    it('supplies DEFAULT_UNIVERSE, so a paper start is not the smoke set by omission', () => {
      // `ProductionConfig.universe` defaults to `SMOKE_TEST_UNIVERSE` and
      // nothing used to override it, which is why a live paper run logged
      // `universe: ["BTC-USD"]`. The profile is where that is answered,
      // because which instruments a paper run trades is a tuning decision of
      // the same kind as every other value in this file.
      const { universe } = paperStartingProfile('paper');

      expect(universe?.map((instrument) => instrument.asset)).toEqual([
        'SPY',
        'QQQ',
        'AAPL',
        'TSLA',
        'BTC-USD',
        'ETH-USD',
      ]);
    });

    it('covers both asset classes, so no per-class dial reads as inert', () => {
      // The startup warn this removes: "no instruments configured for asset
      // class; volatility breaker reads 0 (inert) for this class {stocks}".
      const { universe } = paperStartingProfile('paper');
      const classes = new Set(universe?.map((instrument) => instrument.asset_class));

      expect([...classes].sort()).toEqual(['crypto', 'stocks']);
    });

    it('sizes drift tolerance as a fraction, so a $200 equity has a real gate', () => {
      // The absolute 500 this replaces was 250% of a $200 instrument — a
      // staleness gate that could never fire. Asserted as the resulting
      // dollar bound rather than as the fraction, because the bound is the
      // thing that was wrong.
      const { verdictConfig } = paperStartingProfile('paper');

      const equityBound = 200 * verdictConfig.drift_tolerance_pct.stocks;
      expect(equityBound).toBeLessThan(5);
      expect(equityBound).toBeGreaterThan(0);

      // ...and BTC-USD keeps the calibration the absolute value encoded: 500
      // at a ~$100k entry, which is what 0.5% re-expresses.
      expect(100_000 * verdictConfig.drift_tolerance_pct.crypto).toBeCloseTo(500, 10);
    });

    it('keeps size_over inert, because manual short-circuits before flags are read', () => {
      // `size_over: 0` is unit-incommensurable across fractional BTC and
      // whole-share SPY, and widening the universe made that worse rather
      // than better. It stays harmless only while `automation_level` is
      // `manual` for BOTH classes — `shouldEngageHitl` returns true on that
      // check before `isFlagged` is ever called. Pinned so turning either
      // class to `semi_auto` fails here first.
      const { verdictConfig } = paperStartingProfile('paper');

      expect(verdictConfig.automation_level.crypto).toBe('manual');
      expect(verdictConfig.automation_level.stocks).toBe('manual');
      expect(verdictConfig.flag_thresholds.size_over).toBe(0);
    });

    it('leaves the stocks staleness bound well clear of one debate latency budget', () => {
      // `LATENCY_BUDGET_MS.stocks` is 60s and `decision_timestamp` is the
      // quote's own `observed_at`, so the signal-producing pipeline cannot
      // approach this bound. If it ever could, every equity order would
      // no-go on staleness and the soak would silently trade crypto only.
      const { verdictConfig } = paperStartingProfile('paper');

      expect(verdictConfig.max_signal_age.stocks).toBeGreaterThan(10 * LATENCY_BUDGET_MS.stocks);
    });

    it('correlates over a window Alpaca can serve on tick 1, so #303 is not reachable here', () => {
      // The #303 warm-up blind spot needs a pair with fewer than `min_bars`
      // overlapping returns. `MarketDataServiceImpl.getBars` fetches from the
      // source on every call rather than accumulating locally, so a cold
      // first tick pulls the whole window from Alpaca's archive — and every
      // instrument in `DEFAULT_UNIVERSE` has years of daily history. This
      // pins the relationship the decision rests on: the window is a daily
      // one, and short enough that a long-listed instrument always clears it.
      const { correlationConfig } = paperStartingProfile('paper');

      expect(correlationConfig.window.timeframe).toBe('1d');
      expect(correlationConfig.min_bars).toBeLessThan(correlationConfig.window.lookback);
    });
  });

  it('refuses live mode — these values are uncalibrated starting points', () => {
    // The whole point of the profile is that nobody has tuned it yet: the
    // volatility baseline is uncalibrated, the notional caps assume a paper
    // account's default equity, and the HITL gate is auto-approved by
    // `ConsoleApprovalChannel`. None of that may reach real money by way of
    // the shipped entrypoint.
    expect(() => paperStartingProfile('live')).toThrow(/live/i);
    expect(() => paperStartingProfile('live')).toThrow(/PAPER_STARTING_PROFILE|paper/i);
  });

  it('carries the resolved mode through so paper is what the root is built with', () => {
    expect(paperStartingProfile('paper').mode).toBe('paper');
    expect(paperStartingProfile('backtest').mode).toBe('backtest');
  });

  it('orders the risk caps monotonically, so no cap is unreachable', () => {
    // The Risk pipeline trims per-trade -> per-asset -> per-asset-class ->
    // portfolio (risk-manager-spec.md "Check Pipeline"). If an outer cap were
    // tighter than an inner one, the inner one could never bind and the
    // `binding_constraint` audit field would name the wrong step.
    const { riskConfig } = paperStartingProfile('paper');

    expect(riskConfig.max_position_size).toBeLessThanOrEqual(riskConfig.per_asset_cap);
    expect(riskConfig.per_asset_cap).toBeLessThanOrEqual(riskConfig.per_asset_class_cap.crypto);
    expect(riskConfig.per_asset_cap).toBeLessThanOrEqual(riskConfig.per_asset_class_cap.stocks);
    expect(riskConfig.per_asset_class_cap.crypto).toBeLessThanOrEqual(
      riskConfig.portfolio_gross_cap,
    );
    expect(riskConfig.per_asset_class_cap.stocks).toBeLessThanOrEqual(
      riskConfig.portfolio_gross_cap,
    );
    expect(riskConfig.concentration.cap).toBeGreaterThanOrEqual(riskConfig.max_position_size);
  });

  it('keeps every cap inside the account equity it is anchored to', () => {
    // Gross exposure above equity is leverage. Nothing in the docs asks for
    // leverage on a first paper run, and an Alpaca paper account would reject
    // it anyway.
    const { riskConfig } = paperStartingProfile('paper');

    expect(riskConfig.portfolio_gross_cap).toBeLessThanOrEqual(PAPER_ACCOUNT_EQUITY_ANCHOR);
  });

  it("does not set Risk's dust floor above the Trader's minimum notional", () => {
    // If Risk's floor were the higher of the two, every intent the Trader
    // considered viable would be trimmed and then rejected as dust — a run
    // that boots and never trades.
    const { riskConfig, traderConfig } = paperStartingProfile('paper');

    expect(riskConfig.min_viable_size).toBeLessThanOrEqual(traderConfig.min_viable_notional);
  });

  it('reuses DEFAULT_TRADER_CONFIG rather than restating its values', () => {
    // One source of truth for the sizing constants: a copy here would drift
    // silently from `src/trader/types.ts`.
    const { traderConfig } = paperStartingProfile('paper');

    expect(traderConfig.conviction_floor).toBe(DEFAULT_TRADER_CONFIG.conviction_floor);
    expect(traderConfig.max_risk_per_trade).toBe(DEFAULT_TRADER_CONFIG.max_risk_per_trade);
    expect(traderConfig.asset_class_risk_multiplier).toEqual(
      DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier,
    );
  });

  it('uses a time-in-force each venue accepts, per asset class (#381)', () => {
    // Alpaca crypto orders take `gtc`/`ioc` and reject `day` at submission;
    // equities take `day`. A boot that dies on its first order is not a boot,
    // and with a two-asset-class universe a single value guarantees one of the
    // two halves dies. Both are asserted here, not just crypto's, because the
    // failure this pins is precisely "the value that was right for the old
    // universe is wrong for the new one".
    const { traderConfig } = paperStartingProfile('paper');

    expect(['gtc', 'ioc']).toContain(traderConfig.time_in_force.crypto);
    expect(traderConfig.time_in_force.stocks).toBe('day');
  });

  it('requires a human on every trade, per the staged-deployment dial', () => {
    // verdict-spec.md "Notes & Rationale": start `manual` (a human confirms
    // every trade during paper / tiny-live), open up as trust is earned.
    const { verdictConfig } = paperStartingProfile('paper');

    expect(verdictConfig.automation_level.crypto).toBe('manual');
    expect(verdictConfig.automation_level.stocks).toBe('manual');
  });

  it('bounds the hard drawdown breaker at the documented target, as a fraction', () => {
    // CONTEXT.md "Drawdown": max ~20-25%. `PortfolioView.drawdown_pct` is
    // computed as `(peak - equity) / peak` (portfolio-view.ts) — a FRACTION,
    // despite the `_pct` name. A `20` here would mean 2000% and never trip.
    const { breakerConfig } = paperStartingProfile('paper');

    expect(breakerConfig.max_drawdown_pct).toBe(0.2);
    expect(breakerConfig.daily_loss_pct).toBeGreaterThan(0);
    expect(breakerConfig.daily_loss_pct).toBeLessThan(breakerConfig.max_drawdown_pct);
  });

  it('leaves the volatility baseline finite, so the fail-closed sentinel still trips', () => {
    // `MarketDataVolatilityReadingProvider` aggregates a failed/non-finite
    // indicator read in as `Infinity` to trip the breaker conservatively. A
    // baseline of `Infinity` (or one large enough that `baseline * multiplier`
    // overflows to `Infinity`) would make `reading > baseline * multiplier`
    // false even for that sentinel, silently disabling the fail-closed path.
    const { breakerConfig } = paperStartingProfile('paper');
    const { baseline, multiplier } = breakerConfig.volatility;

    expect(Number.isFinite(baseline.crypto * multiplier)).toBe(true);
    expect(Number.isFinite(baseline.stocks * multiplier)).toBe(true);
    expect(Number.POSITIVE_INFINITY > baseline.crypto * multiplier).toBe(true);
  });

  it('polls CII inside the cadence ADR-0002 fixed, even though the feed is parked', () => {
    // ADR-0002 §2: WorldMonitor polls on its own decoupled cadence, 5-15 min.
    const { ciiConsumerConfig } = paperStartingProfile('paper');

    expect(ciiConsumerConfig.pollIntervalMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(ciiConsumerConfig.pollIntervalMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it('charges above the cost model’s structural non-zero floor on both classes', () => {
    // cost-model-backtest-spec.md Principle 1: no config may manufacture a
    // frictionless fill. `CostModelImpl` floors at 1bp; a profile at or under
    // that floor would be silently replaced by it rather than modelling the
    // venue's real frictions.
    const { costConfig } = paperStartingProfile('paper');

    for (const assetClass of ['crypto', 'stocks'] as const) {
      expect(costConfig[assetClass].commissionRate).toBeGreaterThan(0.0001);
      expect(costConfig[assetClass].spreadVolatilityCoefficient).toBeGreaterThan(0);
      expect(costConfig[assetClass].slippageCoefficient).toBeGreaterThan(0);
      expect(costConfig[assetClass].impactK).toBeGreaterThan(0);
    }
    // Crypto taker fees are materially worse than a US equity commission
    // (cost-model-backtest-spec.md story 4).
    expect(costConfig.crypto.commissionRate).toBeGreaterThan(costConfig.stocks.commissionRate);
  });

  it('returns a fresh object each call, so a caller cannot mutate the profile', () => {
    const first = paperStartingProfile('paper');
    const second = paperStartingProfile('paper');

    expect(first).not.toBe(second);
    expect(first.riskConfig).not.toBe(second.riskConfig);
    // Includes the nested #366 block: a caller that mutated a dial's bounds
    // would otherwise be editing the next run's safety limits.
    expect(first.feedback).not.toBe(second.feedback);
    expect(first.feedback?.config).not.toBe(second.feedback?.config);
  });

  /**
   * #366 — the ninth seam. Before this, `ProductionConfig.feedback` had no
   * supplier at all, so `buildProductionOrchestrator` never started the daily
   * timer and stage 6 of the 6-stage pipeline was dead for an entire 14-day
   * soak (#238) while the run looked healthy.
   */
  describe('feedback block (#366)', () => {
    it('supplies the FeedbackConfig the daily cycle has no other source for', () => {
      expect(paperStartingProfile('paper').feedback?.config).toBeDefined();
    });

    it('names no transport and no cadence, leaving both to the composition root', () => {
      const feedback = paperStartingProfile('paper').feedback;

      // Same rule as the eight: this file supplies tuning VALUES. Where an
      // operator's alerts go is a deployment decision resolved from
      // `SAMURAI_ALERTS` (alert-transport.ts), and hard-coding one posture
      // into a checked-in file is what #322 exists to prevent.
      expect(feedback?.approvals).toBeUndefined();
      expect(feedback?.intervalMs).toBeUndefined();
    });

    it('supplies metrics, so computeMetrics has a production caller (#379)', () => {
      // The inversion of the #345 posture, decided in #379: leaving this unset
      // made a sixth fully-tested mechanism nothing calls. What makes it safe
      // is the source's own 60-observation gate (ADR-0006 §5), not the
      // omission — see the two store-level cases in production.test.ts.
      expect(paperStartingProfile('paper').feedback?.metrics).toBeDefined();
    });

    it('supplies the real series-backed source, not a stub that fabricates a suite', () => {
      const metrics = paperStartingProfile('paper').feedback?.metrics;
      if (metrics === undefined) throw new Error('no metrics block');

      // A factory, because this file holds no stores — the composition root
      // owns the handle and calls it (#379). Resolving it here with a real
      // in-memory handle pins BOTH halves: that the profile defers, and that
      // what it defers to is the gated `SqliteDailyEquityMetricsSource` rather
      // than something that would make "never checked" read as "did not
      // breach".
      if (typeof metrics.source !== 'function') {
        throw new Error('metrics.source must be a factory: the profile opens no database');
      }
      const db = openSharedStore(':memory:');
      try {
        const source = metrics.source({
          db,
          trades: { getClosedTradesBetween: () => [] },
          logger: { log: () => undefined },
        });
        expect(source).toBeInstanceOf(SqliteDailyEquityMetricsSource);
        // Empty series: the gate refuses, which is the state every soak-length
        // run is in.
        expect(source.getDailyMetrics()).toBeUndefined();
      } finally {
        db.close();
      }
    });

    it('leaves backtest_reference_sharpe inert at 0, keeping #375 unarmed', () => {
      // #375: no backtest of anything this system trades has ever run, so
      // there is no frozen Sharpe to compare against. A plausible number here
      // would arm `autoTighten` — which WRITES every risk threshold — against
      // a reference nobody measured. `<= 0` makes `liveBacktestDivergence`
      // refuse to manufacture a breach.
      expect(paperStartingProfile('paper').feedback?.metrics?.backtest_reference_sharpe).toBe(0);
    });

    it('refuses live mode for the feedback block too, not only the eight', () => {
      // The guard is on `paperStartingProfile` itself, so a new block cannot
      // be added past it — this pins that rather than trusting it.
      expect(() => paperStartingProfile('live')).toThrow();
    });

    it('attributes over a window longer than the cycle it runs on', () => {
      const config = paperStartingProfile('paper').feedback?.config;

      // The one silent-data-loss failure mode in this block. The cycle reads
      // `(now - window, now]` and its timer restarts with the process, so a
      // window equal to the cadence leaves every trade that closed inside a
      // restart's re-phasing unattributed forever.
      expect(config?.attribution_window_ms).toBeGreaterThan(DEFAULT_FEEDBACK_INTERVAL_MS);
    });

    it('centres the analyst-weight band on 1.0, so an even record implies no re-weighting', () => {
      const weights = paperStartingProfile('paper').feedback?.config.weights;
      if (weights === undefined) throw new Error('no weights dial');

      // `impliedWeight` pulls a zero-credit analyst to the band's MIDPOINT
      // (attribution.ts). Any band not centred on the neutral multiplier
      // silently re-weights every analyst that produced no evidence.
      expect((weights.floor + weights.ceiling) / 2).toBeCloseTo(1);
    });

    it('bounds analyst weights two-sided, so none is silenced or dominates', () => {
      const weights = paperStartingProfile('paper').feedback?.config.weights;
      if (weights === undefined) throw new Error('no weights dial');

      // Spec story 4: no analyst "swings wildly, drops to zero permanently, or
      // dominates".
      expect(weights.floor).toBeGreaterThan(0);
      expect(weights.ceiling).toBeLessThan(Number.POSITIVE_INFINITY);
      expect(weights.ceiling).toBeGreaterThan(weights.floor);
    });

    it('caps the step so no soak-length run can traverse the whole band', () => {
      const config = paperStartingProfile('paper').feedback?.config;
      const weights = config?.weights;
      if (weights === undefined) throw new Error('no weights dial');

      const cyclesToTraverse = (weights.ceiling - weights.floor) / weights.max_step;
      // A dial that could run floor-to-ceiling inside the 14-day soak (#238)
      // would let the first few trades decide the whole trajectory — the
      // "swings wildly" story 4 rules out.
      expect(cyclesToTraverse).toBeGreaterThan(14);
    });

    it('carries no shadow-credit knobs — attribution no longer reads influence (#370)', () => {
      const config = paperStartingProfile('paper').feedback?.config;
      if (config === undefined) throw new Error('no feedback config');

      // Both fields were `influence_score` compensation. Credit is correctness
      // alone now, so a profile still setting them would be configuring a knob
      // nothing consults — this fails if one is reintroduced without a
      // consumer.
      expect('shadow_credit' in config).toBe(false);
      expect('shadow_influence_ceiling' in config).toBe(false);
    });

    it('sets the three kill-lines the spec states literally', () => {
      // feedback-loop-spec.md story 13: "PBO > 0.05, OOS/paper Sharpe < 0.5,
      // DSR insignificant". The first two are stated as numbers and must not
      // drift; `PboVerdict`'s own reject line is the same 0.05.
      const kill = paperStartingProfile('paper').feedback?.config.kill_thresholds;

      expect(kill?.max_pbo).toBe(0.05);
      expect(kill?.min_oos_sharpe).toBe(0.5);
      // A probability, so a value outside (0,1) could never be breached or
      // could never pass.
      expect(kill?.min_deflated_sharpe).toBeGreaterThan(0);
      expect(kill?.min_deflated_sharpe).toBeLessThan(1);
      // A FRACTIONAL drop against the backtest reference, not a Sharpe
      // difference (`liveBacktestDivergence`, feedback-loop/metrics.ts).
      expect(kill?.max_live_backtest_divergence).toBeGreaterThan(0);
      expect(kill?.max_live_backtest_divergence).toBeLessThanOrEqual(1);
    });

    it('is accepted by runDailyCycle rather than merely type-checking', () => {
      const config = paperStartingProfile('paper').feedback?.config;
      if (config === undefined) throw new Error('no feedback config');

      const requestLoosenApproval = vi.fn();
      // `runDailyCycle` rejects a config whose `strategy_params` and
      // `risk_thresholds` share a name (`param_updates` is one flat map and
      // would silently drop one). Running the real cycle over the real
      // profile is the only check that catches that here.
      const result = runDailyCycle({
        clock: new SimulatedClock(new Date('2026-08-05T00:00:00.000Z')),
        trades: new InMemoryClosedTradeStore(),
        debate_log: new InMemoryDebateLogStore(),
        tuning: new InMemoryTuningStore(),
        adjustments: { append: vi.fn() },
        config,
        approvals: { requestLoosenApproval },
        proposals: [],
        mode: 'paper',
      });

      expect(result.applied).toBe(false);
      expect(result.loosen_pending_approval).toEqual([]);
    });
  });
});
