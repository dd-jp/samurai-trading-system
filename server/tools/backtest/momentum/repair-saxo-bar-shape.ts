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
  readonly rangesWidened: number;
  readonly droppedBars: number;
  readonly droppedDates: Readonly<Record<string, readonly string[]>>;
  readonly violationsBefore: number;
  readonly violationsAfter: number;
}

interface ManifestLine {
  readonly first: string;
  readonly last: string;
  readonly bars: number;
  readonly density: number;
  readonly hygiene: object;
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

function withShapeNote(hygiene: string): string {
  return hygiene.includes(SHAPE_REPAIR_MANIFEST_NOTE)
    ? hygiene
    : `${hygiene}; ${SHAPE_REPAIR_MANIFEST_NOTE}`;
}

function repairedLine(line: ManifestLine | undefined, repair: SymbolRepair): ManifestLine {
  if (line === undefined) {
    throw new Error(`${repair.symbol}: repaired series is not listed in the Saxo manifest`);
  }
  const { bars } = repair.repaired;
  return {
    ...line,
    first: (bars[0] as DailyBar).date,
    last: (bars[bars.length - 1] as DailyBar).date,
    bars: bars.length,
    density: density(bars),
    hygiene: { ...line.hygiene, shape_repair: repair.report },
  };
}

export function updateManifest<T extends ManifestShape>(
  manifest: T,
  repairs: readonly SymbolRepair[],
): T {
  if (repairs.length === 0) return manifest;
  const symbols = { ...manifest.symbols };
  for (const repair of repairs) {
    symbols[repair.symbol] = repairedLine(symbols[repair.symbol], repair);
  }
  const window = windowStartOf(symbols);
  return {
    ...manifest,
    hygiene: withShapeNote(manifest.hygiene),
    window_start: window.windowStart,
    window_binding_line: window.binding,
    symbols,
  };
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
  if (repairs.length > 0) {
    await store.write(
      SAXO_VENUE,
      repairs.map((repair) => repair.repaired),
    );
    if (manifestPath !== undefined) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestShape;
      const updated = updateManifest(manifest, repairs);
      writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
    }
  }
  const after = await store.readVenue(SAXO_VENUE);
  return {
    series: stored.size,
    repairedSymbols: repairs.map((repair) => repair.symbol),
    barsBefore: countBars(stored),
    barsAfter: countBars(after),
    rescaledFields: sum(repairs, (repair) => repair.report.rescaled_fields.length),
    rangesWidened: sum(repairs, (repair) => repair.report.ranges_widened),
    droppedBars: sum(repairs, (repair) => repair.report.dropped_glitch_dates.length),
    droppedDates: Object.fromEntries(
      repairs
        .filter((repair) => repair.report.dropped_glitch_dates.length > 0)
        .map((repair) => [repair.symbol, repair.report.dropped_glitch_dates]),
    ),
    violationsBefore: countShapeViolations(stored),
    violationsAfter: countShapeViolations(after),
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
    if (result.repairedSymbols.length > 0) formatManifest(manifestPath);
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
