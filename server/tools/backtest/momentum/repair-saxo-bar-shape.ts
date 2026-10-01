import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import type { ShapeRepairReport } from '../../../providers/bar-store/index.js';
import {
  DEFAULT_BAR_STORE_ROOT,
  ParquetBarStore,
  repairBarShape,
  SHAPE_REPAIR_MANIFEST_NOTE,
  violatesBarShape,
} from '../../../providers/bar-store/index.js';
import { isMainModule } from '../../cli-entrypoint.js';
import { roundBarPrices } from './bar-csv.js';
import { density, windowStartOf } from './pull-saxo-bars.js';

const SAXO_VENUE = 'saxo';
const DEFAULT_MANIFEST_PATH = 'data/bars/saxo/manifest.json';

export interface SymbolRepair {
  readonly symbol: string;
  readonly report: ShapeRepairReport;
  readonly repaired: BarSeries;
}

export interface StoreRepairResult {
  readonly series: number;
  readonly repairedSymbols: readonly string[];
  readonly barsBefore: number;
  readonly barsAfter: number;
  readonly rescaledFields: number;
  readonly neighbourRepairs: number;
  readonly rangesWidened: number;
  readonly droppedBars: number;
  readonly droppedDates: Readonly<Record<string, readonly string[]>>;
  readonly violationsBefore: number;
  readonly violationsAfter: number;
  readonly manifestUpdated: boolean;
}

interface ManifestLine {
  readonly first: string;
  readonly last: string;
  readonly bars: number;
  readonly density: number;
  readonly hygiene: {
    readonly shape_repair?: Partial<ShapeRepairReport>;
    readonly [key: string]: unknown;
  };
}

interface ManifestShape {
  readonly hygiene: string;
  readonly window_start: string;
  readonly window_binding_line: string;
  readonly symbols: Record<string, ManifestLine>;
}

export function countShapeViolations(series: ReadonlyMap<string, BarSeries>): number {
  let violations = 0;
  for (const { bars } of series.values()) {
    violations += bars.filter(violatesBarShape).length;
  }
  return violations;
}

function isChanged(report: ShapeRepairReport): boolean {
  return (
    report.rescaled_fields.length > 0 ||
    report.neighbour_repairs.length > 0 ||
    report.dropped_glitch_dates.length > 0 ||
    report.ranges_widened > 0
  );
}

export function planShapeRepairs(series: ReadonlyMap<string, BarSeries>): SymbolRepair[] {
  const repairs: SymbolRepair[] = [];
  for (const [symbol, one] of series) {
    const { bars, report } = repairBarShape(one.bars);
    if (isChanged(report)) {
      repairs.push({ symbol, report, repaired: { symbol, bars: roundBarPrices(bars) } });
    }
  }
  return repairs;
}

const SHAPE_NOTE_LEAD = '; then the bar shape is repaired';

const NO_REPAIR: ShapeRepairReport = {
  rescaled_fields: [],
  neighbour_repairs: [],
  dropped_glitch_dates: [],
  ranges_widened: 0,
};

function withShapeNote(hygiene: string): string {
  const lead = hygiene.indexOf(SHAPE_NOTE_LEAD);
  return `${lead < 0 ? hygiene : hygiene.slice(0, lead)}; ${SHAPE_REPAIR_MANIFEST_NOTE}`;
}

function byDate<T extends { readonly date: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => left.date.localeCompare(right.date));
}

function mergeUnique<T extends { readonly date: string; readonly field: string }>(
  prior: readonly T[],
  added: readonly T[],
): T[] {
  const known = new Set(prior.map((entry) => `${entry.date}:${entry.field}`));
  return byDate([...prior, ...added.filter((entry) => !known.has(`${entry.date}:${entry.field}`))]);
}

function entryCount(report: Omit<ShapeRepairReport, 'ranges_widened'>): number {
  return (
    report.rescaled_fields.length +
    report.neighbour_repairs.length +
    report.dropped_glitch_dates.length
  );
}

function mergeReports(
  prior: Partial<ShapeRepairReport> | undefined,
  added: ShapeRepairReport,
): ShapeRepairReport {
  const before = { ...NO_REPAIR, ...prior };
  const merged = {
    rescaled_fields: mergeUnique(before.rescaled_fields, added.rescaled_fields),
    neighbour_repairs: mergeUnique(before.neighbour_repairs, added.neighbour_repairs),
    dropped_glitch_dates: [
      ...new Set([...before.dropped_glitch_dates, ...added.dropped_glitch_dates]),
    ].sort(),
  };
  const fresh = prior === undefined || entryCount(merged) > entryCount(before);
  return {
    ...merged,
    ranges_widened: before.ranges_widened + (fresh ? added.ranges_widened : 0),
  };
}

