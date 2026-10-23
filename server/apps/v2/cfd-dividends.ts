import type { MarketData, Position } from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';
import {
  addDays,
  type DividendsAcross,
  type EodhdDividend,
  type EodhdExchange,
  isCfdVenue,
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
}

export interface HeldDividends {
  readonly bookings: readonly CfdDividendBooking[];
  readonly unread?: string | undefined;
  readonly splitBefore?: string | undefined;
}

const NONE: HeldDividends = { bookings: [] };

export interface HeldDividendInputs {
  readonly bookId: string;
  readonly held: Position;
  readonly tradingDate: string;
  readonly lastMarkDate: string | undefined;
  readonly market: Pick<MarketData, 'lastBarBefore' | 'barsBefore'>;
  readonly source: CfdDividendSource;
  readonly fxQuotePerGbp: number;
  readonly booked: (exDate: string) => boolean;
}

// The cycle on date T marks the last bar before T, so it books every ex-date after the bar its
// previous mark took, through the bar it marks now; the position is the one held before this
// cycle books any fill, which is the holding at the close of the day before each such ex-date
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

function perShareByDate(dividends: readonly EodhdDividend[]): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const { exDate, perShare } of dividends) {
    byDate.set(exDate, (byDate.get(exDate) ?? 0) + perShare);
  }
  return byDate;
}

function bookingOf(
  inputs: HeldDividendInputs,
  exDate: string,
  perShareNative: number,
): CfdDividendBooking {
  const { held } = inputs;
  const withholding = cfdDividendWithholding(exchangeOf(held.venue), held.qty);
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
    fx_quote_per_gbp: inputs.fxQuotePerGbp,
    amount_gbp: cfdDividendCashGbp(held.qty, perShareNative, withholding, inputs.fxQuotePerGbp),
  };
}

function readDetail(across: Exclude<DividendsAcross, { kind: 'covered' }>): string {
  return across.kind === 'uncovered'
    ? `no dividend read covers ${across.from}`
    : `dividend reads disagree on ${across.date}`;
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
  const bookings: CfdDividendBooking[] = [];
  for (const [exDate, perShare] of perShareByDate(dividends)) {
    if (inputs.booked(exDate)) continue;
    if (splitBefore(inputs, window, exDate)) return { bookings, splitBefore: exDate };
    bookings.push(bookingOf(inputs, exDate, perShare));
  }
  return { bookings };
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
           recorded_at)
         VALUES (@book_id, @trading_date, @instrument, @venue, @client_order_id, @ex_date, @qty,
           @per_share_native, @withholding, @fx_quote_per_gbp, @amount_gbp,
           (SELECT COUNT(*) FROM v2_fills WHERE trading_date = @trading_date), @recorded_at)`,
      )
      .run({ ...booking, recorded_at: toStoredTimestamp(this.clock.now()) });
  }
}
