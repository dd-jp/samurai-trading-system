import {
  applyBarHygiene,
  DEFAULT_BAR_STORE_ROOT,
  type HygieneReport,
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
  SAXO_CHART_PAGE,
  type SaxoLine,
  type SaxoReadOnlyApi,
  samplesToBars,
} from '../../providers/saxo-bars/index.js';
import type { BarSeries, DailyBar, LogEventCode, Logger } from '../../shared/index.js';
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
  stoppedAtCap,
  type TimeLimit,
  UNLIMITED,
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
import { isSplitStep, splitRatioAcross } from './split.js';

const HISTORY_RESCALE_TOLERANCE = 0.05;
// Between the 2026-09-25 pull (data/bars/saxo-aux/raw) and the 2026-09-30 store, 0 of 85,175
// overlapping completed closes changed; the largest gap, 1.29%, was the partial fetch-day bar
// hygiene drops, so any revision is unexplained; 0.5% only leaves room above 4-decimal rounding;
// it holds only while Saxo closes stay price-only (doc 70's ISF/CUKX check): a back-adjustment
// revising the closes before an ex-date inside the overlap refuses the line (see alignedOlder)
const MAX_CLOSE_REVISION = 0.005;
// #2143's "0.05% floor"; with prices rounded to 4 decimals it sits above one rounding tick only
// from £0.20 up (the UK pool screens at 100p), and a re-pull of unchanged closes measures exactly 1
const UNIFORM_SHIFT_RESCALE_FLOOR = 0.0005;
const SAXO_VENUE = 'saxo';

export type SaxoBarsApi = Pick<SaxoReadOnlyApi, 'instrumentDetails' | 'dailyHistory'>;

export interface BarLineContext {
  readonly store: ParquetBarStore;
  readonly tradingDate: string;
  readonly logger: Logger;
  readonly limit?: TimeLimit;
}

export interface SaxoBarRefreshOptions extends BarLineContext {
  readonly api: SaxoBarsApi;
  readonly lines: readonly SaxoLine[];
}

