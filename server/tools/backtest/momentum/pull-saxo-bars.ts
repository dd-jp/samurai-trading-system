import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSaxoOAuthConfig } from '../../../pipeline/execution/adapters/saxo-oauth.js';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { TRADING_DAYS_PER_YEAR } from '../../../pipeline/momentum/index.js';
import type { HygieneReport, ShapeRepairReport } from '../../../providers/bar-store/index.js';
import {
  applyBarHygiene,
  DEFAULT_BAR_STORE_ROOT,
  ParquetBarStore,
  repairBarShape,
  SHAPE_REPAIR_MANIFEST_NOTE,
} from '../../../providers/bar-store/index.js';
import type {
  ChartPage,
  InstrumentDetails,
  SaxoLine,
  SplicedLine,
} from '../../../providers/saxo-bars/index.js';
import {
  assertUnitMatchesSaxo,
  gbpPerQuotedUnit,
  isSpliced,
  LSE_AUX_LINES,
  LSE_CALENDAR_REFERENCE,
  LSE_MOMENTUM_LINES,
  liveTokenSource,
  SaxoReadOnlyApi,
  samplesToBars,
} from '../../../providers/saxo-bars/index.js';
import { failExitCodeOnRejection, isMainModule } from '../../cli-entrypoint.js';
import { barsToCsv, roundBarPrices } from './bar-csv.js';
import type { FxRate } from './fx.js';
import { parseBoeXudlussCsv } from './fx.js';
import type { SaxoSpreadRow } from './measure-saxo-spread.js';
import {
  BURST_READS,
  BURST_SPACING_MS,
  DEFAULT_SAXO_SPREAD_PATH,
  parseSaxoSpreadCsv,
} from './measure-saxo-spread.js';
import type { OverlapStats } from './splice.js';
import {
  convertUsdBarsToGbp,
  SPLICE_MAX_MEAN_ABS_RETURN_DIFF_BPS,
  spliceSibling,
} from './splice.js';

export const DEFAULT_SAXO_BARS_DIR = 'data/bars/saxo';

type SaxoHygieneReport = HygieneReport & { readonly shape_repair: ShapeRepairReport };
const DEFAULT_SAXO_AUX_DIR = 'data/bars/saxo-aux';
const DEFAULT_FX_PATH = 'data/bars/fx/gbpusd-boe-xudluss.csv';

interface SpliceRecord {
  readonly tidm: string;
  readonly uic: number;
  readonly unit: 'USD';
  readonly fx: string;
  readonly sibling_first: string;
  readonly sibling_last: string;
  readonly sibling_bars: number;
  readonly sibling_hygiene: SaxoHygieneReport;
  readonly splice_date: string;
  readonly sibling_bars_used: number;
  readonly overlap: OverlapStats;
  readonly within_tolerance: boolean;
}

interface SaxoSymbolEntry {
  readonly uic: number;
  readonly asset_type: string;
  readonly role: string;
  readonly unit: string;
  readonly price_to_contract_factor: number;
  readonly is_complex: boolean;
  readonly first: string;
  readonly last: string;
  readonly bars: number;
  readonly density: number;
  readonly half_spread_bps: number;
  readonly half_spread_median_bps: number;
  readonly hygiene: SaxoHygieneReport;
  readonly spliced_from?: SpliceRecord;
}

interface SaxoExcludedEntry {
  readonly uic: number;
  readonly role: string;
  readonly first: string;
  readonly bars: number;
  readonly reason: string;
  readonly hygiene: SaxoHygieneReport;
  readonly spliced_from?: SpliceRecord;
}

interface SaxoBarsManifest {
  readonly source: string;
  readonly fetched_at: string;
  readonly delayed_by_minutes: number | undefined;
  readonly fetch_date_bars_dropped: string;
  readonly hygiene: string;
  readonly calendar_reference: string;
  readonly window_start: string;
  readonly window_binding_line: string;
  readonly spread: {
    readonly source: string;
    readonly statistic: string;
    readonly measured_at: string;
  };
  readonly symbols: Record<string, SaxoSymbolEntry>;
  readonly excluded: Record<string, SaxoExcludedEntry>;
  readonly checks: Record<string, unknown>;
}

