import type { DailyBar } from './bars.js';

export const ATR_WINDOW = 20;
export const STOP_ATR_MULTIPLE = 2;

export function trueRange(bar: DailyBar, previousClose: number): number {
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - previousClose),
    Math.abs(bar.low - previousClose),
  );
}

export function averageTrueRange(
  bars: readonly DailyBar[],
  endIndex: number,
  window: number = ATR_WINDOW,
): number | undefined {
  if (window < 1) throw new Error(`averageTrueRange: window must be >= 1 (got ${window})`);
  if (endIndex - window < 0 || endIndex >= bars.length) return undefined;
  let sum = 0;
  for (let index = endIndex - window + 1; index <= endIndex; index++) {
    const bar = bars[index] as DailyBar;
    const previous = bars[index - 1] as DailyBar;
    sum += trueRange(bar, previous.close);
  }
  return sum / window;
}

export function restingStopLevel(
  entryPrice: number,
  atr: number,
  multiple: number = STOP_ATR_MULTIPLE,
): number {
  if (!(entryPrice > 0) || !(atr >= 0) || !(multiple > 0)) {
    throw new Error(
      `restingStopLevel: bad inputs (entry ${entryPrice}, atr ${atr}, multiple ${multiple})`,
    );
  }
  return entryPrice - multiple * atr;
}

export function neverMovedUp(existingStop: number | undefined, candidate: number): number {
  return existingStop === undefined ? candidate : Math.min(existingStop, candidate);
}

export function stopTriggered(bar: DailyBar, stop: number): boolean {
  return bar.low <= stop;
}

export function stopFillPrice(bar: DailyBar, stop: number, halfSpreadFraction: number): number {
  const trigger = bar.open < stop ? bar.open : stop;
  return trigger * (1 - halfSpreadFraction);
}
