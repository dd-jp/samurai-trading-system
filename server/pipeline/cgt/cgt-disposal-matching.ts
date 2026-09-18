export const HMRC_SAME_DAY_RULE_CITATION = 'CG51560';
export const HMRC_30_DAY_RULE_CITATION = 'CG51560/CG51570';
export const HMRC_SECTION_104_CITATION = 'CG51575';

export const ANNUAL_EXEMPT_AMOUNT_GBP = 3000;

export const ANNUAL_EXEMPT_AMOUNT_SOURCED_FROM_TAX_YEAR = 2024;

export function assertTaxYearIsSourced(startYear: number): void {
  if (startYear < ANNUAL_EXEMPT_AMOUNT_SOURCED_FROM_TAX_YEAR) {
    throw new Error(
      `CGT: tax year ${taxYearLabelForStartYear(startYear)} is before ${ANNUAL_EXEMPT_AMOUNT_SOURCED_FROM_TAX_YEAR}` +
        `/${String((ANNUAL_EXEMPT_AMOUNT_SOURCED_FROM_TAX_YEAR + 1) % 100).padStart(2, '0')} — ` +
        `ANNUAL_EXEMPT_AMOUNT_GBP (£${ANNUAL_EXEMPT_AMOUNT_GBP}) is only sourced from that year onward, ` +
        'and an earlier year used a different Annual Exempt Amount this report does not have on file.',
    );
  }
}

export interface CgtFillLeg {
  instrument: string;
  kind: 'acquisition' | 'disposal';
  date: Date;
  quantity: number;
  grossAmount: number;
  charges: number;
  idempotency_key: string;
  broker_fill_id: string;
}

export interface UnconvertedCgtFill {
  instrument: string;
  kind: 'acquisition' | 'disposal';
  date: Date;
  quantity: number;
  grossAmount: number;
  charges: number;
  currency: string;
  fxRateToGbpSource: string;
  idempotency_key: string;
  broker_fill_id: string;
}