export function density(bars: readonly DailyBar[]): number {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined || bars.length < 2) return 0;
  const years =
    (Date.parse(`${last.date}T00:00:00Z`) - Date.parse(`${first.date}T00:00:00Z`)) /
    (365.25 * 86_400_000);
  return years <= 0 ? 0 : bars.length / (years * TRADING_DAYS_PER_YEAR);
}

export function distributionAdjustmentCheck(
  dist: BarSeries,
  acc: BarSeries,
): Record<string, unknown> {
  const accClose = new Map(acc.bars.map((bar) => [bar.date, bar.close]));
  const common = dist.bars.filter((bar) => accClose.has(bar.date));
  const first = common[0];
  const last = common[common.length - 1];
  if (first === undefined || last === undefined || first === last) {
    return { pair: [dist.symbol, acc.symbol], result: 'no common dates' };
  }
  const ratioFirst = first.close / (accClose.get(first.date) as number);
  const ratioLast = last.close / (accClose.get(last.date) as number);
  const years =
    (Date.parse(`${last.date}T00:00:00Z`) - Date.parse(`${first.date}T00:00:00Z`)) /
    (365.25 * 86_400_000);
  return {
    pair: [dist.symbol, acc.symbol],
    from: first.date,
    to: last.date,
    ratio_first: ratioFirst,
    ratio_last: ratioLast,
    annualised_drift: (ratioLast / ratioFirst) ** (1 / years) - 1,
    reading:
      'a distributing/accumulating close ratio that drifts down at roughly the dividend yield means Saxo closes are price-only (not total return); a flat ratio means they are distribution-adjusted',
  };
}

interface PulledLine {
  readonly line: SaxoLine | SplicedLine;
  readonly details: InstrumentDetails;
  readonly page: ChartPage;
  readonly bars: DailyBar[];
  readonly hygiene: SaxoHygieneReport;
}

export type SaxoBarsApi = Pick<SaxoReadOnlyApi, 'instrumentDetails' | 'dailyHistory'>;

export interface PullContext {
  readonly api: SaxoBarsApi;
  readonly store: ParquetBarStore;
  readonly auxDir: string;
  readonly rawDir: string;
  readonly fetchDate: string;
  readonly fxRates: readonly FxRate[];
  readonly spreads: ReadonlyMap<string, SaxoSpreadRow>;
  readonly spreadsPath: string;
}

async function pullLine(ctx: PullContext, line: SaxoLine): Promise<PulledLine> {
  const details = await ctx.api.instrumentDetails(line.uic, line.assetType);
  assertUnitMatchesSaxo(line, details);
  const page = await ctx.api.dailyHistory(line.uic, line.assetType);
  const factor = line.unit === 'USD' ? 1 : gbpPerQuotedUnit(line.unit);
  const raw = samplesToBars(page.samples, factor);
  writeFileSync(join(ctx.rawDir, `${line.tidm}.csv`), barsToCsv(raw));
  const cleaned = applyBarHygiene(line.tidm, raw, { fetchDate: ctx.fetchDate });
  const repaired = repairBarShape(cleaned.bars);
  const bars = repaired.bars;
  const report = { ...cleaned.report, shape_repair: repaired.report };
  const first = bars[0];
  const last = bars[bars.length - 1];
  console.log(
    `${line.tidm} (${line.uic}, ${line.unit}): ${bars.length} bars ${first?.date ?? '-'}..${last?.date ?? '-'}, FirstSampleTime ${page.firstSampleTime ?? '?'}, density ${(density(bars) * 100).toFixed(0)}%, dropped ${report.dropped_dates.length}, unit breaks ${report.unit_breaks.map((b) => `${b.date}×${b.factor}`).join(' ') || 'none'}, suspect flips ${report.suspect_flips?.count ?? 0}, shape: rescaled ${report.shape_repair.rescaled_fields.length} replaced ${report.shape_repair.neighbour_repairs.length} widened ${report.shape_repair.ranges_widened} dropped ${report.shape_repair.dropped_glitch_dates.length}`,
  );
  return { line, details, page, bars, hygiene: report };
}

