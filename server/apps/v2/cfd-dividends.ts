import type { MarketData, Position, Venue } from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';
import {
  addDays,
  type ConvertibleCurrency,
  type DividendsAcross,
  type EodhdDividend,
  type EodhdExchange,
  isCfdVenue,
  isConvertibleCurrency,
  quoteCurrencyOf,
} from './data/index.js';
import { splitRatioAcross } from './split.js';
import { exchangeOf } from './split-crosscheck.js';

// David 2026-10-23 (#2143,
// https://github.com/dd-jp/samurai-trading-system/issues/2143#issuecomment-6369667188): a long is
// paid the gross less the market's default withholding, UK none and US the 30% statutory rate,
// until a real Saxo US CFD dividend shows otherwise; a short pays the gross
export const CFD_DIVIDEND_LONG_WITHHOLDING: Readonly<Record<EodhdExchange, number>> = {
  LSE: 0,
  US: 0.3,
};

const MS_PER_DAY = 86_400_000;

function cfdDividendWithholding(exchange: EodhdExchange, qty: number): number {
  return qty > 0 ? CFD_DIVIDEND_LONG_WITHHOLDING[exchange] : 0;
}

// Signed by qty: a long is credited, a short debited
function cfdDividendCashGbp(
  qty: number,
  perShareNative: number,
  withholding: number,
  fxQuotePerGbp: number,
): number {
  return (qty * perShareNative * (1 - withholding)) / fxQuotePerGbp;
}

export interface DividendWindow {
  readonly after: string;
  readonly through: string;
}

export interface CfdDividendSource {
  across(instrument: string, exchange: EodhdExchange, window: DividendWindow): DividendsAcross;
}

export interface CfdDividendBooking {
  readonly book_id: string;
  readonly trading_date: string;
  readonly instrument: string;
  readonly venue: string;
  readonly client_order_id: string;
  readonly ex_date: string;
  readonly qty: number;
  readonly per_share_native: number;
  readonly withholding: number;
  readonly fx_quote_per_gbp: number;
  readonly amount_gbp: number;
  readonly declared_per_share: number | null;
  readonly declared_currency: ConvertibleCurrency | null;
  readonly fx_declared_per_gbp: number | null;
}

export interface HeldDividends {
  readonly bookings: readonly CfdDividendBooking[];
  readonly unread?: string | undefined;
  readonly splitBefore?: string | undefined;
  readonly refused?: readonly string[] | undefined;
  readonly implausible?: readonly string[] | undefined;
  readonly unverifiable?: readonly string[] | undefined;
}

const NONE: HeldDividends = { bookings: [] };

export interface SessionFill {
  readonly client_order_id: string;
  readonly side: 'buy' | 'sell';
  readonly qty: number;
  readonly session: string | null;
  readonly trading_date: string;
}

export interface CfdFillSource {
  fillsFor(bookId: string, instrument: string): readonly SessionFill[];
  cfdInstrumentsFilledAfter(
    bookId: string,
    tradingDate: string,
  ): readonly { readonly instrument: string; readonly venue: Venue }[];
}

export interface DividendSubject {
  readonly instrument: string;
  readonly venue: Venue;
  readonly position: Position | undefined;
}

export interface HeldDividendInputs {
  readonly bookId: string;
  readonly subject: DividendSubject;
  readonly fills: readonly SessionFill[];
  readonly tradingDate: string;
  readonly lastMarkDate: string | undefined;
  readonly market: Pick<MarketData, 'lastBarBefore' | 'barsBefore'>;
  readonly source: CfdDividendSource;
  readonly fxFor: (currency: ConvertibleCurrency) => number;
  readonly booked: (exDate: string) => boolean;
}

// The cycle on date T marks the last bar before T, so it reads every ex-date after the bar its
// previous mark took, through the bar it marks now
export function dividendWindow(
  inputs: Pick<HeldDividendInputs, 'subject' | 'tradingDate' | 'lastMarkDate' | 'market'>,
): DividendWindow | undefined {
  const { market, lastMarkDate } = inputs;
  if (lastMarkDate === undefined) return undefined;
  const { instrument } = inputs.subject;
  const after = market.lastBarBefore(instrument, lastMarkDate)?.date;
  const through = market.lastBarBefore(instrument, inputs.tradingDate)?.date;
  if (after === undefined || through === undefined || after >= through) return undefined;
  return { after, through };
}

