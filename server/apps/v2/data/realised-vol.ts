import type { V2Bar } from '../../../../contracts/index.js';
import { TRADING_DAYS_PER_YEAR } from '../../../shared/index.js';

export function realisedVolatility(bars: readonly V2Bar[], window: number): number | undefined {
  if (bars.length < window + 1) return undefined;
  const closes = bars.slice(-(window + 1)).map((bar) => bar.close);
  if (closes.some((close) => !(close > 0))) return undefined;
  const returns = closes
    .slice(1)
    .map((close, index) => Math.log(close / (closes[index] as number)));
  const mean = returns.reduce((sum, value) => sum + value, 0) / window;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (window - 1);
  return Math.sqrt(variance * TRADING_DAYS_PER_YEAR);
}