function spliceRecord(
  sibling: PulledLine,
  fxLabel: string,
  result: ReturnType<typeof spliceSibling>,
): SpliceRecord {
  return {
    tidm: sibling.line.tidm,
    uic: sibling.line.uic,
    unit: 'USD',
    fx: fxLabel,
    sibling_first: sibling.bars[0]?.date ?? '',
    sibling_last: sibling.bars[sibling.bars.length - 1]?.date ?? '',
    sibling_bars: sibling.bars.length,
    sibling_hygiene: sibling.hygiene,
    splice_date: result.spliceDate,
    sibling_bars_used: result.siblingBarsUsed,
    overlap: result.overlap,
    within_tolerance: result.withinTolerance,
  };
}

export function parseSaxoPullArgs(argv: readonly string[]): {
  outDir: string;
  storeRoot: string;
  auxDir: string;
  spreads: string;
  fx: string;
  tokenFile: string | undefined;
} {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    outDir: value('--out') ?? DEFAULT_SAXO_BARS_DIR,
    storeRoot: value('--store') ?? DEFAULT_BAR_STORE_ROOT,
    auxDir: value('--aux') ?? DEFAULT_SAXO_AUX_DIR,
    spreads: value('--spreads') ?? DEFAULT_SAXO_SPREAD_PATH,
    fx: value('--fx') ?? DEFAULT_FX_PATH,
    tokenFile: value('--token-file'),
  };
}

type LineOutcome =
  | { readonly kind: 'included'; readonly pulled: PulledLine; readonly entry: SaxoSymbolEntry }
  | { readonly kind: 'excluded'; readonly pulled: PulledLine; readonly entry: SaxoExcludedEntry };

async function spliceLine(
  ctx: PullContext,
  line: SplicedLine,
  primary: PulledLine,
): Promise<{ bars: DailyBar[]; record: SpliceRecord }> {
  const sibling = await pullLine(ctx, line.spliceFrom);
  writeFileSync(join(ctx.auxDir, `${sibling.line.tidm}.csv`), barsToCsv(sibling.bars));
  const converted = convertUsdBarsToGbp(sibling.bars, ctx.fxRates);
  const result = spliceSibling({ symbol: line.tidm, bars: primary.bars }, converted);
  const record = spliceRecord(sibling, 'BoE XUDLUSS, same-day fix or last on or before', result);
  writeFileSync(join(ctx.auxDir, `${line.tidm}-spliced.csv`), barsToCsv(result.bars));
  console.log(
    `${line.tidm} splice from ${sibling.line.tidm}: overlap ${result.overlap.sessions} sessions, mean abs return diff ${result.overlap.meanAbsReturnDiffBps.toFixed(2)} bps/day, mean ${result.overlap.meanReturnDiffBps.toFixed(2)} bps, corr ${result.overlap.returnCorrelation.toFixed(4)}, within tolerance ${result.withinTolerance}`,
  );
  return { bars: result.bars, record };
}

export async function pullMomentumLine(
  ctx: PullContext,
  line: SaxoLine | SplicedLine,
): Promise<LineOutcome> {
  const primary = await pullLine(ctx, line);
  const splice = isSpliced(line) ? await spliceLine(ctx, line, primary) : undefined;
  if (splice !== undefined && !splice.record.within_tolerance) {
    writeFileSync(join(ctx.auxDir, `${line.tidm}.csv`), barsToCsv(primary.bars));
    return {
      kind: 'excluded',
      pulled: primary,
      entry: excludedEntry(line, primary, splice.record),
    };
  }
  const bars = splice?.bars ?? primary.bars;
  const spread = ctx.spreads.get(line.tidm);
  if (spread === undefined)
    throw new Error(`${line.tidm}: no measured half spread in ${ctx.spreadsPath}`);
  await ctx.store.write('saxo', [{ symbol: line.tidm, bars: roundBarPrices(bars) }]);
  return {
    kind: 'included',
    pulled: { ...primary, bars },
    entry: includedEntry(line, primary, bars, spread, splice?.record),
  };
}

