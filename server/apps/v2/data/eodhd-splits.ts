import type { EodhdSplit, SplitsRead } from './eodhd-client.js';
import { addDays } from './macro-calendar.js';

export type SplitsAcross =
  | { readonly kind: 'covered'; readonly ratio: number; readonly splits: readonly EodhdSplit[] }
  | { readonly kind: 'uncovered'; readonly from: string }
  | { readonly kind: 'conflict'; readonly date: string };

const CONFLICT = Symbol('conflict');

// a read cannot vouch for days after it was made, whatever window it asked for
export function coverageEnd(read: SplitsRead): string {
  return read.asOf < read.to ? read.asOf : read.to;
}

function covers(read: SplitsRead, date: string): boolean {
  return read.from <= date && date <= coverageEnd(read);
}

function firstUncovered(reads: readonly SplitsRead[], start: string): string {
  let cursor = start;
  for (const read of [...reads].sort((a, b) => a.from.localeCompare(b.from))) {
    if (read.from > cursor) break;
    const end = coverageEnd(read);
    if (end >= cursor) cursor = addDays(end, 1);
  }
  return cursor;
}

// every read covering the date must agree, so a split one read lists and an overlapping read omits refuses
function ratioOn(reads: readonly SplitsRead[], date: string): number | undefined | typeof CONFLICT {
  const ratios = new Set(
    reads
      .filter((read) => covers(read, date))
      .map((read) => read.splits.find((split) => split.date === date)?.ratio),
  );
  return ratios.size === 1 ? [...ratios][0] : CONFLICT;
}

function listedDates(reads: readonly SplitsRead[], after: string, through: string): string[] {
  const dates = new Set(reads.flatMap((read) => read.splits.map((split) => split.date)));
  return [...dates].filter((date) => date > after && date <= through).sort();
}

function assertOneSymbol(reads: readonly SplitsRead[]): void {
  if (new Set(reads.map((read) => read.symbol)).size > 1) {
    throw new Error('splitsAcross: reads for more than one symbol');
  }
}

export function splitsAcross(
  reads: readonly SplitsRead[],
  after: string,
  through: string,
): SplitsAcross {
  assertOneSymbol(reads);
  const uncovered = firstUncovered(reads, addDays(after, 1));
  if (uncovered <= through) return { kind: 'uncovered', from: uncovered };
  const splits: EodhdSplit[] = [];
  for (const date of listedDates(reads, after, through)) {
    const ratio = ratioOn(reads, date);
    if (ratio === CONFLICT) return { kind: 'conflict', date };
    if (ratio !== undefined) splits.push({ date, ratio });
  }
  return {
    kind: 'covered',
    ratio: splits.reduce((product, split) => product * split.ratio, 1),
    splits,
  };
}
