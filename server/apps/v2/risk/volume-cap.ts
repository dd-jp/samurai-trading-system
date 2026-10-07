import type { V2Bar } from '../../../../contracts/index.js';
import { addDays } from '../data/index.js';

const MAX_LAST_BAR_AGE_CALENDAR_DAYS = 5;
const HOLIDAY_ALLOWANCE_CALENDAR_DAYS = 7;

export function spanCovered(bars: readonly V2Bar[], window: number, tradingDate: string): boolean {
  const first = bars[0];
  const last = bars.at(-1);
  if (bars.length < window || first === undefined || last === undefined) return false;
  const maxSpanDays = Math.ceil((window * 7) / 5) + HOLIDAY_ALLOWANCE_CALENDAR_DAYS;
  return (
    addDays(last.date, MAX_LAST_BAR_AGE_CALENDAR_DAYS) >= tradingDate &&
    addDays(first.date, maxSpanDays) >= tradingDate
  );
}

// Adjusted close × split-adjusted volume cancels the split factor, so the mean is quote-currency
// notional traded that stays comparable to a raw entry price across a split
export function averageDailyNotional(
  bars: readonly V2Bar[],
  window: number,
  tradingDate: string,
): number | undefined {
  const tail = bars.slice(-window);
  if (!spanCovered(tail, window, tradingDate)) return undefined;
  let total = 0;
  for (const bar of tail) total += bar.close * bar.volume;
  return Number.isFinite(total) ? total / window : undefined;
}

export function volumeCapShares(averageNotional: number, advShare: number, price: number): number {
  const shares = Math.floor((advShare * averageNotional) / price);
  return Number.isFinite(shares) ? Math.max(0, shares) : 0;
}
