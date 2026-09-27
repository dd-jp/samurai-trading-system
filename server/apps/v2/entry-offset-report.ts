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

function pathFor(
  entry: JournalledEntry,
  barsFrom: BarsFrom,
  benchmark: string,
  holdDays: number,
): Path | undefined {
  const bars = barsFrom(entry.instrument, entry.tradingDate, holdDays);
  const bench = barsFrom(benchmark, entry.tradingDate, holdDays);
  const [first] = bars;
  const [benchFirst] = bench;
  const exit = bars[holdDays - 1];
  const benchExit = bench[holdDays - 1];
  if (first === undefined || exit === undefined) return undefined;
  if (benchFirst === undefined || benchExit === undefined) return undefined;
  return {
    first,
    exitClose: exit.close,
    benchmarkReturn: benchExit.close / benchFirst.open - 1,
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

export function entryOffsetReport(
  entries: readonly JournalledEntry[],
  barsFrom: BarsFrom,
  benchmark: string,
  holdDays: number,
): EntryOffsetReport {
  const offsets: readonly (number | 'open')[] = [...REPORT_OFFSETS_BPS, 'open'];
  const tallies = offsets.map((offset) => ({ offset, filled: 0, excess: 0 }));
  let scored = 0;
  for (const entry of entries) {
    const path = pathFor(entry, barsFrom, benchmark, holdDays);
    if (path === undefined) continue;
    scored += 1;
    const sign = entry.side === 'buy' ? 1 : -1;
    for (const tally of tallies) {
      const price = adjustedFill(entry, tally.offset, path.first);
      if (price === undefined) continue;
      tally.filled += 1;
      tally.excess += sign * (path.exitClose / price - 1 - path.benchmarkReturn);
    }
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
