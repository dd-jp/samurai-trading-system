import type {
  BookCashWire,
  FreshMarkWire,
  FxRateWire,
  MarketData,
  MarkWire,
  PanelWire,
  PositionsWire,
  PositionWire,
  QuoteCurrencyWire,
  Venue,
  VenueTotalWire,
} from '../../../../contracts/index.js';
import type { DailyBar } from '../../../pipeline/momentum/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { heldKey, isFresh, type LastBar, type MarkSource, quotePerGbp } from '../data/index.js';

const VENUE_CURRENCY: Readonly<Record<Venue, QuoteCurrencyWire>> = { alpaca: 'USD', saxo: 'GBP' };
const VENUES: readonly Venue[] = ['alpaca', 'saxo'];
const MARK_READ_TIMEOUT_MS = 5_000;
const FX_SOURCE = 'Bank of England XUDLUSS, last observation on or before 1 January';

interface HoldingRow {
  book_id: string;
  variant: string;
  instrument: string;
  venue: Venue;
  qty: number;
  avg_price_gbp: number;
  stop_gbp: number | null;
  opened_date: string;
  marks_held: number;
}

export interface Holdings {
  readonly asOf: string | undefined;
  readonly positions: readonly HoldingRow[];
  readonly cash: readonly BookCashWire[];
}

export function readHoldings(db: StoreHandle): Holdings {
  const latest = db.prepare('SELECT MAX(trading_date) AS as_of FROM v2_book_days').get() as {
    as_of: string | null;
  };
  const positions = db
    .prepare(
      `SELECT p.book_id, b.variant, p.instrument, p.venue, p.qty, p.avg_price_gbp, p.stop_gbp,
              p.opened_date, p.marks_held
         FROM v2_positions p JOIN v2_books b USING (book_id)
        ORDER BY b.sleeve_id, b.variant <> 'primary', p.book_id, p.instrument`,
    )
    .all() as HoldingRow[];
  const cash = db
    .prepare(
      `SELECT book_id, variant, cash_gbp FROM v2_books
        ORDER BY sleeve_id, variant <> 'primary', book_id`,
    )
    .all() as BookCashWire[];
  return { asOf: latest.as_of ?? undefined, positions, cash };
}

function isPrimary(row: { variant: string }): boolean {
  return row.variant === 'primary';
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

function markFor(
  row: HoldingRow,
  bar: LastBar,
  quotePerGbp: number | undefined,
  asOf: string,
): MarkWire {
  if (bar instanceof Error || quotePerGbp === undefined) return { status: 'unavailable' };
  if (bar === undefined) return { status: 'stale', bar_date: null };
  if (!isFresh(bar as DailyBar | undefined, asOf)) return { status: 'stale', bar_date: bar.date };
  const priceGbp = bar.rawClose / quotePerGbp;
  return {
    status: 'fresh',
    bar_date: bar.date,
    price_quote: bar.rawClose,
    price_gbp: priceGbp,
    market_value_gbp: row.qty * priceGbp,
    unrealised_gbp: row.qty * (priceGbp - row.avg_price_gbp),
  };
}

function freshMark(row: PositionWire): FreshMarkWire | null {
  return row.mark.status === 'fresh' ? row.mark : null;
}

function quoteValue(row: PositionWire): number | null {
  const mark = freshMark(row);
  return mark === null ? null : row.qty * mark.price_quote;
}

function venueTotal(venue: Venue, positions: readonly PositionWire[]): VenueTotalWire {
  const held = positions.filter((row) => row.venue === venue && isPrimary(row));
  return {
    venue,
    currency: VENUE_CURRENCY[venue],
    positions_value_quote: sumOrNull(held.map(quoteValue)),
    positions_value_gbp: sumOrNull(held.map((row) => freshMark(row)?.market_value_gbp ?? null)),
  };
}

export class PositionsPanel {
  constructor(
    private readonly marks: MarkSource,
    private readonly market: MarketData,
    private readonly timeoutMs = MARK_READ_TIMEOUT_MS,
  ) {}

  async present(holdings: Holdings): Promise<PanelWire<PositionsWire>> {
    const { asOf } = holdings;
    if (asOf === undefined) return { status: 'empty' };
    const bars = await this.#lastBars(holdings.positions, asOf);
    const fx = this.#fx(asOf);
    const positions = holdings.positions.map((row) =>
      this.#position(row, bars.get(heldKey(row)), asOf, fx),
    );
    const venues = VENUES.map((venue) => venueTotal(venue, positions));
    const primaryCash = holdings.cash.filter(isPrimary).map((row) => row.cash_gbp);
    return {
      status: 'fed',
      as_of: asOf,
      fx,
      positions,
      cash: holdings.cash,
      venues,
      total_gbp: sumOrNull([...primaryCash, ...venues.map((row) => row.positions_value_gbp)]),
    };
  }

  async #lastBars(
    held: readonly HoldingRow[],
    asOf: string,
  ): Promise<ReadonlyMap<string, LastBar>> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('mark read timed out')), this.timeoutMs);
    });
    try {
      return await Promise.race([this.marks.lastBarsBefore(held, asOf), timeout]);
    } catch (error) {
      const fault = error instanceof Error ? error : new Error(String(error));
      return new Map(held.map((row) => [heldKey(row), fault]));
    } finally {
      clearTimeout(timer);
    }
  }

  #fx(asOf: string): FxRateWire | null {
    try {
      return {
        gbp_usd: quotePerGbp(this.market, 'alpaca', asOf),
        year: Number(asOf.slice(0, 4)),
        source: FX_SOURCE,
      };
    } catch {
      return null;
    }
  }

  #position(row: HoldingRow, bar: LastBar, asOf: string, fx: FxRateWire | null): PositionWire {
    const perGbp = row.venue === 'alpaca' ? fx?.gbp_usd : quotePerGbp(this.market, row.venue, asOf);
    return {
      book_id: row.book_id,
      variant: row.variant,
      instrument: row.instrument,
      venue: row.venue,
      currency: VENUE_CURRENCY[row.venue],
      qty: row.qty,
      entry_gbp: row.avg_price_gbp,
      stop_gbp: row.stop_gbp,
      opened_date: row.opened_date,
      marks_held: row.marks_held,
      mark: markFor(row, bar, perGbp, asOf),
    };
  }
}
