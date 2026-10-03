import type {
  TaxDisposalWire,
  TaxHeldOutWire,
  TaxLogWire,
  Venue,
} from '../../../contracts/index.js';
import { addDays, isCfdVenue } from './data/index.js';
import {
  type MatchLeg,
  matchShares,
  type ShareMatch,
  THIRTY_DAY_WINDOW_DAYS,
} from './share-matching.js';
import { type TaxCashInLieuRow, withBrokerCashInLieu } from './tax-cash-in-lieu.js';

export interface TaxFillRow {
  readonly fill_id: string;
  readonly instrument: string;
  readonly venue: string;
  readonly leg: string;
  readonly side: string;
  readonly qty: number;
  readonly trading_date: string;
  readonly fill_date: string | null;
  readonly currency: string | null;
  readonly price_native: number | null;
  readonly fee_native: number | null;
  readonly cash_in_lieu_activity?: string | null | undefined;
}

export interface TaxSplitRow {
  readonly instrument: string;
  readonly split_date: string;
  readonly ratio: number;
}

export type RateLookup =
  | { readonly ok: true; readonly quotePerGbp: number; readonly source: string }
  | { readonly ok: false; readonly reason: string };

export type DayRate = (currency: string, date: string) => RateLookup;

export interface HeldOutInstrument extends TaxHeldOutWire {
  readonly taxYears: readonly number[];
}

export interface TaxLog {
  readonly disposals: readonly TaxDisposalWire[];
  readonly heldOut: readonly HeldOutInstrument[];
}

function ascending(years: readonly number[]): number[] {
  return [...new Set(years)].sort((a, b) => a - b);
}

export function taxYearOf(date: string): number {
  const year = Number(date.slice(0, 4));
  return date.slice(5) >= '04-06' ? year : year - 1;
}

interface ConvertedFill {
  readonly fill: TaxFillRow;
  readonly date: string;
  readonly currency: string;
  readonly rate: { readonly quotePerGbp: number; readonly source: string };
  readonly unitFactor: number;
}

type Conversion =
  | { readonly ok: true; readonly converted: ConvertedFill }
  | { readonly ok: false; readonly reason: string };

function unitFactor(splits: readonly TaxSplitRow[], date: string): number {
  return splits.filter((split) => split.split_date > date).reduce((f, s) => f * s.ratio, 1);
}

function fillDateOf(fill: TaxFillRow): string {
  return fill.fill_date ?? fill.trading_date;
}

function convert(fill: TaxFillRow, splits: readonly TaxSplitRow[], dayRate: DayRate): Conversion {
  if (fill.currency === null || fill.price_native === null || fill.fee_native === null) {
    return {
      ok: false,
      reason: `fill ${fill.fill_id} predates native price and FX capture (migration 0085)`,
    };
  }
  const date = fillDateOf(fill);
  const rate = dayRate(fill.currency, date);
  if (!rate.ok) return { ok: false, reason: `fill ${fill.fill_id}: ${rate.reason}` };
  return {
    ok: true,
    converted: { fill, date, currency: fill.currency, rate, unitFactor: unitFactor(splits, date) },
  };
}

function legOf({ fill, date, rate, unitFactor: factor }: ConvertedFill): MatchLeg {
  return {
    kind: fill.side === 'buy' ? 'acquisition' : 'disposal',
    date,
    qty: fill.qty * factor,
    amountGbp: (fill.qty * (fill.price_native as number)) / rate.quotePerGbp,
    chargesGbp: (fill.fee_native as number) / rate.quotePerGbp,
  };
}

function heldOut(fills: readonly TaxFillRow[], reason: string): HeldOutInstrument {
  const first = fills[0] as TaxFillRow;
  return {
    instrument: first.instrument,
    venue: first.venue,
    reason,
    fills: fills.length,
    taxYears: ascending(fills.map((fill) => taxYearOf(fillDateOf(fill)))),
  };
}

