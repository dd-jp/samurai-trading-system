import { addDays } from './data/index.js';

// Ported from v1's server/pipeline/cgt/cgt-disposal-matching.ts (#1518): TCGA92 ss105-106A in
// HMRC's order, same-day (CG51560), then the next 30 days (CG51560/CG51570), then the section 104
// pool (CG51575). Dates are UK calendar dates, so the v1 UTC-day caveat does not carry over
export const THIRTY_DAY_WINDOW_DAYS = 30;

export type MatchRule = 'same-day' | '30-day' | 'section-104';

export interface MatchLeg {
  readonly kind: 'acquisition' | 'disposal';
  readonly date: string;
  readonly qty: number;
  readonly amountGbp: number;
  readonly chargesGbp: number;
}

export interface ShareMatch {
  readonly disposalDate: string;
  readonly acquisitionDate: string | null;
  readonly qty: number;
  readonly proceedsGbp: number;
  readonly costGbp: number;
  readonly rule: MatchRule;
}

export type MatchOutcome =
  | { readonly ok: true; readonly matches: readonly ShareMatch[] }
  | { readonly ok: false; readonly reason: string };

const POOL_TOLERANCE = 1e-9;

interface DayLot {
  readonly date: string;
  readonly qty: number;
  readonly amountGbp: number;
  readonly chargesGbp: number;
  remaining: number;
}

interface Slice {
  readonly amountGbp: number;
  readonly chargesGbp: number;
}

function isOpen(lot: DayLot): boolean {
  return lot.remaining > POOL_TOLERANCE;
}

function toDayLots(legs: readonly MatchLeg[]): DayLot[] {
  const byDay = new Map<string, DayLot>();
  for (const leg of legs) {
    const lot = byDay.get(leg.date);
    byDay.set(leg.date, {
      date: leg.date,
      qty: (lot?.qty ?? 0) + leg.qty,
      amountGbp: (lot?.amountGbp ?? 0) + leg.amountGbp,
      chargesGbp: (lot?.chargesGbp ?? 0) + leg.chargesGbp,
      remaining: (lot?.remaining ?? 0) + leg.qty,
    });
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function take(lot: DayLot, qty: number): Slice {
  lot.remaining -= qty;
  return {
    amountGbp: (lot.amountGbp * qty) / lot.qty,
    chargesGbp: (lot.chargesGbp * qty) / lot.qty,
  };
}

function matchOf(
  disposal: DayLot,
  acquisitionDate: string | null,
  qty: number,
  costGbp: number,
  rule: MatchRule,
): ShareMatch {
  const proceeds = take(disposal, qty);
  return {
    disposalDate: disposal.date,
    acquisitionDate,
    qty,
    proceedsGbp: proceeds.amountGbp - proceeds.chargesGbp,
    costGbp,
    rule,
  };
}

function pairLots(disposal: DayLot, acquisition: DayLot, rule: MatchRule): ShareMatch {
  const qty = Math.min(acquisition.remaining, disposal.remaining);
  const cost = take(acquisition, qty);
  return matchOf(disposal, acquisition.date, qty, cost.amountGbp + cost.chargesGbp, rule);
}

function matchSameDay(acquisitions: readonly DayLot[], disposals: readonly DayLot[]): ShareMatch[] {
  const byDate = new Map(acquisitions.map((lot) => [lot.date, lot]));
  return disposals.flatMap((disposal) => {
    const acquisition = byDate.get(disposal.date);
    return acquisition === undefined ? [] : [pairLots(disposal, acquisition, 'same-day')];
  });
}

function inThirtyDayWindow(disposal: DayLot, acquisition: DayLot): boolean {
  return (
    acquisition.date > disposal.date &&
    acquisition.date <= addDays(disposal.date, THIRTY_DAY_WINDOW_DAYS)
  );
}

function thirtyDayMatchesOf(disposal: DayLot, acquisitions: readonly DayLot[]): ShareMatch[] {
  const matches: ShareMatch[] = [];
  for (const acquisition of acquisitions.filter((lot) => inThirtyDayWindow(disposal, lot))) {
    if (isOpen(disposal) && isOpen(acquisition)) {
      matches.push(pairLots(disposal, acquisition, '30-day'));
    }
  }
  return matches;
}

function matchThirtyDay(
  acquisitions: readonly DayLot[],
  disposals: readonly DayLot[],
): ShareMatch[] {
  return disposals.flatMap((disposal) => thirtyDayMatchesOf(disposal, acquisitions));
}

interface Pool {
  qty: number;
  costGbp: number;
}

function addToPool(pool: Pool, lot: DayLot): void {
  const qty = lot.remaining;
  const slice = take(lot, qty);
  pool.qty += qty;
  pool.costGbp += slice.amountGbp + slice.chargesGbp;
}

function shortfall(pool: Pool, lot: DayLot): string {
  return (
    `section 104 pool holds ${pool.qty} shares but the disposal on ${lot.date} needs ` +
    `${lot.remaining}: a short sale, or acquisitions missing from the fill history (CG51575)`
  );
}

function drawFromPool(pool: Pool, lot: DayLot): ShareMatch {
  const qty = lot.remaining;
  const costGbp = (pool.costGbp * qty) / pool.qty;
  pool.qty -= qty;
  pool.costGbp -= costGbp;
  return matchOf(lot, null, qty, costGbp, 'section-104');
}

function poolEvents(acquisitions: readonly DayLot[], disposals: readonly DayLot[]) {
  return [
    ...acquisitions.map((lot) => ({ lot, acquisition: true })),
    ...disposals.map((lot) => ({ lot, acquisition: false })),
  ]
    .filter(({ lot }) => isOpen(lot))
    .sort((a, b) => a.lot.date.localeCompare(b.lot.date));
}

function matchSection104(
  acquisitions: readonly DayLot[],
  disposals: readonly DayLot[],
): MatchOutcome {
  const pool: Pool = { qty: 0, costGbp: 0 };
  const matches: ShareMatch[] = [];
  for (const { lot, acquisition } of poolEvents(acquisitions, disposals)) {
    if (acquisition) {
      addToPool(pool, lot);
    } else if (pool.qty + POOL_TOLERANCE < lot.remaining) {
      return { ok: false, reason: shortfall(pool, lot) };
    } else {
      matches.push(drawFromPool(pool, lot));
    }
  }
  return { ok: true, matches };
}

export function matchShares(legs: readonly MatchLeg[]): MatchOutcome {
  const acquisitions = toDayLots(legs.filter((leg) => leg.kind === 'acquisition'));
  const disposals = toDayLots(legs.filter((leg) => leg.kind === 'disposal'));
  const sameDay = matchSameDay(acquisitions, disposals);
  const thirtyDay = matchThirtyDay(acquisitions, disposals);
  const pooled = matchSection104(acquisitions, disposals);
  if (!pooled.ok) return pooled;
  return {
    ok: true,
    matches: [...sameDay, ...thirtyDay, ...pooled.matches].sort((a, b) =>
      a.disposalDate.localeCompare(b.disposalDate),
    ),
  };
}
