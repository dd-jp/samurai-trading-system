
import type { Bar, IndicatorSpec } from '../../providers/market-data-service/index.js';
import {
  computeIndicator,
  recommendedWarmupFor,
} from '../../providers/market-data-service/index.js';

export interface ProxyStrategyConfig {
  fastWindow: number;
  slowWindow: number;
  atrWindow: number;
  atrStopMult: number;
  atrTargetMult: number;
  allowShort: boolean;
}

export function proxyAtrSpec(config: ProxyStrategyConfig, timeframe: string): IndicatorSpec {
  const floor: IndicatorSpec = {
    indicator: 'atr',
    params: { period: config.atrWindow },
    timeframe,
    lookback: config.atrWindow + 1,
  };
  return { ...floor, lookback: recommendedWarmupFor(floor) };
}

export function proxyWarmupBars(config: ProxyStrategyConfig, timeframe: string): number {
  return Math.max(config.fastWindow, config.slowWindow, proxyAtrSpec(config, timeframe).lookback);
}

export interface ProxySignal {
  direction: 'long' | 'short' | 'flat';
  stop: number;
  target: number;
}

export function proxySignal(
  bars: readonly Bar[],
  config: ProxyStrategyConfig,
  timeframe: string,
): ProxySignal {
  const fastSma = computeIndicator(bars.slice(-config.fastWindow) as Bar[], {
    indicator: 'sma',
    params: {},
    timeframe,
    lookback: config.fastWindow,
  });
  const slowSma = computeIndicator(bars.slice(-config.slowWindow) as Bar[], {
    indicator: 'sma',
    params: {},
    timeframe,
    lookback: config.slowWindow,
  });

  const favored: 'long' | 'short' | 'flat' =
    fastSma > slowSma ? 'long' : fastSma < slowSma ? 'short' : 'flat';

  const lastBar = bars[bars.length - 1];
  if (lastBar === undefined) {
    throw new Error('proxySignal: bars must not be empty.');
  }
  const lastClose = lastBar.close;

  if (favored === 'flat' || (favored === 'short' && !config.allowShort)) {
    return { direction: 'flat', stop: lastClose, target: lastClose };
  }

  const atrSpec = proxyAtrSpec(config, timeframe);
  const atrValue = computeIndicator(bars.slice(-atrSpec.lookback) as Bar[], atrSpec);

  return favored === 'long'
    ? {
        direction: 'long',
        stop: lastClose - atrValue * config.atrStopMult,
        target: lastClose + atrValue * config.atrTargetMult,
      }
    : {
        direction: 'short',
        stop: lastClose + atrValue * config.atrStopMult,
        target: lastClose - atrValue * config.atrTargetMult,
      };
}