function excludedEntry(
  line: SaxoLine,
  primary: PulledLine,
  record: SpliceRecord,
): SaxoExcludedEntry {
  const first = primary.bars[0]?.date;
  return {
    uic: line.uic,
    role: line.role,
    first: first ?? '',
    bars: primary.bars.length,
    hygiene: primary.hygiene,
    reason: `GBX line starts ${first ?? '?'} (under ten years); sibling splice exceeds the pre-declared tolerance (mean abs return diff ${record.overlap.meanAbsReturnDiffBps.toFixed(2)} bps/day > ${SPLICE_MAX_MEAN_ABS_RETURN_DIFF_BPS}) — STOP for David`,
    spliced_from: record,
  };
}

function includedEntry(
  line: SaxoLine,
  primary: PulledLine,
  bars: readonly DailyBar[],
  spread: SaxoSpreadRow,
  record: SpliceRecord | undefined,
): SaxoSymbolEntry {
  return {
    uic: line.uic,
    asset_type: line.assetType,
    role: line.role,
    unit: line.unit,
    price_to_contract_factor: primary.details.priceToContractFactor,
    is_complex: primary.details.isComplex,
    first: bars[0]?.date ?? '',
    last: bars[bars.length - 1]?.date ?? '',
    bars: bars.length,
    density: density(bars),
    half_spread_bps: spread.p25HalfSpreadBps,
    half_spread_median_bps: spread.medianHalfSpreadBps,
    hygiene: primary.hygiene,
    ...(record === undefined ? {} : { spliced_from: record }),
  };
}

export function windowStartOf(symbols: Record<string, { readonly first: string }>): {
  windowStart: string;
  binding: string;
} {
  let windowStart = '';
  let binding = '';
  for (const [tidm, entry] of Object.entries(symbols)) {
    if (entry.first > windowStart) {
      windowStart = entry.first;
      binding = tidm;
    }
  }
  return { windowStart, binding };
}

export interface PulledLines {
  readonly symbols: Record<string, SaxoSymbolEntry>;
  readonly excluded: Record<string, SaxoExcludedEntry>;
  readonly pulled: ReadonlyMap<string, PulledLine>;
  readonly delayed: number | undefined;
}

export async function pullAllLines(ctx: PullContext): Promise<PulledLines> {
  const symbols: Record<string, SaxoSymbolEntry> = {};
  const excluded: Record<string, SaxoExcludedEntry> = {};
  const pulled = new Map<string, PulledLine>();
  let delayed: number | undefined;
  for (const line of LSE_MOMENTUM_LINES) {
    const outcome = await pullMomentumLine(ctx, line);
    delayed ??= outcome.pulled.page.delayedByMinutes;
    if (outcome.kind === 'excluded') {
      excluded[line.tidm] = outcome.entry;
      continue;
    }
    symbols[line.tidm] = outcome.entry;
    pulled.set(line.tidm, outcome.pulled);
  }
  for (const aux of LSE_AUX_LINES) {
    const line = await pullLine(ctx, aux);
    writeFileSync(join(ctx.auxDir, `${aux.tidm}.csv`), barsToCsv(line.bars));
    pulled.set(aux.tidm, line);
  }
  return { symbols, excluded, pulled, delayed };
}

