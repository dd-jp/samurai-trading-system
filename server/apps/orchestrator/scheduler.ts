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
 */
export const DEFAULT_UNIVERSE: readonly UniverseInstrument[] = [
  { asset: 'QQQ', asset_class: 'stocks' },
  { asset: 'AAPL', asset_class: 'stocks' },
  { asset: 'TSLA', asset_class: 'stocks' },
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

    return {
      // No always-open exception for any asset_class (#738) — every
      // instrument in the universe is gated on the same calendar/window
      // instant, or it does not appear in the plan.
      instruments: marketOpen ? [...this.config.universe] : [],
      tick_time: tickTime,
    };
  }
}