function cashInLieuActivity(days: readonly ConvertedFill[]): string | null {
  const activities = days.flatMap((day) => day.fill.cash_in_lieu_activity ?? []);
  return activities.length === 0 ? null : [...new Set(activities)].join(' ');
}

function toDisposal(
  match: ShareMatch,
  day: ConvertedFill,
  days: readonly ConvertedFill[],
  asOf: string,
) {
  const proceeds = match.proceedsGbp;
  return {
    disposal_date: match.disposalDate,
    instrument: day.fill.instrument,
    venue: day.fill.venue,
    qty: match.qty / day.unitFactor,
    proceeds_gbp: proceeds,
    cost_gbp: match.costGbp,
    gain_gbp: proceeds - match.costGbp,
    rule: match.rule,
    acquisition_date: match.acquisitionDate,
    currency: day.currency,
    fx_quote_per_gbp: day.rate.quotePerGbp,
    fx_source: day.rate.source,
    provisional:
      match.rule === 'section-104' && addDays(match.disposalDate, THIRTY_DAY_WINDOW_DAYS) >= asOf,
    cash_in_lieu: days.some((fill) => fill.fill.leg === 'cash_in_lieu'),
    cash_in_lieu_activity: cashInLieuActivity(days),
  } satisfies TaxDisposalWire;
}

function disposalsOf(
  converted: readonly ConvertedFill[],
  matches: readonly ShareMatch[],
  asOf: string,
): TaxDisposalWire[] {
  const sells = converted.filter((fill) => fill.fill.side !== 'buy');
  return matches.map((match) => {
    const days = sells.filter((fill) => fill.date === match.disposalDate);
    return toDisposal(match, days[0] as ConvertedFill, days, asOf);
  });
}

type InstrumentLog =
  | { readonly ok: true; readonly disposals: readonly TaxDisposalWire[] }
  | { readonly ok: false; readonly heldOut: HeldOutInstrument };

function logInstrument(
  fills: readonly TaxFillRow[],
  splits: readonly TaxSplitRow[],
  dayRate: DayRate,
  asOf: string,
): InstrumentLog {
  const conversions = fills.map((fill) => convert(fill, splits, dayRate));
  const failed = conversions.flatMap((conversion) => (conversion.ok ? [] : [conversion.reason]));
  if (failed.length > 0) {
    const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : '';
    return { ok: false, heldOut: heldOut(fills, `${failed[0]}${more}`) };
  }
  const converted = conversions.map(
    (conversion) => (conversion as { converted: ConvertedFill }).converted,
  );
  const currencies = new Set(converted.map((fill) => fill.currency));
  if (currencies.size > 1) {
    return {
      ok: false,
      heldOut: heldOut(fills, `fills in more than one currency: ${[...currencies].join(', ')}`),
    };
  }
  const outcome = matchShares(converted.map(legOf));
  if (!outcome.ok) return { ok: false, heldOut: heldOut(fills, outcome.reason) };
  return { ok: true, disposals: disposalsOf(converted, outcome.matches, asOf) };
}

// A split is journalled once per venue holding the name; its ratio counts once per date
function distinctSplits(splits: readonly TaxSplitRow[]): readonly TaxSplitRow[] | string {
  const byDate = new Map<string, TaxSplitRow>();
  for (const split of splits) {
    const seen = byDate.get(split.split_date);
    if (seen !== undefined && seen.ratio !== split.ratio) {
      return `split on ${split.split_date} journalled at ratios ${seen.ratio} and ${split.ratio}`;
    }
    byDate.set(split.split_date, split);
  }
  return [...byDate.values()];
}

interface InstrumentJournal {
  readonly fills: readonly TaxFillRow[];
  readonly splits: readonly TaxSplitRow[];
  readonly cashInLieu: readonly TaxCashInLieuRow[];
}

