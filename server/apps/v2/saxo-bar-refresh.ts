import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import {
  applyBarHygiene,
  DEFAULT_BAR_STORE_ROOT,
  ParquetBarStore,
} from '../../providers/bar-store/index.js';
import {
  assertUnitMatchesSaxo,
  gbpPerQuotedUnit,
  isSpliced,
  LSE_MOMENTUM_LINES,
  openSaxoLiveSession,
  type SaxoLine,
  type SaxoReadOnlyApi,
  samplesToBars,
} from '../../providers/saxo-bars/index.js';
import type { Logger } from '../../shared/index.js';
import {
  assertNoShrink,
  type BarRefresh,
  type BarRefreshReport,
  type BarRefreshSymbolResult,
  type Buckets,
  logRefresh,
  messageOf,
  recordOutcome,
  roundPrices,
  type SymbolOutcome,
} from './bar-refresh-core.js';
import { isFresh } from './data/index.js';
import { LSE_LINES } from './signal/index.js';

const HISTORY_RESCALE_TOLERANCE = 0.05;
const SAXO_VENUE = 'saxo';

export type SaxoBarsApi = Pick<SaxoReadOnlyApi, 'instrumentDetails' | 'dailyHistory'>;

export interface SaxoBarRefreshOptions {
  readonly api: SaxoBarsApi;
  readonly store: ParquetBarStore;
  readonly tradingDate: string;
  readonly lines: readonly SaxoLine[];
  readonly logger: Logger;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as number) + upper) / 2;
}

// Saxo rewrites past bars after a split, so the old-to-new close ratio over the overlap is
// uniform (the split ratio) rather than noise; the median keeps a single revised bar from
// tripping it
export function historyRescaleFactor(
  existing: BarSeries,
  next: readonly DailyBar[],
): number | undefined {
  const replacement = new Map(next.map((bar) => [bar.date, bar.close]));
  const ratios = existing.bars.flatMap((bar) => {
    const close = replacement.get(bar.date);
    return close === undefined || close === 0 ? [] : [bar.close / close];
  });
  const factor = median(ratios);
  if (factor === undefined || Math.abs(factor - 1) <= HISTORY_RESCALE_TOLERANCE) return undefined;
  return factor;
}

export function saxoRefreshLines(): readonly SaxoLine[] {
  return LSE_LINES.map(({ tidm }) => {
    const line = LSE_MOMENTUM_LINES.find((candidate) => candidate.tidm === tidm);
    if (line === undefined) throw new Error(`${tidm}: no Saxo line declared for a v2 LSE line`);
    return line;
  });
}

async function pullBars(line: SaxoLine, api: SaxoBarsApi): Promise<DailyBar[]> {
  assertUnitMatchesSaxo(line, await api.instrumentDetails(line.uic, line.assetType));
  const page = await api.dailyHistory(line.uic, line.assetType);
  return samplesToBars(page.samples, gbpPerQuotedUnit(line.unit));
}

function assertFresh(tidm: string, bars: readonly DailyBar[], tradingDate: string): void {
  if (isFresh(bars.at(-1), tradingDate)) return;
  throw new Error(
    `${tidm}: last bar ${bars.at(-1)?.date} is stale for trading date ${tradingDate} after refresh`,
  );
}

function warnIfRescaled(
  existing: BarSeries | undefined,
  rounded: readonly DailyBar[],
  logger: Logger,
): void {
  const factor = existing === undefined ? undefined : historyRescaleFactor(existing, rounded);
  if (factor === undefined) return;
  logRefresh(
    logger,
    'warn',
    'v2_saxo_history_rescaled',
    `${existing?.symbol}: Saxo rewrote the stored history by ${Number(factor.toPrecision(4))}x ` +
      '(split?); held quantity, stop and target were set before it and are not rescaled here',
  );
}

