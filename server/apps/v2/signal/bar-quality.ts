import type { V2Bar } from '../../../../contracts/index.js';

// #1838: a shape-invalid bar is never priced off (fail-closed, the candleFeatures idiom); a
// caller's read function should reject an invalid last bar and filter invalid bars out of its
// trailing window rather than treat them as zero-return days
export function shapeValid(bar: V2Bar): boolean {
  return (
    bar.open >= bar.low && bar.open <= bar.high && bar.close >= bar.low && bar.close <= bar.high
  );
}

export function simpleMovingAverage(bars: readonly V2Bar[], window: number): number | undefined {
  if (bars.length < window) return undefined;
  let total = 0;
  for (const bar of bars.slice(-window)) total += bar.close;
  return total / window;
}

// V2Bar.close is split/dividend-adjusted; rawClose is the true traded price. ATR is computed on
// the adjusted series (comparable across a split), then rescaled by the last bar's own
// rawClose/close ratio so it sits in the same raw terms as the price/stop it is paired with
export function atrInRawTerms(atr: number | undefined, last: V2Bar): number | undefined {
  return atr === undefined ? undefined : (atr * last.rawClose) / last.close;
}
