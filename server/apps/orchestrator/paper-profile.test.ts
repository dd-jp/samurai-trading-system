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

  /**
   * #1112 (AC1/AC2): before this, `paperStartingProfile('paper')` carried no
   * `capitalCeilingUsd`, so `sizingEquity` (direct-bind.ts) never clamped in
   * paper mode and the Trader sized off the simulated Alpaca balance
   * (~$100,000) directly — ~100x `LIVE_BOOK_GBP`. Pinning the value here
   * (rather than only `toBeDefined()`) is what a regression that reverted the
   * default to `undefined`, or drifted it to some OTHER number, would trip.
   */
  it('sizes paper against the declared book, not funded equity (#1112)', () => {
    expect(paperStartingProfile('paper').capitalCeilingUsd).toBe(LIVE_BOOK_SIZING_USD);
  });

  /**
   * #1180: the ceiling is clamped against Alpaca's USD-denominated
   * `portfolio.equity` by `sizingEquity` (direct-bind.ts), so passing the GBP
   * book raw made the declared £1,000 book bind at $1,000 — ~£790, ~21%
   * under. The direction is asserted explicitly because inverting a rate is
   * the same defect wearing the opposite sign: £1,000 must become $1,270, not
   * $787.
   *
   * `toBe` on an exact 1_270 rather than `toBeCloseTo`: migration 0052
   * normalizes the pre-conversion stamp with `WHERE sizing_capital_ceiling =
   * 1000` -> `= 1270`, and that literal is only provably the runtime's stamp
   * while this product is exact.
   */
  it('converts the declared book UP into the account currency (#1180)', () => {
    expect(SIZING_USD_PER_GBP).toBeGreaterThan(1);
    expect(LIVE_BOOK_SIZING_USD).toBe(LIVE_BOOK_GBP * SIZING_USD_PER_GBP);
    expect(LIVE_BOOK_SIZING_USD).toBe(1_270);
    expect(paperStartingProfile('paper').capitalCeilingUsd).toBeGreaterThan(LIVE_BOOK_GBP);
  });

  /**
   * #1180: the rate travels with the ceiling as config so the boot log can
   * say which rate produced which ceiling — and so a live ceiling, declared
   * in USD and never converted, is distinguishable from a derived one rather
   * than being stamped with a rate it never saw.
   */
  it('carries the rate the ceiling was converted at, and only where one was applied (#1180)', () => {
    expect(paperStartingProfile('paper').capitalCeilingUsdPerGbp).toBe(SIZING_USD_PER_GBP);
    expect(paperStartingProfile('backtest').capitalCeilingUsdPerGbp).toBeUndefined();
    expect('capitalCeilingUsdPerGbp' in liveStartingProfile(LIVE_BOOK_SIZING_USD)).toBe(false);
  });

  /**
   * `backtest` deliberately keeps `capitalCeilingUsd` unset (#1112 scope
   * line): backtest's cost-model calibration and Stage-2 tooling read
   * `portfolio.equity` unclamped today, and widening that blast radius is a
   * separate decision #1112 does not make. Pinned so a future edit that
   * "simplifies" the conditional spread to apply to every mode fails here
   * first, not in a Stage-2 run months later.
   */
  it('does NOT set a capital ceiling for backtest (#1112 scope)', () => {
    expect(paperStartingProfile('backtest').capitalCeilingUsd).toBeUndefined();
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
      //
      // #738: `DEFAULT_UNIVERSE` no longer carries BTC-USD/ETH-USD — crypto
      // is out of Samurai's scope (ADR-0014 amendment), and the production
      // schedule this profile feeds must never resolve one.
      const { universe } = paperStartingProfile('paper');

      // #1006: 'SPY' is gone too — it is a BENCHMARK_INSTRUMENTS member, and a
      // universe row for it made the orchestrator a second writer of the bars
      // the outside-benchmark port already owns.
      expect(universe).toEqual(DEFAULT_UNIVERSE);
      // 20 names since the paper-soak widening. Asserted as a NUMBER as well as
      // an identity so a change to `DEFAULT_UNIVERSE` still has to be a
      // deliberate edit here — the identity check alone would follow it
      // silently, and universe size is what every rate dial is derived from.
      expect(universe).toHaveLength(20);
      // No `BENCHMARK_INSTRUMENTS` member may appear: a universe row for one
      // makes the orchestrator a second writer of the benchmark port's own bar
      // rows (#1006). In paper this is NOT caught by #989's boot guard, which
      // only fires when the calendar is not `UsEquityRegularHoursCalendar`.
      for (const asset of BENCHMARK_INSTRUMENTS) {
        expect(universe?.map((instrument) => instrument.asset)).not.toContain(asset);
      }
      // No row may carry `subclass` while #1019's same-tick portfolio-cap
      // race is open — an armed `perSubclassDeploymentCap` is what makes that
      // race reachable. See `maxConcurrentInstruments`' comment.
      expect(universe?.every((instrument) => instrument.subclass === undefined)).toBe(true);
    });

    it('covers exactly the one asset class it schedules, so the other reads INERT rather than silently misleading (#738)', () => {
      // Before #738, DEFAULT_UNIVERSE covering both classes silenced the
      // startup warn below for BOTH. Now that crypto is out of the schedule,
      // "no instruments configured for asset class; volatility breaker reads
      // 0 (inert) for this class {crypto}" is the CORRECT startup state, not
      // a gap this profile should paper over — crypto genuinely never ticks.
      const { universe } = paperStartingProfile('paper');
      const classes = new Set(universe?.map((instrument) => instrument.asset_class));

      expect([...classes].sort()).toEqual(['stocks']);
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

    it('keeps size_over inert, because auto short-circuits before flags are read', () => {
      // `size_over: 0` is unit-incommensurable across fractional BTC and
      // whole-share SPY, and widening the universe made that worse rather
      // than better. It stays harmless only while `automation_level` is
      // `auto` for BOTH classes — `shouldEngageHitl` returns false on that
      // check before `isFlagged` is ever called (it short-circuited on
      // `manual` before ADR-0007, on the opposite branch of the same check).
      // Pinned so turning either class to `semi_auto` fails here first.
      const { verdictConfig } = paperStartingProfile('paper');

      expect(verdictConfig.automation_level.crypto).toBe('auto');
      expect(verdictConfig.automation_level.stocks).toBe('auto');
      expect(verdictConfig.flag_thresholds.size_over).toBe(0);
    });

    it('leaves the stocks staleness bound well clear of one debate latency budget', () => {
      // Gate 1 measures age from `decided_at` (#1190) — `clock.now()` read at
      // Trader intent-build time, bounded by the debate latency budget, not by
      // the quote's own `observed_at`. If it ever approached this bound, every
      // equity order would no-go on staleness and the soak would silently trade
      // crypto only.
      //
      // 900,000ms against a 112,000ms budget is 8.03x: a debate that spends its
      // ENTIRE budget still hands Verdict an intent at an eighth of the
      // staleness bound. 5x is the floor below which "well clear" would stop
      // being true, since the gate also has to have room for the rest of the
      // pass (Trader, Risk, Verdict) on top of the debate.
      const { verdictConfig } = paperStartingProfile('paper');

      expect(verdictConfig.max_signal_age.stocks).toBeGreaterThan(5 * LATENCY_BUDGET_MS.stocks);
    });

    /**
     * #1080. `LATENCY_BUDGET_MS.stocks` derives from
     * `MAX_ROUNDS_BY_ASSET_CLASS.stocks`, so raising the round cap raises the
     * budget silently — and the budget is a per-instrument cost inside a tick
     * that also has to run analysts, Trader, Risk, Verdict and Execution.
     *
     * This does NOT assert the pass fits the tick — it does not: the analyst
     * stage runs before the debate, so a worst-case pass reaches ~172s against
     * a 120,000ms tick, and `paper-profile.ts`'s pass-duration tripwire is
     * where that argument lives. What this pins is the floor on how far the
     * budget alone may drift: one debate must not on its own outlast a whole
     * tick. Raising the round cap inflates the budget superlinearly — at a cap
     * of 2 it is 196,000ms against a 120,000ms tick and this fails, forcing
     * whoever raises it to re-read the tripwire.
     */
    it('keeps one debate budget inside the tick interval it runs in (#1080)', () => {
      const { tickIntervalMs } = paperStartingProfile('paper');

      expect(tickIntervalMs).toBe(120_000);
      expect(LATENCY_BUDGET_MS.stocks).toBeLessThanOrEqual(tickIntervalMs);
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
    // volatility baseline is uncalibrated and the notional caps assume a
    // paper account's default equity. None of that may reach real money by
    // way of the shipped entrypoint.
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
    // #886 made every cap a fraction of live equity rather than of a frozen
    // cash anchor, so the leverage check is now a bound on the fraction
    // itself: above 1 the portfolio gross cap alone would permit more
    // notional than the account holds. Nothing in the docs asks for leverage
    // on a first paper run, and an Alpaca paper account would reject it
    // anyway.
    const { riskConfig } = paperStartingProfile('paper');

    expect(riskConfig.portfolio_gross_cap_fraction_of_equity).toBeLessThanOrEqual(1);
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
    // silently from `server/pipeline/trader/types.ts`. `asset_class_risk_multiplier`
    // is asserted per-key, not by object equality against the default, because
    // `stocks` is a deliberate #1112 departure (see the dedicated block below)
    // while `crypto` still passes through unchanged.
    const { traderConfig } = paperStartingProfile('paper');

    expect(traderConfig.conviction_floor).toBe(DEFAULT_TRADER_CONFIG.conviction_floor);
    expect(traderConfig.max_risk_per_trade).toBe(DEFAULT_TRADER_CONFIG.max_risk_per_trade);
    expect(traderConfig.asset_class_risk_multiplier.crypto).toBe(
      DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.crypto,
    );
  });

  describe('asset_class_risk_multiplier.stocks (#1112 follow-up)', () => {
    // ADR-0018 D5's single-stock ETP deployment cap: 25% of equity. This
    // path (`decide.ts`'s generic ATR sizing, `bracket === null`) has no
    // deployment fraction of its own — D5's cap is reused here only as the
    // target the retuned multiplier must not exceed on the reference
    // scenario below, not as a claim that this path enforces it in general
    // (see the caveat in the assignment site's comment).
    const D5_SINGLE_STOCK_CAP = 0.25;

    it('departs from the shared default for paper only, and never reaches live', () => {
      const { traderConfig } = paperStartingProfile('paper');

      expect(traderConfig.asset_class_risk_multiplier.stocks).toBe(1.9);
      expect(traderConfig.asset_class_risk_multiplier.stocks).not.toBe(
        DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.stocks,
      );

      // `liveStartingProfile` spreads the same `DEFAULT_TRADER_CONFIG` and
      // carries no override of its own for this field — pinned here, not
      // just asserted absent, so a future live-side override that copies
      // paper's 1.9 without a fresh derivation fails this test rather than
      // shipping unreviewed.
      const live = liveStartingProfile(LIVE_BOOK_GBP);
      expect(live.traderConfig.asset_class_risk_multiplier.stocks).toBe(1.0);
      expect(live.traderConfig.asset_class_risk_multiplier.stocks).toBe(
        DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.stocks,
      );
    });

    it('leaves DEFAULT_TRADER_CONFIG itself untouched (paper-only scope, #1112)', () => {
      // Pins the scope by test, not by care: `paperStartingProfile` must not
      // mutate the shared default it spreads from, which would otherwise
      // leak this departure into `liveStartingProfile` (spreads the SAME
      // `buildStartingProfileConfigs()`/`DEFAULT_TRADER_CONFIG`) and every
      // other caller of the shared constant.
      paperStartingProfile('paper');

      expect(DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.stocks).toBe(1.0);
    });

    it('does not touch backtest mode', () => {
      // Same scoping rationale as `capitalCeilingUsd` (#1112): backtest's
      // cost-model calibration reads `portfolio.equity` unclamped and never
      // exercises `whole_share_sizing`'s floor the way a real paper fill
      // can, so retuning this path for backtest would be an unrelated
      // change riding along.
      const { traderConfig } = paperStartingProfile('backtest');

      expect(traderConfig.asset_class_risk_multiplier.stocks).toBe(
        DEFAULT_TRADER_CONFIG.asset_class_risk_multiplier.stocks,
      );
    });

    /**
     * Drives `decide.ts` end to end with the SHIPPED paper profile, rather
     * than hand-rescaling a logged number — the earlier version of this test
     * asserted `measuredDeploymentAtDefaultMultiplier * (retuned / shipped)`,
     * a linear function of two hardcoded constants that never called
     * `decide.ts` at all, despite a comment claiming otherwise.
     *
     * It is not a replay of #1112's own logged MU incident: that incident's
     * ATR and confidence were never recorded, only the resulting notional
     * (12939.225) and a SESSION-OPEN equity (99876.86) quoted from a
     * different tick than the one that produced that notional — conflating
     * the two is the arithmetic error `paper-profile.ts`'s derivation
     * comment (the retuned multiplier's assignment site) now corrects. A
     * faithful replay of that exact tick is not reachable from what #1112
     * logged, so this test instead exercises the same code path
     * (`decide.ts`'s generic ATR sizing, `bracket === null`) on a
     * constructed, fully-specified fixture at a representative
     * mid-conviction confidence, and asserts the real invariant: the
     * SHIPPED config's deployment on that fixture stays under D5's
     * single-stock cap.
     */
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

      // This drives `decide.ts` end to end so the deployment figure is real,
      // not a hand-rescale — but at this fixture's conviction/vol/precedent
      // inputs the cap only trips above mult ~2.67, so it does not distinguish
      // 1.9 from 2.0 (neither should: M1's derivation shows the D5 cap does
      // not force that choice). The test above that pins `stocks: 1.9` via
      // `toBe` is what guards the shipped value; this one guards the
      // consequence of whatever that value is.
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

  it('puts no human on any trade, per ADR-0007', () => {
    // ADR-0007 (David, 2026-08-06) replaces verdict-spec.md's original
    // manual -> semi_auto -> auto staging with `auto` from the start, in
    // paper AND live: `VerdictImpl.decide` awaits `requestApproval` inside
    // the instrument pass and `max_concurrent_instruments` is 1, so a human
    // in this loop serializes the whole universe behind one tap.
    //
    // Pinned for `paper` only because `live` cannot be asked: this profile
    // refuses to build in live mode at all (see the guard at the bottom of
    // paper-profile.ts), so a live composition root supplies its own tuned
    // `VerdictConfig`. ADR-0007's decision applies there too, but this file
    // is not where it can be enforced.
    const { verdictConfig } = paperStartingProfile('paper');

    expect(verdictConfig.automation_level.crypto).toBe('auto');
    expect(verdictConfig.automation_level.stocks).toBe('auto');
  });

  /**
   * ADR-0008's two knobs. Neither was pinned when they landed, which a review
   * pass on #428 caught by (wrongly) reporting the cadence literal as a typo:
   * the claim was false, but nothing in the suite could have contradicted it.
   *
   * A digit slip here is silent and expensive in exactly the way this repo's
   * defect pattern predicts. `15 * 60_00` still compiles, still boots, still
   * ticks, still passes every other test in this file — and burns a fortnight's
   * budget in hours, after which the cap refuses every debate and the run looks
   * like a market that went quiet on day 1.
   */
  describe('the $50 / 14-day soak budget (ADR-0008)', () => {
    /**
     * #400's instrument-pass arithmetic at the 60s `DEFAULT_TICK_INTERVAL_MS`
     * (2 crypto × 1,440 + 4 stocks × 390), against the ~$45/day estimate
     * `paper-profile.ts` carries. Restated rather than imported because the
     * point is to check the shipped constants against the reasoning, and a
     * derivation that imports its own conclusion checks nothing.
     */
    const SOAK_DAYS = 14;

    /**
     * **The cost model these tests used has been invalidated, and that is the
     * finding, not a nuisance.**
     *
     * They previously derived spend from instrument-*passes* — `passesPerDay ×
     * USD_PER_PASS` — because while #617 was open the debate re-ran on every
     * tick within a bar, so cost really was proportional to 1/τ. #617 is
     * closed (`7d68fa0`): `debate-adapter.ts`'s same-bar short-circuit returns
     * the persisted debate ahead of the spend cap, the rate limiter and every
     * LLM call, so **spend is keyed to the debate bar and a faster tick is
     * free**.
     *
     * Keeping the old arithmetic would not merely fail — it would fail in the
     * direction that forbids the correct value, which is how a stale test
     * becomes a veto on a decision it never made.
     *
     * Measured units, doc 41 / #657: **$0.0060 and ~13s per debate run**.
     */
    const USD_PER_DEBATE = 0.006;
    const PASS_DURATION_MS = 13_000;
    /**
     * 1h bars: 24/day for the 24/7 crypto leg, ~7 for a full US equity session.
     *
     * The equity term is deliberately the PRE-window figure. `stocksTradingWindow`
     * (#706) narrows entries to 14:30-15:45 London, which cuts the real count to
     * ~2 per name per session — so 7 now overstates it ~3.5x. Kept anyway,
     * because this is a budget headroom assertion and the honest failure
     * direction is to over-estimate spend: re-keying it to 2 would let a later
     * widening of the window silently consume headroom this test claims to
     * guard. Update it only alongside a change that makes 7 an UNDER-estimate.
     */
    const DEBATES_PER_DAY = 2 * 24 + 4 * 7;

    it('carries the budget, and the cadence #670 stepped to once #617 closed', () => {
      const profile = paperStartingProfile('paper');

      expect(profile.llmBudgetUsd).toBe(50);
      expect(profile.tickIntervalMs).toBe(120_000);
    });

    it('fits a full 14 days inside the budget on the bar-keyed cost model', () => {
      // Still "whatever the literal is, the soak it implies is affordable" —
      // but the literal that governs spend is now the debate bar, not the tick
      // interval. ~$6.4 against a $50 cap.
      const profile = paperStartingProfile('paper');

      expect(DEBATES_PER_DAY * SOAK_DAYS * USD_PER_DEBATE).toBeLessThan(profile.llmBudgetUsd);
    });

    it('leaves a pass room to finish, so a digit slip cannot outrun the tick', () => {
      // The floor that replaces the old budget guard. A `2 * 60_00` slip is
      // 12s — under the measured 13s pass — and would have every tick land on
      // a pass still running. Four passes of headroom.
      expect(paperStartingProfile('paper').tickIntervalMs).toBeGreaterThanOrEqual(
        4 * PASS_DURATION_MS,
      );
    });

    it('ticks fast enough that the stop means what it says', () => {
      // The ceiling that replaces "too slowly to trade", and it is a stronger
      // claim than plumbing-liveness. Entries are bar-gated, so cadence buys
      // EXIT resolution: doc 41 Result 2 measures the conditional tail as
      // g(D) = 0.525%·√D on a 3x equity ETP, at a mean delay of τ/2.
      //
      // Against ADR-0018 D3's -2.16% neutral stop, τ = 15 min overshoots by
      // ~1.44% — two thirds of the stop distance, i.e. a stop that does not
      // mean what it says. τ = 2 min gives ~0.53%, under a quarter.
      const profile = paperStartingProfile('paper');
      const meanDelayMinutes = profile.tickIntervalMs / 60_000 / 2;
      const overshootPct = 0.525 * Math.sqrt(meanDelayMinutes);
      const NEUTRAL_STOP_PCT = 2.16;

      expect(overshootPct).toBeLessThan(NEUTRAL_STOP_PCT / 3);
    });
  });

  /**
   * #1013: `maxConcurrentInstruments` used to fall through to
   * `buildProductionOrchestrator`'s `?? 1` default, silently — the universe
   * walked one instrument at a time regardless of how wide `runTickPlan`'s
   * pool could otherwise run. These pin the explicit value this profile now
   * carries, and the two claims that justify it: today's universe fits
   * without serializing, and the width stays well inside the rate limiter's
   * own budget even in the worst case the pool could produce.
   */
  describe('maxConcurrentInstruments (#1013)', () => {
    it('is set explicitly, not left to the ?? 1 fallback that made every pass serial', () => {
      const profile = paperStartingProfile('paper');

      expect(profile.maxConcurrentInstruments).toBeDefined();
      expect(profile.maxConcurrentInstruments).toBe(6);
    });

    /**
     * REPLACES a check that asserted this pass against
     * `verdictConfig.max_signal_age.stocks` and `max_mark_age.stocks` and
     * called itself "that argument, executable" (#1104). It was neither.
     * Verdict's gate 1 measures `now - orderIntent.decided_at`, and
     * `decided_at` is a `clock.now()` read inside that instrument's OWN Trader
     * step (decide.ts) — so the walk it was compared against is not a quantity
     * that gate ever sees, and the comparison passed for a reason unrelated to
     * what it claimed to prove. Gate 2 measures the age of a mark re-fetched at
     * gate time, likewise per-instrument.
     *
     * So this pins the arithmetic instead, from the shipped sub-budgets rather
     * than from #1012's stale ~61s per-instrument estimate. Nothing downstream
     * refuses a pass for being slow — the walk overruns `tickIntervalMs`
     * (120,000ms) by design since #1080 — which makes
     * `maxConcurrentInstruments`' tripwire a HUMAN one, and this pin the thing
     * that forces it to be re-read when either sub-budget moves.
     */
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
      // Headroom, not a hard proof: `RateLimiter.reserve` is what actually
      // enforces `maxDebates` as a ceiling (it never throws, so #785's
      // bounded per-bar retry can't turn a refusal into a runaway) — this
      // just checks that today's universe, and the width itself, both sit
      // comfortably clear of that ceiling on ordinary operation, one debate
      // per instrument per window.
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
      // `paperStartingProfile('backtest')` explicitly overrides
      // `maxConcurrentInstruments` back to 1 rather than inheriting
      // `buildStartingProfileConfigs()`'s 6 — backtest's log-insertion-order
      // determinism depends on instruments running one at a time, unlike
      // paper/live width 6 (see paper-profile.ts's return statement and
      // failover-data-source.ts's replay-determinism comment).
      expect(paperStartingProfile('backtest').maxConcurrentInstruments).toBe(1);
      expect(paperStartingProfile('paper').maxConcurrentInstruments).toBe(6);
    });

    it('tripwire: same-tick portfolio-cap netting (#1019) stays bounded only while the universe carries no subclass — break loudly, not silently, if that changes at width > 1', () => {
      // #1019's mechanism: at width > 1, sibling submissions in the same tick
      // read each other's exposure as zero (the fill poll hasn't caught up),
      // so `perSubclassDeploymentCap`'s cross-instrument netting cannot net
      // same-tick exposure. Today that's harmless only because
      // `subclassOfUniverse(universe)` is empty, which leaves the per-name
      // gates (`perTradeSizeCap`, `perAssetExposureCap`) doing the real work
      // unassisted. If a universe edit adds a `subclass` to any instrument
      // while width stays > 1, this assertion — not a live drawdown — should
      // be the first thing to notice.
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
    // The refusal message is what an operator reads when they try to go live,
    // so every checkable claim in it has to still be true. It has now been
    // wrong twice in the same way: it first blamed "a channel that
    // auto-approves" after ADR-0007 removed the human gate, then blamed #384,
    // #375 and #333 as "three breakers that cannot fire" after all three
    // closed. A refusal whose evidence is checkable and wrong is worse than a
    // vague one, because the next reader trusts it.
    //
    // Pinned two ways: the closed numbers may not reappear, and the standing
    // reason — the soak that would tune these values has not run — must.
    const message = (() => {
      try {
        paperStartingProfile('live');
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return expect.unreachable('paperStartingProfile("live") must throw');
    })();

    // Third time, #868: the seven the list carried from #566 were all closed by
    // 2026-08-18 and still rendered here. The refusal is the second call site
    // of LIVE_MONEY_GATE_SUMMARY, so it is pinned on the same numbers as the
    // live boot — a list corrected in one message and not the other is the
    // divergence live-money-gates.ts exists to prevent.
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
      // Closed 2026-08-19 and deleted from the list in the same edit, per that
      // module's own rule: the change that made the mandatory flat-by-close
      // exit survive a stalled mark source closes it.
      '#826',
      // Closed the same day by the change that stopped Verdict's staleness
      // gate refusing that flatten one stage later; the surviving half of the
      // gap is cited as #900.
      '#894',
      // Closed 2026-08-26 (the "accept the wider envelope" ruling) and
      // replaced by #925 in the same edit.
      '#798',
      // Closed 2026-08-26 (D5 cap authority + equity-relative caps shipped)
      // and replaced by #932, the per_asset_cap gap #886 left open.
      '#886',
      // Closed 2026-08-30 by PR #948 — the funded-equity-vs-declared-book gap.
      // The USD/GBP mismatch it flagged (not fixed) carries forward as #949.
      '#888',
      // Closed 2026-08-31 by PR #952 — the drawdown breaker's hard ceiling
      // raised to 0.45 and MEASURED_DRAWDOWN_ENVELOPE to 0.418, per David's
      // approval to widen it to 0.45.
      '#925',
      // Closed 2026-08-31 by PR #956 — per_asset_cap now exempts a
      // D5-classified instrument the same way #886 exempted per_trade_size_cap.
      '#932',
    ]) {
      expect(message).not.toContain(closed);
    }
    for (const open of ['#895', '#900']) {
      expect(message).toContain(open);
    }
    expect(message).toContain('#238');
    expect(message).toContain('has not run');
    expect(message).toContain('yarn check:live-gates');
  });

  it('routes an operator to the live profile rather than to a dead end', () => {
    // #511: the refusal must not read as "live is unreachable". It is reachable
    // and deliberately explicit — through a profile whose caps come from a
    // declared ceiling rather than from an assumed paper balance.
    expect(() => paperStartingProfile('live')).toThrow('liveStartingProfile');
    expect(() => paperStartingProfile('live')).toThrow('SAMURAI_LIVE_MAX_CAPITAL_USD');
  });

  it('bounds the hard drawdown breaker above the designed envelope, as a fraction', () => {
    // `PortfolioView.drawdown_pct` is computed as `(peak - equity) / peak`
    // (portfolio-view.ts) — a FRACTION, despite the `_pct` name. A `30` here
    // would mean 3000% and never trip.
    //
    // 0.44 is the owner ruling on #634, re-sited 2026-08-31 by David's
    // approval of #925 above ADR-0018's measured drawdown envelope (26.2%
    // index ETPs / 41.8% single-stock at today's sizing, #729/#798 —
    // supersedes the older 23.1%/26.2% pair the trip used to sit above).
    // CONTEXT.md's "~20-25%" is that envelope's design target, not the halt
    // line — it binds on the RE-ARM edge below instead.
    const { breakerConfig } = paperStartingProfile('paper');

    expect(breakerConfig.max_drawdown_pct).toBe(0.44);
    expect(breakerConfig.max_drawdown_pct).toBeGreaterThan(0.418);

    // The hysteresis band (#634): re-arm strictly inside the trip level, and
    // back within the design envelope rather than merely off its worst point.
    expect(breakerConfig.auto_rearm.recovery_drawdown_pct).toBe(0.2);
    expect(breakerConfig.auto_rearm.recovery_drawdown_pct).toBeLessThan(
      breakerConfig.max_drawdown_pct,
    );
    expect(breakerConfig.daily_loss_pct).toBeGreaterThan(0);
    expect(breakerConfig.daily_loss_pct).toBeLessThan(breakerConfig.max_drawdown_pct);

    // Same fraction convention for the per-class tier (#333) — and the same
    // trap: these share ONE denominator with the portfolio figure (portfolio
    // equity), so a `5` here would be 500% and the class tier would never trip,
    // silently leaving only the account-wide floor in place.
    for (const asset_class of ['crypto', 'stocks'] as const) {
      const threshold = breakerConfig.daily_loss_pct_by_class[asset_class];
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThan(breakerConfig.max_drawdown_pct);
    }
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

  // #1032 item 2: the live equity venue is Saxo (ADR-0015, 2026-08-30), and
  // its Classic-tier commission (ADR-0015:201) only reaches `CostModelImpl`
  // when BOTH halves are wired — the venue override in `costConfig.venues`
  // AND the venue stamp on every `MarketState` the Simulated adapter and the
  // submit-time snapshot build. Either half alone is inert.
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
      expect(feedback?.loosenNotices).toBeUndefined();
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
          // #384: the revalidation source. Empty here, which is the state a
          // deployment that has never run Stage 2 is in.
          stage2Selections: new SqliteStage2SelectionStore(db),
          clock: new SystemClock(),
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

      const notifyLoosenApplied = vi.fn();
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
        loosen_notices: { notifyLoosenApplied },
        proposals: [],
      });

      expect(result.applied).toBe(false);
      expect(result.param_updates).toEqual({});
      expect(notifyLoosenApplied).not.toHaveBeenCalled();
    });
  });
});
