import type { TradingCalendar } from './trading-calendar.js';
import type { Bar } from './types.js';

export interface SessionVwap {
  vwap: number | null;
  distance_from_vwap: number | null;
}

const NO_SESSION_ANCHOR: SessionVwap = { vwap: null, distance_from_vwap: null };

export function computeSessionVwap(
  bars: Bar[],
  calendar: TradingCalendar,
  asOf: Date,
): SessionVwap {
  if (calendar.sessionEnd(asOf) === null) {
    return NO_SESSION_ANCHOR;
  }

  const sessionStart = calendar.sessionStart(asOf);
  const sessionBars = bars.filter(
    (bar) =>
      bar.close_time.getTime() > sessionStart.getTime() &&
      bar.close_time.getTime() <= asOf.getTime(),
  );

  if (sessionBars.length === 0) {
    return NO_SESSION_ANCHOR;
  }

  let sumPriceVolume = 0;
  let sumVolume = 0;
  for (const bar of sessionBars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    sumPriceVolume += typicalPrice * bar.volume;
    sumVolume += bar.volume;
  }

  if (sumVolume === 0) {
    return NO_SESSION_ANCHOR;
  }

  const vwap = sumPriceVolume / sumVolume;
  const lastClose = (sessionBars[sessionBars.length - 1] as Bar).close;

  return { vwap, distance_from_vwap: lastClose - vwap };
}
