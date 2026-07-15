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

  /**
   * `null` when the source doesn't quote bid/ask at all (`fetchQuote` is
   * unimplemented), when it has no quote for this instrument/asOf, or when
   * a returned quote is timestamped after `asOf` (defensive PIT re-check,
   * mirroring `getBars`'s close-time re-filter) — never a fabricated value.
   */
  async getSpreadEstimate(instrument: string, asOf: Date = this.clock.now()): Promise<number | null> {
    const quote = await this.dataSource.fetchQuote?.(instrument, asOf);
    if (!quote || quote.observed_at.getTime() > asOf.getTime()) {
      return null;
    }
    return quote.ask - quote.bid;
  }

  /**
   * Average bars volume over the window, via the same PIT-filtered
   * `getBars` every other read uses. Throws when the window has no bars
   * (matching `FixtureDataSource.fetchMark`'s "no completed bar" behaviour)
   * rather than returning 0, which would divide-by-zero in the cost
   * model's √(size / adv) market-impact term.
   */
  async getADV(instrument: string, window: BarWindow, asOf: Date = this.clock.now()): Promise<number> {
    const bars = await this.getBars(instrument, window, asOf);
    if (bars.length === 0) {
      throw new Error(`No bars for ${instrument} in window ending ${asOf.toISOString()} to compute ADV`);
    }
    const totalVolume = bars.reduce((sum, bar) => sum + bar.volume, 0);
    return totalVolume / bars.length;
  }
}
