import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import {
  applyBarHygiene,
  DEFAULT_BAR_STORE_ROOT,
  ParquetBarStore,
  repairBarShape,
  type ShapeRepairReport,
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
  recentDates,
  recordOutcome,
  roundPrices,
  type SymbolOutcome,
  withinTimeLimit,
} from './bar-refresh-core.js';
import { isFresh } from './data/index.js';
import {
  connectUnlessLost,
  ledgerFor,
  noteSessionLoss,
  type SaxoSessionLedger,
} from './saxo-session-loss.js';
import { LSE_LINES } from './signal/index.js';

const HISTORY_RESCALE_TOLERANCE = 0.05;
// Between the 2026-09-25 pull (data/bars/saxo-aux/raw) and the 2026-09-30 store, 0 of 85,175
// overlapping completed closes changed; the largest gap, 1.29%, was the partial fetch-day bar
// hygiene drops, so any revision is unexplained; 0.5% only leaves room above 4-decimal rounding
const MAX_CLOSE_REVISION = 0.005;
const SAXO_VENUE = 'saxo';

export type SaxoBarsApi = Pick<SaxoReadOnlyApi, 'instrumentDetails' | 'dailyHistory'>;

export interface SaxoBarRefreshOptions {
  readonly api: SaxoBarsApi;
  readonly store: ParquetBarStore;
  readonly tradingDate: string;
  readonly lines: readonly SaxoLine[];
  readonly logger: Logger;
  readonly signal?: AbortSignal;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as number) + upper) / 2;
}

interface CloseRatio {
  readonly date: string;
  readonly stored: number;
  readonly pulled: number;
  readonly ratio: number;
}

function closeRatios(existing: BarSeries, next: readonly DailyBar[]): CloseRatio[] {
  const replacement = new Map(next.map((bar) => [bar.date, bar.close]));
  return existing.bars.flatMap((bar) => {
    const pulled = replacement.get(bar.date);
    if (pulled === undefined || pulled === 0) return [];
    return [{ date: bar.date, stored: bar.close, pulled, ratio: bar.close / pulled }];
  });
}

// Saxo rewrites past bars after a split, so the old-to-new close ratio over the overlap is
// uniform (the split ratio) rather than noise; the median keeps a single revised bar from
// tripping it
export function historyRescaleFactor(
  existing: BarSeries,
  next: readonly DailyBar[],
): number | undefined {
  const factor = median(closeRatios(existing, next).map(({ ratio }) => ratio));
  if (factor === undefined || Math.abs(factor - 1) <= HISTORY_RESCALE_TOLERANCE) return undefined;
  return factor;
}

const LISTED_DATES = 5;

function listed(dates: readonly string[]): string {
  const more = dates.length > LISTED_DATES ? ` and ${dates.length - LISTED_DATES} more` : '';
  return `${dates.slice(0, LISTED_DATES).join(', ')}${more}`;
}

function earlierStart(existing: BarSeries, next: readonly DailyBar[]): string | undefined {
  const storedFirst = existing.bars[0]?.date;
  const pulledFirst = next[0]?.date;
  if (storedFirst === undefined || pulledFirst === undefined || pulledFirst >= storedFirst) {
    return undefined;
  }
  return `starts at ${pulledFirst}, before the stored first bar ${storedFirst}`;
}

function interiorGap(existing: BarSeries, next: readonly DailyBar[]): string | undefined {
  const pulled = new Set(next.map((bar) => bar.date));
  const missing = existing.bars.map((bar) => bar.date).filter((date) => !pulled.has(date));
  if (missing.length === 0) return undefined;
  return `drops stored bar(s) ${listed(missing)}`;
}

// Measured against the median ratio, not 1, so a uniform split rescale (warned, then written)
// never counts as a revision of every bar
function revisedCloses(existing: BarSeries, next: readonly DailyBar[]): string | undefined {
  const ratios = closeRatios(existing, next);
  const base = median(ratios.map(({ ratio }) => ratio)) ?? 1;
  const revised = ratios.filter(({ ratio }) => Math.abs(ratio / base - 1) > MAX_CLOSE_REVISION);
  if (revised.length === 0) return undefined;
  const shown = revised.map(({ date, stored, pulled }) => `${date} ${stored} to ${pulled}`);
  return `revises stored close(s) by more than ${MAX_CLOSE_REVISION * 100}%: ${listed(shown)}`;
}

export function assertHistoryConsistent(
  symbol: string,
  existing: BarSeries,
  next: readonly DailyBar[],
): void {
  const conflict =
    earlierStart(existing, next) ?? interiorGap(existing, next) ?? revisedCloses(existing, next);
  if (conflict === undefined) return;
  throw new Error(
    `${symbol}: the Saxo re-pull ${conflict}; refusing to write, the stored bars stand until ` +
      'the line is checked and re-seeded with the Saxo puller',
  );
}

