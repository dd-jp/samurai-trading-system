import { pathToFileURL } from 'node:url';
import type { OrderSide } from '../../../contracts/index.js';
import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openReadOnlyStore } from '../../shared/store/index.js';
import { ParquetBarsSource } from './data/index.js';
import {
  type BarsFrom,
  entryOffsetReport,
  formatEntryOffsetReport,
  type JournalledEntry,
} from './entry-offset-report.js';
import { V2_STORE_PATH } from './index.js';
import { DEBATE_SLEEVE_SPEC } from './signal/index.js';

export const OFFSET_BENCHMARK = 'SPY';

const HOLD_DAYS = DEBATE_SLEEVE_SPEC.sizing.timeStopTradingDays;

interface EntryRow {
  readonly trading_date: string;
  readonly instrument: string;
  readonly side: string;
  readonly payload: string;
}

function limitFrom(payload: string): number | undefined {
  try {
    const { price } = JSON.parse(payload) as { price?: unknown };
    return typeof price === 'number' ? price : undefined;
  } catch {
    return undefined;
  }
}

export function readJournalledEntries(db: StoreHandle): readonly JournalledEntry[] {
  const rows = db
    .prepare(
      `SELECT trading_date, instrument, side, payload FROM v2_orders
        WHERE leg = 'entry' AND venue = 'alpaca' ORDER BY trading_date, instrument, client_order_id`,
    )
    .all() as EntryRow[];
  const seen = new Set<string>();
  const entries: JournalledEntry[] = [];
  for (const row of rows) {
    const key = `${row.trading_date}|${row.instrument}|${row.side}`;
    const limit = limitFrom(row.payload);
    if (seen.has(key) || limit === undefined) continue;
    seen.add(key);
    entries.push({
      tradingDate: row.trading_date,
      instrument: row.instrument,
      side: row.side as OrderSide,
      limit,
    });
  }
  return entries;
}

export function barsFromSource(source: ParquetBarsSource): BarsFrom {
  return (instrument, tradingDate) =>
    (source.load(instrument)?.bars ?? []).filter((bar) => bar.date >= tradingDate);
}

export async function reportEntryOffsets(storePath: string, barRoot: string): Promise<string> {
  const db = openReadOnlyStore(storePath);
  try {
    const bars = new ParquetBarsSource(barRoot, 'alpaca');
    await bars.prime();
    const report = entryOffsetReport(
      readJournalledEntries(db),
      barsFromSource(bars),
      OFFSET_BENCHMARK,
      HOLD_DAYS,
    );
    return formatEntryOffsetReport(report, HOLD_DAYS);
  } finally {
    db.close();
  }
}

export async function main(
  argv: readonly string[],
  write: (line: string) => void,
  report = reportEntryOffsets,
): Promise<number> {
  const [storePath = V2_STORE_PATH, barRoot = DEFAULT_BAR_STORE_ROOT] = argv;
  try {
    write(await report(storePath, barRoot));
    return 0;
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), (line) => console.log(line));
}