export interface BarLine {
  readonly tidm: string;
  readonly pageStartMoves: boolean;
  readonly pull: () => Promise<DailyBar[]>;
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

// A moving page's first pulled bar can be one hygiene dropped from the stored copy; only a
// fixed-start line treats an earlier start as a conflict
function assertHistoryConsistent(
  line: BarLine,
  existing: BarSeries,
  next: readonly DailyBar[],
): void {
  const symbol = line.tidm;
  const conflict =
    (line.pageStartMoves ? undefined : earlierStart(existing, next)) ??
    interiorGap(existing, next) ??
    revisedCloses(existing, next);
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
  if (isSpliced(line)) {
    throw new Error(
      `${line.tidm}: spliced from a USD sibling (${line.spliceFrom.tidm}); a refresh cannot reproduce the splice`,
    );
  }
  assertUnitMatchesSaxo(line, await api.instrumentDetails(line.uic, line.assetType));
  const page = await api.dailyHistory(line.uic, line.assetType);
  return samplesToBars(page.samples, gbpPerQuotedUnit(line.unit));
}

function lseBarLine(line: SaxoLine, api: SaxoBarsApi): BarLine {
  return { tidm: line.tidm, pageStartMoves: false, pull: () => pullBars(line, api) };
}

// A short page that starts late shares too few bars with the stored copy for the overlap guards
// to see a truncation or a rewrite; the slack covers the few samples a page varies by day to day
export const PAGE_SHRINK_SLACK_BARS = 5;

interface StoredHistory {
  readonly older: readonly DailyBar[];
  readonly overlap: BarSeries | undefined;
}

const NO_STORED_HISTORY: StoredHistory = { older: [], overlap: undefined };

function refuseMovingPage(tidm: string, reason: string): never {
  throw new Error(
    `${tidm}: the Saxo page ${reason}; refusing to write, the stored bars stand until the line ` +
      'is checked and re-seeded',
  );
}

function assertFullPage(tidm: string, existing: BarSeries, pageSamples: number): void {
  const expected = Math.min(existing.bars.length, SAXO_CHART_PAGE);
  if (pageSamples + PAGE_SHRINK_SLACK_BARS >= expected) return;
  refuseMovingPage(tidm, `is truncated (${pageSamples} samples where ${expected} were expected)`);
}

// Older bars keep the stored scale, so a page Saxo rewrote (split, unit break) would leave a step
// at the page's first date that no later refresh sees
function splitAtPageStart(
  tidm: string,
  existing: BarSeries,
  pageSamples: number,
  pulled: readonly DailyBar[],
): StoredHistory {
  assertFullPage(tidm, existing, pageSamples);
  const first = pulled[0]?.date ?? '';
  const older = existing.bars.filter((bar) => bar.date < first);
  const overlap = { ...existing, bars: existing.bars.filter((bar) => bar.date >= first) };
  if (overlap.bars.length === 0)
    refuseMovingPage(tidm, `starts at ${first}, after every stored bar`);
  const factor = historyRescaleFactor(overlap, pulled);
  if (older.length > 0 && factor !== undefined) {
    refuseMovingPage(tidm, `rewrites the stored bars by ${Number(factor.toPrecision(4))}x`);
  }
  return { older, overlap };
}

function rescaledBar(bar: DailyBar, multiplier: number): DailyBar {
  return {
    ...bar,
    open: bar.open * multiplier,
    high: bar.high * multiplier,
    low: bar.low * multiplier,
    close: bar.close * multiplier,
    rawClose: bar.rawClose * multiplier,
  };
}

// A uniform shift under HISTORY_RESCALE_TOLERANCE (a dividend back-adjust with the ex-date on
// the newest bar) passes revisedCloses, and the older bars must follow it or the seam carries
// a step no later refresh sees; volume stays, as on the overlap
function alignedOlder(
  tidm: string,
  older: readonly DailyBar[],
  overlap: BarSeries | undefined,
  pulled: readonly DailyBar[],
  logger: Logger,
): readonly DailyBar[] {
  if (older.length === 0 || overlap === undefined) return older;
  const shift = median(closeRatios(overlap, pulled).map(({ ratio }) => ratio)) ?? 1;
  if (Math.abs(shift - 1) <= UNIFORM_SHIFT_RESCALE_FLOOR) return older;
  const multiplier = 1 / shift;
  logRefresh(
    logger,
    'warn',
    'v2_saxo_history_rescaled',
    `${tidm}: Saxo shifted every close from ${pulled[0]?.date} by ${Number(multiplier.toPrecision(6))}x; ` +
      `the ${older.length} older stored bar(s) are multiplied by the same factor so no step stands at the seam`,
  );
  return roundPrices(older.map((bar) => rescaledBar(bar, multiplier)));
}

function guardedStored(
  line: BarLine,
  existing: BarSeries | undefined,
  pageSamples: number,
  pulled: readonly DailyBar[],
): StoredHistory {
  if (existing === undefined) return NO_STORED_HISTORY;
  if (line.pageStartMoves) return splitAtPageStart(line.tidm, existing, pageSamples, pulled);
  assertNoShrink(line.tidm, existing, pulled);
  return { older: [], overlap: existing };
}

function assertFresh(tidm: string, bars: readonly DailyBar[], tradingDate: string): void {
  if (isFresh(bars.at(-1), tradingDate)) return;
  throw new Error(
    `${tidm}: last bar ${bars.at(-1)?.date} is stale for trading date ${tradingDate} after refresh`,
  );
}

type SuspectFlips = HygieneReport['suspect_flips'];

function carryRawClose(
  existing: BarSeries,
  next: readonly DailyBar[],
  rewritten: boolean,
): DailyBar[] {
  const stored = new Map(existing.bars.map((bar) => [bar.date, bar]));
  return roundPrices(
    next.map((bar) => {
      const prior = stored.get(bar.date);
      if (prior === undefined) return bar;
      const rawClose = rewritten ? prior.rawClose : bar.close * (prior.rawClose / prior.close);
      return { ...bar, rawClose };
    }),
  );
}

function rescaledMessage(symbol: string, factor: number, outcome: string): string {
  return `${symbol}: Saxo rewrote the stored history by ${Number(factor.toPrecision(4))}x (split?); ${outcome}`;
}

// A rewritten overlap keeps the stored rawClose, so #1865's detector reads the old scale up to
// the split and 1 after it, as for Alpaca; a step it cannot tie to a continuous adjusted
// series is refused and alerted, never guessed
function stepFromRewrite(
  existing: BarSeries,
  pulled: readonly DailyBar[],
  factor: number,
  logger: Logger,
): DailyBar[] {
  const stepped = carryRawClose(existing, pulled, true);
  if (splitRatioAcross(stepped).rejected.length === 0) {
    const outcome = 'rawClose carries the step so held positions rescale';
    logRefresh(
      logger,
      'warn',
      'v2_saxo_history_rescaled',
      rescaledMessage(existing.symbol, factor, outcome),
    );
    return stepped;
  }
  const outcome =
    'the adjusted closes are not continuous across it, so it is not a split; no rescale, check the line';
  logRefresh(
    logger,
    'error',
    'v2_saxo_history_rescaled',
    rescaledMessage(existing.symbol, factor, outcome),
  );
  return carryRawClose(existing, pulled, false);
}

function errorOnUnadjustedStep(existing: BarSeries, flips: SuspectFlips, logger: Logger): void {
  if (flips === undefined || flips.to <= (existing.bars.at(-1)?.date ?? '')) return;
  logRefresh(
    logger,
    'error',
    'v2_saxo_unadjusted_step',
    `${existing.symbol}: ${flips.count} close step(s) beyond 1.35x between ${flips.from} and ${flips.to} with the stored history unrewritten; a split Saxo left unadjusted looks the same, so a held position is not rescaled, check the line`,
  );
}

const UNIT_BREAK_BAND_MIN = 90;
const UNIT_BREAK_BAND_MAX = 110;

function inUnitBreakBand(factor: number): boolean {
  const size = Math.max(factor, 1 / factor);
  return size > UNIT_BREAK_BAND_MIN && size < UNIT_BREAK_BAND_MAX;
}

// normaliseUnitBreaks rescales every earlier bar to the newest bar's unit, so a GBX/GBP flip on
// the newest bar rewrites the whole overlap by 100x or 0.01x, which is not a split
function isUnitBreakRewrite(existing: BarSeries, factor: number, report: HygieneReport): boolean {
  const storedLast = existing.bars.at(-1)?.date ?? '';
  return inUnitBreakBand(factor) || report.unit_breaks.some((unit) => unit.date > storedLast);
}

function withSplitStep(
  existing: BarSeries | undefined,
  pulled: readonly DailyBar[],
  report: HygieneReport,
  logger: Logger,
): DailyBar[] {
  if (existing === undefined) return [...pulled];
  const factor = historyRescaleFactor(existing, pulled);
  if (factor === undefined) {
    errorOnUnadjustedStep(existing, report.suspect_flips, logger);
  } else if (isUnitBreakRewrite(existing, factor, report)) {
    const outcome = 'a unit break, not a split, so nothing is rescaled; check the line';
    logRefresh(
      logger,
      'error',
      'v2_saxo_history_rescaled',
      rescaledMessage(existing.symbol, factor, outcome),
    );
  } else if (isSplitStep(factor)) {
    return stepFromRewrite(existing, pulled, factor, logger);
  } else {
    const outcome = 'too small for a split, nothing rescaled, check the line';
    logRefresh(
      logger,
      'error',
      'v2_saxo_history_rescaled',
      rescaledMessage(existing.symbol, factor, outcome),
    );
  }
  return carryRawClose(existing, pulled, false);
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
  line: BarLine,
  existing: BarSeries | undefined,
  options: BarLineContext,
): Promise<BarRefreshSymbolResult> {
  const page = await line.pull();
  const hygiene = applyBarHygiene(line.tidm, page, { fetchDate: options.tradingDate });
  if (hygiene.bars.length === 0) throw new Error(`${line.tidm}: Saxo returned no bars`);
  const repaired = repairBarShape(hygiene.bars);
  if (repaired.bars.length === 0) throw new Error(`${line.tidm}: no bars left after shape repair`);
  assertNoRecentRepair(line.tidm, hygiene.bars, repaired.report);
  const pulled = roundPrices(repaired.bars);
  const { older, overlap } = guardedStored(line, existing, page.length, pulled);
  if (overlap !== undefined) assertHistoryConsistent(line, overlap, pulled);
  const kept = alignedOlder(line.tidm, older, overlap, pulled, options.logger);
  const rounded = [...kept, ...withSplitStep(overlap, pulled, hygiene.report, options.logger)];
  await (options.limit ?? UNLIMITED).atomic(() =>
    options.store.write(SAXO_VENUE, [{ symbol: line.tidm, bars: rounded }]),
  );
  warnIfShapeRepaired(line.tidm, repaired.report, options.logger);
  assertFresh(line.tidm, rounded, options.tradingDate);
  return {
    symbol: line.tidm,
    bars: rounded.length,
    unitBreaks: hygiene.report.unit_breaks.length,
  };
}

async function refreshLineSafely(
  line: BarLine,
  existing: BarSeries | undefined,
  options: BarLineContext,
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

export interface BarLineLabels {
  readonly noun: string;
  readonly summaryEvent: LogEventCode;
  readonly stopAfterFailuresInARow?: number;
}

const LSE_LABELS: BarLineLabels = {
  noun: 'Saxo lines',
  summaryEvent: 'v2_saxo_bar_refresh_summary',
};

function stopsHere(failuresInARow: number, labels: BarLineLabels, logger: Logger): boolean {
  if (failuresInARow !== labels.stopAfterFailuresInARow) return false;
  logRefresh(
    logger,
    'warn',
    'v2_bar_refresh_stopped',
    `stopped refreshing ${labels.noun} after ${failuresInARow} failures in a row; the rest keep their stored bars`,
  );
  return true;
}

function failureRun(outcome: SymbolOutcome, failuresInARow: number): number {
  return outcome.kind === 'failed' ? failuresInARow + 1 : 0;
}

function aborted(options: BarLineContext): boolean {
  return options.limit?.signal.aborted === true;
}

async function refreshStep(
  line: BarLine,
  existing: ReadonlyMap<string, BarSeries>,
  options: BarLineContext,
  buckets: Buckets,
): Promise<SymbolOutcome | undefined> {
  if (aborted(options)) return undefined;
  if (!line.pageStartMoves) warnIfUnguarded(line.tidm, existing, options.logger);
  const outcome = await refreshLineSafely(line, existing.get(line.tidm), options);
  if (aborted(options)) return undefined;
  recordOutcome(outcome, buckets, options.logger);
  return outcome;
}

async function refreshBarLines(
  lines: readonly BarLine[],
  options: BarLineContext,
  labels: BarLineLabels,
): Promise<BarRefreshReport> {
  const existing = await options.store.readVenue(SAXO_VENUE);
  const buckets: Buckets = { updated: [], noNewBars: [], failed: [] };
  const report = { attempted: lines.length, ...buckets };
  let failuresInARow = 0;
  for (const line of lines) {
    const outcome = await refreshStep(line, existing, options, buckets);
    if (outcome === undefined) return report;
    failuresInARow = failureRun(outcome, failuresInARow);
    if (stopsHere(failuresInARow, labels, options.logger)) break;
  }
  logRefresh(
    options.logger,
    'info',
    labels.summaryEvent,
    `refreshed ${buckets.updated.length}/${lines.length} ${labels.noun}, ${buckets.failed.length} failed`,
  );
  return report;
}

export function refreshSaxoBars(options: SaxoBarRefreshOptions): Promise<BarRefreshReport> {
  const lines = options.lines.map((line) => lseBarLine(line, options.api));
  return refreshBarLines(lines, options, LSE_LABELS);
}

interface SaxoSession<Api = SaxoBarsApi> {
  readonly api: Api;
  readonly stop: () => Promise<void>;
  readonly lostReason?: () => string | undefined;
}

type SaxoConnect<Api> = (
  env: NodeJS.ProcessEnv,
  logger: Logger,
  signal: AbortSignal,
) => SaxoSession<Api>;

// Each 429 costs a 65 s backoff and each request may wait 60 s, so an all-429 day runs past 1.5
// hours; ten minutes covers a clean pull of the 22 lines with room for several backoffs
const SAXO_REFRESH_TIME_LIMIT_MS = 10 * 60_000;

export interface SaxoBarRefreshDeps<Api = SaxoBarsApi> {
  readonly storeRoot?: string;
  readonly connect?: SaxoConnect<Api>;
  readonly tokenPath?: string;
  readonly now?: () => Date;
  readonly timeLimitMs?: number;
}

export interface SaxoBarLegPlan<Api> {
  readonly linesFor: (api: Api, logger: Logger) => readonly BarLine[];
  readonly labels: BarLineLabels;
  readonly unavailableEvent: LogEventCode;
  readonly whenUnavailable: string;
  readonly timeLimitMs: number;
}

interface SaxoLeg<Api> {
  readonly env: NodeJS.ProcessEnv;
  readonly tradingDate: string;
  readonly storeRoot: string;
  readonly connect: SaxoConnect<Api>;
  readonly ledger: SaxoSessionLedger;
  readonly plan: SaxoBarLegPlan<Api>;
}

async function stopQuietly(session: SaxoSession<unknown>, logger: Logger): Promise<void> {
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

async function refreshInSession<Api>(
  session: SaxoSession<Api>,
  leg: SaxoLeg<Api>,
  limit: TimeLimit,
): Promise<BarRefreshReport> {
  const logger = leg.ledger.logger;
  try {
    const store = await ParquetBarStore.open(leg.storeRoot);
    try {
      const lines = leg.plan.linesFor(session.api, logger);
      const context = { store, tradingDate: leg.tradingDate, logger, limit };
      return await refreshBarLines(lines, context, leg.plan.labels);
    } finally {
      store.close();
    }
  } finally {
    noteSessionLoss(session.lostReason?.(), leg.ledger);
    await stopQuietly(session, logger);
  }
}

async function connectAndRefresh<Api>(
  leg: SaxoLeg<Api>,
  limit: TimeLimit,
): Promise<BarRefreshReport> {
  try {
    const session = connectUnlessLost(
      () => leg.connect(leg.env, leg.ledger.logger, limit.signal),
      leg.ledger,
    );
    return await refreshInSession(stoppedAtCap(session, limit), leg, limit);
  } catch (error) {
    return unavailable(messageOf(error), leg);
  }
}

function unavailable<Api>(reason: string, leg: SaxoLeg<Api>): BarRefreshReport {
  logRefresh(
    leg.ledger.logger,
    'warn',
    leg.plan.unavailableEvent,
    `${leg.plan.labels.noun} not refreshed (${reason}); ${leg.plan.whenUnavailable}`,
  );
  return { attempted: 1, updated: [], noNewBars: [], failed: [{ symbol: SAXO_VENUE, reason }] };
}

export function saxoBarLegFor<Api>(
  env: NodeJS.ProcessEnv,
  tradingDate: string,
  logger: Logger,
  plan: SaxoBarLegPlan<Api>,
  deps: SaxoBarRefreshDeps<Api> & { readonly connect: SaxoConnect<Api> },
): BarRefresh {
  const leg: SaxoLeg<Api> = {
    env,
    tradingDate,
    storeRoot: deps.storeRoot ?? DEFAULT_BAR_STORE_ROOT,
    connect: deps.connect,
    ledger: ledgerFor(deps, logger),
    plan,
  };
  const limitMs = deps.timeLimitMs ?? plan.timeLimitMs;
  const expired = () =>
    unavailable(
      `cut at the ${limitMs / 1000} s cap; lines not yet written keep their stored bars`,
      leg,
    );
  return {
    run: () => withinTimeLimit(limitMs, (limit) => connectAndRefresh(leg, limit), expired),
  };
}

export function liveSaxoConnect(tokenPath: string | undefined): SaxoConnect<SaxoReadOnlyApi> {
  return (env, logger, signal) => openSaxoLiveSession(env, tokenPath, logger, signal);
}

const LSE_PLAN: SaxoBarLegPlan<SaxoBarsApi> = {
  linesFor: (api) => saxoRefreshLines().map((line) => lseBarLine(line, api)),
  labels: LSE_LABELS,
  unavailableEvent: 'v2_saxo_bar_refresh_unavailable',
  whenUnavailable: 'LSE reads keep the last stored bars and fail closed once they go stale',
  timeLimitMs: SAXO_REFRESH_TIME_LIMIT_MS,
};

// A Saxo failure never aborts the run: the US leg does not depend on it, and every LSE read
// already fails closed on a stale ISF or a stale line
export function saxoBarRefreshFor(
  env: NodeJS.ProcessEnv,
  tradingDate: string,
  logger: Logger,
  deps: SaxoBarRefreshDeps = {},
): BarRefresh {
  const connect = deps.connect ?? liveSaxoConnect(deps.tokenPath);
  return saxoBarLegFor(env, tradingDate, logger, LSE_PLAN, { ...deps, connect });
}
