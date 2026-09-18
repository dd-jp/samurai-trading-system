import { ANALYST_STAGE_WALL_CLOCK_MS } from '../../pipeline/analysts/index.js';
import type { DebateResult } from '../../pipeline/debate-engine/index.js';
import { InMemoryDebateLogStore, LATENCY_BUDGET_MS } from '../../pipeline/debate-engine/index.js';
import {
  InMemoryClosedTradeStore,
  InMemoryTuningStore,
  runDailyCycle,
} from '../../pipeline/feedback-loop/index.js';
import { DEFAULT_TRADER_CONFIG, decide, FixtureSetupStore } from '../../pipeline/trader/index.js';
import {
  AlwaysOpenCalendar,
  type Bar,
  collectMarks,
  type IndicatorValue,
  type Mark,
  type MarketDataService,
  type MarkRead,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock } from '../../shared/index.js';
import { SimulatedClock, SystemClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { SAXO_COMMISSION_RATE, SqliteStage2SelectionStore } from '../../tools/backtest/index.js';
import { REQUIRED_INJECTED_CONFIG } from './index.js';
import { liveStartingProfile } from './live-profile.js';
import {
  LIVE_BOOK_GBP,
  LIVE_BOOK_SIZING_USD,
  paperStartingProfile,
  SIZING_USD_PER_GBP,
  subclassOfUniverse,
} from './paper-profile.js';
import { SqliteDailyEquityMetricsSource } from './production/daily-equity-metrics-source.js';
import { BENCHMARK_INSTRUMENTS, DEFAULT_FEEDBACK_INTERVAL_MS } from './production.js';
import { DEFAULT_UNIVERSE } from './scheduler.js';

describe('paperStartingProfile', () => {
  it('supplies every dependency REQUIRED_INJECTED_CONFIG demands', () => {
    const profile = paperStartingProfile('paper');

    for (const key of REQUIRED_INJECTED_CONFIG) {
      expect(profile[key]).toBeDefined();
    }
  });

  it('sizes paper against the declared book, not funded equity (#1112)', () => {
    expect(paperStartingProfile('paper').capitalCeilingUsd).toBe(LIVE_BOOK_SIZING_USD);
  });

  it('converts the declared book UP into the account currency (#1180)', () => {
    expect(SIZING_USD_PER_GBP).toBeGreaterThan(1);
    expect(LIVE_BOOK_SIZING_USD).toBe(LIVE_BOOK_GBP * SIZING_USD_PER_GBP);
    expect(LIVE_BOOK_SIZING_USD).toBe(1_270);
    expect(paperStartingProfile('paper').capitalCeilingUsd).toBeGreaterThan(LIVE_BOOK_GBP);
  });

  it('carries the rate the ceiling was converted at, and only where one was applied (#1180)', () => {
    expect(paperStartingProfile('paper').capitalCeilingUsdPerGbp).toBe(SIZING_USD_PER_GBP);
    expect(paperStartingProfile('backtest').capitalCeilingUsdPerGbp).toBeUndefined();
    expect('capitalCeilingUsdPerGbp' in liveStartingProfile(LIVE_BOOK_SIZING_USD)).toBe(false);
  });

  it('does NOT set a capital ceiling for backtest (#1112 scope)', () => {
    expect(paperStartingProfile('backtest').capitalCeilingUsd).toBeUndefined();
  });

  describe('the full ADR-0001 universe', () => {
    it('supplies DEFAULT_UNIVERSE, so a paper start is not the smoke set by omission', () => {
      const { universe } = paperStartingProfile('paper');

      expect(universe).toEqual(DEFAULT_UNIVERSE);
      expect(universe).toHaveLength(20);
      for (const asset of BENCHMARK_INSTRUMENTS) {
        expect(universe?.map((instrument) => instrument.asset)).not.toContain(asset);
      }
      expect(universe?.every((instrument) => instrument.subclass === undefined)).toBe(true);
    });

    it('covers exactly the one asset class it schedules, so the other reads INERT rather than silently misleading (#738)', () => {
      const { universe } = paperStartingProfile('paper');
      const classes = new Set(universe?.map((instrument) => instrument.asset_class));

      expect([...classes].sort()).toEqual(['stocks']);
    });

    it('sizes drift tolerance as a fraction, so a $200 equity has a real gate', () => {
      const { verdictConfig } = paperStartingProfile('paper');

      const equityBound = 200 * verdictConfig.drift_tolerance_pct.stocks;
      expect(equityBound).toBeLessThan(5);
      expect(equityBound).toBeGreaterThan(0);

      expect(100_000 * verdictConfig.drift_tolerance_pct.crypto).toBeCloseTo(500, 10);
    });

    it('keeps size_over inert, because auto short-circuits before flags are read', () => {
      const { verdictConfig } = paperStartingProfile('paper');

      expect(verdictConfig.automation_level.crypto).toBe('auto');
      expect(verdictConfig.automation_level.stocks).toBe('auto');
      expect(verdictConfig.flag_thresholds.size_over).toBe(0);
    });

    it('leaves the stocks staleness bound well clear of one debate latency budget', () => {
      const { verdictConfig } = paperStartingProfile('paper');

      expect(verdictConfig.max_signal_age.stocks).toBeGreaterThan(5 * LATENCY_BUDGET_MS.stocks);
    });

    it('keeps one debate budget inside the tick interval it runs in (#1080)', () => {
      const { tickIntervalMs } = paperStartingProfile('paper');

      expect(tickIntervalMs).toBe(120_000);
      expect(LATENCY_BUDGET_MS.stocks).toBeLessThanOrEqual(tickIntervalMs);
    });

    it('correlates over a window Alpaca can serve on tick 1, so #303 is not reachable here', () => {
      const { correlationConfig } = paperStartingProfile('paper');

      expect(correlationConfig.window.timeframe).toBe('1d');
      expect(correlationConfig.min_bars).toBeLessThan(correlationConfig.window.lookback);
    });
  });

  it('refuses live mode — these values are uncalibrated starting points', () => {
    expect(() => paperStartingProfile('live')).toThrow(/live/i);
    expect(() => paperStartingProfile('live')).toThrow(/PAPER_STARTING_PROFILE|paper/i);
  });

  it('carries the resolved mode through so paper is what the root is built with', () => {
    expect(paperStartingProfile('paper').mode).toBe('paper');
    expect(paperStartingProfile('backtest').mode).toBe('backtest');
  });

  it('orders the risk caps monotonically, so no cap is unreachable', () => {
    const { riskConfig } = paperStartingProfile('paper');

    expect(riskConfig.max_position_size_fraction_of_equity).toBeLessThanOrEqual(
      riskConfig.per_asset_cap_fraction_of_equity,
    );
    expect(riskConfig.per_asset_cap_fraction_of_equity).toBeLessThanOrEqual(
      riskConfig.per_asset_class_cap_fraction_of_equity.crypto,
    );
    expect(riskConfig.per_asset_cap_fraction_of_equity).toBeLessThanOrEqual(
      riskConfig.per_asset_class_cap_fraction_of_equity.stocks,
    );
    expect(riskConfig.per_asset_class_cap_fraction_of_equity.crypto).toBeLessThanOrEqual(
      riskConfig.portfolio_gross_cap_fraction_of_equity,
    );
    expect(riskConfig.per_asset_class_cap_fraction_of_equity.stocks).toBeLessThanOrEqual(
      riskConfig.portfolio_gross_cap_fraction_of_equity,
    );
    expect(riskConfig.concentration.cap_fraction_of_equity).toBeGreaterThanOrEqual(
      riskConfig.max_position_size_fraction_of_equity,
    );
  });

  it('keeps every cap at or under 1x equity — no leverage on a first paper run (#886)', () => {
    const { riskConfig } = paperStartingProfile('paper');

    expect(riskConfig.portfolio_gross_cap_fraction_of_equity).toBeLessThanOrEqual(1);
  });

  it("does not set Risk's dust floor above the Trader's minimum notional", () => {
    const { riskConfig, traderConfig } = paperStartingProfile('paper');

    expect(riskConfig.min_viable_size).toBeLessThanOrEqual(traderConfig.min_viable_notional);
  });

  it('reuses DEFAULT_TRADER_CONFIG rather than restating its values', () => {
    const { traderConfig } = paperStartingProfile('paper');

    expect(traderConfig.conviction_floor).toBe(DEFAULT_TRADER_CONFIG.conviction_floor);
    expect(traderConfig.max_risk_per_trade).toBe(DEFAULT_TRADER_CONFIG.max_risk_per_trade);
    expect(traderConfig.asset_class_risk_multiplier.crypto).toBe(
      DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.crypto,
    );
  });

  describe('asset_class_risk_multiplier.stocks (#1112 follow-up)', () => {
    const D5_SINGLE_STOCK_CAP = 0.25;

    it('departs from the shared default for paper only, and never reaches live', () => {
      const { traderConfig } = paperStartingProfile('paper');

      expect(traderConfig.asset_class_risk_multiplier.stocks).toBe(1.9);
      expect(traderConfig.asset_class_risk_multiplier.stocks).not.toBe(
        DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.stocks,
      );

      const live = liveStartingProfile(LIVE_BOOK_GBP);
      expect(live.traderConfig.asset_class_risk_multiplier.stocks).toBe(1.0);
      expect(live.traderConfig.asset_class_risk_multiplier.stocks).toBe(
        DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.stocks,
      );
    });

    it('leaves DEFAULT_TRADER_CONFIG itself untouched (paper-only scope, #1112)', () => {
      paperStartingProfile('paper');

      expect(DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.stocks).toBe(1.0);
    });

    it('does not touch backtest mode', () => {
      const { traderConfig } = paperStartingProfile('backtest');

      expect(traderConfig.asset_class_risk_multiplier.stocks).toBe(
        DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.stocks,
      );
    });

    describe('drives decide.ts end to end and stays under D5 cap', () => {
      const ENTRY_PRICE = 100;
      const ATR = 2;
      const DECISION_BAR = new Date('2026-07-15T10:00:00Z');
      const SIZING_EQUITY = 100_000;

      class FixedClock implements Clock {
        now(): Date {
          return DECISION_BAR;
        }
      }

      function sizingBars(): Bar[] {
        return Array.from({ length: 15 }, (_, i) => {
          const closeTime = new Date(DECISION_BAR.getTime() - (14 - i) * 60 * 60 * 1000);
          return {
            instrument: 'MU',
            timeframe: '1h',
            open_time: new Date(closeTime.getTime() - 60 * 60 * 1000),
            close_time: closeTime,
            open: ENTRY_PRICE,
            high: ENTRY_PRICE + ATR / 2,
            low: ENTRY_PRICE - ATR / 2,
            close: ENTRY_PRICE,
            volume: 1,
            source: 'fixture',
          };
        });
      }

      class SizingFixtureMarketData implements MarketDataService {
        async getBars(): Promise<Bar[]> {
          return sizingBars();
        }
        async getMark(): Promise<Mark> {
          return {
            price: ENTRY_PRICE,
            observed_at: DECISION_BAR,
            source: 'fixture',
            asset_class: 'stocks',
          };
        }
        async getMarks(instruments: readonly string[], asOf: Date): Promise<Map<string, MarkRead>> {
          return collectMarks((_instrument, _at) => this.getMark(), instruments, asOf);
        }
        async getIndicator(): Promise<IndicatorValue> {
          throw new Error('SizingFixtureMarketData.getIndicator: not part of the entry path');
        }
        async getSpreadEstimate(): Promise<number | null> {
          throw new Error('SizingFixtureMarketData.getSpreadEstimate: not part of the Trader path');
        }
        async getQuote(): Promise<null> {
          throw new Error('SizingFixtureMarketData.getQuote: not part of the Trader path');
        }
        async getADV(): Promise<number> {
          throw new Error('SizingFixtureMarketData.getADV: not part of the Trader path');
        }
      }

      function sizingDebate(): DebateResult {
        return {
          synthesis: 'Analysts converge on upside momentum.',
          position: 'Enter long.',
          confidence: 0.775,
          contributions: [],
          disagreement_summary: '',
          open_items: [],
          converged: true,
          rounds_completed: 2,
          latency_ms: 9_000,
          direction: 'bullish',
          debate_id: 'debate-1112-sizing',
          bar_timestamp: DECISION_BAR,
          read: true,
        };
      }

      it("keeps the shipped multiplier's deployment under D5's single-stock cap", async () => {
        const { traderConfig } = paperStartingProfile('paper');

        const intent = await decide({
          trace_id: 'trace-1112-sizing',
          instrument: 'MU',
          debate: sizingDebate(),
          clock: new FixedClock(),
          marketData: new SizingFixtureMarketData(),
          equity: async () => SIZING_EQUITY,
          config: traderConfig,
          positionState: async () => [],
          exitFillSizes: async () => new Map<string, number>(),
          unresolvedFlattens: async () => [],
          setupStore: new FixtureSetupStore(),
          sessionCalendars: {
            crypto: new AlwaysOpenCalendar(),
            stocks: new UsEquityRegularHoursCalendar(),
          },
        });

        expect(intent).not.toBeNull();
        const deployment = ((intent?.size ?? 0) * (intent?.entry ?? 0)) / SIZING_EQUITY;
        expect(deployment).toBeLessThan(D5_SINGLE_STOCK_CAP);
      });
    });
  });

  it('uses a time-in-force each venue accepts, per asset class (#381)', () => {
    const { traderConfig } = paperStartingProfile('paper');

    expect(['gtc', 'ioc']).toContain(traderConfig.time_in_force.crypto);
    expect(traderConfig.time_in_force.stocks).toBe('day');
  });

  it('puts no human on any trade, per ADR-0007', () => {
    const { verdictConfig } = paperStartingProfile('paper');

    expect(verdictConfig.automation_level.crypto).toBe('auto');
    expect(verdictConfig.automation_level.stocks).toBe('auto');
  });

  describe('the $50 / 14-day soak budget (ADR-0008)', () => {
    const SOAK_DAYS = 14;

    const USD_PER_DEBATE = 0.006;
    const PASS_DURATION_MS = 13_000;
    const DEBATES_PER_DAY = 2 * 24 + 4 * 7;

    it('carries the budget, and the cadence #670 stepped to once #617 closed', () => {
      const profile = paperStartingProfile('paper');

      expect(profile.llmBudgetUsd).toBe(50);
      expect(profile.tickIntervalMs).toBe(120_000);
    });

    it('fits a full 14 days inside the budget on the bar-keyed cost model', () => {
      const profile = paperStartingProfile('paper');

      expect(DEBATES_PER_DAY * SOAK_DAYS * USD_PER_DEBATE).toBeLessThan(profile.llmBudgetUsd);
    });

    it('leaves a pass room to finish, so a digit slip cannot outrun the tick', () => {
      expect(paperStartingProfile('paper').tickIntervalMs).toBeGreaterThanOrEqual(
        4 * PASS_DURATION_MS,
      );
    });

    it('ticks fast enough that the stop means what it says', () => {
      const profile = paperStartingProfile('paper');
      const meanDelayMinutes = profile.tickIntervalMs / 60_000 / 2;
      const overshootPct = 0.525 * Math.sqrt(meanDelayMinutes);
      const NEUTRAL_STOP_PCT = 2.16;

      expect(overshootPct).toBeLessThan(NEUTRAL_STOP_PCT / 3);
    });
  });

  describe('maxConcurrentInstruments (#1013)', () => {
    it('is set explicitly, not left to the ?? 1 fallback that made every pass serial', () => {
      const profile = paperStartingProfile('paper');

      expect(profile.maxConcurrentInstruments).toBeDefined();
      expect(profile.maxConcurrentInstruments).toBe(6);
    });

    it('pins the widened universe worst-case pass, which nothing downstream bounds (#1104)', () => {
      const profile = paperStartingProfile('paper');
      const universe = profile.universe;
      if (universe === undefined) {
        throw new Error("paperStartingProfile('paper') always carries a universe");
      }

      const width = profile.maxConcurrentInstruments ?? universe.length;
      const worstCaseGroupMs = ANALYST_STAGE_WALL_CLOCK_MS + LATENCY_BUDGET_MS.stocks;
      const worstCasePassMs = Math.ceil(universe.length / width) * worstCaseGroupMs;

      expect(worstCaseGroupMs).toBe(172_000);
      expect(worstCasePassMs).toBe(688_000);
    });

    it('stays well inside the stocks rate-limiter budget even if every instrument debates in one window', () => {
      const profile = paperStartingProfile('paper');
      const universe = profile.universe;
      const stocksBudget = profile.rateLimiterConfig.perAssetClass?.stocks;
      if (universe === undefined || stocksBudget === undefined) {
        throw new Error(
          "paperStartingProfile('paper') always carries a universe and a stocks rate-limit budget",
        );
      }

      expect(universe.length).toBeLessThan(stocksBudget.maxDebates);
    });

    it('pins backtest at width 1 for replay determinism, not the paper/live 6 (#1013 fix-up H1)', () => {
      expect(paperStartingProfile('backtest').maxConcurrentInstruments).toBe(1);
      expect(paperStartingProfile('paper').maxConcurrentInstruments).toBe(6);
    });

    it('tripwire: same-tick portfolio-cap netting (#1019) stays bounded only while the universe carries no subclass — break loudly, not silently, if that changes at width > 1', () => {
      const profile = paperStartingProfile('paper');
      const universe = profile.universe;
      if (universe === undefined) {
        throw new Error("paperStartingProfile('paper') always carries a universe");
      }

      expect(profile.maxConcurrentInstruments).toBeGreaterThan(1);
      expect(Object.keys(subclassOfUniverse(universe))).toEqual([]);
    });
  });

  it('refuses live mode without citing issues that have since closed', () => {
    const message = (() => {
      try {
        paperStartingProfile('live');
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return expect.unreachable('paperStartingProfile("live") must throw');
    })();

    for (const closed of [
      '#526',
      '#519',
      '#548',
      '#549',
      '#550',
      '#551',
      '#562',
      '#384',
      '#375',
      '#333',
      '#525',
      '#800',
      '#826',
      '#894',
      '#798',
      '#886',
      '#888',
      '#925',
      '#932',
    ]) {
      expect(message).not.toContain(closed);
    }
    for (const open of ['#895', '#900']) {
      expect(message).toContain(open);
    }
    expect(message).toContain('#238');
    expect(message).toContain('has not run');
    expect(message).toContain('npm run check:live-gates');
  });

  it('routes an operator to the live profile rather than to a dead end', () => {
    expect(() => paperStartingProfile('live')).toThrow('liveStartingProfile');
    expect(() => paperStartingProfile('live')).toThrow('SAMURAI_LIVE_MAX_CAPITAL_USD');
  });

  it('bounds the hard drawdown breaker above the designed envelope, as a fraction', () => {
    const { breakerConfig } = paperStartingProfile('paper');

    expect(breakerConfig.max_drawdown_pct).toBe(0.44);
    expect(breakerConfig.max_drawdown_pct).toBeGreaterThan(0.418);

    expect(breakerConfig.auto_rearm.recovery_drawdown_pct).toBe(0.2);
    expect(breakerConfig.auto_rearm.recovery_drawdown_pct).toBeLessThan(
      breakerConfig.max_drawdown_pct,
    );
    expect(breakerConfig.daily_loss_pct).toBeGreaterThan(0);
    expect(breakerConfig.daily_loss_pct).toBeLessThan(breakerConfig.max_drawdown_pct);

    for (const asset_class of ['crypto', 'stocks'] as const) {
      const threshold = breakerConfig.daily_loss_pct_by_class[asset_class];
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThan(breakerConfig.max_drawdown_pct);
    }
  });

  it('leaves the volatility baseline finite, so the fail-closed sentinel still trips', () => {
    const { breakerConfig } = paperStartingProfile('paper');
    const { baseline, multiplier } = breakerConfig.volatility;

    expect(Number.isFinite(baseline.crypto * multiplier)).toBe(true);
    expect(Number.isFinite(baseline.stocks * multiplier)).toBe(true);
    expect(Number.POSITIVE_INFINITY > baseline.crypto * multiplier).toBe(true);
  });

  it('polls CII inside the cadence ADR-0002 fixed, even though the feed is parked', () => {
    const { ciiConsumerConfig } = paperStartingProfile('paper');

    expect(ciiConsumerConfig.pollIntervalMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(ciiConsumerConfig.pollIntervalMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it('charges above the cost model’s structural non-zero floor on both classes', () => {
    const { costConfig } = paperStartingProfile('paper');

    for (const assetClass of ['crypto', 'stocks'] as const) {
      expect(costConfig[assetClass].commissionRate).toBeGreaterThan(0.0001);
      expect(costConfig[assetClass].spreadVolatilityCoefficient).toBeGreaterThan(0);
      expect(costConfig[assetClass].slippageCoefficient).toBeGreaterThan(0);
      expect(costConfig[assetClass].impactK).toBeGreaterThan(0);
    }
    expect(costConfig.crypto.commissionRate).toBeGreaterThan(costConfig.stocks.commissionRate);
  });

  it('wires the Saxo venue into both the cost config and the simulated adapter config', () => {
    const { costConfig, executionConfig } = paperStartingProfile('paper');

    expect(costConfig.venues?.saxo?.commissionRate).toBe(SAXO_COMMISSION_RATE);
    expect(executionConfig.simulated.venue).toBe('saxo');
  });

  it('returns a fresh object each call, so a caller cannot mutate the profile', () => {
    const first = paperStartingProfile('paper');
    const second = paperStartingProfile('paper');

    expect(first).not.toBe(second);
    expect(first.riskConfig).not.toBe(second.riskConfig);
    expect(first.feedback).not.toBe(second.feedback);
    expect(first.feedback?.config).not.toBe(second.feedback?.config);
  });

  describe('feedback block (#366)', () => {
    it('supplies the FeedbackConfig the daily cycle has no other source for', () => {
      expect(paperStartingProfile('paper').feedback?.config).toBeDefined();
    });

    it('names no transport and no cadence, leaving both to the composition root', () => {
      const feedback = paperStartingProfile('paper').feedback;

      expect(feedback?.loosenNotices).toBeUndefined();
      expect(feedback?.intervalMs).toBeUndefined();
    });

    it('supplies metrics, so computeMetrics has a production caller (#379)', () => {
      expect(paperStartingProfile('paper').feedback?.metrics).toBeDefined();
    });

    it('supplies the real series-backed source, not a stub that fabricates a suite', () => {
      const metrics = paperStartingProfile('paper').feedback?.metrics;
      if (metrics === undefined) throw new Error('no metrics block');

      if (typeof metrics.source !== 'function') {
        throw new Error('metrics.source must be a factory: the profile opens no database');
      }
      const db = openSharedStore(':memory:');
      try {
        const source = metrics.source({
          db,
          trades: { getClosedTradesBetween: () => [] },
          logger: { log: () => undefined },
          stage2Selections: new SqliteStage2SelectionStore(db),
          clock: new SystemClock(),
        });
        expect(source).toBeInstanceOf(SqliteDailyEquityMetricsSource);
        expect(source.getDailyMetrics()).toBeUndefined();
      } finally {
        db.close();
      }
    });

    it('leaves backtest_reference_sharpe inert at 0, keeping #375 unarmed', () => {
      expect(paperStartingProfile('paper').feedback?.metrics?.backtest_reference_sharpe).toBe(0);
    });

    it('refuses live mode for the feedback block too, not only the eight', () => {
      expect(() => paperStartingProfile('live')).toThrow();
    });

    it('attributes over a window longer than the cycle it runs on', () => {
      const config = paperStartingProfile('paper').feedback?.config;

      expect(config?.attribution_window_ms).toBeGreaterThan(DEFAULT_FEEDBACK_INTERVAL_MS);
    });

    it('centres the analyst-weight band on 1.0, so an even record implies no re-weighting', () => {
      const weights = paperStartingProfile('paper').feedback?.config.weights;
      if (weights === undefined) throw new Error('no weights dial');

      expect((weights.floor + weights.ceiling) / 2).toBeCloseTo(1);
    });

    it('bounds analyst weights two-sided, so none is silenced or dominates', () => {
      const weights = paperStartingProfile('paper').feedback?.config.weights;
      if (weights === undefined) throw new Error('no weights dial');

      expect(weights.floor).toBeGreaterThan(0);
      expect(weights.ceiling).toBeLessThan(Number.POSITIVE_INFINITY);
      expect(weights.ceiling).toBeGreaterThan(weights.floor);
    });

    it('caps the step so no soak-length run can traverse the whole band', () => {
      const config = paperStartingProfile('paper').feedback?.config;
      const weights = config?.weights;
      if (weights === undefined) throw new Error('no weights dial');

      const cyclesToTraverse = (weights.ceiling - weights.floor) / weights.max_step;
      expect(cyclesToTraverse).toBeGreaterThan(14);
    });

    it('carries no shadow-credit knobs — attribution no longer reads influence (#370)', () => {
      const config = paperStartingProfile('paper').feedback?.config;
      if (config === undefined) throw new Error('no feedback config');

      expect('shadow_credit' in config).toBe(false);
      expect('shadow_influence_ceiling' in config).toBe(false);
    });

    it('sets the three kill-lines the spec states literally', () => {
      const kill = paperStartingProfile('paper').feedback?.config.kill_thresholds;

      expect(kill?.max_pbo).toBe(0.05);
      expect(kill?.min_oos_sharpe).toBe(0.5);
      expect(kill?.min_deflated_sharpe).toBeGreaterThan(0);
      expect(kill?.min_deflated_sharpe).toBeLessThan(1);
      expect(kill?.max_live_backtest_divergence).toBeGreaterThan(0);
      expect(kill?.max_live_backtest_divergence).toBeLessThanOrEqual(1);
    });

    it('is accepted by runDailyCycle rather than merely type-checking', () => {
      const config = paperStartingProfile('paper').feedback?.config;
      if (config === undefined) throw new Error('no feedback config');

      const notifyLoosenApplied = vi.fn();
      const result = runDailyCycle({
        clock: new SimulatedClock(new Date('2026-08-05T00:00:00.000Z')),
        trades: new InMemoryClosedTradeStore(),
        debate_log: new InMemoryDebateLogStore(),
        tuning: new InMemoryTuningStore(),
        adjustments: { append: vi.fn() },
        config,
        loosen_notices: { notifyLoosenApplied },
        proposals: [],
      });

      expect(result.applied).toBe(false);
      expect(result.param_updates).toEqual({});
      expect(notifyLoosenApplied).not.toHaveBeenCalled();
    });
  });
});
