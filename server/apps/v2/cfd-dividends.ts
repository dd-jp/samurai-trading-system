import type { MarketData, Position } from '../../../contracts/index.js';
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

export interface HeldDividendInputs {
  readonly bookId: string;
  readonly held: Position;
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
  inputs: Pick<HeldDividendInputs, 'held' | 'tradingDate' | 'lastMarkDate' | 'market'>,
): DividendWindow | undefined {
  const { held, market } = inputs;
  const since =
    inputs.lastMarkDate === undefined || inputs.lastMarkDate < held.openedDate
      ? held.openedDate
      : inputs.lastMarkDate;
  const after = market.lastBarBefore(held.instrument, since)?.date;
  const through = market.lastBarBefore(held.instrument, inputs.tradingDate)?.date;
  if (after === undefined || through === undefined || after >= through) return undefined;
  return { after, through };
}

// The ledger rescales a split only when this cycle reads its bar, after this booking, so a split
// between the last mark and the ex-date leaves the qty in units the dividend is not paid in
function splitBefore(inputs: HeldDividendInputs, window: DividendWindow, exDate: string): boolean {
  const days = Math.round((Date.parse(exDate) - Date.parse(window.after)) / MS_PER_DAY) + 1;
  const bars = inputs.market
    .barsBefore(inputs.held.instrument, addDays(exDate, 1), days)
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
  const bar = inputs.market.lastBarBefore(inputs.held.instrument, addDays(line.exDate, 1));
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
  const quote = quoteCurrencyOf(inputs.held.venue);
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

function bookingOf(
  inputs: HeldDividendInputs,
  exDate: string,
  dividend: ExDateDividend,
): CfdDividendBooking {
  const { held } = inputs;
  const perShareNative = dividend.perShare;
  const withholding = cfdDividendWithholding(exchangeOf(held.venue), held.qty);
  const fxQuotePerGbp = inputs.fxFor(quoteCurrencyOf(held.venue));
  return {
    book_id: inputs.bookId,
    trading_date: inputs.tradingDate,
    instrument: held.instrument,
    venue: held.venue,
    client_order_id: held.clientOrderId,
    ex_date: exDate,
    qty: held.qty,
    per_share_native: perShareNative,
    withholding,
    fx_quote_per_gbp: fxQuotePerGbp,
    amount_gbp: cfdDividendCashGbp(held.qty, perShareNative, withholding, fxQuotePerGbp),
    ...declaredColumns(dividend.declared),
  };
}

function readDetail(across: Exclude<DividendsAcross, { kind: 'covered' }>): string {
  return across.kind === 'uncovered'
    ? `no dividend read covers ${across.from}`
    : `dividend reads disagree on ${across.date}`;
}

// #2171: the held position is the ex-date−1 holding only when the window is the one session after
// the bar the last mark took; across more, a fill journalled since may postdate the ex-date or a
// fill made before it may not be journalled yet
function spansOneSession(inputs: HeldDividendInputs, window: DividendWindow): boolean {
  return inputs.market.lastBarBefore(inputs.held.instrument, window.through)?.date === window.after;
}

// Ex-dates book in order up to the first one a split precedes; that one and any after it are
// left for David, since no later cycle can place the qty in their units
export function heldDividends(inputs: HeldDividendInputs): HeldDividends {
  if (!isCfdVenue(inputs.held.venue)) return NONE;
  const window = dividendWindow(inputs);
  if (window === undefined) return NONE;
  const across = inputs.source.across(
    inputs.held.instrument,
    exchangeOf(inputs.held.venue),
    window,
  );
  if (across.kind !== 'covered') return { bookings: [], unread: readDetail(across) };
  return bookingsAcross(inputs, window, across.dividends);
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
  const oneSession = spansOneSession(inputs, window);
  const bookings: CfdDividendBooking[] = [];
  for (const [exDate, dividend] of byExDate(lines)) {
    if (inputs.booked(exDate)) continue;
    if (!oneSession) {
      unverifiable.push(
        `ex-date ${exDate} falls in a window from ${window.after} through ${window.through} of more than one session`,
      );
      continue;
    }
    if (splitBefore(inputs, window, exDate)) return { bookings, splitBefore: exDate, ...unbooked };
    bookings.push(bookingOf(inputs, exDate, dividend));
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
