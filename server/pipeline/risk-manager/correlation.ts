import type {
  Bar,
  BarWindow,
  MarketDataService,
} from '../../providers/market-data-service/index.js';
import type { CorrelationEstimate } from './types.js';

export interface CorrelationConfig {
  window: BarWindow;
  min_bars: number;
}

export interface CorrelationEstimateInput {
  instrument: string;
  otherInstruments: string[];
  marketData: MarketDataService;
  asOf: Date;
  config: CorrelationConfig;
}

function logReturns(bars: Bar[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1];
    const current = bars[i];
    if (previous === undefined || current === undefined) continue;
    returns.push(Math.log(current.close / previous.close));
  }
  return returns;
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const x = a.slice(-n);
  const y = b.slice(-n);
  const meanX = x.reduce((sum, v) => sum + v, 0) / n;
  const meanY = y.reduce((sum, v) => sum + v, 0) / n;

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined || yi === undefined) continue;
    const dx = xi - meanX;
    const dy = yi - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  if (varianceX === 0 || varianceY === 0) return 0;
  return covariance / Math.sqrt(varianceX * varianceY);
}

export async function computeCorrelationEstimate(
  input: CorrelationEstimateInput,
): Promise<CorrelationEstimate> {
  const { instrument, otherInstruments, marketData, asOf, config } = input;

  const instruments = [instrument, ...otherInstruments];
  const returnsByInstrument = new Map<string, number[]>(
    await Promise.all(
      instruments.map(async (i) => {
        const bars = await marketData.getBars(i, { ...config.window, partial: 'allow' }, asOf);
        return [i, logReturns(bars)] as const;
      }),
    ),
  );

  const targetReturns = returnsByInstrument.get(instrument) ?? [];
  const correlations: Record<string, number> = {};
  const insufficient_history: string[] = [];

  for (const other of otherInstruments) {
    const otherReturns = returnsByInstrument.get(other) ?? [];
    const overlap = Math.min(targetReturns.length, otherReturns.length);
    if (overlap < config.min_bars) {
      insufficient_history.push(other);
      continue;
    }
    correlations[other] = pearsonCorrelation(targetReturns, otherReturns);
  }

  return { correlations, insufficient_history };
}
