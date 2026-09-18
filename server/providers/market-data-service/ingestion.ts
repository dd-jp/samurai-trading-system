
import { closeTimeOf, isDailyTimeframe } from './timeframe.js';
import type { TradingCalendar } from './trading-calendar.js';
import type { Bar, Mark } from './types.js';

export interface RawCandle {
  open_time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NormalizeContext {
  instrument: string;
  timeframe: string;
  source: string;
  calendar: TradingCalendar;
}

function isInSession(candle: RawCandle, context: NormalizeContext): boolean {
  return isDailyTimeframe(context.timeframe)
    ? context.calendar.isTradingDay(candle.open_time)
    : context.calendar.isOpen(candle.open_time);
}

export function normalizeBars(candles: readonly RawCandle[], context: NormalizeContext): Bar[] {
  return candles
    .filter((candle) => isInSession(candle, context))
    .map((candle) => ({
      instrument: context.instrument,
      timeframe: context.timeframe,
      open_time: candle.open_time,
      close_time: closeTimeOf(candle.open_time, context.timeframe),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      source: context.source,
    }))
    .sort((a, b) => a.close_time.getTime() - b.close_time.getTime());
}

export function completedBars(bars: readonly Bar[], asOf: Date, lookback: number): Bar[] {
  return bars.filter((bar) => bar.close_time.getTime() <= asOf.getTime()).slice(-lookback);
}

export const FORMING_BAR_FETCH_MARGIN = 1;

export function deriveBacktestMark(
  bars: readonly Bar[],
  instrument: string,
  asOf: Date,
  assetClass: 'crypto' | 'stocks',
): Mark {
  const lastCompleted = bars
    .filter((bar) => bar.close_time.getTime() <= asOf.getTime())
    .sort((a, b) => a.close_time.getTime() - b.close_time.getTime())
    .at(-1);

  if (!lastCompleted) {
    throw new Error(`No completed bar for ${instrument} at or before ${asOf.toISOString()}`);
  }

  return {
    price: lastCompleted.close,
    observed_at: lastCompleted.close_time,
    source: lastCompleted.source,
    asset_class: assetClass,
  };
}
