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
    const limit = (JSON.parse(row.payload) as { price?: unknown }).price;
    if (seen.has(key) || typeof limit !== 'number') continue;
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
  return (instrument, tradingDate, count) =>
    (source.load(instrument)?.bars ?? []).filter((bar) => bar.date >= tradingDate).slice(0, count);
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [storePath = V2_STORE_PATH, barRoot = DEFAULT_BAR_STORE_ROOT] = process.argv.slice(2);
  reportEntryOffsets(storePath, barRoot)
    .then((text) => console.log(text))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
