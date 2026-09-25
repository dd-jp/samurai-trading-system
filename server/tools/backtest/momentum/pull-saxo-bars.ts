import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSaxoOAuthConfig } from '../../../pipeline/execution/adapters/saxo-oauth.js';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { TRADING_DAYS_PER_YEAR } from '../../../pipeline/momentum/index.js';
import { isMainModule } from '../../cli-entrypoint.js';
import { barsToCsv } from './bar-csv.js';
import type { FxRate } from './fx.js';
import { parseBoeXudlussCsv } from './fx.js';
import type { SaxoLine, SplicedLine } from './lse-lines.js';
import {
  gbpPerQuotedUnit,
  isSpliced,
  LSE_AUX_LINES,
  LSE_CALENDAR_REFERENCE,
  LSE_MOMENTUM_LINES,
} from './lse-lines.js';
import type { SaxoSpreadRow } from './measure-saxo-spread.js';
import {
  BURST_READS,
  BURST_SPACING_MS,
  DEFAULT_SAXO_SPREAD_PATH,
  parseSaxoSpreadCsv,
} from './measure-saxo-spread.js';
import type { ChartPage, InstrumentDetails } from './saxo-api.js';
import { liveTokenSource, SaxoReadOnlyApi, samplesToBars } from './saxo-api.js';
import type { OverlapStats } from './splice.js';
import {
  convertUsdBarsToGbp,
  SPLICE_MAX_MEAN_ABS_RETURN_DIFF_BPS,
  spliceSibling,
} from './splice.js';

export const DEFAULT_SAXO_BARS_DIR = 'data/bars/saxo';
export const DEFAULT_SAXO_AUX_DIR = 'data/bars/saxo-aux';
const DEFAULT_FX_PATH = 'data/bars/fx/gbpusd-boe-xudluss.csv';

export interface SpliceRecord {
  readonly tidm: string;
  readonly uic: number;
  readonly unit: 'USD';
  readonly fx: string;
  readonly sibling_first: string;
  readonly sibling_last: string;
  readonly sibling_bars: number;
  readonly splice_date: string;
  readonly sibling_bars_used: number;
  readonly overlap: OverlapStats;
  readonly within_tolerance: boolean;
}

export interface SaxoSymbolEntry {
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
  readonly spliced_from?: SpliceRecord;
}

export interface SaxoExcludedEntry {
  readonly uic: number;
  readonly role: string;
  readonly first: string;
  readonly bars: number;
  readonly reason: string;
  readonly spliced_from?: SpliceRecord;
}

export interface SaxoBarsManifest {
  readonly source: string;
  readonly fetched_at: string;
  readonly delayed_by_minutes: number | undefined;
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

export function assertUnitMatchesSaxo(line: SaxoLine, details: InstrumentDetails): void {
  const expected = line.unit === 'USD' ? 1 : gbpPerQuotedUnit(line.unit);
  if (details.priceToContractFactor !== expected) {
    throw new Error(
      `${line.tidm}: LSE list says ${line.unit} (factor ${expected}) but Saxo PriceToContractFactor is ${details.priceToContractFactor}`,
    );
  }
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
}

async function pullLine(api: SaxoReadOnlyApi, line: SaxoLine): Promise<PulledLine> {
  const details = await api.instrumentDetails(line.uic, line.assetType);
  assertUnitMatchesSaxo(line, details);
  const page = await api.dailyHistory(line.uic, line.assetType);
  const factor = line.unit === 'USD' ? 1 : gbpPerQuotedUnit(line.unit);
  const bars = samplesToBars(page.samples, factor);
  const first = bars[0];
  const last = bars[bars.length - 1];
  console.log(
    `${line.tidm} (${line.uic}, ${line.unit}): ${bars.length} bars ${first?.date ?? '-'}..${last?.date ?? '-'}, FirstSampleTime ${page.firstSampleTime ?? '?'}, density ${(density(bars) * 100).toFixed(0)}%`,
  );
  return { line, details, page, bars };
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
    splice_date: result.spliceDate,
    sibling_bars_used: result.siblingBarsUsed,
    overlap: result.overlap,
    within_tolerance: result.withinTolerance,
  };
}

export function parsePullArgs(argv: readonly string[]): {
  outDir: string;
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
    auxDir: value('--aux') ?? DEFAULT_SAXO_AUX_DIR,
    spreads: value('--spreads') ?? DEFAULT_SAXO_SPREAD_PATH,
    fx: value('--fx') ?? DEFAULT_FX_PATH,
    tokenFile: value('--token-file'),
  };
}

interface PullContext {
  readonly api: SaxoReadOnlyApi;
  readonly outDir: string;
  readonly auxDir: string;
  readonly fxRates: readonly FxRate[];
  readonly spreads: ReadonlyMap<string, SaxoSpreadRow>;
  readonly spreadsPath: string;
}

type LineOutcome =
  | { readonly kind: 'included'; readonly pulled: PulledLine; readonly entry: SaxoSymbolEntry }
  | { readonly kind: 'excluded'; readonly pulled: PulledLine; readonly entry: SaxoExcludedEntry };