export interface MatchedDisposal {
  instrument: string;
  disposalDate: Date;
  acquisitionDate?: Date;
  quantity: number;
  proceeds: number;
  allowableCost: number;
  gain: number;
  rule: 'same-day' | '30-day' | 'section-104';
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const THIRTY_DAY_WINDOW_MS = 30 * MS_PER_DAY;

export function disposalStillInThirtyDayWindow(disposalDate: Date, asOf: Date): boolean {
  return asOf.getTime() <= disposalDate.getTime() + THIRTY_DAY_WINDOW_MS;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayStart(date: Date): Date {
  return new Date(`${dayKey(date)}T00:00:00.000Z`);
}

interface DayLot {
  key: string;
  date: Date;
  quantity: number;
  totalAmount: number;
  totalCharges: number;
  remaining: number;
}

function toDayLots(fills: readonly CgtFillLeg[]): DayLot[] {
  const byDay = new Map<string, DayLot>();
  for (const fill of fills) {
    const key = dayKey(fill.date);
    const existing = byDay.get(key);
    if (existing === undefined) {
      byDay.set(key, {
        key,
        date: dayStart(fill.date),
        quantity: fill.quantity,
        totalAmount: fill.grossAmount,
        totalCharges: fill.charges,
        remaining: fill.quantity,
      });
    } else {
      existing.quantity += fill.quantity;
      existing.totalAmount += fill.grossAmount;
      existing.totalCharges += fill.charges;
      existing.remaining += fill.quantity;
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function unitAmount(lot: DayLot): number {
  return lot.totalAmount / lot.quantity;
}
function unitCharge(lot: DayLot): number {
  return lot.totalCharges / lot.quantity;
}

function take(lot: DayLot, quantity: number): { amount: number; charges: number } {
  const amount = unitAmount(lot) * quantity;
  const charges = unitCharge(lot) * quantity;
  lot.remaining -= quantity;
  return { amount, charges };
}

function buildMatch(
  instrument: string,
  disposalDate: Date,
  acquisitionDate: Date | undefined,
  quantity: number,
  proceeds: { amount: number; charges: number },
  cost: { amount: number; charges: number },
  rule: MatchedDisposal['rule'],
): MatchedDisposal {
  const netProceeds = proceeds.amount - proceeds.charges;
  const allowableCost = cost.amount + cost.charges;
  return {
    instrument,
    disposalDate,
    ...(acquisitionDate === undefined ? {} : { acquisitionDate }),
    quantity,
    proceeds: netProceeds,
    allowableCost,
    gain: netProceeds - allowableCost,
    rule,
  };
}

function matchSameDay(
  instrument: string,
  acquisitions: readonly DayLot[],
  disposals: readonly DayLot[],
): MatchedDisposal[] {
  const acqByKey = new Map(acquisitions.map((lot) => [lot.key, lot]));
  const results: MatchedDisposal[] = [];
  for (const disp of disposals) {
    const acq = acqByKey.get(disp.key);
    if (acq === undefined) continue;
    const matchQty = Math.min(acq.remaining, disp.remaining);
    if (matchQty <= 0) continue;
    const cost = take(acq, matchQty);
    const proceeds = take(disp, matchQty);
    results.push(buildMatch(instrument, disp.date, acq.date, matchQty, proceeds, cost, 'same-day'));
  }
  return results;
}

function matchDisposalWithinThirtyDayWindow(
  instrument: string,
  disp: DayLot,
  acquisitions: readonly DayLot[],
  windowEnd: Date,
): MatchedDisposal[] {
  const results: MatchedDisposal[] = [];
  for (const acq of acquisitions) {
    if (disp.remaining <= 0) break;
    if (acq.remaining <= 0) continue;
    if (acq.date.getTime() <= disp.date.getTime()) continue;
    if (acq.date.getTime() > windowEnd.getTime()) continue;
    const matchQty = Math.min(acq.remaining, disp.remaining);
    const cost = take(acq, matchQty);
    const proceeds = take(disp, matchQty);
    results.push(buildMatch(instrument, disp.date, acq.date, matchQty, proceeds, cost, '30-day'));
  }
  return results;
}

function matchThirtyDay(
  instrument: string,
  acquisitions: readonly DayLot[],
  disposals: readonly DayLot[],
): MatchedDisposal[] {
  const results: MatchedDisposal[] = [];
  for (const disp of disposals) {
    if (disp.remaining <= 0) continue;
    const windowEnd = new Date(disp.date.getTime() + THIRTY_DAY_WINDOW_MS);
    results.push(...matchDisposalWithinThirtyDayWindow(instrument, disp, acquisitions, windowEnd));
  }
  return results;
}

interface Section104Pool {
  qty: number;
  cost: number;
}

function applyAcquisitionToPool(pool: Section104Pool, lot: DayLot): void {
  const qty = lot.remaining;
  if (qty <= 0) return;
  const { amount, charges } = take(lot, qty);
  pool.qty += qty;
  pool.cost += amount + charges;
}

function applyDisposalToPool(
  instrument: string,
  pool: Section104Pool,
  lot: DayLot,
): MatchedDisposal | undefined {
  const qty = lot.remaining;
  if (qty <= 0) return undefined;
  if (pool.qty + 1e-9 < qty) {
    throw new Error(
      `CGT: Section 104 pool for ${instrument} holds ${pool.qty} shares but a disposal on ` +
        `${lot.date.toISOString().slice(0, 10)} needs ${qty} — the fill history under-records ` +
        `acquisitions for this instrument (${HMRC_SECTION_104_CITATION}).`,
    );
  }
  const avgCost = pool.cost / pool.qty;
  const cost = avgCost * qty;
  pool.qty -= qty;
  pool.cost -= cost;
  const proceeds = take(lot, qty);
  return buildMatch(
    instrument,
    lot.date,
    undefined,
    qty,
    proceeds,
    { amount: cost, charges: 0 },
    'section-104',
  );
}

function matchSection104Pool(
  instrument: string,
  acquisitions: readonly DayLot[],
  disposals: readonly DayLot[],
): MatchedDisposal[] {
  const results: MatchedDisposal[] = [];
  type PoolEvent = { date: Date; kind: 'acquisition' | 'disposal'; lot: DayLot };
  const events: PoolEvent[] = [
    ...acquisitions
      .filter((lot) => lot.remaining > 0)
      .map((lot) => ({ date: lot.date, kind: 'acquisition' as const, lot })),
    ...disposals
      .filter((lot) => lot.remaining > 0)
      .map((lot) => ({ date: lot.date, kind: 'disposal' as const, lot })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  const pool: Section104Pool = { qty: 0, cost: 0 };
  for (const event of events) {
    if (event.kind === 'acquisition') {
      applyAcquisitionToPool(pool, event.lot);
    } else {
      const matched = applyDisposalToPool(instrument, pool, event.lot);
      if (matched !== undefined) results.push(matched);
    }
  }
  return results;
}

export function matchDisposals(fills: readonly CgtFillLeg[]): MatchedDisposal[] {
  const byInstrument = new Map<string, CgtFillLeg[]>();
  for (const fill of fills) {
    if (!(fill.quantity > 0)) {
      throw new Error(
        `CGT: fill ${fill.idempotency_key}/${fill.broker_fill_id} has non-positive quantity.`,
      );
    }
    const list = byInstrument.get(fill.instrument) ?? [];
    list.push(fill);
    byInstrument.set(fill.instrument, list);
  }

  const matched: MatchedDisposal[] = [];
  for (const [instrument, instrumentFills] of byInstrument) {
    matched.push(...matchInstrument(instrument, instrumentFills));
  }
  matched.sort((a, b) => a.disposalDate.getTime() - b.disposalDate.getTime());
  return matched;
}

function matchInstrument(instrument: string, fills: readonly CgtFillLeg[]): MatchedDisposal[] {
  const acquisitions = toDayLots(fills.filter((f) => f.kind === 'acquisition'));
  const disposals = toDayLots(fills.filter((f) => f.kind === 'disposal'));

  return [
    ...matchSameDay(instrument, acquisitions, disposals),
    ...matchThirtyDay(instrument, acquisitions, disposals),
    ...matchSection104Pool(instrument, acquisitions, disposals),
  ];
}

export interface CgtTaxYearReport {
  taxYear: string;
  from: Date;
  to: Date;
  disposals: MatchedDisposal[];
  totalProceeds: number;
  totalAllowableCost: number;
  totalGain: number;
  annualExemptAmountGbp: number;
}

export function taxYearLabelForStartYear(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function ukTaxYearLabel(date: Date): string {
  const bounds = ukTaxYearBounds(date.getUTCFullYear());
  const startYear =
    date.getTime() >= bounds.from.getTime() ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return taxYearLabelForStartYear(startYear);
}

export function ukTaxYearBounds(startYear: number): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(startYear, 3, 6)),
    to: new Date(Date.UTC(startYear + 1, 3, 6)),
  };
}

function inTaxYear<T>(rows: readonly T[], startYear: number, dateOf: (row: T) => Date): T[] {
  const { from, to } = ukTaxYearBounds(startYear);
  return rows
    .filter(
      (row) => dateOf(row).getTime() >= from.getTime() && dateOf(row).getTime() < to.getTime(),
    )
    .sort((a, b) => dateOf(a).getTime() - dateOf(b).getTime());
}

export function cgtReportForTaxYear(
  disposals: readonly MatchedDisposal[],
  startYear: number,
): CgtTaxYearReport {
  assertTaxYearIsSourced(startYear);
  const { from, to } = ukTaxYearBounds(startYear);
  const inYear = inTaxYear(disposals, startYear, (d) => d.disposalDate);

  return {
    taxYear: taxYearLabelForStartYear(startYear),
    from,
    to,
    disposals: inYear,
    totalProceeds: inYear.reduce((sum, d) => sum + d.proceeds, 0),
    totalAllowableCost: inYear.reduce((sum, d) => sum + d.allowableCost, 0),
    totalGain: inYear.reduce((sum, d) => sum + d.gain, 0),
    annualExemptAmountGbp: ANNUAL_EXEMPT_AMOUNT_GBP,
  };
}

export function unconvertedCgtFillsInTaxYear(
  unconverted: readonly UnconvertedCgtFill[],
  startYear: number,
): UnconvertedCgtFill[] {
  return inTaxYear(unconverted, startYear, (f) => f.date);
}
