import {
  type BookPerformanceWire,
  type ClosedTradesBookWire,
  type EntryOffsetTradesWire,
  type EquityPointWire,
  type EvidenceWire,
  type NotYetFedWire,
  type PanelWire,
  type PerformanceWire,
  type TradeCountWire,
  V2_CONTRACT_VERSION,
} from '../../../../contracts/index.js';
import type { Clock } from '../../../shared/index.js';
import { type StoreHandle, toStoredTimestamp } from '../../../shared/store/index.js';
import { annualisedSharpe, maxDrawdown, moments } from '../../../tools/backtest/index.js';
import { ENTRY_LIMIT_OFFSET } from '../risk/index.js';

const G1_CLOSED_TRADES = 100;

const ARM2 = { status: 'not-yet-fed', owner: 'arm 2', ticket: '#1773' } as const;
const STEP_1B = { status: 'not-yet-fed', owner: 'Step 1b', ticket: '#1785' } as const;
const GATE: NotYetFedWire = { status: 'not-yet-fed', owner: 'Step 1b and Step 4', ticket: '#1785' };

interface BookRow {
  book_id: string;
  sleeve_id: string;
  variant: string;
}

interface OffsetRow extends EntryOffsetTradesWire {
  book_id: string;
}

// David ruled 2026-09-30 on #1815: the paper sample splits at the offset change. A bracket leg
// shares its entry's order id; an exit order is matched to the latest entry fill on its book and
// instrument before it. An entry journalled before the tag carries no limit: it went out at 0 bps
const CLOSED_TRADES_BY_ENTRY_OFFSET = `
  WITH closes AS (
    SELECT book_id, instrument, client_order_id, MIN(rowid) AS at FROM v2_fills
     WHERE leg <> 'entry' GROUP BY book_id, client_order_id
  ), tagged AS (
    SELECT c.book_id,
           (SELECT COALESCE(json_extract(o.payload, '$.entry_offset_bps'),
                            CASE WHEN json_extract(o.payload, '$.limit') IS NULL THEN 0 END)
              FROM v2_fills e JOIN v2_orders o ON o.client_order_id = e.client_order_id
             WHERE e.book_id = c.book_id AND e.instrument = c.instrument
               AND e.leg = 'entry' AND e.rowid < c.at
             ORDER BY e.client_order_id = c.client_order_id DESC, e.rowid DESC
             LIMIT 1) AS entry_offset_bps
      FROM closes c
  )
  SELECT book_id, entry_offset_bps, COUNT(*) AS closed_trades FROM tagged
   GROUP BY book_id, entry_offset_bps ORDER BY book_id, entry_offset_bps`;

function inCurrentSample({ entry_offset_bps }: EntryOffsetTradesWire): boolean {
  return entry_offset_bps === null || entry_offset_bps === ENTRY_LIMIT_OFFSET.capBps;
}

function closedTradesBook(
  book: Omit<BookRow, 'sleeve_id'>,
  rows: readonly OffsetRow[],
): ClosedTradesBookWire {
  const byEntryOffset = rows
    .filter((row) => row.book_id === book.book_id)
    .map(({ entry_offset_bps, closed_trades }) => ({ entry_offset_bps, closed_trades }));
  return {
    book_id: book.book_id,
    variant: book.variant,
    closed_trades: byEntryOffset
      .filter(inCurrentSample)
      .reduce((total, row) => total + row.closed_trades, 0),
    by_entry_offset: byEntryOffset,
  };
}

interface DayRow extends EquityPointWire {
  book_id: string;
}

function dailyReturns(equity: readonly number[]): number[] | null {
  const returns: number[] = [];
  for (let day = 1; day < equity.length; day += 1) {
    const previous = equity[day - 1] as number;
    if (!(previous > 0)) return null;
    returns.push((equity[day] as number) / previous - 1);
  }
  return returns;
}

function sharpeOf(equity: readonly number[]): number | null {
  const returns = dailyReturns(equity);
  if (returns === null || returns.length < 2 || moments(returns).stdev === 0) return null;
  return annualisedSharpe(returns);
}

function bookPerformance(book: BookRow, points: readonly EquityPointWire[]): BookPerformanceWire {
  const equity = points.map((point) => point.equity_gbp);
  return {
    ...book,
    days: points.length,
    sharpe: sharpeOf(equity),
    max_drawdown: maxDrawdown(equity),
    equity: points,
  };
}

export class EvidenceReader {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  read(): EvidenceWire {
    const { performance, tradeCount } = this.db.transaction(() => ({
      performance: this.#performance(),
      tradeCount: this.#tradeCount(),
    }))();
    return {
      contract_version: V2_CONTRACT_VERSION,
      generated_at: toStoredTimestamp(this.clock.now()),
      performance,
      vs_arm2: ARM2,
      vs_benchmark: STEP_1B,
      trade_count: tradeCount,
      arm2_test: ARM2,
      band: STEP_1B,
      gate: GATE,
    };
  }

  #performance(): PanelWire<PerformanceWire> {
    const books = this.db
      .prepare(
        `SELECT book_id, sleeve_id, variant FROM v2_books
          ORDER BY sleeve_id, variant <> 'primary', book_id`,
      )
      .all() as BookRow[];
    const days = this.db
      .prepare(
        'SELECT book_id, trading_date, equity_gbp FROM v2_book_days ORDER BY book_id, trading_date',
      )
      .all() as DayRow[];
    if (days.length === 0) return { status: 'empty' };
    const byBook = new Map<string, EquityPointWire[]>();
    for (const { book_id, trading_date, equity_gbp } of days) {
      byBook.set(book_id, [...(byBook.get(book_id) ?? []), { trading_date, equity_gbp }]);
    }
    return {
      status: 'fed',
      books: books.map((book) => bookPerformance(book, byBook.get(book.book_id) ?? [])),
    };
  }

  #tradeCount(): PanelWire<TradeCountWire> {
    const books = this.db
      .prepare(
        `SELECT book_id, variant FROM v2_books
          ORDER BY sleeve_id, variant <> 'primary', book_id`,
      )
      .all() as Omit<BookRow, 'sleeve_id'>[];
    const rows = this.db.prepare(CLOSED_TRADES_BY_ENTRY_OFFSET).all() as OffsetRow[];
    return books.length === 0
      ? { status: 'empty' }
      : {
          status: 'fed',
          target: G1_CLOSED_TRADES,
          books: books.map((book) => closedTradesBook(book, rows)),
        };
  }
}