async function spliceLine(
  ctx: PullContext,
  line: SplicedLine,
  primary: PulledLine,
): Promise<{ bars: DailyBar[]; record: SpliceRecord }> {
  const sibling = await pullLine(ctx.api, line.spliceFrom);
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

async function pullMomentumLine(
  ctx: PullContext,
  line: SaxoLine | SplicedLine,
): Promise<LineOutcome> {
  const primary = await pullLine(ctx.api, line);
  const splice = isSpliced(line) ? await spliceLine(ctx, line, primary) : undefined;
  if (splice !== undefined && !splice.record.within_tolerance) {
    writeFileSync(join(ctx.auxDir, `${line.tidm}.csv`), barsToCsv(primary.bars));
    return {
      kind: 'excluded',
      pulled: primary,
      entry: {
        uic: line.uic,
        role: line.role,
        first: primary.bars[0]?.date ?? '',
        bars: primary.bars.length,
        reason: `GBX line starts ${primary.bars[0]?.date ?? '?'} (under ten years); sibling splice exceeds the pre-declared tolerance (mean abs return diff ${splice.record.overlap.meanAbsReturnDiffBps.toFixed(2)} bps/day > ${SPLICE_MAX_MEAN_ABS_RETURN_DIFF_BPS}) — STOP for David`,
        spliced_from: splice.record,
      },
    };
  }
  const bars = splice?.bars ?? primary.bars;
  const spread = ctx.spreads.get(line.tidm);
  if (spread === undefined)
    throw new Error(`${line.tidm}: no measured half spread in ${ctx.spreadsPath}`);
  writeFileSync(join(ctx.outDir, `${line.tidm}.csv`), barsToCsv(bars));
  return {
    kind: 'included',
    pulled: { ...primary, bars },
    entry: {
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
      ...(splice === undefined ? {} : { spliced_from: splice.record }),
    },
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

async function main(argv: readonly string[]): Promise<void> {
  const args = parsePullArgs(argv);
  const spreads = parseSaxoSpreadCsv(readFileSync(args.spreads, 'utf8'));
  const fxRates = parseBoeXudlussCsv(readFileSync(args.fx, 'utf8'));
  const tokens = liveTokenSource(process.env, args.tokenFile);
  const ctx: PullContext = {
    api: new SaxoReadOnlyApi(tokens, resolveSaxoOAuthConfig('live', process.env).gatewayBaseUrl),
    outDir: args.outDir,
    auxDir: args.auxDir,
    fxRates,
    spreads,
    spreadsPath: args.spreads,
  };
  mkdirSync(args.outDir, { recursive: true });
  mkdirSync(args.auxDir, { recursive: true });

  const symbols: Record<string, SaxoSymbolEntry> = {};
  const excluded: Record<string, SaxoExcludedEntry> = {};
  const pulled = new Map<string, PulledLine>();
  let delayed: number | undefined;
  try {
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
      const line = await pullLine(ctx.api, aux);
      writeFileSync(join(args.auxDir, `${aux.tidm}.csv`), barsToCsv(line.bars));
      pulled.set(aux.tidm, line);
    }
  } finally {
    await tokens.stop();
  }
  const checks: Record<string, unknown> = {};
  const isf = pulled.get('ISF');
  const cukx = pulled.get('CUKX');
  if (isf !== undefined && cukx !== undefined) {
    checks.distribution_adjustment = distributionAdjustmentCheck(
      { symbol: 'ISF', bars: isf.bars },
      { symbol: 'CUKX', bars: cukx.bars },
    );
  }
  const { windowStart, binding } = windowStartOf(symbols);
  const manifest: SaxoBarsManifest = {
    source:
      'Saxo OpenAPI GET /chart/v3/charts, Horizon=1440, Count=1200, paged back with Mode=UpTo; prices in GBP (GBX lines × 0.01 per the LSE instrument list currency, checked against PriceToContractFactor)',
    fetched_at: new Date().toISOString(),
    delayed_by_minutes: delayed,
    calendar_reference: LSE_CALENDAR_REFERENCE,
    window_start: windowStart,
    window_binding_line: binding,
    spread: {
      source: `Saxo GET /trade/v1/infoprices/list, FieldGroups=Quote, one burst of ${BURST_READS} reads spaced ${BURST_SPACING_MS / 1000} s at a single time point (delayed 15 min), measured once; raw in ${args.spreads}`,
      statistic: 'p25 of the burst half spreads, bps of mid (median alongside)',
      measured_at: [...spreads.values()][0]?.measuredAt ?? '',
    },
    symbols,
    excluded,
    checks,
  };
  writeFileSync(join(args.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const lastBar = Object.values(symbols).reduce(
    (max, entry) => (entry.last > max ? entry.last : max),
    '',
  );
  console.log(
    `wrote ${Object.keys(symbols).length} lines to ${args.outDir} (window from ${windowStart}, binding ${binding}); excluded ${Object.keys(excluded).join(', ') || 'none'}; last bar ${lastBar}`,
  );
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
