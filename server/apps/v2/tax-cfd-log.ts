import type {
  TaxCfdDisposalWire,
  TaxCfdLogWire,
  TaxHeldOutWire,
  Venue,
} from '../../../contracts/index.js';
import { isCfdVenue } from './data/index.js';
import {
  type DayRate,
  type HeldOutInstrument,
  type TaxFillRow,
  type TaxSplitRow,
  taxYearOf,
  taxYearsOfDates,
} from './tax-log.js';

export interface TaxCfdFillRow extends TaxFillRow {
  readonly book_id: string;
  readonly client_order_id: string;
}

export interface TaxCfdCarryRow {
  readonly book_id: string;
  readonly trading_date: string;
  readonly instrument: string;
  readonly client_order_id: string;
  readonly financing_gbp: number;
  readonly borrow_gbp: number;
}

export interface TaxCfdBookDayRow {
  readonly book_id: string;
  readonly trading_date: string;
  readonly financing_gbp: number;
  readonly borrow_gbp: number;
}

export interface CfdTaxJournal {
  readonly fills: readonly TaxCfdFillRow[];
  readonly carry: readonly TaxCfdCarryRow[];
  readonly bookDays: readonly TaxCfdBookDayRow[];
  readonly splits: readonly TaxSplitRow[];
}

export interface CfdTaxLog {
  readonly disposals: readonly TaxCfdDisposalWire[];
  readonly heldOut: readonly HeldOutInstrument[];
}

const FLAT_EPSILON = 1e-9;
const CARRY_EPSILON = 1e-9;

interface CfdLeg {
  readonly fill: TaxCfdFillRow;
  readonly date: string;
  readonly signedQty: number;
  readonly valueNative: number;
  readonly valueGbp: number;
  readonly feeGbp: number;
  readonly source: string;
}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function legOf(fill: TaxCfdFillRow, dayRate: DayRate): Outcome<CfdLeg> {
  if (fill.currency === null || fill.price_native === null || fill.fee_native === null) {
    return {
      ok: false,
      reason: `fill ${fill.fill_id} predates native price and FX capture (migration 0085)`,
    };
  }
  const date = fill.fill_date ?? fill.trading_date;
  const rate = dayRate(fill.currency, date);
  if (!rate.ok) return { ok: false, reason: `fill ${fill.fill_id}: ${rate.reason}` };
  const valueNative = fill.qty * fill.price_native;
  return {
    ok: true,
    value: {
      fill,
      date,
      signedQty: fill.side === 'buy' ? fill.qty : -fill.qty,
      valueNative,
      valueGbp: valueNative / rate.quotePerGbp,
      feeGbp: fill.fee_native / rate.quotePerGbp,
      source: rate.source,
    },
  };
}

function cyclesOf(legs: readonly CfdLeg[]): Outcome<CfdLeg[][]> {
  const cycles: CfdLeg[][] = [];
  let open: CfdLeg[] = [];
  let held = 0;
  for (const leg of legs) {
    const sum = held + leg.signedQty;
    const next = Math.abs(sum) < FLAT_EPSILON ? 0 : sum;
    if (held * next < 0) {
      return { ok: false, reason: `fill ${leg.fill.fill_id} crosses the position through flat` };
    }
    open.push(leg);
    held = next;
    if (held === 0) {
      cycles.push(open);
      open = [];
    }
  }
  return { ok: true, value: cycles };
}

function sumOf<T>(rows: readonly T[], value: (row: T) => number): number {
  return rows.reduce((total, row) => total + value(row), 0);
}

function distinctJoined(values: readonly string[]): string {
  return [...new Set(values)].join(' ');
}

interface CycleContext {
  readonly carry: readonly TaxCfdCarryRow[];
  readonly uncoveredDates: ReadonlySet<string>;
  readonly splits: readonly TaxSplitRow[];
}