function logGroup(journal: InstrumentJournal, dayRate: DayRate, asOf: string): InstrumentLog {
  const { fills } = journal;
  const distinct = distinctSplits(journal.splits);
  if (typeof distinct === 'string') return { ok: false, heldOut: heldOut(fills, distinct) };
  const paid = withBrokerCashInLieu(fills, journal.cashInLieu);
  if (typeof paid === 'string') return { ok: false, heldOut: heldOut(fills, paid) };
  return logInstrument(paid, distinct, dayRate, asOf);
}

function unpairedCashInLieu(rows: readonly TaxCashInLieuRow[]): HeldOutInstrument {
  const first = rows[0] as TaxCashInLieuRow;
  return {
    instrument: first.instrument,
    venue: first.venue,
    reason: `broker cash in lieu ${first.venue}:${first.activity_id} on ${first.activity_date} for a name with no fills`,
    fills: 0,
    taxYears: ascending(rows.map((row) => taxYearOf(row.activity_date))),
  };
}

function byInstrument<T extends { readonly instrument: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(row.instrument, [...(groups.get(row.instrument) ?? []), row]);
  return groups;
}

function grouped(
  fills: readonly TaxFillRow[],
  splits: readonly TaxSplitRow[],
  cashInLieu: readonly TaxCashInLieuRow[],
): InstrumentJournal[] {
  const splitsOf = byInstrument(splits);
  const cashInLieuOf = byInstrument(cashInLieu.filter((row) => !isCfdVenue(row.venue as Venue)));
  const shares = byInstrument(fills.filter((fill) => !isCfdVenue(fill.venue as Venue)));
  return [...shares].map(([instrument, group]) => ({
    fills: group,
    splits: splitsOf.get(instrument) ?? [],
    cashInLieu: cashInLieuOf.get(instrument) ?? [],
  }));
}

function unpairedByInstrument(
  fills: readonly TaxFillRow[],
  cashInLieu: readonly TaxCashInLieuRow[],
): HeldOutInstrument[] {
  const held = new Set(
    fills.filter((fill) => !isCfdVenue(fill.venue as Venue)).map((fill) => fill.instrument),
  );
  const orphans = cashInLieu.filter(
    (row) => !isCfdVenue(row.venue as Venue) && !held.has(row.instrument),
  );
  return [...byInstrument(orphans).values()].map(unpairedCashInLieu);
}

export function buildTaxLog(
  fills: readonly TaxFillRow[],
  splits: readonly TaxSplitRow[],
  dayRate: DayRate,
  asOf: string,
  cashInLieu: readonly TaxCashInLieuRow[] = [],
): TaxLog {
  const disposals: TaxDisposalWire[] = [];
  const held: HeldOutInstrument[] = [];
  for (const journal of grouped(fills, splits, cashInLieu)) {
    const log = logGroup(journal, dayRate, asOf);
    if (log.ok) disposals.push(...log.disposals);
    else held.push(log.heldOut);
  }
  held.push(...unpairedByInstrument(fills, cashInLieu));
  disposals.sort(
    (a, b) =>
      a.disposal_date.localeCompare(b.disposal_date) || a.instrument.localeCompare(b.instrument),
  );
  return { disposals, heldOut: held.sort((a, b) => a.instrument.localeCompare(b.instrument)) };
}

export function taxYearsOf(log: TaxLog): number[] {
  return ascending([
    ...log.disposals.map((disposal) => taxYearOf(disposal.disposal_date)),
    ...log.heldOut.flatMap((held) => held.taxYears),
  ]);
}

export function taxYearLog(log: TaxLog, year: number): TaxLogWire {
  const rows = log.disposals.filter((disposal) => taxYearOf(disposal.disposal_date) === year);
  const sum = (field: 'proceeds_gbp' | 'cost_gbp' | 'gain_gbp') =>
    rows.reduce((total, row) => total + row[field], 0);
  return {
    rows,
    held_out: log.heldOut
      .filter((held) => held.taxYears.includes(year))
      .map(({ taxYears: _years, ...held }) => held),
    proceeds_gbp: sum('proceeds_gbp'),
    cost_gbp: sum('cost_gbp'),
    gain_gbp: sum('gain_gbp'),
  };
}
