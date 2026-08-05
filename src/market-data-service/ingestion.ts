/**
 * Ingestion normalization (ticket #66) — the shared core every DataSource
 * runs its source-native payload through, so ccxt, IBKR and Alpaca land on
 * one identical Bar/Mark representation.
 * See docs/specs/market-data-service-spec.md (Module: Ingestion & Sources).
 *
 * Source-specific knowledge stops at `RawCandle`: each source maps its own
 * payload into that shape, and everything after this point is source-blind.
 */

import { closeTimeOf, isDailyTimeframe } from './timeframe.js';
import type { TradingCalendar } from './trading-calendar.js';
import type { Bar, Mark } from './types.js';

/**
 * A source-native candle, already mapped out of the source's wire format.
 * Timestamped at the candle's OPEN — every source does this (spec Module:
 * Point-in-Time Enforcement); `close_time` is derived here, never trusted
 * from the source.
 */
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
  /** 'kraken' | 'ibkr' | 'alpaca' — audit only; consumers ignore. */
  source: string;
  calendar: TradingCalendar;
}

/**
 * Is this candle inside a trading session?
 *
 * Judged on `open_time`: a session runs [open, close), so an intraday candle
 * belongs to the session it opens in. The 15:30 candle of a 16:00-close
 * session is in-session; a candle opening at 16:00 is not. Daily candles open
 * at midnight — outside any intraday session — so they are judged on whether
 * the day trades at all, otherwise a session filter would discard every
 * daily stock bar.
 */
function isInSession(candle: RawCandle, context: NormalizeContext): boolean {
  return isDailyTimeframe(context.timeframe)
    ? context.calendar.isTradingDay(candle.open_time)
    : context.calendar.isOpen(candle.open_time);
}

/**
 * Source payload -> canonical Bars: derives `close_time`, stamps provenance,
 * and drops out-of-session candles (#66 AC: "market-hours stock ingestion
 * never produces bars outside trading hours"). Crypto passes an always-open
 * calendar and so keeps every candle.
 */
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

/**
 * The point-in-time read filter: only bars complete at `asOf`, most recent
 * `lookback` of them. Re-applied by the serving layer too — belt and braces
 * on the no-lookahead guarantee (spec Module: Point-in-Time Enforcement).
 */
export function completedBars(bars: readonly Bar[], asOf: Date, lookback: number): Bar[] {
  return bars.filter((bar) => bar.close_time.getTime() <= asOf.getTime()).slice(-lookback);
}

/**
 * Extra RAW candles requested beyond the completed-bar count a caller needs
 * (issue #362): the newest candle can still be forming at `asOf`, and
 * `completedBars` correctly drops it, so a `lookback`-sized raw fetch can
 * land one completed bar short. Applied once, in
 * `NormalizingDataSource.fetchBars`; `completedBars` still receives the
 * caller's ORIGINAL `lookback`, unwidened.
 *
 * Unrelated to `minimumBarsFor`'s `period + 1` for rsi/atr — that's how many
 * COMPLETED bars an indicator's own math needs. A caller that already widens
 * its own lookback for that (`trader/decide.ts`'s `atr_lookback + 1`) still
 * needs THIS margin on top, not as a substitute.
 */
export const FORMING_BAR_FETCH_MARGIN = 1;

/**
 * Backtest mark derivation, shared by every source: the close of the last
 * completed bar, observed at that bar's close_time (spec Module: Marks).
 *
 * Lives here, once, because reading `latest_mark` in replay would inject
 * today's price into a historical decision — the catastrophic lookahead the
 * spec singles out. One implementation = one thing to get right.
 */
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
