import { readFileSync } from 'node:fs';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import {
  AlpacaBarsApi,
  applyBarHygiene,
  credentialsFromEnv,
  DEFAULT_BAR_STORE_ROOT,
  ParquetBarStore,
  pullSymbol,
  type QuarantinedBar,
  quarantineImplausibleBars,
} from '../../providers/bar-store/index.js';
import type { Logger } from '../../shared/index.js';
import {
  assertNoShrink,
  type BarRefresh,
  type BarRefreshReport,
  type BarRefreshSymbolResult,
  type Buckets,
  inSequence,
  logRefresh,
  messageOf,
  recentDates,
  recordOutcome,
  roundPrices,
  type SymbolOutcome,
} from './bar-refresh-core.js';
import { cfdCatalogueRefreshFor } from './cfd-catalogue-refresh.js';
import {
  CALENDAR_REFERENCE,
  CFD_CATALOGUE_PATH,
  currentConstituents,
  FX_PATH,
  isFresh,
} from './data/index.js';
import { type FxFetch, fxRefreshFor } from './fx-refresh.js';
import { saxoBarRefreshFor } from './saxo-bar-refresh.js';

export type { BarRefresh };

const FULL_HISTORY_START = '2016-01-04';

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
  const { bars, quarantined } = quarantineImplausibleBars(rounded);
  if (symbol === CALENDAR_REFERENCE) assertCalendarNotQuarantined(rounded, quarantined);
  await options.store.write('alpaca', [{ symbol, bars }]);
  warnIfQuarantined(symbol, quarantined, options.logger);
  if (symbol === CALENDAR_REFERENCE) assertCalendarFresh(bars, options.tradingDate);
  return { symbol, bars: bars.length, unitBreaks: hygiene.report.unit_breaks.length };
}

// SPY's bars are the session calendar for every US name, so quarantining a recent SPY bar
// would silently shift the whole universe's decision day rather than skip one name
function assertCalendarNotQuarantined(
  rounded: readonly DailyBar[],
  quarantined: readonly QuarantinedBar[],
): void {
  const recent = recentDates(
    rounded,
    quarantined.map(({ date }) => date),
  );
  if (recent.length === 0) return;
  throw new Error(
    `v2 bar refresh: ${CALENDAR_REFERENCE} bar ${recent.join(', ')} is implausible and too recent to quarantine; the calendar reference cannot skip a session`,
  );
}

function warnIfQuarantined(
  symbol: string,
  quarantined: readonly QuarantinedBar[],
  logger: Logger,
): void {
  for (const { date, field, price, ratio } of quarantined) {
    logRefresh(
      logger,
      'warn',
      'v2_bar_quarantined',
      `${symbol}: quarantined ${date} (${field} ${price} is ${ratio.toFixed(2)}x beyond the neighbouring closes); the name skips that session`,
    );
  }
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
  cfdCataloguePath: string = CFD_CATALOGUE_PATH,
  fx: { readonly path: string; readonly fetch: FxFetch } = { path: FX_PATH, fetch },
): BarRefresh {
  if (dryRun) return NO_BAR_REFRESH;
  const api = new AlpacaBarsApi(credentialsFromEnv(env));
  const constituents = currentConstituents(readFileSync(constituentsPath, 'utf8'), tradingDate);
  const alpaca: BarRefresh = {
    run: async () => {
      const store = await ParquetBarStore.open(DEFAULT_BAR_STORE_ROOT);
      try {
        return await refreshAlpacaBars({ api, store, tradingDate, constituents, logger });
      } finally {
        store.close();
      }
    },
  };
  const cfdCatalogue = cfdCatalogueRefreshFor(env, {
    tradingDate,
    constituents,
    path: cfdCataloguePath,
    logger,
  });
  return inSequence([
    alpaca,
    saxoBarRefreshFor(env, tradingDate, logger),
    cfdCatalogue,
    fxRefreshFor({ ...fx, logger }),
  ]);
}
