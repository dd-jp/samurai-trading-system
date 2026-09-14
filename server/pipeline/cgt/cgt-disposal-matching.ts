/**
 * #1518 — UK CGT share-identification matching for Samurai's live Saxo GIA
 * equity leg (ADR-0015's 2026-08-26 GIA ruling: disposals on that leg are CGT
 * events, not ISA-exempt). This is a RECORDKEEPING mechanism, not tax advice
 * — see `docs/cgt-disposal-matching.md` for the disclaimer this module's
 * output must always carry.
 *
 * Applies HMRC's statutory share-identification order (TCGA92 ss105-106A, as
 * restated in the CGT manual):
 *   1. Same-day rule (CG51560) — acquisitions and disposals of the same
 *      instrument on the same day are matched with each other first.
 *   2. 30-day "bed and breakfast" rule (CG51560/CG51570) — a disposal's
 *      remainder is matched against acquisitions of the same instrument in
 *      the FOLLOWING 30 days, earliest first.
 *   3. Section 104 pool (CG51575) — whatever is left matches against a
 *      single running average-cost pool of every other acquisition.
 *
 * Pure and side-effect-free: no store, no clock, no I/O. Every date is an
 * input. `server/pipeline/cgt/sqlite-cgt-fill-source.ts` is the store-backed
 * caller.
 */

export const HMRC_SAME_DAY_RULE_CITATION = 'CG51560';
export const HMRC_30_DAY_RULE_CITATION = 'CG51560/CG51570';
export const HMRC_SECTION_104_CITATION = 'CG51575';

/** 2024/25 onward (Autumn Statement 2022 cut) — HMRC "Capital Gains Tax rates and allowances". Not a computed tax figure: this module reports gains, never tax owed (rate depends on the operator's income band). */
export const ANNUAL_EXEMPT_AMOUNT_GBP = 3000;

/**
 * One fill, already classified as an acquisition (an `entry` leg) or a
 * disposal (`stop`/`target`/`exit`) by the caller. `grossAmount` is
 * price × quantity in book currency (GBP); `charges` is the fill's own
 * incidental cost (commission/fee), also GBP — the caller is responsible for
 * refusing a non-GBP `fee_currency` before construction (see
 * `sqlite-cgt-fill-source.ts`), because this module has no FX model and must
 * not silently misprice one.
 */
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

export interface MatchedDisposal {
  instrument: string;
  disposalDate: Date;
  /** The specific matched acquisition's date — same-day/30-day only. A Section 104 match blends many acquisition dates, so it has none. */
  acquisitionDate?: Date;
  quantity: number;
  /** Gross disposal proceeds less this quantity's share of disposal-leg charges. */
  proceeds: number;
  /** Acquisition cost plus this quantity's share of acquisition-leg charges. */
  allowableCost: number;
  gain: number;
  rule: 'same-day' | '30-day' | 'section-104';
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The calendar day a fill's timestamp falls on, as a sortable key.
 *
 * UTC, not Europe/London — deliberately. The LSE trading session is
 * 08:00-16:30 London time and this venue restriction is structural
 * (`tradeableUniverse`, GBP LSE-listed only), so no fill this module ever
 * sees can land in the 00:00-01:00 window where UTC and London-local dates
 * diverge during BST. UTC bucketing is therefore equal to London-calendar
 * bucketing FOR THIS VENUE — a non-LSE venue would break this invariant, so
 * do not reuse this key for one without re-deriving it in Europe/London.
 */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayStart(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MS_PER_DAY) * MS_PER_DAY);
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

/** This lot's current per-share cost/proceeds, averaged over whatever the lot still holds. */
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