// The holding is rebuilt from the ledger qty after this cycle's rescale, and the journalled fills
// are in the units they booked in, so a split anywhere in the window leaves them in different units
function splitInWindow(inputs: HeldDividendInputs, window: DividendWindow): boolean {
  const days = Math.round((Date.parse(window.through) - Date.parse(window.after)) / MS_PER_DAY) + 1;
  const bars = inputs.market
    .barsBefore(inputs.subject.instrument, addDays(window.through, 1), days)
    .filter((bar) => bar.date >= window.after);
  return splitRatioAcross(bars).steps.length > 0;
}

interface DeclaredLine {
  readonly perShare: number;
  readonly currency: ConvertibleCurrency;
  readonly fxPerGbp: number;
}

interface QuotedLine extends EodhdDividend {
  readonly declared: DeclaredLine;
}

interface ExDateDividend {
  readonly perShare: number;
  readonly declared: readonly DeclaredLine[];
}

function byExDate(lines: readonly QuotedLine[]): Map<string, ExDateDividend> {
  const byDate = new Map<string, ExDateDividend>();
  for (const { exDate, perShare, declared } of lines) {
    const held = byDate.get(exDate) ?? { perShare: 0, declared: [] };
    byDate.set(exDate, {
      perShare: held.perShare + perShare,
      declared: [...held.declared, declared],
    });
  }
  return byDate;
}

type DeclaredColumns = Pick<
  CfdDividendBooking,
  'declared_per_share' | 'declared_currency' | 'fx_declared_per_gbp'
>;

// One row per ex-date holds one declared currency, so lines declared in two leave it undeclared
function declaredColumns(declared: readonly DeclaredLine[]): DeclaredColumns {
  const first = declared[0] as DeclaredLine;
  if (declared.some((line) => line.currency !== first.currency)) {
    return { declared_per_share: null, declared_currency: null, fx_declared_per_gbp: null };
  }
  return {
    declared_per_share: declared.reduce((total, line) => total + line.perShare, 0),
    declared_currency: first.currency,
    fx_declared_per_gbp: first.fxPerGbp,
  };
}

interface QuotedLines {
  readonly lines: readonly QuotedLine[];
  readonly refused: readonly string[];
}

// David 2026-11-03 (#2143 comment 6612506642): a dividend above this share of the ex-date close is
// taken as pence labelled GBP, which would credit 100 times the cash
export const CFD_DIVIDEND_MAX_SHARE_OF_RAW_CLOSE = 0.25;

interface PlausibleLines {
  readonly lines: readonly QuotedLine[];
  readonly implausible: readonly string[];
}

function implausibility(inputs: HeldDividendInputs, line: EodhdDividend): string | undefined {
  const bar = inputs.market.lastBarBefore(inputs.subject.instrument, addDays(line.exDate, 1));
  if (bar === undefined) return `ex-date ${line.exDate} has no bar to bound its amount`;
  if (line.perShare <= bar.rawClose * CFD_DIVIDEND_MAX_SHARE_OF_RAW_CLOSE) return undefined;
  return `ex-date ${line.exDate} pays ${line.perShare} ${line.currency} a share, over ${CFD_DIVIDEND_MAX_SHARE_OF_RAW_CLOSE * 100}% of the ${bar.date} raw close ${bar.rawClose}`;
}

function plausible(inputs: HeldDividendInputs, quoted: readonly QuotedLine[]): PlausibleLines {
  const lines: QuotedLine[] = [];
  const implausible: string[] = [];
  for (const line of quoted) {
    const why = implausibility(inputs, line);
    if (why === undefined) lines.push(line);
    else implausible.push(why);
  }
  return { lines, implausible };
}