export function saxoBarsManifest(
  ctx: PullContext,
  { symbols, excluded, pulled, delayed }: PulledLines,
  fetchedAt: string,
): SaxoBarsManifest {
  const checks: Record<string, unknown> = {
    aux_hygiene: Object.fromEntries(
      LSE_AUX_LINES.flatMap((aux) => {
        const line = pulled.get(aux.tidm);
        return line === undefined ? [] : [[aux.tidm, line.hygiene]];
      }),
    ),
  };
  const isf = pulled.get('ISF');
  const cukx = pulled.get('CUKX');
  if (isf !== undefined && cukx !== undefined) {
    checks.distribution_adjustment = distributionAdjustmentCheck(
      { symbol: 'ISF', bars: isf.bars },
      { symbol: 'CUKX', bars: cukx.bars },
    );
  }
  const { windowStart, binding } = windowStartOf(symbols);
  return {
    source:
      'Saxo OpenAPI GET /chart/v3/charts, Horizon=1440, Count=1200, paged back with Mode=UpTo; prices in GBP (GBX lines × 0.01 per the LSE instrument list currency, checked against PriceToContractFactor)',
    fetched_at: fetchedAt,
    delayed_by_minutes: delayed,
    fetch_date_bars_dropped: ctx.fetchDate,
    hygiene: `weekend-dated and fetch-day bars dropped; a close/close ratio inside (90, 110) or its inverse is a unit break and the earlier segment is rescaled to the latest unit; a ratio beyond 3× that is not a unit break refuses the pull; ratios beyond 1.35× are counted as suspect flips; raw pre-hygiene series under saxo-aux/raw; ${SHAPE_REPAIR_MANIFEST_NOTE}`,
    calendar_reference: LSE_CALENDAR_REFERENCE,
    window_start: windowStart,
    window_binding_line: binding,
    spread: {
      source: `Saxo GET /trade/v1/infoprices/list, FieldGroups=Quote, one burst of ${BURST_READS} reads spaced ${BURST_SPACING_MS / 1000} s at a single time point (delayed 15 min), measured once; raw in ${ctx.spreadsPath}`,
      statistic: 'p25 of the burst half spreads, bps of mid (median alongside)',
      measured_at: [...ctx.spreads.values()][0]?.measuredAt ?? '',
    },
    symbols,
    excluded,
    checks,
  };
}

export function saxoPullSummary(outDir: string, manifest: SaxoBarsManifest): string {
  const lastBar = Object.values(manifest.symbols).reduce(
    (max, entry) => (entry.last > max ? entry.last : max),
    '',
  );
  return `wrote ${Object.keys(manifest.symbols).length} lines to ${outDir} (window from ${manifest.window_start}, binding ${manifest.window_binding_line}); excluded ${Object.keys(manifest.excluded).join(', ') || 'none'}; last bar ${lastBar}`;
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseSaxoPullArgs(argv);
  const spreads = parseSaxoSpreadCsv(readFileSync(args.spreads, 'utf8'));
  const fxRates = parseBoeXudlussCsv(readFileSync(args.fx, 'utf8'));
  const tokens = liveTokenSource(process.env, args.tokenFile);
  const store = await ParquetBarStore.open(args.storeRoot);
  const ctx: PullContext = {
    api: new SaxoReadOnlyApi(tokens, resolveSaxoOAuthConfig('live', process.env).gatewayBaseUrl),
    store,
    auxDir: args.auxDir,
    rawDir: join(args.auxDir, 'raw'),
    fetchDate: new Date().toISOString().slice(0, 10),
    fxRates,
    spreads,
    spreadsPath: args.spreads,
  };
  mkdirSync(args.outDir, { recursive: true });
  mkdirSync(ctx.rawDir, { recursive: true });

  const pulledLines = await pullAllLines(ctx).finally(() => {
    tokens.stop();
    store.close();
  });
  const manifest = saxoBarsManifest(ctx, pulledLines, new Date().toISOString());
  writeFileSync(join(args.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync('npx', ['biome', 'format', '--write', join(args.outDir, 'manifest.json')], {
    stdio: 'ignore',
  });
  console.log(saxoPullSummary(args.storeRoot, manifest));
}

if (isMainModule(import.meta.url)) {
  void failExitCodeOnRejection(main(process.argv.slice(2)));
}
