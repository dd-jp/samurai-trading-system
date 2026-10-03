import type { BrokerActivityStatus } from '../../../contracts/index.js';
import type { TaxFillRow } from './tax-log.js';

export interface TaxCashInLieuRow {
  readonly venue: string;
  readonly activity_id: string;
  readonly instrument: string;
  readonly activity_date: string;
  readonly qty: number | null;
  readonly amount_native: number;
  readonly currency: string;
  readonly status: BrokerActivityStatus;
}

// The broker dates its payment itself: before the estimate when the cycle first saw the split on
// a later fill, or weeks after it for a reverse split paid once DTC pays (debate-sleeve spec, #1984)
export const CASH_IN_LIEU_PAIRING_DAYS = 30;

const MS_PER_DAY = 86_400_000;

function fillDateOf(fill: TaxFillRow): string {
  return fill.fill_date ?? fill.trading_date;
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / MS_PER_DAY;
}

function isEstimate(fill: TaxFillRow, venue: string): boolean {
  return fill.leg === 'cash_in_lieu' && fill.venue === venue && fill.cash_in_lieu_activity == null;
}

function nearestEstimateDate(estimates: readonly TaxFillRow[], date: string): string | undefined {
  let nearest: string | undefined;
  for (const fill of estimates) {
    const candidate = fillDateOf(fill);
    if (daysApart(candidate, date) > CASH_IN_LIEU_PAIRING_DAYS) continue;
    if (nearest === undefined || closer(candidate, nearest, date)) nearest = candidate;
  }
  return nearest;
}

function closer(candidate: string, nearest: string, date: string): boolean {
  const gap = daysApart(candidate, date) - daysApart(nearest, date);
  return gap < 0 || (gap === 0 && candidate < nearest);
}

function activityOf(row: TaxCashInLieuRow): string {
  return `${row.venue}:${row.activity_id}`;
}

function estimatedQty(paired: readonly TaxFillRow[]): number {
  return paired.reduce((total, fill) => total + fill.qty, 0);
}

function qtyAgrees(broker: number, ledger: number): boolean {
  return Math.abs(broker - ledger) <= 1e-6;
}

function qtyRefusal(row: TaxCashInLieuRow, paired: readonly TaxFillRow[]): string | undefined {
  const ledger = estimatedQty(paired);
  if (row.qty === null || qtyAgrees(row.qty, ledger)) return undefined;
  return `broker cash in lieu ${activityOf(row)} is for ${row.qty} shares, its estimate for ${ledger}`;
}

function refusal(row: TaxCashInLieuRow, paired: readonly TaxFillRow[]): string | undefined {
  const sides = new Set(paired.map((fill) => fill.side));
  if (sides.size > 1) return `broker cash in lieu ${activityOf(row)} pairs a buy and a sell`;
  const first = paired[0] as TaxFillRow;
  if (first.currency !== row.currency) {
    return `broker cash in lieu ${activityOf(row)} is in ${row.currency}, its estimate in ${first.currency}`;
  }
  if (Math.sign(row.amount_native) !== (first.side === 'sell' ? 1 : -1)) {
    return `broker cash in lieu ${activityOf(row)} of ${row.amount_native} ${row.currency} has the wrong sign for a ${first.side}`;
  }
  return qtyRefusal(row, paired);
}

function brokerFill(row: TaxCashInLieuRow, paired: readonly TaxFillRow[]): TaxFillRow {
  const first = paired[0] as TaxFillRow;
  const qty = estimatedQty(paired);
  return {
    ...first,
    fill_id: `${row.venue}:cash-in-lieu-activity:${row.activity_id}`,
    qty,
    currency: row.currency,
    price_native: Math.abs(row.amount_native) / qty,
    fee_native: 0,
    cash_in_lieu_activity: activityOf(row),
  };
}

function pairOne(fills: readonly TaxFillRow[], row: TaxCashInLieuRow): TaxFillRow[] | string {
  const estimates = fills.filter((fill) => isEstimate(fill, row.venue));
  const date = nearestEstimateDate(estimates, row.activity_date);
  if (date === undefined) {
    return `broker cash in lieu ${activityOf(row)} on ${row.activity_date} has no estimate within ${CASH_IN_LIEU_PAIRING_DAYS} days`;
  }
  const paired = estimates.filter((fill) => fillDateOf(fill) === date);
  const refused = refusal(row, paired);
  if (refused !== undefined) return refused;
  const replacement = brokerFill(row, paired);
  return fills.flatMap((fill) => {
    if (fill === paired[0]) return [replacement];
    return paired.includes(fill) ? [] : [fill];
  });
}

function inReadOrder(a: TaxCashInLieuRow, b: TaxCashInLieuRow): number {
  return (
    a.activity_date.localeCompare(b.activity_date) || a.activity_id.localeCompare(b.activity_id)
  );
}

// A canceled status on any read voids every row of that activity, the first read included
export function standingCashInLieu(rows: readonly TaxCashInLieuRow[]): readonly TaxCashInLieuRow[] {
  const canceled = new Set(rows.filter((row) => row.status === 'canceled').map(activityOf));
  return rows.filter((row) => !canceled.has(activityOf(row)));
}

// One broker payment stands for every estimate of its nearest date, since the account holds the
// books' shares as one position
export function withBrokerCashInLieu(
  fills: readonly TaxFillRow[],
  rows: readonly TaxCashInLieuRow[],
): readonly TaxFillRow[] | string {
  const correction = rows.find((row) => row.status === 'correct');
  if (correction !== undefined) {
    return `broker cash in lieu ${activityOf(correction)} is a correction the broker does not link to the activity it corrects`;
  }
  let paired: readonly TaxFillRow[] = fills;
  for (const row of [...rows].sort(inReadOrder)) {
    const next = pairOne(paired, row);
    if (typeof next === 'string') return next;
    paired = next;
  }
  return paired;
}
