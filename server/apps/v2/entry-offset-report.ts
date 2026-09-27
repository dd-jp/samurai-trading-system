import type { OrderSide, V2Bar } from '../../../contracts/index.js';

const REPORT_OFFSETS_BPS: readonly number[] = [0, 50, 100, 200];

export interface JournalledEntry {
  readonly tradingDate: string;
  readonly instrument: string;
  readonly side: OrderSide;
  readonly limit: number;
}

export type BarsFrom = (instrument: string, tradingDate: string, count: number) => readonly V2Bar[];

export interface OffsetRow {
  readonly offset: number | 'open';
  readonly filled: number;
  readonly meanExcessBps: number;
}

export interface EntryOffsetReport {
  readonly scored: number;
  readonly pending: number;
  readonly rows: readonly OffsetRow[];
}

interface Path {
  readonly first: V2Bar;
  readonly exitClose: number;
  readonly benchmarkReturn: number;
}

interface Hold {
  readonly first: V2Bar;
  readonly exit: V2Bar;
}

function holdFor(bars: readonly V2Bar[], holdDays: number): Hold | undefined {
  const [first] = bars;
  const exit = bars[holdDays - 1];
  return first === undefined || exit === undefined ? undefined : { first, exit };
}

function pathFor(
  entry: JournalledEntry,
  barsFrom: BarsFrom,
  benchmark: string,
  holdDays: number,
): Path | undefined {
  const own = holdFor(barsFrom(entry.instrument, entry.tradingDate, holdDays), holdDays);
  const bench = holdFor(barsFrom(benchmark, entry.tradingDate, holdDays), holdDays);
  if (own === undefined || bench === undefined) return undefined;
  if (own.first.date !== bench.first.date || own.exit.date !== bench.exit.date) return undefined;
  return {
    first: own.first,
    exitClose: own.exit.close,
    benchmarkReturn: bench.exit.close / bench.first.open - 1,
  };
}

function adjustedFill(
  entry: JournalledEntry,
  offset: number | 'open',
  bar: V2Bar,
): number | undefined {
  if (offset === 'open') return bar.open;
  const toQuoted = bar.rawClose / bar.close;
  const sign = entry.side === 'buy' ? 1 : -1;
  const limit = (entry.limit * (1 + (sign * offset) / 10_000)) / toQuoted;
  if (entry.side === 'buy') return bar.low <= limit ? Math.min(bar.open, limit) : undefined;
  return bar.high >= limit ? Math.max(bar.open, limit) : undefined;
}

interface Tally {
  readonly offset: number | 'open';
  filled: number;
  excess: number;
}

function score(entry: JournalledEntry, path: Path, tallies: readonly Tally[]): void {
  const sign = entry.side === 'buy' ? 1 : -1;
  for (const tally of tallies) {
    const price = adjustedFill(entry, tally.offset, path.first);
    if (price === undefined) continue;
    tally.filled += 1;
    tally.excess += sign * (path.exitClose / price - 1 - path.benchmarkReturn);
  }
}

export function entryOffsetReport(
  entries: readonly JournalledEntry[],
  barsFrom: BarsFrom,
  benchmark: string,
  holdDays: number,
): EntryOffsetReport {
  const offsets: readonly (number | 'open')[] = [...REPORT_OFFSETS_BPS, 'open'];
  const tallies: Tally[] = offsets.map((offset) => ({ offset, filled: 0, excess: 0 }));
  let scored = 0;
  for (const entry of entries) {
    const path = pathFor(entry, barsFrom, benchmark, holdDays);
    if (path === undefined) continue;
    scored += 1;
    score(entry, path, tallies);
  }
  return {
    scored,
    pending: entries.length - scored,
    rows: tallies.map(({ offset, filled, excess }) => ({
      offset,
      filled,
      meanExcessBps: scored === 0 ? 0 : (excess / scored) * 10_000,
    })),
  };
}

export function formatEntryOffsetReport(report: EntryOffsetReport, holdDays: number): string {
  const lines = [
    `entries scored: ${report.scored}, awaiting ${holdDays} bars: ${report.pending}`,
    'offset      filled   mean excess per entry (bps, a miss counts 0)',
  ];
  for (const row of report.rows) {
    const label = row.offset === 'open' ? 'at the open' : `${row.offset} bps`;
    const share = report.scored === 0 ? 0 : (100 * row.filled) / report.scored;
    lines.push(
      `${label.padEnd(12)}${`${share.toFixed(1)}%`.padStart(6)}   ${row.meanExcessBps.toFixed(2)}`,
    );
  }
  return lines.join('\n');
}
