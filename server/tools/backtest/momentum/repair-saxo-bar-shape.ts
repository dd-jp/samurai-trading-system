import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import type { BarSeries } from '../../../pipeline/momentum/index.js';
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
    report.dropped_glitch_dates.length > 0 ||
    report.ranges_widened > 0
  );
}

export function planShapeRepairs(series: ReadonlyMap<string, BarSeries>): {
  changed: BarSeries[];
  repairs: SymbolRepair[];
} {
  const changed: BarSeries[] = [];
  const repairs: SymbolRepair[] = [];
  for (const [symbol, one] of series) {
    const { bars, report } = repairBarShape(one.bars);
    if (!isChanged(report)) continue;
    const rounded = roundBarPrices(bars);
    changed.push({ symbol, bars: rounded });
    repairs.push({ symbol, report });
  }
  return { changed, repairs };
}

export function updateManifest<T extends ManifestShape>(
  manifest: T,
  repairs: readonly SymbolRepair[],
  changed: readonly BarSeries[],
): T {
  if (repairs.length === 0) return manifest;
  const symbols = { ...manifest.symbols };
  for (const one of changed) {
    const line = symbols[one.symbol];
    const repair = repairs.find((entry) => entry.symbol === one.symbol);
    if (line === undefined || repair === undefined) {
      throw new Error(`${one.symbol}: repaired series is not listed in the Saxo manifest`);
    }
    symbols[one.symbol] = {
      ...line,
      first: one.bars[0]?.date ?? '',
      last: one.bars[one.bars.length - 1]?.date ?? '',
      bars: one.bars.length,
      density: density(one.bars),
      hygiene: { ...line.hygiene, shape_repair: repair.report },
    };
  }
  const window = windowStartOf(symbols);
  return {
    ...manifest,
    hygiene: manifest.hygiene.includes(SHAPE_REPAIR_MANIFEST_NOTE)
      ? manifest.hygiene
      : `${manifest.hygiene}; ${SHAPE_REPAIR_MANIFEST_NOTE}`,
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
  const { changed, repairs } = planShapeRepairs(stored);
  if (changed.length > 0) {
    await store.write(SAXO_VENUE, changed);
    if (manifestPath !== undefined) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestShape;
      const updated = updateManifest(manifest, repairs, changed);
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

async function main(argv: readonly string[]): Promise<void> {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const store = await ParquetBarStore.open(value('--store') ?? DEFAULT_BAR_STORE_ROOT);
  try {
    const manifestPath = value('--manifest') ?? DEFAULT_MANIFEST_PATH;
    const result = await repairSaxoStore(store, manifestPath);
    if (result.repairedSymbols.length > 0) {
      execFileSync('npx', ['biome', 'format', '--write', manifestPath], { stdio: 'ignore' });
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
