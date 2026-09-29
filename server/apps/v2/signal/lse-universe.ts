import { type BarsSource, LSE_CALENDAR_REFERENCE, sessionsBefore } from '../data/index.js';
import { LSE_LINES } from './lse-lines.js';
import {
  isSet,
  LSE_LIQUIDITY_SCREEN,
  type Parameter,
  SAXO_APPROPRIATENESS_TEST_TAKEN,
  UnsetParameterError,
} from './parameters.js';
import { averageDollarVolume, coveredHistory } from './universe.js';

const LSE_LIQUIDITY_WINDOW_DAYS = 20;

export interface LseUniverseSelection {
  readonly instruments: readonly string[];
  readonly refusals: readonly UnsetParameterError[];
}

export function lseInstrumentsAbove(
  bars: BarsSource,
  tradingDate: string,
  floorGbp: number,
): readonly string[] {
  const eligible = LSE_LINES.filter((line) => SAXO_APPROPRIATENESS_TEST_TAKEN || !line.isComplex);
  const sessions = sessionsBefore(bars, tradingDate, LSE_CALENDAR_REFERENCE);
  const instruments: string[] = [];
  for (const line of eligible) {
    const history = coveredHistory(
      bars,
      line.tidm,
      tradingDate,
      sessions,
      LSE_LIQUIDITY_WINDOW_DAYS,
    );
    const adv = averageDollarVolume(history, LSE_LIQUIDITY_WINDOW_DAYS);
    if (adv !== undefined && adv >= floorGbp) instruments.push(line.tidm);
  }
  return instruments;
}

export function selectLseUniverse(
  bars: BarsSource,
  tradingDate: string,
  screen: Parameter<number> = LSE_LIQUIDITY_SCREEN,
): LseUniverseSelection {
  if (!isSet(screen)) {
    return { instruments: [], refusals: [new UnsetParameterError(screen.name, screen.ticket)] };
  }
  return { instruments: lseInstrumentsAbove(bars, tradingDate, screen.value), refusals: [] };
}
