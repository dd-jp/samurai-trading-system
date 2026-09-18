import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOLATILITY_INDICATOR } from '../../apps/orchestrator/production/defaults.js';
import {
  type Bar,
  computeIndicator,
  type IndicatorSpec,
  minimumBarsFor,
  recommendedWarmupFor,
} from '../../providers/market-data-service/index.js';
import { atrIndicatorSpec } from './decide.js';

const PERIOD = 14;

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../providers/market-data-service/__fixtures__/indicator-golden.json',
        import.meta.url,
      ),
    ),
    { encoding: 'utf8' },
  ),
) as {
  bars: {
    open_time: number;
    close_time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
};

const BARS: Bar[] = GOLDEN.bars.map((raw) => ({
  instrument: 'GOLDEN',
  timeframe: '1h',
  open_time: new Date(raw.open_time),
  close_time: new Date(raw.close_time),
  open: raw.open,
  high: raw.high,
  low: raw.low,
  close: raw.close,
  volume: raw.volume,
  source: 'golden-fixture',
}));

function atrAt(endIndex: number, lookback: number): number {
  const start = Math.max(0, endIndex - lookback);
  const window = BARS.slice(start, endIndex);
  const spec: IndicatorSpec = {
    indicator: 'atr',
    params: { period: PERIOD },
    timeframe: '1h',
    lookback: window.length,
  };
  return computeIndicator(window, spec);
}

const FLOOR = minimumBarsFor({
  indicator: 'atr',
  params: { period: PERIOD },
  timeframe: '1h',
  lookback: 15,
});
const CONVERGED = 4 * PERIOD + 1;
const WARM = 200;

const REGION = Array.from({ length: 141 }, (_, i) => i + 60);

describe('both live ATR specs sit on a converged warm-up (#757)', () => {
  it('atrIndicatorSpec asks for the recommendation, not the fabrication floor', () => {
    const spec = atrIndicatorSpec(PERIOD, '1h');
    expect(spec.params.period).toBe(PERIOD);
    expect(FLOOR).toBe(PERIOD + 1);
    expect(spec.lookback).toBe(recommendedWarmupFor(spec));
    expect(spec.lookback).toBe(CONVERGED);
    expect(spec.lookback).toBeGreaterThan(FLOOR);
  });

  it('DEFAULT_VOLATILITY_INDICATOR asks for the recommendation too', () => {
    expect(DEFAULT_VOLATILITY_INDICATOR.params.period).toBe(PERIOD);
    expect(DEFAULT_VOLATILITY_INDICATOR.lookback).toBe(
      recommendedWarmupFor(DEFAULT_VOLATILITY_INDICATOR),
    );
    expect(DEFAULT_VOLATILITY_INDICATOR.lookback).toBe(CONVERGED);
    expect(DEFAULT_VOLATILITY_INDICATOR.lookback).toBeGreaterThan(FLOOR);
  });

  it('minimumBarsFor is unchanged — the floor still trades, just less warm', () => {
    expect(minimumBarsFor(atrIndicatorSpec(PERIOD, '1h'))).toBe(FLOOR);
    expect(minimumBarsFor(DEFAULT_VOLATILITY_INDICATOR)).toBe(FLOOR);
  });

  it('the declared gate: relative shift floor vs converged, over the fixture region', () => {
    const relShifts: number[] = [];
    const signedShifts: number[] = [];
    for (const end of REGION) {
      const floor = atrAt(end, FLOOR);
      const converged = atrAt(end, CONVERGED);
      relShifts.push(Math.abs(converged - floor) / floor);
      signedShifts.push((converged - floor) / floor);
    }
    relShifts.sort((a, b) => a - b);
    const median = relShifts[Math.floor(relShifts.length / 2)] as number;
    const p90 = relShifts[Math.floor(relShifts.length * 0.9)] as number;
    const meanSigned = signedShifts.reduce((a, b) => a + b, 0) / signedShifts.length;

    expect(median).toBeLessThanOrEqual(0.15);
    expect(p90).toBeLessThanOrEqual(0.3);
    expect(median).toBeCloseTo(0.0301, 3);
    expect(p90).toBeCloseTo(0.0693, 3);
    expect(Math.abs(meanSigned)).toBeLessThan(0.02);
  });

  it('the converged width has actually converged, against a 200-bar reference', () => {
    for (const end of [120, 200, 340, BARS.length]) {
      const converged = atrAt(end, CONVERGED);
      const warm = atrAt(end, WARM);
      expect(Math.abs(converged - warm) / warm).toBeLessThan(0.02);
    }
  });

  it('and no longer the plain-mean seed the floor returns', () => {
    for (const end of [120, 200, 340, BARS.length]) {
      expect(Math.abs(atrAt(end, CONVERGED) - atrAt(end, FLOOR))).toBeGreaterThan(0);
    }
  });
});
