/**
 * Scheduler (ticket #94) — see docs/specs/orchestrator-spec.md (Module: Scheduler).
 *
 * Crypto instruments always fire (24/7, no session boundaries). Stock
 * instruments fire only when the injected trading calendar reports the market
 * open at `tick_time`, so a tick never fires into a closed market
 * (orchestrator-spec.md stories 1-2).
 *
 * The calendar is an injected dependency, not designed here — the port already
 * exists at src/market-data-service/trading-calendar.ts (#66), which is the
 * same seam the spec's "small injected dependency (holiday/session table)"
 * describes. The real holiday/session table implements it without touching
 * this file.
 */
import type { TradingCalendar } from '../market-data-service/trading-calendar.js';
import type { Clock } from '../shared/clock.js';
import type { Scheduler, TickPlan, UniverseInstrument } from './types.js';

/**
 * The default universe (ADR-0001, orchestrator-spec.md story 3). Configurable
 * so the covered universe changes without a code change.
 */
export const DEFAULT_UNIVERSE: readonly UniverseInstrument[] = [
  { asset: 'SPY', asset_class: 'stocks' },
  { asset: 'QQQ', asset_class: 'stocks' },
  { asset: 'AAPL', asset_class: 'stocks' },
  { asset: 'TSLA', asset_class: 'stocks' },
  { asset: 'BTC-USD', asset_class: 'crypto' },
  { asset: 'ETH-USD', asset_class: 'crypto' },
];

export interface SchedulerConfig {
  universe: readonly UniverseInstrument[];
  /** Gates stock instruments only; crypto never consults it. */
  calendar: TradingCalendar;
}

export class UniverseScheduler implements Scheduler {
  constructor(private readonly config: SchedulerConfig) {}

  nextTick(clock: Clock): TickPlan {
    const tickTime = clock.now();
    // Read once per tick, not per instrument: every stock in the plan must be
    // gated on the same instant, or a session boundary crossed mid-iteration
    // would produce a plan that was never true at any single point in time.
    const stocksOpen = this.config.calendar.isOpen(tickTime);

    return {
      instruments: this.config.universe.filter(
        (instrument) => instrument.asset_class === 'crypto' || stocksOpen,
      ),
      tick_time: tickTime,
    };
  }
}
