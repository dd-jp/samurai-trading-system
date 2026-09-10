/**
 * Scheduler (ticket #94) — see docs/specs/orchestrator-spec.md (Module: Scheduler).
 *
 * **2026-08-17 (#738) — crypto is out of Samurai's scope, and this file is
 * asset-class-blind, not asset-class-aware-and-inert.** Every instrument in
 * `universe` — whatever its `asset_class` — fires only when the injected
 * trading calendar reports the market open at `tick_time`, so a tick never
 * fires into a closed market (orchestrator-spec.md stories 1-2). There is no
 * "crypto always fires" exception: `asset_class` is read nowhere in this
 * file. `AssetClass` keeps its `'crypto'` member and `UniverseInstrument`
 * still accepts crypto rows — a caller that configures one (the smoke
 * harness does) gets it gated exactly like any other name, by whatever
 * calendar that caller injects.
 *
 * The calendar is an injected dependency, not designed here — the port already
 * exists at server/providers/market-data-service/trading-calendar.ts (#66), which is the
 * same seam the spec's "small injected dependency (holiday/session table)"
 * describes. The real holiday/session table implements it without touching
 * this file.
 */
import type { TradingCalendar } from '../../providers/market-data-service/index.js';
import type { Clock } from '../../shared/index.js';
import type { Scheduler, TickPlan, UniverseInstrument } from './types.js';

/**
 * The default universe (ADR-0001, orchestrator-spec.md story 3). Configurable
 * so the covered universe changes without a code change.
 *
 * **Crypto-free as of #738.** Crypto is out of Samurai's scope
 * (ADR-0014 amendment); the two rows this array carried (BTC-USD, ETH-USD)
 * were removed so the production path never resolves a schedule containing
 * one by default. `AssetClass` and `UniverseInstrument` still accept a
 * `'crypto'` row — nothing here forbids one — this array just no longer
 * declares any. `SMOKE_TEST_UNIVERSE` (production.ts) still does, on purpose.
 *
 * **SPY-free as of #1006.** SPY is a `BENCHMARK_INSTRUMENTS` member, and the
 * outside-benchmark path (#981, under #636) writes SPY bars through
 * `buildBenchmarkDataSource`'s fixed port, always normalized against
 * `UsEquityRegularHoursCalendar`. A universe row for SPY makes the orchestrator
 * a SECOND writer of those same `(instrument, timeframe, open_time)` rows under
 * whatever calendar the mode resolves — `AlpacaEquitySessionCalendar` in paper,
 * `LseRegularHoursCalendar` in live — so the two disagree on any early-close
 * session. #989's boot guard refuses to start on exactly that pairing; removing
 * the row removes the collision itself rather than the alarm, and leaves the
 * benchmark port as SPY's only writer.
 *
 * This costs one screening instrument and no tradeable one: the whole
 * SPY/QQQ/AAPL/TSLA universe is already non-tradeable live (ADR-0016 — live
 * instruments are LSE leveraged ETPs), and #751's cutover retires this array's
 * US symbols wholesale.
 *
 * **Widened from 3 to 20 names for the paper soak.** The binding constraint on
 * ADR-0017's Gate 2 is TRADE COUNT (~126 trades on the expectancy sign test),
 * not calendar time, and a 3-name universe produces trades too slowly to reach
 * it in any tolerable number of soaks. Breadth is the only lever that
 * compresses Gate 2 — Gate 1 is 14 calendar days and does not compress. The
 * cost is linear and small: `instruments x 7 hourly bars x 10 sessions x
 * $0.0060/debate` = `instruments x $0.42`, so 20 names is ~$8.40 per 14-day
 * soak against ADR-0008's $50/14d cap (~17%).
 *
 * Three properties this list is chosen to preserve, none of them incidental:
 *
 * - **No `BENCHMARK_INSTRUMENTS` member.** SPY and AGG are the full benchmark
 *   set and BOTH are excluded, for the dual-writer reason stated above — which
 *   is independent of #989's boot guard. That guard only fires when the mode's
 *   calendar is not `UsEquityRegularHoursCalendar`, and paper resolves to
 *   exactly that, so in paper the guard would NOT catch a SPY row. The
 *   exclusion is the control here, not the alarm.
 * - **No `subclass` on any row.** `perSubclassDeploymentCap` (ADR-0018 D5)
 *   stays inert, which is what keeps #1019's same-tick portfolio-cap race
 *   bounded: `computePortfolioView` values a just-submitted order at zero until
 *   a fill poll, so an armed subclass cap could be breached by siblings inside
 *   one tick. With no subclasses the per-name gates (`perTradeSizeCap`,
 *   `perAssetExposureCap`) still bind independently. Do not classify these rows
 *   until #1019 is closed.
 * - **Cash equities and one index ETF, no leveraged ETPs.** A US 3x proxy would
 *   look like the live LSE ETP pool and measure something else entirely: the
 *   spread step (~0.003% here vs ~0.18% there) is the exact substitution that
 *   made ADR-0016's expectancy figures wrong in SIGN. This universe measures
 *   the PIPELINE, not the live instruments' expectancy.
 *
 * Composition is biased to high-beta movers per ADR-0016's movers objective —
 * an intraday, flat-by-close horizon needs names that actually travel far
 * enough within a session to reach a bracket.
 *
 * This is a paper-soak widening, NOT #751. There is no daily re-rank, no
 * session immutability, and no screener here; #751's `ActiveUniverseProvider`
 * cutover still owns all three, and still retires this array's US symbols
 * wholesale when it lands.
 */
