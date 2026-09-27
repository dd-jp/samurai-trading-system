import { readFileSync } from 'node:fs';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import {
  AlpacaBarsApi,
  applyBarHygiene,
  credentialsFromEnv,
  DEFAULT_BAR_STORE_ROOT,
  ParquetBarStore,
  pullSymbol,
} from '../../providers/bar-store/index.js';
import type { Logger } from '../../shared/index.js';
import { CALENDAR_REFERENCE, currentConstituents, isFresh } from './data/index.js';

const FULL_HISTORY_START = '2016-01-04';

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

export const NO_BAR_REFRESH: BarRefresh = {
  run: () => Promise.resolve({ attempted: 0, updated: [], noNewBars: [], failed: [] }),
};

export interface BarRefreshOptions {
  readonly api: AlpacaBarsApi;
  readonly store: ParquetBarStore;
  readonly tradingDate: string;
  readonly constituents: readonly string[];
  readonly logger: Logger;
}

function roundPrices(bars: readonly DailyBar[]): DailyBar[] {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logRefresh(logger: Logger, level: 'info' | 'warn', event: string, message: string): void {
  logger.log({ trace_id: 'v2-bar-refresh', stage: 'v2', level, event, message });
}

// write() replaces a symbol's whole series, so a truncated Alpaca response (an outage, a
// paused pagination) would silently erase committed history rather than just fail to extend it
function shrinksHistory(existing: BarSeries, next: readonly DailyBar[]): boolean {
  const existingFirst = existing.bars[0]?.date;
  const nextFirst = next[0]?.date;
  return (
    next.length < existing.bars.length ||
    (existingFirst !== undefined && (nextFirst === undefined || nextFirst > existingFirst))
  );
}

function assertNoShrink(symbol: string, existing: BarSeries, rounded: readonly DailyBar[]): void {
  if (!shrinksHistory(existing, rounded)) return;
  throw new Error(
    `${symbol}: refresh would shrink history (had ${existing.bars.length} bars from ` +
      `${existing.bars[0]?.date}, got ${rounded.length} from ${rounded[0]?.date ?? 'none'}) — refusing to overwrite`,
  );
}

function assertCalendarFresh(rounded: readonly DailyBar[], tradingDate: string): void {
  if (isFresh(rounded.at(-1), tradingDate)) return;
  throw new Error(
    `v2 bar refresh: ${CALENDAR_REFERENCE} still stale after refresh (last bar ` +
      `${rounded.at(-1)?.date ?? 'none'}, trading date ${tradingDate})`,
  );
}

async function refreshOne(
  symbol: string,
  existing: BarSeries | undefined,
  options: BarRefreshOptions,
): Promise<BarRefreshSymbolResult | undefined> {
  const pulled = await pullSymbol(options.api, symbol, FULL_HISTORY_START, options.tradingDate);
  if (pulled === undefined) return undefined;
  const hygiene = applyBarHygiene(symbol, pulled.bars, { fetchDate: options.tradingDate });
  if (hygiene.bars.length === 0) return undefined;
  const rounded = roundPrices(hygiene.bars);
  if (existing !== undefined) assertNoShrink(symbol, existing, rounded);
  await options.store.write('alpaca', [{ symbol, bars: rounded }]);
  if (symbol === CALENDAR_REFERENCE) assertCalendarFresh(rounded, options.tradingDate);
  return { symbol, bars: rounded.length, unitBreaks: hygiene.report.unit_breaks.length };
}

function orderedUniverse(
  constituents: readonly string[],
  existing: ReadonlyMap<string, BarSeries>,
): string[] {
  const universe = new Set([CALENDAR_REFERENCE, ...constituents, ...existing.keys()]);
  return [
    CALENDAR_REFERENCE,
    ...[...universe].filter((symbol) => symbol !== CALENDAR_REFERENCE).sort(),
  ];
}

type SymbolOutcome =
  | { readonly kind: 'updated'; readonly result: BarRefreshSymbolResult }
  | { readonly kind: 'unchanged'; readonly symbol: string }
  | { readonly kind: 'failed'; readonly symbol: string; readonly reason: string };

// SPY (the calendar reference) gates every name's freshness check, so a failure there
// aborts the run; every other symbol fails in isolation so one bad print never blocks
// the rest of the universe
async function refreshSymbolSafely(
  symbol: string,
  existing: BarSeries | undefined,
  options: BarRefreshOptions,
): Promise<SymbolOutcome> {
  try {
    const result = await refreshOne(symbol, existing, options);
    return result === undefined ? { kind: 'unchanged', symbol } : { kind: 'updated', result };
  } catch (error) {
    if (symbol === CALENDAR_REFERENCE) throw error;
    return { kind: 'failed', symbol, reason: messageOf(error) };
  }
}

interface Buckets {
  readonly updated: BarRefreshSymbolResult[];
  readonly noNewBars: string[];
  readonly failed: { readonly symbol: string; readonly reason: string }[];
}

function recordOutcome(outcome: SymbolOutcome, buckets: Buckets, logger: Logger): void {
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

export async function refreshAlpacaBars(options: BarRefreshOptions): Promise<BarRefreshReport> {
  const existing = await options.store.readVenue('alpaca');
  const ordered = orderedUniverse(options.constituents, existing);
  const buckets: Buckets = { updated: [], noNewBars: [], failed: [] };

  for (const symbol of ordered) {
    const outcome = await refreshSymbolSafely(symbol, existing.get(symbol), options);
    recordOutcome(outcome, buckets, options.logger);
  }

  logRefresh(
    options.logger,
    'info',
    'v2_bar_refresh_summary',
    `refreshed ${buckets.updated.length}/${ordered.length} symbols, ${buckets.noNewBars.length} unchanged, ${buckets.failed.length} failed`,
  );
  return { attempted: ordered.length, ...buckets };
}

export function barRefreshFor(
  dryRun: boolean,
  env: NodeJS.ProcessEnv,
  tradingDate: string,
  constituentsPath: string,
  logger: Logger,
): BarRefresh {
  if (dryRun) return NO_BAR_REFRESH;
  const api = new AlpacaBarsApi(credentialsFromEnv(env));
  const constituents = currentConstituents(readFileSync(constituentsPath, 'utf8'), tradingDate);
  return {
    run: async () => {
      const store = await ParquetBarStore.open(DEFAULT_BAR_STORE_ROOT);
      try {
        return await refreshAlpacaBars({ api, store, tradingDate, constituents, logger });
      } finally {
        store.close();
      }
    },
  };
}
