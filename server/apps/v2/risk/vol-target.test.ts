import { describe, expect, it } from 'vitest';
import type { V2Bar } from '../../../../contracts/index.js';
import { realisedVolatility } from '../data/index.js';
import {
  assertVolTargetSizing,
  type VolTargetSizing,
  volTargetBarsWanted,
  volTargetRiskScale,
  volTargetScale,
} from './vol-target.js';

const SIZING: VolTargetSizing = { annualTargetVol: 0.2, windowBars: 3, sleeveIds: ['debate'] };

function bars(closes: readonly number[], lastDate = '2026-09-24'): V2Bar[] {
  const last = Date.parse(`${lastDate}T00:00:00.000Z`);
  return closes.map((close, index) => ({
    date: new Date(last - (closes.length - 1 - index) * 86_400_000).toISOString().slice(0, 10),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
    rawClose: close,
  }));
}

describe('assertVolTargetSizing', () => {
  it('accepts a positive finite target over a window of at least two returns', () => {
    expect(() => assertVolTargetSizing(SIZING)).not.toThrow();
    expect(() => assertVolTargetSizing({ ...SIZING, windowBars: 2 })).not.toThrow();
  });

  it.each([
    { annualTargetVol: 0 },
    { annualTargetVol: -0.1 },
    { annualTargetVol: Number.NaN },
    { annualTargetVol: Number.POSITIVE_INFINITY },
    { windowBars: 1 },
    { windowBars: 2.5 },
  ])('refuses %o', (override) => {
    expect(() => assertVolTargetSizing({ ...SIZING, ...override })).toThrow(
      /vol-target sizing out of range: .* \(#1860\)/,
    );
  });
});

describe('volTargetScale', () => {
  it('never scales up: at or below the target the risk fraction is unchanged', () => {
    expect(volTargetScale(0.2, 0)).toBe(1);
    expect(volTargetScale(0.2, 0.1)).toBe(1);
    expect(volTargetScale(0.2, 0.2)).toBe(1);
  });

  it('scales down by target over realised above the target', () => {
    expect(volTargetScale(0.2, 0.4)).toBe(0.5);
    expect(volTargetScale(0.2, 0.8)).toBe(0.25);
  });
});

describe('volTargetRiskScale', () => {
  it('reads window + 1 closes', () => {
    expect(volTargetBarsWanted(SIZING)).toBe(4);
  });

  it('scales by the realised volatility of the last window + 1 adjusted closes', () => {
    const history = bars([1, 100, 110, 100, 110]);
    const vol = realisedVolatility(history, 3) as number;
    expect(vol).toBeGreaterThan(0.2);
    expect(volTargetRiskScale(SIZING, history, '2026-09-25')).toBeCloseTo(0.2 / vol, 12);
  });

  it('reads only the last window + 1 bars, so older history neither covers nor moves it', () => {
    const recent = bars([100, 110, 100, 110]);
    const history = [...bars([1, 1_000], '2026-08-01'), ...recent];
    expect(volTargetRiskScale(SIZING, history, '2026-09-25')).toBe(
      volTargetRiskScale(SIZING, recent, '2026-09-25'),
    );
    expect(volTargetRiskScale(SIZING, history, '2026-09-25')).toBeLessThan(1);
  });

  it('leaves a calm line at full risk', () => {
    expect(volTargetRiskScale(SIZING, bars([100, 100, 100, 100]), '2026-09-25')).toBe(1);
  });

  it('fails closed on a short, stale or gapped window or a non-positive close', () => {
    expect(volTargetRiskScale(SIZING, bars([100, 110, 100]), '2026-09-25')).toBeUndefined();
    expect(volTargetRiskScale(SIZING, bars([100, 110, 100, 110]), '2026-09-30')).toBeUndefined();
    expect(volTargetRiskScale(SIZING, bars([100, 110, 100, 110]), '2026-09-29')).toBeCloseTo(
      0.2 / (realisedVolatility(bars([100, 110, 100, 110]), 3) as number),
      12,
    );
    const gapped = [...bars([100], '2026-09-01'), ...bars([110, 100, 110])];
    expect(volTargetRiskScale(SIZING, gapped, '2026-09-25')).toBeUndefined();
    expect(volTargetRiskScale(SIZING, bars([100, 0, 100, 110]), '2026-09-25')).toBeUndefined();
  });
});
