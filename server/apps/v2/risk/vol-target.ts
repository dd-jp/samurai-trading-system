import type { V2Bar } from '../../../../contracts/index.js';
import { realisedVolatility } from '../data/index.js';
import { spanCovered } from './volume-cap.js';

export interface VolTargetSizing {
  readonly annualTargetVol: number;
  readonly windowBars: number;
  readonly sleeveIds: readonly string[];
}

export function assertVolTargetSizing(sizing: VolTargetSizing): void {
  const valid =
    sizing.annualTargetVol > 0 &&
    Number.isFinite(sizing.annualTargetVol) &&
    Number.isInteger(sizing.windowBars) &&
    sizing.windowBars >= 2;
  if (!valid) throw new Error(`vol-target sizing out of range: ${JSON.stringify(sizing)} (#1860)`);
}

export function volTargetScale(annualTargetVol: number, realisedVol: number): number {
  return realisedVol > annualTargetVol ? annualTargetVol / realisedVol : 1;
}

export function volTargetBarsWanted(sizing: VolTargetSizing): number {
  return sizing.windowBars + 1;
}

export function volTargetRiskScale(
  sizing: VolTargetSizing,
  bars: readonly V2Bar[],
  tradingDate: string,
): number | undefined {
  const wanted = volTargetBarsWanted(sizing);
  const tail = bars.slice(-wanted);
  if (!spanCovered(tail, wanted, tradingDate)) return undefined;
  const vol = realisedVolatility(tail, sizing.windowBars);
  return vol === undefined ? undefined : volTargetScale(sizing.annualTargetVol, vol);
}