/**
 * Matches every disposal fill against its acquisitions, per instrument, in
 * HMRC's statutory order (same-day → 30-day → Section 104 pool). Throws
 * rather than silently under-reporting when a disposal cannot be matched at
 * all — an unmatchable disposal is a data-integrity fault (fills missing
 * upstream, or a short sale this long-only model cannot price), and a wrong
 * gain of zero is worse than a refusal on a document headed for HMRC.
 */
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
  const results: MatchedDisposal[] = [];

  // 1. Same-day (CG51560): pool every acquisition and disposal dated the
  // same day and match the smaller side in full, at that day's average
  // price on each side.
  const acqByKey = new Map(acquisitions.map((lot) => [lot.key, lot]));
  const dispByKey = new Map(disposals.map((lot) => [lot.key, lot]));
  for (const [key, disp] of dispByKey) {
    const acq = acqByKey.get(key);
    if (acq === undefined) continue;
    const matchQty = Math.min(acq.remaining, disp.remaining);
    if (matchQty <= 0) continue;
    const cost = take(acq, matchQty);
    const proceeds = take(disp, matchQty);
    results.push({
      instrument,
      disposalDate: disp.date,
      acquisitionDate: acq.date,
      quantity: matchQty,
      proceeds: proceeds.amount - proceeds.charges,
      allowableCost: cost.amount + cost.charges,
      gain: proceeds.amount - proceeds.charges - (cost.amount + cost.charges),
      rule: 'same-day',
    });
  }

  // 2. 30-day / bed-and-breakfast (CG51560/CG51570): each disposal's
  // remainder, earliest disposal first, against acquisitions strictly AFTER
  // it within 30 days, earliest acquisition first (FIFO) — so an earlier
  // disposal claims a shared re-acquisition ahead of a later one.
  const acqAscending = [...acquisitions].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const disp of disposals) {
    if (disp.remaining <= 0) continue;
    const windowEnd = new Date(disp.date.getTime() + 30 * MS_PER_DAY);
    for (const acq of acqAscending) {
      if (disp.remaining <= 0) break;
      if (acq.remaining <= 0) continue;
      if (acq.date.getTime() <= disp.date.getTime()) continue; // strictly AFTER — direction matters
      if (acq.date.getTime() > windowEnd.getTime()) continue;
      const matchQty = Math.min(acq.remaining, disp.remaining);
      const cost = take(acq, matchQty);
      const proceeds = take(disp, matchQty);
      results.push({
        instrument,
        disposalDate: disp.date,
        acquisitionDate: acq.date,
        quantity: matchQty,
        proceeds: proceeds.amount - proceeds.charges,
        allowableCost: cost.amount + cost.charges,
        gain: proceeds.amount - proceeds.charges - (cost.amount + cost.charges),
        rule: '30-day',
      });
    }
  }

  // 3. Section 104 pool (CG51575): everything same-day and 30-day matching
  // left untouched, processed in strict chronological order as one running
  // average-cost pool. An acquisition always tops the pool up; a disposal
  // always draws from it — same-day/30-day resolution above guarantees no
  // day's lot has remaining quantity on BOTH sides, so there is no ordering
  // ambiguity to resolve on a tied date.
  type PoolEvent = { date: Date; kind: 'acquisition' | 'disposal'; lot: DayLot };
  const events: PoolEvent[] = [
    ...acquisitions
      .filter((lot) => lot.remaining > 0)
      .map((lot) => ({ date: lot.date, kind: 'acquisition' as const, lot })),
    ...disposals
      .filter((lot) => lot.remaining > 0)
      .map((lot) => ({ date: lot.date, kind: 'disposal' as const, lot })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  let poolQty = 0;
  let poolCost = 0;
  for (const event of events) {
    if (event.kind === 'acquisition') {
      const qty = event.lot.remaining;
      if (qty <= 0) continue;
      const { amount, charges } = take(event.lot, qty);
      poolQty += qty;
      poolCost += amount + charges;
    } else {
      const qty = event.lot.remaining;
      if (qty <= 0) continue;
      if (poolQty + 1e-9 < qty) {
        throw new Error(
          `CGT: Section 104 pool for ${instrument} holds ${poolQty} shares but a disposal on ` +
            `${event.lot.date.toISOString().slice(0, 10)} needs ${qty} — the fill history under-records ` +
            `acquisitions for this instrument (${HMRC_SECTION_104_CITATION}).`,
        );
      }
      const avgCost = poolCost / poolQty;
      const cost = avgCost * qty;
      poolQty -= qty;
      poolCost -= cost;
      const { amount, charges } = take(event.lot, qty);
      results.push({
        instrument,
        disposalDate: event.lot.date,
        quantity: qty,
        proceeds: amount - charges,
        allowableCost: cost,
        gain: amount - charges - cost,
        rule: 'section-104',
      });
    }
  }

  return results;
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

/** '2025-26' for any date from 6 Apr 2025 up to (not including) 6 Apr 2026. */
export function ukTaxYearLabel(date: Date): string {
  const bounds = ukTaxYearBounds(date.getUTCFullYear());
  const startYear =
    date.getTime() >= bounds.from.getTime() ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Half-open `[6 Apr startYear, 6 Apr startYear+1)`, UTC — see `dayKey`'s doc for why UTC is London-calendar-correct on this LSE-only venue. */
export function ukTaxYearBounds(startYear: number): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(startYear, 3, 6)),
    to: new Date(Date.UTC(startYear + 1, 3, 6)),
  };
}

/**
 * Every already-matched disposal whose date falls in the given UK tax year.
 * Matching itself (`matchDisposals`) must run over the FULL fill history
 * first — the Section 104 pool and the 30-day rule both need acquisitions
 * outside the reported year to price a disposal inside it correctly.
 */
export function cgtReportForTaxYear(
  disposals: readonly MatchedDisposal[],
  startYear: number,
): CgtTaxYearReport {
  const { from, to } = ukTaxYearBounds(startYear);
  const inYear = disposals
    .filter(
      (d) => d.disposalDate.getTime() >= from.getTime() && d.disposalDate.getTime() < to.getTime(),
    )
    .sort((a, b) => a.disposalDate.getTime() - b.disposalDate.getTime());

  return {
    taxYear: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
    from,
    to,
    disposals: inYear,
    totalProceeds: inYear.reduce((sum, d) => sum + d.proceeds, 0),
    totalAllowableCost: inYear.reduce((sum, d) => sum + d.allowableCost, 0),
    totalGain: inYear.reduce((sum, d) => sum + d.gain, 0),
    annualExemptAmountGbp: ANNUAL_EXEMPT_AMOUNT_GBP,
  };
}
