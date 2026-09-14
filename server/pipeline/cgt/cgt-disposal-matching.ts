/**
 * #1518 — UK CGT share-identification matching for Samurai's live Saxo GIA
 * equity leg. David's 2026-08-26 GIA ruling, recorded in ADR-0015's
 * 2026-08-30 amendment: disposals on that leg are CGT events, not
 * ISA-exempt. This is a RECORDKEEPING mechanism, not tax advice — see
 * `docs/cgt-disposal-matching.md` for the disclaimer this module's output
 * must always carry.
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

/** The earliest UK tax year `ANNUAL_EXEMPT_AMOUNT_GBP` is sourced for — an earlier year used a different (undocumented here) Annual Exempt Amount. */
export const ANNUAL_EXEMPT_AMOUNT_SOURCED_FROM_TAX_YEAR = 2024;

/**
 * Refuses a tax year this module has no sourced Annual Exempt Amount for,
 * rather than printing `ANNUAL_EXEMPT_AMOUNT_GBP` under a year it may not
 * apply to — the same refuse-rather-than-mis-report posture as the Section
 * 104 pool's insufficient-pool guard below.
 */
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

/**
 * One fill, already classified as an acquisition (an `entry` leg) or a
 * disposal (`stop`/`target`/`exit`) by the caller. `grossAmount` is
 * price × quantity in GBP; `charges` is the fill's own incidental cost
 * (commission/fee), also GBP — the caller is responsible for converting a
 * GBX (pence) figure and setting aside anything it cannot price in sterling
 * before construction (see `sqlite-cgt-fill-source.ts`), because this module
 * has no FX model and must not silently misprice a foreign-currency fill.
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

/**
 * A fill the caller could not price in sterling — its `fee_currency` (which
 * also names the currency `grossAmount`/`charges` are denominated in, see
 * `sqlite-cgt-fill-source.ts`) is neither GBP nor GBX, and this module has no
 * FX rate to convert it with. Carried in native currency so the report can
 * name exactly what is missing rather than guess or drop it silently.
 */
export interface UnconvertedCgtFill {
  instrument: string;
  kind: 'acquisition' | 'disposal';
  date: Date;
  quantity: number;
  grossAmount: number;
  charges: number;
  currency: string;
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

/** The 30-day rule's window (CG51560/CG51570) — also used to flag a disposal as still provisional (see `disposalStillInThirtyDayWindow`). */
export const THIRTY_DAY_WINDOW_MS = 30 * MS_PER_DAY;

/**
 * True while a disposal's 30-day bed-and-breakfast window is still open as of
 * `asOf` — an acquisition of the same instrument arriving before the window
 * closes would still reclassify this disposal from `section-104` to `30-day`
 * (or change which acquisition a `30-day` match already used), so a report
 * run inside the window is provisional for that disposal. Inclusive of the
 * boundary day itself, matching the matcher's own `<=` window-end check.
 */
export function disposalStillInThirtyDayWindow(disposalDate: Date, asOf: Date): boolean {
  return asOf.getTime() <= disposalDate.getTime() + THIRTY_DAY_WINDOW_MS;
}

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

/** Derived from `dayKey`, not computed independently — a `MatchedDisposal.disposalDate` that disagreed with the day `dayKey` grouped it under would misfile a disposal into the wrong tax year with no test able to see the two had drifted apart. */
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

/** This day-lot's per-share cost/proceeds, averaged over its ORIGINAL quantity — `take()` only decrements `remaining`, never `quantity`, so every partial take prices at the same day-average, not a shrinking one. */
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

/** Same-day rule (CG51560): pool every acquisition and disposal dated the same day and match the smaller side in full, at that day's average price on each side. */
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

/**
 * 30-day / bed-and-breakfast rule (CG51560/CG51570): each disposal's
 * remainder, earliest disposal first, against acquisitions strictly AFTER it
 * within 30 days, earliest acquisition first (FIFO) — so an earlier disposal
 * claims a shared re-acquisition ahead of a later one.
 */
function matchThirtyDay(
  instrument: string,
  acquisitions: readonly DayLot[],
  disposals: readonly DayLot[],
): MatchedDisposal[] {
  const results: MatchedDisposal[] = [];
  // `acquisitions` already arrives sorted ascending by date (`toDayLots`) —
  // no re-sort needed.
  for (const disp of disposals) {
    if (disp.remaining <= 0) continue;
    const windowEnd = new Date(disp.date.getTime() + THIRTY_DAY_WINDOW_MS);
    for (const acq of acquisitions) {
      if (disp.remaining <= 0) break;
      if (acq.remaining <= 0) continue;
      if (acq.date.getTime() <= disp.date.getTime()) continue; // strictly AFTER — direction matters
      if (acq.date.getTime() > windowEnd.getTime()) continue; // inclusive of the +30 boundary itself
      const matchQty = Math.min(acq.remaining, disp.remaining);
      const cost = take(acq, matchQty);
      const proceeds = take(disp, matchQty);
      results.push(buildMatch(instrument, disp.date, acq.date, matchQty, proceeds, cost, '30-day'));
    }
  }
  return results;
}

/**
 * Section 104 pool (CG51575): everything same-day and 30-day matching left
 * untouched, processed in strict chronological order as one running
 * average-cost pool. An acquisition always tops the pool up; a disposal
 * always draws from it — same-day/30-day resolution above guarantees no
 * day's lot has remaining quantity on BOTH sides, so there is no ordering
 * ambiguity to resolve on a tied date.
 */
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
      const proceeds = take(event.lot, qty);
      results.push(
        buildMatch(
          instrument,
          event.lot.date,
          undefined,
          qty,
          proceeds,
          { amount: cost, charges: 0 }, // `cost` is already the pooled average cost — no separate charges to add
          'section-104',
        ),
      );
    }
  }
  return results;
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

/** '2025-26' for a tax year starting 6 Apr `startYear`. The one place this format is built — `ukTaxYearLabel`, `cgtReportForTaxYear` and `report-cgt-disposals.ts`'s `--tax-year` validation all derive from it rather than recomputing the same string three ways. */
export function taxYearLabelForStartYear(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** '2025-26' for any date from 6 Apr 2025 up to (not including) 6 Apr 2026. */
export function ukTaxYearLabel(date: Date): string {
  const bounds = ukTaxYearBounds(date.getUTCFullYear());
  const startYear =
    date.getTime() >= bounds.from.getTime() ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return taxYearLabelForStartYear(startYear);
}

/** Half-open `[6 Apr startYear, 6 Apr startYear+1)`, UTC — see `dayKey`'s doc for why UTC is London-calendar-correct on this LSE-only venue. */
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

/**
 * Every already-matched disposal whose date falls in the given UK tax year.
 * Matching itself (`matchDisposals`) must run over the FULL fill history
 * first — the Section 104 pool and the 30-day rule both need acquisitions
 * outside the reported year to price a disposal inside it correctly.
 *
 * Refuses a year `ANNUAL_EXEMPT_AMOUNT_GBP` is not sourced for (see
 * `assertTaxYearIsSourced`) rather than printing that figure under a year it
 * may not apply to.
 */
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

/** The subset of `unconverted` (see `UnconvertedCgtFill`) whose fill date falls in the given UK tax year — same windowing `cgtReportForTaxYear` applies to matched disposals, so the report's two sections cover the same period. */
export function unconvertedCgtFillsInTaxYear(
  unconverted: readonly UnconvertedCgtFill[],
  startYear: number,
): UnconvertedCgtFill[] {
  return inTaxYear(unconverted, startYear, (f) => f.date);
}