function cycleProblem(cycle: readonly CfdLeg[], closing: readonly CfdLeg[], context: CycleContext) {
  const first = cycle[0] as CfdLeg;
  const last = cycle[cycle.length - 1] as CfdLeg;
  const within = (date: string) =>
    date >= first.fill.trading_date && date <= last.fill.trading_date;
  const uncovered = [...context.uncoveredDates].filter(within).sort()[0];
  if (uncovered !== undefined) {
    return `CFD carry on ${uncovered} is not journalled per position (migration 0094)`;
  }
  const split = context.splits.find(
    (row) => row.split_date > first.date && row.split_date <= last.date,
  );
  if (split !== undefined) return `split on ${split.split_date} while the CFD position was open`;
  const years = new Set(closing.map((leg) => taxYearOf(leg.date)));
  if (years.size > 1) return `closing fills span tax years ${[...years].sort().join(' and ')}`;
  return undefined;
}

function disposalOf(cycle: readonly CfdLeg[], context: CycleContext): Outcome<TaxCfdDisposalWire> {
  const first = cycle[0] as CfdLeg;
  const long = first.signedQty > 0;
  const opening = cycle.filter((leg) => leg.signedQty > 0 === long);
  const closing = cycle.filter((leg) => leg.signedQty > 0 !== long);
  const problem = cycleProblem(cycle, closing, context);
  if (problem !== undefined) return { ok: false, reason: problem };
  const qty = sumOf(opening, (leg) => leg.fill.qty);
  const openNative = sumOf(opening, (leg) => leg.valueNative);
  const closeNative = sumOf(closing, (leg) => leg.valueNative);
  const openGbp = sumOf(opening, (leg) => leg.valueGbp);
  const closeGbp = sumOf(closing, (leg) => leg.valueGbp);
  const carried = context.carry.filter((row) => row.client_order_id === first.fill.client_order_id);
  const realised = long ? closeGbp - openGbp : openGbp - closeGbp;
  const commission = sumOf(cycle, (leg) => leg.feeGbp);
  const financing = sumOf(carried, (row) => row.financing_gbp);
  const borrow = sumOf(carried, (row) => row.borrow_gbp);
  return {
    ok: true,
    value: {
      instrument: first.fill.instrument,
      venue: first.fill.venue,
      direction: long ? 'long' : 'short',
      open_date: first.date,
      close_date: (cycle[cycle.length - 1] as CfdLeg).date,
      qty,
      currency: first.fill.currency as string,
      open_price_native: openNative / qty,
      close_price_native: closeNative / qty,
      open_fx_quote_per_gbp: openNative / openGbp,
      close_fx_quote_per_gbp: closeNative / closeGbp,
      fx_source: distinctJoined(cycle.map((leg) => leg.source)),
      open_value_gbp: openGbp,
      close_value_gbp: closeGbp,
      realised_pnl_gbp: realised,
      commission_gbp: commission,
      financing_gbp: financing,
      borrow_gbp: borrow,
      net_gbp: realised - commission - financing - borrow,
      treatment: 'unconfirmed',
    },
  };
}

function legsOf(fills: readonly TaxCfdFillRow[], dayRate: DayRate): Outcome<CfdLeg[]> {
  const legs: CfdLeg[] = [];
  for (const fill of fills) {
    const leg = legOf(fill, dayRate);
    if (!leg.ok) return leg;
    legs.push(leg.value);
  }
  const currencies = new Set(legs.map((leg) => leg.fill.currency));
  if (currencies.size > 1) {
    return { ok: false, reason: `fills in more than one currency: ${[...currencies].join(', ')}` };
  }
  return { ok: true, value: legs };
}

function logPosition(
  fills: readonly TaxCfdFillRow[],
  dayRate: DayRate,
  context: CycleContext,
): Outcome<TaxCfdDisposalWire[]> {
  const legs = legsOf(fills, dayRate);
  if (!legs.ok) return legs;
  const cycles = cyclesOf(legs.value);
  if (!cycles.ok) return cycles;
  const disposals: TaxCfdDisposalWire[] = [];
  for (const cycle of cycles.value) {
    const disposal = disposalOf(cycle, context);
    if (!disposal.ok) return disposal;
    disposals.push(disposal.value);
  }
  return { ok: true, value: disposals };
}

