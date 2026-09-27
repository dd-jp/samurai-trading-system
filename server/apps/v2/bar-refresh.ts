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
  if (existing !== undefined && shrinksHistory(existing, rounded)) {
    throw new Error(
      `${symbol}: refresh would shrink history (had ${existing.bars.length} bars from ` +
        `${existing.bars[0]?.date}, got ${rounded.length} from ${rounded[0]?.date ?? 'none'}) — refusing to overwrite`,
    );
  }
  await options.store.write('alpaca', [{ symbol, bars: rounded }]);
  if (symbol === CALENDAR_REFERENCE && !isFresh(rounded.at(-1), options.tradingDate)) {
    throw new Error(
      `v2 bar refresh: ${CALENDAR_REFERENCE} still stale after refresh (last bar ` +
        `${rounded.at(-1)?.date ?? 'none'}, trading date ${options.tradingDate})`,
    );
  }
  return { symbol, bars: rounded.length, unitBreaks: hygiene.report.unit_breaks.length };
}

// SPY (the calendar reference) gates every name's freshness check, so it refreshes first
// and a failure there aborts the run; every other symbol fails in isolation so one bad
// print never blocks the rest of the universe
export async function refreshAlpacaBars(options: BarRefreshOptions): Promise<BarRefreshReport> {
  const existing = await options.store.readVenue('alpaca');
  const universe = new Set([CALENDAR_REFERENCE, ...options.constituents, ...existing.keys()]);
  const ordered = [
    CALENDAR_REFERENCE,
    ...[...universe].filter((symbol) => symbol !== CALENDAR_REFERENCE).sort(),
  ];

  const updated: BarRefreshSymbolResult[] = [];
  const noNewBars: string[] = [];
  const failed: { symbol: string; reason: string }[] = [];

  for (const symbol of ordered) {
    try {
      const result = await refreshOne(symbol, existing.get(symbol), options);
      if (result === undefined) {
        noNewBars.push(symbol);
        continue;
      }
      updated.push(result);
      if (result.unitBreaks > 0) {
        logRefresh(
          options.logger,
          'warn',
          'v2_bar_refresh_unit_break',
          `${symbol}: ${result.unitBreaks} unit break(s) normalised`,
        );
      }
    } catch (error) {
      if (symbol === CALENDAR_REFERENCE) throw error;
      failed.push({ symbol, reason: messageOf(error) });
      logRefresh(options.logger, 'warn', 'v2_bar_refresh_failed', `${symbol}: ${messageOf(error)}`);
    }
  }

  logRefresh(
    options.logger,
    'info',
    'v2_bar_refresh_summary',
    `refreshed ${updated.length}/${ordered.length} symbols, ${noNewBars.length} unchanged, ${failed.length} failed`,
  );
  return { attempted: ordered.length, updated, noNewBars, failed };
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
