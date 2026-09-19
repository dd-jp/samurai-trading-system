import type { TradingCalendar } from '../../providers/market-data-service/index.js';
import type { Clock } from '../../shared/index.js';
import type { Scheduler, TickPlan, UniverseInstrument } from './types.js';

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
  calendar: TradingCalendar;
  stocksTradingWindow?: (instant: Date) => boolean;
  postCloseFlattenWindow?: (instant: Date) => boolean;
}

export class UniverseScheduler implements Scheduler {
  constructor(private readonly config: SchedulerConfig) {}

  private isMarketOpen(tickTime: Date): boolean {
    return (
      this.config.calendar.isOpen(tickTime) && (this.config.stocksTradingWindow?.(tickTime) ?? true)
    );
  }

  nextTick(clock: Clock): TickPlan {
    const tickTime = clock.now();

    if (this.isMarketOpen(tickTime)) {
      return { instruments: [...this.config.universe], tick_time: tickTime };
    }

    if (this.config.postCloseFlattenWindow?.(tickTime) ?? false) {
      return { instruments: [...this.config.universe], tick_time: tickTime, grace_only: true };
    }

    return { instruments: [], tick_time: tickTime };
  }
}
