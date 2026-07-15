/**
 * Market Data Service — bar/mark serving core (ticket #64).
 * See docs/specs/market-data-service-spec.md (Module: Point-in-Time
 * Enforcement, Module: Marks) and docs/specs/cross-spec-contracts.md §3.
 */
import type { Clock } from '../shared/clock.js';
import type { Bar, BarWindow, DataSource, Mark, MarketDataService } from './types.js';

export class MarketDataServiceImpl implements MarketDataService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly clock: Clock,
    private readonly mode: 'live' | 'backtest',
  ) {}

  /**
   * Returns only bars with close_time <= asOf — the forming candle is never
   * returned as complete. Re-applied here (not left solely to the source)
   * so the no-lookahead guarantee holds at this seam regardless of source
   * behaviour.
   */
  async getBars(
    instrument: string,
    window: BarWindow,
    asOf: Date = this.clock.now(),
  ): Promise<Bar[]> {
    const bars = await this.dataSource.fetchBars(instrument, window, asOf);
    return bars.filter((bar) => bar.close_time.getTime() <= asOf.getTime());
  }

  /**
   * Live vs backtest derivation lives inside `DataSource.fetchMark(mode)`;
   * this method forwards `mode` without branching on it, staying mode-blind.
   */
  async getMark(instrument: string, asOf: Date = this.clock.now()): Promise<Mark> {
    return this.dataSource.fetchMark(instrument, asOf, this.mode);
  }
}
