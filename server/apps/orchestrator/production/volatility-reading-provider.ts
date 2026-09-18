import type { VolatilityReading } from '../../../pipeline/risk-manager/index.js';
import type {
  IndicatorSpec,
  IndicatorValue,
  MarketDataService,
  TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import { currentTraceId, describeThrownSafely } from '../../../shared/index.js';
import type { AssetClass, Logger, UniverseInstrument } from '../types.js';
import type { VolatilityReadingProvider } from './direct-bind.js';

export interface VolatilityReadingProviderConfig {
  marketData: MarketDataService;
  universe: readonly UniverseInstrument[];
  volatility_indicator: IndicatorSpec;
  calendars: Record<AssetClass, TradingCalendar>;
  logger: Logger;
}

const NO_READING = 0;

const FAILURE_READING = Number.POSITIVE_INFINITY;

const ASSET_CLASSES = ['crypto', 'stocks'] as const satisfies readonly AssetClass[];

const MAX_CONCURRENT_INDICATOR_CALLS = 8;

export class MarketDataVolatilityReadingProvider implements VolatilityReadingProvider {
  constructor(private readonly config: VolatilityReadingProviderConfig) {
    for (const asset_class of ASSET_CLASSES) {
      warnIfClassEmpty(config.universe, asset_class, config.logger);
    }
  }

  async getVolatilityReading(asOf: Date): Promise<VolatilityReading> {
    const { marketData, universe, volatility_indicator, calendars, logger } = this.config;

    const open = universe.filter((instrument) => calendars[instrument.asset_class].isOpen(asOf));

    const settled = await settleWithConcurrency(
      open,
      MAX_CONCURRENT_INDICATOR_CALLS,
      (instrument) => marketData.getIndicator(instrument.asset, volatility_indicator, asOf),
    );

    const readings = open.map((instrument, index) => {
      const result = settled[index] as PromiseSettledResult<IndicatorValue>;

      if (result.status === 'rejected') {
        logger.log({
          trace_id: currentTraceId() ?? 'volatility-reading-provider',
          stage: 'volatility-reading-provider',
          event: 'volatility_indicator_rejected',
          level: 'error',
          message:
            'getIndicator rejected; treating instrument as fail-closed (max reading) rather than excluding it',
          payload: {
            instrument: instrument.asset,
            asset_class: instrument.asset_class,
            error: sanitizeErrorMessage(describeThrownSafely(result.reason)),
          },
        });
        return { asset_class: instrument.asset_class, value: FAILURE_READING };
      }

      const { value } = result.value;
      if (!Number.isFinite(value)) {
        logger.log({
          trace_id: currentTraceId() ?? 'volatility-reading-provider',
          stage: 'volatility-reading-provider',
          event: 'volatility_indicator_non_finite',
          level: 'error',
          message:
            'getIndicator returned a non-finite value; treating instrument as fail-closed (max reading) rather than excluding it',
          payload: { instrument: instrument.asset, asset_class: instrument.asset_class, value },
        });
        return { asset_class: instrument.asset_class, value: FAILURE_READING };
      }

      return { asset_class: instrument.asset_class, value };
    });

    return {
      crypto: maxByClass(readings, 'crypto'),
      stocks: maxByClass(readings, 'stocks'),
    };
  }
}

async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = Array.from<PromiseSettledResult<R>>({ length: items.length });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index] as T;
      try {
        const value = await fn(item);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

function sanitizeErrorMessage(message: string): string {
  const MAX_LENGTH = 200;
  const redacted = message.replace(/([?&][\w.-]+=)[^\s&]*/g, '$1[redacted]');
  return redacted.length > MAX_LENGTH ? `${redacted.slice(0, MAX_LENGTH)}…` : redacted;
}

function warnIfClassEmpty(
  universe: readonly UniverseInstrument[],
  asset_class: AssetClass,
  logger: Logger,
): void {
  if (universe.some((instrument) => instrument.asset_class === asset_class)) {
    return;
  }
  logger.log({
    trace_id: 'volatility-reading-provider',
    stage: 'volatility-reading-provider',
    event: 'volatility_universe_empty',
    level: 'warn',
    message:
      'no instruments configured for asset class; volatility breaker reads 0 (inert) for this class',
    payload: { asset_class },
  });
}

function maxByClass(
  readings: readonly { asset_class: AssetClass; value: number }[],
  asset_class: AssetClass,
): number {
  const values = readings
    .filter((reading) => reading.asset_class === asset_class)
    .map((reading) => reading.value);
  return values.length === 0 ? NO_READING : Math.max(...values);
}
