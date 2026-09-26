import {
  type BookPerformanceWire,
  type ClosedTradesBookWire,
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
import { annualisedSharpe, maxDrawdown } from '../../../tools/backtest/index.js';

const G1_CLOSED_TRADES = 100;

const ARM2 = { status: 'not-yet-fed', owner: 'arm 2', ticket: '#1773' } as const;
const STEP_1B = { status: 'not-yet-fed', owner: 'Step 1b', ticket: '#1785' } as const;
const GATE: NotYetFedWire = { status: 'not-yet-fed', owner: 'Step 1b and Step 4', ticket: '#1785' };

interface BookRow {
  book_id: string;
  sleeve_id: string;
  variant: string;
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
  return returns === null || returns.length < 2 ? null : annualisedSharpe(returns);
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
    return {
      status: 'fed',
      books: books.map((book) =>
        bookPerformance(
          book,
          days
            .filter((day) => day.book_id === book.book_id)
            .map(({ trading_date, equity_gbp }) => ({ trading_date, equity_gbp })),
        ),
      ),
    };
  }

  #tradeCount(): PanelWire<TradeCountWire> {
    const books = this.db
      .prepare(
        `SELECT b.book_id, b.variant,
                (SELECT COUNT(*) FROM v2_orders o
                  WHERE o.book_id = b.book_id AND o.leg = 'exit'
                    AND EXISTS (SELECT 1 FROM v2_fills f WHERE f.client_order_id = o.client_order_id)
                ) AS closed_trades
           FROM v2_books b
          ORDER BY b.sleeve_id, b.variant <> 'primary', b.book_id`,
      )
      .all() as ClosedTradesBookWire[];
    return books.length === 0
      ? { status: 'empty' }
      : { status: 'fed', target: G1_CLOSED_TRADES, books };
  }
}