// David 2026-11-03 (#2143,
// https://github.com/dd-jp/samurai-trading-system/issues/2143#issuecomment-6612492738): a line
// declared in another currency is converted at its year-start BoE fix, USD or EUR (#2170), and one
// no fix converts is refused alone
function inPositionQuote(
  inputs: HeldDividendInputs,
  dividends: readonly EodhdDividend[],
): QuotedLines {
  const quote = quoteCurrencyOf(inputs.subject.venue);
  const lines: QuotedLine[] = [];
  const refused: string[] = [];
  for (const line of dividends) {
    const { currency } = line;
    if (!isConvertibleCurrency(currency)) {
      refused.push(`ex-date ${line.exDate} declared in ${currency || 'no currency'}`);
      continue;
    }
    const fxPerGbp = inputs.fxFor(currency);
    const declared = { perShare: line.perShare, currency, fxPerGbp };
    const perShare =
      currency === quote ? line.perShare : (line.perShare * inputs.fxFor(quote)) / fxPerGbp;
    lines.push({ ...line, perShare, currency: quote, declared });
  }
  return { lines, refused };
}

interface Holding {
  readonly qty: number;
  readonly clientOrderId: string;
}

const FLAT_QTY = 1e-9;

const signedQty = (fill: SessionFill): number => (fill.side === 'buy' ? fill.qty : -fill.qty);

// The cycle's opening fill is the one that took the running qty off flat, as the tax log's cycle
// does, so a dividend row joins the disposal it belongs to
function openingOrderId(fills: readonly SessionFill[], before: (fill: SessionFill) => boolean) {
  let running = 0;
  let opener: string | undefined;
  for (const fill of fills.filter(before)) {
    if (Math.abs(running) < FLAT_QTY) opener = fill.client_order_id;
    running += signedQty(fill);
  }
  return opener;
}

// #2171: the holding at the close of ex-date−1 is the qty the ledger holds now less every fill
// that executed on the ex-date or after, so a fill journalled since, or a pair closed since, is
// counted the way the broker's record would. A position the journal holds no fill for is the
// holding from its opening date
function qtyAt(inputs: HeldDividendInputs, exDate: string): number {
  const { fills, subject } = inputs;
  if (fills.length === 0 && (subject.position?.openedDate ?? '') > exDate) return 0;
  const later = fills
    .filter((fill) => (fill.session ?? '') >= exDate)
    .reduce((total, fill) => total + signedQty(fill), 0);
  return (subject.position?.qty ?? 0) - later;
}

function holdingAt(
  inputs: HeldDividendInputs,
  exDate: string,
): Holding | { readonly undated: string } | undefined {
  const { fills, subject } = inputs;
  const undated = fills.find((fill) => fill.session === null && fill.trading_date >= exDate);
  if (undated !== undefined) return { undated: undated.client_order_id };
  const qty = qtyAt(inputs, exDate);
  if (Math.abs(qty) < FLAT_QTY) return undefined;
  const clientOrderId =
    openingOrderId(fills, (fill) => (fill.session ?? fill.trading_date) < exDate) ??
    subject.position?.clientOrderId;
  return clientOrderId === undefined ? undefined : { qty, clientOrderId };
}

function bookingOf(
  inputs: HeldDividendInputs,
  exDate: string,
  dividend: ExDateDividend,
  holding: Holding,
): CfdDividendBooking {
  const { subject } = inputs;
  const perShareNative = dividend.perShare;
  const withholding = cfdDividendWithholding(exchangeOf(subject.venue), holding.qty);
  const fxQuotePerGbp = inputs.fxFor(quoteCurrencyOf(subject.venue));
  return {
    book_id: inputs.bookId,
    trading_date: inputs.tradingDate,
    instrument: subject.instrument,
    venue: subject.venue,
    client_order_id: holding.clientOrderId,
    ex_date: exDate,
    qty: holding.qty,
    per_share_native: perShareNative,
    withholding,
    fx_quote_per_gbp: fxQuotePerGbp,
    amount_gbp: cfdDividendCashGbp(holding.qty, perShareNative, withholding, fxQuotePerGbp),
    ...declaredColumns(dividend.declared),
  };
}

function readDetail(across: Exclude<DividendsAcross, { kind: 'covered' }>): string {
  return across.kind === 'uncovered'
    ? `no dividend read covers ${across.from}`
    : `dividend reads disagree on ${across.date}`;
}