function refreshedLine(line: ManifestLine, repair: SymbolRepair | undefined): ManifestLine {
  const report = mergeReports(line.hygiene.shape_repair, repair?.report ?? NO_REPAIR);
  const bars = repair?.repaired.bars;
  const counted =
    bars === undefined
      ? {}
      : {
          first: (bars[0] as DailyBar).date,
          last: (bars[bars.length - 1] as DailyBar).date,
          bars: bars.length,
          density: density(bars),
        };
  return { ...line, ...counted, hygiene: { ...line.hygiene, shape_repair: report } };
}

export function updateManifest<T extends ManifestShape>(
  manifest: T,
  repairs: readonly SymbolRepair[],
): T {
  const bySymbol = new Map(repairs.map((repair) => [repair.symbol, repair]));
  const unlisted = repairs.find((repair) => manifest.symbols[repair.symbol] === undefined);
  if (unlisted !== undefined) {
    throw new Error(`${unlisted.symbol}: repaired series is not listed in the Saxo manifest`);
  }
  const symbols = Object.fromEntries(
    Object.entries(manifest.symbols).map(([symbol, line]) => [
      symbol,
      refreshedLine(line, bySymbol.get(symbol)),
    ]),
  );
  const window = windowStartOf(symbols);
  return {
    ...manifest,
    hygiene: withShapeNote(manifest.hygiene),
    window_start: window.windowStart,
    window_binding_line: window.binding,
    symbols,
  };
}

function refreshManifestFile(manifestPath: string, repairs: readonly SymbolRepair[]): boolean {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestShape;
  const updated = updateManifest(manifest, repairs);
  if (JSON.stringify(updated) === JSON.stringify(manifest)) return false;
  writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
  return true;
}

function countBars(series: ReadonlyMap<string, BarSeries>): number {
  return [...series.values()].reduce((total, one) => total + one.bars.length, 0);
}

function sum(repairs: readonly SymbolRepair[], count: (repair: SymbolRepair) => number): number {
  return repairs.reduce((total, repair) => total + count(repair), 0);
}

export async function repairSaxoStore(
  store: ParquetBarStore,
  manifestPath: string | undefined,
): Promise<StoreRepairResult> {
  const stored = await store.readVenue(SAXO_VENUE);
  const repairs = planShapeRepairs(stored);
  const manifestUpdated = manifestPath !== undefined && refreshManifestFile(manifestPath, repairs);
  if (repairs.length > 0) {
    await store.write(
      SAXO_VENUE,
      repairs.map((repair) => repair.repaired),
    );
  }
  const after = await store.readVenue(SAXO_VENUE);
  return {
    series: stored.size,
    repairedSymbols: repairs.map((repair) => repair.symbol),
    barsBefore: countBars(stored),
    barsAfter: countBars(after),
    rescaledFields: sum(repairs, (repair) => repair.report.rescaled_fields.length),
    neighbourRepairs: sum(repairs, (repair) => repair.report.neighbour_repairs.length),
    rangesWidened: sum(repairs, (repair) => repair.report.ranges_widened),
    droppedBars: sum(repairs, (repair) => repair.report.dropped_glitch_dates.length),
    droppedDates: Object.fromEntries(
      repairs
        .filter((repair) => repair.report.dropped_glitch_dates.length > 0)
        .map((repair) => [repair.symbol, repair.report.dropped_glitch_dates]),
    ),
    violationsBefore: countShapeViolations(stored),
    violationsAfter: countShapeViolations(after),
    manifestUpdated,
  };
}

export async function repairFromArgs(
  argv: readonly string[],
  formatManifest: (manifestPath: string) => void,
): Promise<StoreRepairResult> {
  const { values } = parseArgs({
    args: [...argv],
    options: { store: { type: 'string' }, manifest: { type: 'string' } },
  });
  const store = await ParquetBarStore.open(values.store ?? DEFAULT_BAR_STORE_ROOT);
  try {
    const manifestPath = values.manifest ?? DEFAULT_MANIFEST_PATH;
    const result = await repairSaxoStore(store, manifestPath);
    if (result.manifestUpdated) formatManifest(manifestPath);
    return result;
  } finally {
    store.close();
  }
}

function formatWithBiome(manifestPath: string): void {
  execFileSync('npx', ['biome', 'format', '--write', manifestPath], { stdio: 'ignore' });
}

if (isMainModule(import.meta.url)) {
  repairFromArgs(process.argv.slice(2), formatWithBiome)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