async function refreshLine(
  line: SaxoLine,
  existing: BarSeries | undefined,
  options: SaxoBarRefreshOptions,
): Promise<BarRefreshSymbolResult> {
  if (isSpliced(line)) {
    throw new Error(
      `${line.tidm}: spliced from a USD sibling (${line.spliceFrom.tidm}); a refresh cannot reproduce the splice`,
    );
  }
  const hygiene = applyBarHygiene(line.tidm, await pullBars(line, options.api), {
    fetchDate: options.tradingDate,
  });
  if (hygiene.bars.length === 0) throw new Error(`${line.tidm}: Saxo returned no bars`);
  const rounded = roundPrices(hygiene.bars);
  if (existing !== undefined) assertNoShrink(line.tidm, existing, rounded);
  await options.store.write(SAXO_VENUE, [{ symbol: line.tidm, bars: rounded }]);
  warnIfRescaled(existing, rounded, options.logger);
  assertFresh(line.tidm, rounded, options.tradingDate);
  return {
    symbol: line.tidm,
    bars: rounded.length,
    unitBreaks: hygiene.report.unit_breaks.length,
  };
}

async function refreshLineSafely(
  line: SaxoLine,
  existing: BarSeries | undefined,
  options: SaxoBarRefreshOptions,
): Promise<SymbolOutcome> {
  try {
    return { kind: 'updated', result: await refreshLine(line, existing, options) };
  } catch (error) {
    return { kind: 'failed', symbol: line.tidm, reason: messageOf(error) };
  }
}

export async function refreshSaxoBars(options: SaxoBarRefreshOptions): Promise<BarRefreshReport> {
  const existing = await options.store.readVenue(SAXO_VENUE);
  const buckets: Buckets = { updated: [], noNewBars: [], failed: [] };
  for (const line of options.lines) {
    const outcome = await refreshLineSafely(line, existing.get(line.tidm), options);
    recordOutcome(outcome, buckets, options.logger);
  }
  logRefresh(
    options.logger,
    'info',
    'v2_saxo_bar_refresh_summary',
    `refreshed ${buckets.updated.length}/${options.lines.length} Saxo lines, ${buckets.failed.length} failed`,
  );
  return { attempted: options.lines.length, ...buckets };
}

export interface SaxoSession {
  readonly api: SaxoBarsApi;
  readonly stop: () => Promise<void>;
}

export interface SaxoBarRefreshDeps {
  readonly storeRoot?: string;
  readonly connect?: (env: NodeJS.ProcessEnv, logger: Logger) => SaxoSession;
}

const connectLive = (env: NodeJS.ProcessEnv, logger: Logger): SaxoSession =>
  openSaxoLiveSession(env, undefined, logger);

async function refreshInSession(
  session: SaxoSession,
  storeRoot: string,
  tradingDate: string,
  logger: Logger,
): Promise<BarRefreshReport> {
  try {
    const store = await ParquetBarStore.open(storeRoot);
    try {
      const lines = saxoRefreshLines();
      return await refreshSaxoBars({ api: session.api, store, tradingDate, lines, logger });
    } finally {
      store.close();
    }
  } finally {
    await session.stop();
  }
}

function unavailable(reason: string, logger: Logger): BarRefreshReport {
  logRefresh(
    logger,
    'warn',
    'v2_saxo_bar_refresh_unavailable',
    `Saxo bars not refreshed (${reason}); LSE reads keep the last stored bars and fail closed once they go stale`,
  );
  return { attempted: 1, updated: [], noNewBars: [], failed: [{ symbol: SAXO_VENUE, reason }] };
}

// A Saxo failure never aborts the run: the US leg does not depend on it, and every LSE read
// already fails closed on a stale ISF or a stale line
export function saxoBarRefreshFor(
  env: NodeJS.ProcessEnv,
  tradingDate: string,
  logger: Logger,
  deps: SaxoBarRefreshDeps = {},
): BarRefresh {
  const connect = deps.connect ?? connectLive;
  const storeRoot = deps.storeRoot ?? DEFAULT_BAR_STORE_ROOT;
  return {
    run: async () => {
      try {
        return await refreshInSession(connect(env, logger), storeRoot, tradingDate, logger);
      } catch (error) {
        return unavailable(messageOf(error), logger);
      }
    },
  };
}