function heldOut(fills: readonly TaxCfdFillRow[], reason: string): HeldOutInstrument {
  const first = fills[0] as TaxCfdFillRow;
  return {
    instrument: first.instrument,
    venue: first.venue,
    reason,
    fills: fills.length,
    taxYears: [
      ...new Set(fills.map((fill) => taxYearOf(fill.fill_date ?? fill.trading_date))),
    ].sort((a, b) => a - b),
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

// v2_book_days holds every mark's CFD carry, so a book-date whose per-position rows do not sum to
// it was marked before migration 0094 (or lost a row) and cannot price a position's costs
function uncoveredDatesOf(bookId: string, journal: CfdTaxJournal): Set<string> {
  const rows = groupBy(
    journal.carry.filter((row) => row.book_id === bookId),
    (row) => row.trading_date,
  );
  const uncovered = new Set<string>();
  for (const day of journal.bookDays.filter((row) => row.book_id === bookId)) {
    const dayRows = rows.get(day.trading_date) ?? [];
    const financing = sumOf(dayRows, (row) => row.financing_gbp);
    const borrow = sumOf(dayRows, (row) => row.borrow_gbp);
    const gap = Math.abs(financing - day.financing_gbp) + Math.abs(borrow - day.borrow_gbp);
    if (gap > CARRY_EPSILON) uncovered.add(day.trading_date);
  }
  return uncovered;
}

function logInstrument(
  fills: readonly TaxCfdFillRow[],
  journal: CfdTaxJournal,
  dayRate: DayRate,
): Outcome<TaxCfdDisposalWire[]> {
  const books = [...new Set(fills.map((fill) => fill.book_id))];
  if (books.length > 1) {
    return {
      ok: false,
      reason: `held in more than one book (${books.join(', ')}); the broker nets them`,
    };
  }
  const bookId = books[0] as string;
  const instrument = (fills[0] as TaxCfdFillRow).instrument;
  return logPosition(fills, dayRate, {
    carry: journal.carry.filter((row) => row.book_id === bookId && row.instrument === instrument),
    uncoveredDates: uncoveredDatesOf(bookId, journal),
    splits: journal.splits.filter((split) => split.instrument === instrument),
  });
}

export function buildCfdTaxLog(journal: CfdTaxJournal, dayRate: DayRate): CfdTaxLog {
  const cfdFills = journal.fills.filter((fill) => isCfdVenue(fill.venue as Venue));
  const disposals: TaxCfdDisposalWire[] = [];
  const held: HeldOutInstrument[] = [];
  for (const fills of groupBy(
    cfdFills,
    (fill) => `${fill.instrument}\u0000${fill.venue}`,
  ).values()) {
    const log = logInstrument(fills, journal, dayRate);
    if (log.ok) disposals.push(...log.value);
    else held.push(heldOut(fills, log.reason));
  }
  return { disposals: disposals.sort(byCloseThenName), heldOut: held.sort(byName) };
}

function byCloseThenName(a: TaxCfdDisposalWire, b: TaxCfdDisposalWire): number {
  return a.close_date.localeCompare(b.close_date) || byName(a, b);
}

function byName(a: { readonly instrument: string }, b: { readonly instrument: string }): number {
  return a.instrument.localeCompare(b.instrument);
}

export function cfdTaxYearsOf(log: CfdTaxLog): number[] {
  return taxYearsOfDates(
    log.disposals.map((disposal) => disposal.close_date),
    log.heldOut,
  );
}

export function cfdTaxYearLog(log: CfdTaxLog, year: number): TaxCfdLogWire {
  const rows = log.disposals.filter((disposal) => taxYearOf(disposal.close_date) === year);
  const sum = (
    field: 'realised_pnl_gbp' | 'commission_gbp' | 'financing_gbp' | 'borrow_gbp' | 'net_gbp',
  ) => sumOf(rows, (row) => row[field]);
  const heldOutRows: TaxHeldOutWire[] = log.heldOut
    .filter((held) => held.taxYears.includes(year))
    .map(({ taxYears: _years, ...held }) => held);
  return {
    rows,
    held_out: heldOutRows,
    realised_pnl_gbp: sum('realised_pnl_gbp'),
    commission_gbp: sum('commission_gbp'),
    financing_gbp: sum('financing_gbp'),
    borrow_gbp: sum('borrow_gbp'),
    net_gbp: sum('net_gbp'),
    treatment: 'unconfirmed',
  };
}
