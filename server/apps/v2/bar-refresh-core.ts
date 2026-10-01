import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import type { LogEventCode, Logger } from '../../shared/index.js';
import { MAX_BAR_AGE_CALENDAR_DAYS } from './data/index.js';

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

// A bar this recent can still be the newest one a fresh read uses: freshness allows
// MAX_BAR_AGE_CALENDAR_DAYS, and that many calendar days never hold more sessions
const RECENT_SESSIONS = MAX_BAR_AGE_CALENDAR_DAYS;

export function recentDates(bars: readonly DailyBar[], dates: readonly string[]): string[] {
  const recent = new Set(bars.slice(-RECENT_SESSIONS).map((bar) => bar.date));
  return dates.filter((date) => recent.has(date));
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logRefresh(
  logger: Logger,
  level: 'info' | 'warn' | 'error',
  event: LogEventCode,
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

const EXPIRED = Symbol('expired');

export interface TimeLimit {
  readonly signal: AbortSignal;
  readonly atomic: <R>(step: () => Promise<R>) => Promise<R>;
}

export const UNLIMITED: TimeLimit = {
  signal: new AbortController().signal,
  atomic: (step) => step(),
};

// The work is abandoned at the limit, except an atomic step already in flight, which is
// awaited so that a bar write never overlaps the reads that follow the refresh
export async function withinTimeLimit<T>(
  limitMs: number,
  work: (limit: TimeLimit) => Promise<T>,
  onExpiry: () => T,
): Promise<T> {
  const controller = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  const limit: TimeLimit = {
    signal: controller.signal,
    atomic: async (step) => {
      controller.signal.throwIfAborted();
      const running = step();
      const settle = () => inFlight.delete(running);
      inFlight.add(running);
      running.then(settle, settle);
      return await running;
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), limitMs);
  });
  const running = work(limit);
  try {
    const outcome = await Promise.race([running, expiry]);
    if (outcome !== EXPIRED) return outcome;
    controller.abort();
    running.catch(() => undefined);
    await Promise.allSettled(inFlight);
    return onExpiry();
  } finally {
    clearTimeout(timer);
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