export function saxoRefreshLines(
  tidms: readonly string[] = LSE_LINES.map((line) => line.tidm),
): readonly SaxoLine[] {
  return tidms.map((tidm) => {
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

function repairedDates(report: ShapeRepairReport): string[] {
  return [
    ...report.dropped_glitch_dates,
    ...report.rescaled_fields.map(({ date }) => date),
    ...report.neighbour_repairs.map(({ date }) => date),
  ];
}

// Widening is left out: it only stretches high/low over the open and close, and about 1.4% of
// recent Saxo bars need it (#1838), so counting it would take lines dark every few days
function assertNoRecentRepair(
  tidm: string,
  sessions: readonly DailyBar[],
  report: ShapeRepairReport,
): void {
  const recent = [...new Set(recentDates(sessions, repairedDates(report)))];
  if (recent.length === 0) return;
  throw new Error(
    `${tidm}: Saxo bar shape repaired or dropped in a recent session (${recent.join(', ')}); ` +
      'refusing to write, the line keeps its stored bars until the bar ages out or Saxo corrects it',
  );
}

function warnIfShapeRepaired(tidm: string, report: ShapeRepairReport, logger: Logger): void {
  const dropped = report.dropped_glitch_dates.map((date) => `dropped ${date}`);
  const rescaled = report.rescaled_fields.map(({ date, field }) => `rescaled ${date} ${field}`);
  const replaced = report.neighbour_repairs.map(
    ({ date, field }) => `replaced ${date} ${field} with the close`,
  );
  const widened = report.ranges_widened > 0 ? [`widened ${report.ranges_widened} range(s)`] : [];
  const repairs = [...dropped, ...rescaled, ...replaced, ...widened];
  if (repairs.length === 0) return;
  logRefresh(
    logger,
    'warn',
    'v2_saxo_bar_shape_repaired',
    `${tidm}: repaired Saxo chart bar shape (${repairs.join(', ')})`,
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
  const repaired = repairBarShape(hygiene.bars);
  if (repaired.bars.length === 0) throw new Error(`${line.tidm}: no bars left after shape repair`);
  assertNoRecentRepair(line.tidm, hygiene.bars, repaired.report);
  const rounded = roundPrices(repaired.bars);
  if (existing !== undefined) {
    assertNoShrink(line.tidm, existing, rounded);
    assertHistoryConsistent(line.tidm, existing, rounded);
  }
  options.signal?.throwIfAborted();
  await options.store.write(SAXO_VENUE, [{ symbol: line.tidm, bars: rounded }]);
  warnIfShapeRepaired(line.tidm, repaired.report, options.logger);
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

// A crash between swapIn's two renames leaves the symbol directory missing, and with no
// stored series the history guards above have nothing to compare against
function warnIfUnguarded(
  tidm: string,
  existing: ReadonlyMap<string, BarSeries>,
  logger: Logger,
): void {
  if (existing.size === 0 || existing.has(tidm)) return;
  logRefresh(
    logger,
    'warn',
    'v2_saxo_line_unguarded',
    `${tidm}: no stored Saxo bars while other lines have them (new line, or a write interrupted ` +
      'mid-swap); writing a fresh series without the history guards',
  );
}

export async function refreshSaxoBars(options: SaxoBarRefreshOptions): Promise<BarRefreshReport> {
  const existing = await options.store.readVenue(SAXO_VENUE);
  const buckets: Buckets = { updated: [], noNewBars: [], failed: [] };
  for (const line of options.lines) {
    if (options.signal?.aborted) break;
    warnIfUnguarded(line.tidm, existing, options.logger);
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
  readonly lostReason?: () => string | undefined;
}

type SaxoConnect = (env: NodeJS.ProcessEnv, logger: Logger) => SaxoSession;

// Each 429 costs a 65 s backoff and each request may wait 60 s, so an all-429 day runs past 1.5
// hours; ten minutes covers a clean pull of the 22 lines with room for several backoffs
export const SAXO_REFRESH_TIME_LIMIT_MS = 10 * 60_000;

export interface SaxoBarRefreshDeps {
  readonly storeRoot?: string;
  readonly connect?: SaxoConnect;
  readonly tokenPath?: string;
  readonly now?: () => Date;
  readonly timeLimitMs?: number;
}

interface SaxoLeg {
  readonly env: NodeJS.ProcessEnv;
  readonly tradingDate: string;
  readonly storeRoot: string;
  readonly connect: SaxoConnect;
  readonly ledger: SaxoSessionLedger;
}

async function stopQuietly(session: SaxoSession, logger: Logger): Promise<void> {
  try {
    await session.stop();
  } catch (error) {
    logRefresh(
      logger,
      'warn',
      'v2_saxo_session_stop_failed',
      `Saxo session did not stop cleanly after the bar refresh (${messageOf(error)}); the refresh result stands`,
    );
  }
}

async function refreshInSession(
  session: SaxoSession,
  leg: SaxoLeg,
  signal: AbortSignal,
): Promise<BarRefreshReport> {
  const logger = leg.ledger.logger;
  try {
    const store = await ParquetBarStore.open(leg.storeRoot);
    try {
      const lines = saxoRefreshLines();
      const { tradingDate } = leg;
      return await refreshSaxoBars({ api: session.api, store, tradingDate, lines, logger, signal });
    } finally {
      store.close();
    }
  } finally {
    noteSessionLoss(session.lostReason?.(), leg.ledger);
    await stopQuietly(session, logger);
  }
}

async function connectAndRefresh(leg: SaxoLeg, signal: AbortSignal): Promise<BarRefreshReport> {
  try {
    const session = connectUnlessLost(() => leg.connect(leg.env, leg.ledger.logger), leg.ledger);
    return await refreshInSession(session, leg, signal);
  } catch (error) {
    return unavailable(messageOf(error), leg.ledger.logger);
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
  const leg: SaxoLeg = {
    env,
    tradingDate,
    storeRoot: deps.storeRoot ?? DEFAULT_BAR_STORE_ROOT,
    connect: deps.connect ?? ((liveEnv, log) => openSaxoLiveSession(liveEnv, deps.tokenPath, log)),
    ledger: ledgerFor(deps, logger),
  };
  const limitMs = deps.timeLimitMs ?? SAXO_REFRESH_TIME_LIMIT_MS;
  const expired = () =>
    unavailable(
      `cut at the ${limitMs / 1000} s cap; lines not yet written keep their stored bars`,
      logger,
    );
  return {
    run: () => withinTimeLimit(limitMs, (signal) => connectAndRefresh(leg, signal), expired),
  };
}
