import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import type { Logger } from '../../shared/index.js';

export interface BarRefreshSymbolResult {
  readonly symbol: string;
  readonly bars: number;
  readonly unitBreaks: number;
}

export interface BarRefreshReport {
  readonly attempted: number;
  readonly updated: readonly BarRefreshSymbolResult[];
  readonly noNewBars: readonly string[];
  readonly failed: readonly { readonly symbol: string; readonly reason: string }[];
}

export interface BarRefresh {
  readonly run: () => Promise<BarRefreshReport>;
}

export function roundPrices(bars: readonly DailyBar[]): DailyBar[] {
  const round = (value: number) => Number(value.toFixed(4));
  return bars.map((bar) => ({
    ...bar,
    open: round(bar.open),
    high: round(bar.high),
    low: round(bar.low),
    close: round(bar.close),
    rawClose: round(bar.rawClose),
  }));
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logRefresh(
  logger: Logger,
  level: 'info' | 'warn',
  event: string,
  message: string,
): void {
  logger.log({ trace_id: 'v2-bar-refresh', stage: 'v2', level, event, message });
}

// write() replaces a symbol's whole series, so a truncated provider response (an outage, a
// paused pagination) would silently erase committed history rather than just fail to extend it
function shrinksHistory(existing: BarSeries, next: readonly DailyBar[]): boolean {
  const existingFirst = existing.bars[0]?.date;
  const nextFirst = next[0]?.date;
  return (
    next.length < existing.bars.length ||
    (existingFirst !== undefined && (nextFirst === undefined || nextFirst > existingFirst))
  );
}

export function assertNoShrink(
  symbol: string,
  existing: BarSeries,
  rounded: readonly DailyBar[],
): void {
  if (!shrinksHistory(existing, rounded)) return;
  throw new Error(
    `${symbol}: refresh would shrink history (had ${existing.bars.length} bars from ` +
      `${existing.bars[0]?.date}, got ${rounded.length} from ${rounded[0]?.date ?? 'none'}) — refusing to overwrite`,
  );
}

export type SymbolOutcome =
  | { readonly kind: 'updated'; readonly result: BarRefreshSymbolResult }
  | { readonly kind: 'unchanged'; readonly symbol: string }
  | { readonly kind: 'failed'; readonly symbol: string; readonly reason: string };

export interface Buckets {
  readonly updated: BarRefreshSymbolResult[];
  readonly noNewBars: string[];
  readonly failed: { readonly symbol: string; readonly reason: string }[];
}

export function recordOutcome(outcome: SymbolOutcome, buckets: Buckets, logger: Logger): void {
  if (outcome.kind === 'unchanged') {
    buckets.noNewBars.push(outcome.symbol);
    return;
  }
  if (outcome.kind === 'failed') {
    buckets.failed.push({ symbol: outcome.symbol, reason: outcome.reason });
    logRefresh(logger, 'warn', 'v2_bar_refresh_failed', `${outcome.symbol}: ${outcome.reason}`);
    return;
  }
  buckets.updated.push(outcome.result);
  if (outcome.result.unitBreaks > 0) {
    logRefresh(
      logger,
      'warn',
      'v2_bar_refresh_unit_break',
      `${outcome.result.symbol}: ${outcome.result.unitBreaks} unit break(s) normalised`,
    );
  }
}

function mergeReports(reports: readonly BarRefreshReport[]): BarRefreshReport {
  return {
    attempted: reports.reduce((sum, report) => sum + report.attempted, 0),
    updated: reports.flatMap((report) => report.updated),
    noNewBars: reports.flatMap((report) => report.noNewBars),
    failed: reports.flatMap((report) => report.failed),
  };
}

export function inSequence(refreshes: readonly BarRefresh[]): BarRefresh {
  return {
    run: async () => {
      const reports: BarRefreshReport[] = [];
      for (const refresh of refreshes) reports.push(await refresh.run());
      return mergeReports(reports);
    },
  };
}
