import type { DividendsRead, EodhdDividend } from './eodhd-client.js';
import { covers, firstUncovered } from './eodhd-splits.js';
import { addDays } from './macro-calendar.js';

export type DividendsAcross =
  | { readonly kind: 'covered'; readonly dividends: readonly EodhdDividend[] }
  | { readonly kind: 'uncovered'; readonly from: string }
  | { readonly kind: 'conflict'; readonly date: string };

function listedOn(read: DividendsRead, date: string): EodhdDividend[] {
  return read.dividends.filter((dividend) => dividend.exDate === date);
}

function amountsKey(dividends: readonly EodhdDividend[]): string {
  return JSON.stringify(dividends.map((dividend) => dividend.perShare).sort((a, b) => a - b));
}

// every read covering the date must list the same dividends on it, so a later read that drops or
// restates one refuses rather than picking either
function agreedOn(reads: readonly DividendsRead[], date: string): EodhdDividend[] | undefined {
  const listings = reads.filter((read) => covers(read, date)).map((read) => listedOn(read, date));
  if (new Set(listings.map(amountsKey)).size !== 1) return undefined;
  return listings[0];
}

function listedDates(reads: readonly DividendsRead[], after: string, through: string): string[] {
  const dates = new Set(reads.flatMap((read) => read.dividends.map((dividend) => dividend.exDate)));
  return [...dates].filter((date) => date > after && date <= through).sort();
}

function assertInputs(reads: readonly DividendsRead[], after: string, through: string): void {
  if (new Set(reads.map((read) => read.symbol)).size > 1) {
    throw new Error('dividendsAcross: reads for more than one symbol');
  }
  if (after > through) throw new Error('dividendsAcross: window ends before it starts');
}

export function dividendsAcross(
  reads: readonly DividendsRead[],
  after: string,
  through: string,
): DividendsAcross {
  assertInputs(reads, after, through);
  const uncovered = firstUncovered(reads, addDays(after, 1));
  if (uncovered <= through) return { kind: 'uncovered', from: uncovered };
  const dividends: EodhdDividend[] = [];
  for (const date of listedDates(reads, after, through)) {
    const agreed = agreedOn(reads, date);
    if (agreed === undefined) return { kind: 'conflict', date };
    dividends.push(...agreed);
  }
  return { kind: 'covered', dividends };
}
