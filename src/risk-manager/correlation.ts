/**
 * Dynamic correlation-matrix concentration estimate (ticket #50 — v2 of the
 * Risk Manager's concentration check, replacing v1's static
 * `ConcentrationBucket` list). See docs/specs/risk-manager-spec.md ("Module:
 * Check Pipeline") and docs/wayfinder/risk-manager-map.md.
 *
 * Computed here — async, `MarketDataService`-backed — and passed into
 * `evaluate()` as a pre-built `CorrelationEstimate`, the same seam
 * `computePortfolioView` (#78) and `CircuitBreakers` (#77) use to keep
 * `evaluate()` itself synchronous and deterministic-given-inputs.
 *
 * Point-in-time by construction: every return series comes from
 * `MarketDataService.getBars(instrument, window, asOf)`, which is
 * no-lookahead by construction (same guarantee the accounting view relies
 * on for marks). A pair with fewer than `min_bars` overlapping returns is
 * simply omitted from the output — that omission is the warm-up fallback
 * (risk-manager-map.md AC3), not a fabricated correlation.
 */
import type { Bar, BarWindow, MarketDataService } from '../market-data-service/index.js';
import type { CorrelationEstimate } from './types.js';

export interface CorrelationConfig {
  /** Bar timeframe + lookback the return series is drawn from. */
  window: BarWindow;
  /** Minimum overlapping return observations before a pair is trusted; pairs below this are omitted. */
  min_bars: number;
}

export interface CorrelationEstimateInput {
  /** The intent's instrument — correlation is computed against this one. */
  instrument: string;
  /** Every other instrument currently held (from `PortfolioView.exposure_by_instrument`). */
  otherInstruments: string[];
  marketData: MarketDataService;
  /** Point-in-time read for every bar lookup — never wall-clock. */
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

/** Pearson correlation over the trailing overlap of two return series. */
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
        const bars = await marketData.getBars(i, config.window, asOf);
        return [i, logReturns(bars)] as const;
      }),
    ),
  );

  const targetReturns = returnsByInstrument.get(instrument) ?? [];
  const correlations: Record<string, number> = {};

  for (const other of otherInstruments) {
    const otherReturns = returnsByInstrument.get(other) ?? [];
    const overlap = Math.min(targetReturns.length, otherReturns.length);
    if (overlap < config.min_bars) continue;
    correlations[other] = pearsonCorrelation(targetReturns, otherReturns);
  }

  return { correlations };
}