// A window with a split is left for David: no later cycle can place the qty in the units a
// dividend is paid in
export function heldDividends(inputs: HeldDividendInputs): HeldDividends {
  if (!isCfdVenue(inputs.subject.venue)) return NONE;
  const window = dividendWindow(inputs);
  if (window === undefined) return NONE;
  const across = inputs.source.across(
    inputs.subject.instrument,
    exchangeOf(inputs.subject.venue),
    window,
  );
  if (across.kind !== 'covered') return { bookings: [], unread: readDetail(across) };
  return bookingsAcross(inputs, window, across.dividends);
}

function bookingAt(
  inputs: HeldDividendInputs,
  exDate: string,
  dividend: ExDateDividend,
  unverifiable: string[],
): CfdDividendBooking | undefined {
  const holding = holdingAt(inputs, exDate);
  if (holding === undefined) return undefined;
  if ('undated' in holding) {
    unverifiable.push(`ex-date ${exDate} has fill ${holding.undated} with no session date`);
    return undefined;
  }
  return bookingOf(inputs, exDate, dividend, holding);
}

function bookingsAcross(
  inputs: HeldDividendInputs,
  window: DividendWindow,
  dividends: readonly EodhdDividend[],
): HeldDividends {
  const quoted = inPositionQuote(inputs, dividends);
  const { lines, implausible } = plausible(inputs, quoted.lines);
  const unverifiable: string[] = [];
  const unbooked = { refused: quoted.refused, implausible, unverifiable };
  const bookings: CfdDividendBooking[] = [];
  for (const [exDate, dividend] of byExDate(lines)) {
    if (inputs.booked(exDate)) continue;
    if (splitInWindow(inputs, window)) return { bookings, splitBefore: exDate, ...unbooked };
    const booking = bookingAt(inputs, exDate, dividend, unverifiable);
    if (booking !== undefined) bookings.push(booking);
  }
  return { bookings, ...unbooked };
}

export interface CfdDividendLedger {
  booked(bookId: string, instrument: string, exDate: string): boolean;
  record(booking: CfdDividendBooking): void;
}

export class SqliteCfdDividends implements CfdDividendLedger {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  booked(bookId: string, instrument: string, exDate: string): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM v2_cfd_dividends WHERE book_id = ? AND instrument = ? AND ex_date = ?',
        )
        .get(bookId, instrument, exDate) !== undefined
    );
  }

  record(booking: CfdDividendBooking): void {
    this.db
      .prepare(
        `INSERT INTO v2_cfd_dividends (book_id, trading_date, instrument, venue, client_order_id,
           ex_date, qty, per_share_native, withholding, fx_quote_per_gbp, amount_gbp, fills_before,
           recorded_at, declared_per_share, declared_currency, fx_declared_per_gbp)
         VALUES (@book_id, @trading_date, @instrument, @venue, @client_order_id, @ex_date, @qty,
           @per_share_native, @withholding, @fx_quote_per_gbp, @amount_gbp,
           (SELECT COUNT(*) FROM v2_fills WHERE trading_date = @trading_date), @recorded_at,
           @declared_per_share, @declared_currency, @fx_declared_per_gbp)`,
      )
      .run({ ...booking, recorded_at: toStoredTimestamp(this.clock.now()) });
  }
}

export class SqliteCfdFills implements CfdFillSource {
  constructor(private readonly db: StoreHandle) {}

  fillsFor(bookId: string, instrument: string): readonly SessionFill[] {
    return this.db
      .prepare(
        `SELECT client_order_id, side, qty, fill_date AS session, trading_date FROM v2_fills
         WHERE book_id = ? AND instrument = ? ORDER BY rowid`,
      )
      .all(bookId, instrument) as SessionFill[];
  }

  cfdInstrumentsFilledAfter(
    bookId: string,
    tradingDate: string,
  ): readonly { readonly instrument: string; readonly venue: Venue }[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT instrument, venue FROM v2_fills
           WHERE book_id = ? AND trading_date > ? ORDER BY instrument`,
        )
        .all(bookId, tradingDate) as { instrument: string; venue: Venue }[]
    ).filter(({ venue }) => isCfdVenue(venue));
  }
}