export const DEFAULT_UNIVERSE: readonly UniverseInstrument[] = [
  { asset: 'QQQ', asset_class: 'stocks' },
  { asset: 'AAPL', asset_class: 'stocks' },
  { asset: 'TSLA', asset_class: 'stocks' },
  { asset: 'NVDA', asset_class: 'stocks' },
  { asset: 'AMD', asset_class: 'stocks' },
  { asset: 'MSFT', asset_class: 'stocks' },
  { asset: 'AMZN', asset_class: 'stocks' },
  { asset: 'GOOGL', asset_class: 'stocks' },
  { asset: 'META', asset_class: 'stocks' },
  { asset: 'AVGO', asset_class: 'stocks' },
  { asset: 'NFLX', asset_class: 'stocks' },
  { asset: 'MU', asset_class: 'stocks' },
  { asset: 'SMCI', asset_class: 'stocks' },
  { asset: 'PLTR', asset_class: 'stocks' },
  { asset: 'COIN', asset_class: 'stocks' },
  { asset: 'MSTR', asset_class: 'stocks' },
  { asset: 'MARA', asset_class: 'stocks' },
  { asset: 'RIOT', asset_class: 'stocks' },
  { asset: 'SOFI', asset_class: 'stocks' },
  { asset: 'UBER', asset_class: 'stocks' },
];

export interface SchedulerConfig {
  universe: readonly UniverseInstrument[];
  /** Gates every instrument in `universe`, regardless of `asset_class`. */
  calendar: TradingCalendar;
  /**
   * An OPTIONAL narrowing of when equities are TICKED, on top of — never
   * instead of — the calendar (#706).
   *
   * **Read that as ticked, not entered, and do not pass a bare entry window.**
   * The name and the policy below are about entries, but this predicate gates
   * `TickPlan.instruments`, and `runOnce` runs the whole pipeline pass only for
   * the instruments in that plan. An instrument this excludes gets no Analysts,
   * no Debate, and no **Trader** — and the Trader is the only thing that
   * flattens, since `withinFlattenWindow` is evaluated on a tick and there is
   * no session-end job. So an entry window ending before the flatten window
   * begins silently switches flat-by-close off. It was landed that way and
   * caught before the soak; `production/stocks-tick-window.ts` is what the
   * composition root now installs instead, and carries the full argument.
   *
   * **Window is policy; calendar is venue, and they must not be merged.**
   * `LseRegularHoursCalendar`'s 08:00-16:30 is venue truth, and the same
   * object resolves `sessionEnd` for the flatten rule (#657: close minus 5
   * minutes, an offset rather than a wall clock, so it is right on both the
   * Alpaca US paper path and the LSE live path). Narrowing the calendar to
   * express a trading preference would silently move the flatten with it.
   *
   * The policy this exists to carry: #656 measured the LSE 08:00-16:30 and US
   * 14:30-21:00 sessions as overlapping for two hours, and every measurement
   * the intraday product rests on — ADR-0016's reach rates, ADR-0018's
   * brackets, doc 41's diffusion constant — is computed on US tape, because
   * there is no free LSE intraday history. Trading an LSE ETP outside the
   * overlap means trading it at hours no evidence covers, against a market
   * maker quoting into a stale reference.
   *
   * Undefined means "no narrowing", which is what every existing profile and
   * the backtest harness want.
   */
  stocksTradingWindow?: (instant: Date) => boolean;
  /**
   * A WIDENING, OR'd in after the calendar has already said shut (#1389) — the
   * only predicate here that can put an instrument in the plan on its own.
   *
   * `stocksTradingWindow` above is a narrowing on top of `isOpen`, so no
   * combination of the two can produce a tick after the bell — and after the
   * bell is exactly when ADR-0014's flatten grace has to run. The Trader is
   * still the only thing that flattens and it is still evaluated on a tick, so
   * a grace with no tick in it is a grace that does not exist.
   *
   * **Additive rather than replacing the `isOpen` conjunct**, deliberately.
   * Making `stocksTradingWindow` authoritative instead of narrowing would let a
   * bare wall-clock entry window admit weekends and holidays, which is precisely
   * what the calendar is there to refuse. This predicate resolves the close
   * through the same calendar object (`postCloseFlattenTail`), so a non-trading
   * day has no close to be inside the grace of and it answers `false`.
   *
   * Undefined means "no post-close ticks", which is what the backtest harness
   * and every fixture want.
   */
  postCloseFlattenWindow?: (instant: Date) => boolean;
}

export class UniverseScheduler implements Scheduler {
  constructor(private readonly config: SchedulerConfig) {}

  nextTick(clock: Clock): TickPlan {
    const tickTime = clock.now();
    // Read once per tick, not per instrument: every stock in the plan must be
    // gated on the same instant, or a session boundary crossed mid-iteration
    // would produce a plan that was never true at any single point in time.
    //
    // The window is read once for the same reason, and evaluated only when the
    // calendar already says open — it narrows a session, it cannot open one.
    const marketOpen =
      this.config.calendar.isOpen(tickTime) &&
      (this.config.stocksTradingWindow?.(tickTime) ?? true);
    // #1389: OR'd, and read on the same `tickTime` for the same reason. The
    // grace runs when the venue is already shut, so it cannot be expressed as a
    // narrowing of an open session — and a tick admitted here can only CLOSE:
    // the entry path consults `withinFlattenWindow` too and returns
    // `skip('session_closing')` before any bar is fetched.
    const inFlattenGrace = this.config.postCloseFlattenWindow?.(tickTime) ?? false;

    return {
      // No always-open exception for any asset_class (#738) — every
      // instrument in the universe is gated on the same calendar/window
      // instant, or it does not appear in the plan.
      instruments: marketOpen || inFlattenGrace ? [...this.config.universe] : [],
      tick_time: tickTime,
    };
  }
}
