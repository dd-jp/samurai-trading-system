import { RVOL_5M_LOOKBACK } from '../../../pipeline/analysts/index.js';
import type { BarWindow, MarketDataService } from '../../../providers/market-data-service/index.js';
import { describeThrownSafely } from '../../../shared/index.js';
import type { Logger, UniverseInstrument } from '../types.js';

export const FIRST_TICK_BAR_WINDOWS: readonly BarWindow[] = [
  { timeframe: '5m', lookback: RVOL_5M_LOOKBACK },
  { timeframe: '1h', lookback: 57 },
  { timeframe: '1d', lookback: 30 },
];

export interface BarPrefetchDeps {
  marketData: Pick<MarketDataService, 'getBars'>;
  universe: readonly UniverseInstrument[];
  asOf: Date;
  logger: Logger;
  traceId: string;
  windows?: readonly BarWindow[];
}

export interface BarPrefetchResult {
  warmed: number;
  failed: number;
}

export async function prefetchBars(deps: BarPrefetchDeps): Promise<BarPrefetchResult> {
  const windows = deps.windows ?? FIRST_TICK_BAR_WINDOWS;
  let warmed = 0;
  let failed = 0;

  for (const instrument of deps.universe) {
    for (const window of windows) {
      try {
        await deps.marketData.getBars(instrument.asset, window, deps.asOf);
        warmed += 1;
      } catch (error) {
        failed += 1;
        deps.logger.log({
          trace_id: deps.traceId,
          stage: 'market_data',
          event: 'bar_prefetch_window_failed',
          level: 'warn',
          message:
            `bar prefetch could not warm ${instrument.asset} ${window.timeframe} ` +
            `(lookback ${window.lookback}): ${describeThrownSafely(error)}. The first tick will ` +
            'reach the venue for this window itself.',
          payload: {
            instrument: instrument.asset,
            timeframe: window.timeframe,
            lookback: window.lookback,
          },
        });
      }
    }
  }

  deps.logger.log({
    trace_id: deps.traceId,
    stage: 'market_data',
    event: 'bar_prefetch_complete',
    level: failed > 0 ? 'warn' : 'info',
    message:
      `bar prefetch warmed ${warmed} of ${warmed + failed} (instrument, window) pair(s) before ` +
      'the tick loop was armed',
    payload: { warmed, failed, windows: windows.map((w) => `${w.timeframe}/${w.lookback}`) },
  });

  return { warmed, failed };
}
