import type {
  ClosedTradeLedgerWire,
  ClosedTradeStatsWire,
  ClosedTradeWire,
  PanelWire,
} from '../../../../contracts/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';

const NEWEST_ROWS = 50;

const PRIMARY_OUTCOMES = `
  v2_decision_outcomes o JOIN v2_books b ON b.book_id = o.book_id WHERE b.variant = 'primary'`;

const NEWEST_TRADES = `
  SELECT o.decision_id, o.book_id, o.instrument, o.direction, o.entry_date, o.exit_date,
         o.exit_reason, o.holding_days, o.realised_pnl_gbp, o.trade_return, o.r_multiple,
         o.benchmark_symbol, o.excess_return
    FROM ${PRIMARY_OUTCOMES}
   ORDER BY o.exit_date DESC, o.outcome_id DESC LIMIT ?`;

const BOOK_TOTALS = `
  SELECT o.book_id,
         COUNT(*) AS trades,
         SUM(o.realised_pnl_gbp > 0) AS wins,
         SUM(o.realised_pnl_gbp) AS net_gbp,
         COALESCE(SUM(CASE WHEN o.realised_pnl_gbp > 0 THEN o.realised_pnl_gbp END), 0) AS gross_win_gbp,
         COALESCE(SUM(CASE WHEN o.realised_pnl_gbp < 0 THEN -o.realised_pnl_gbp END), 0) AS gross_loss_gbp
    FROM ${PRIMARY_OUTCOMES}
   GROUP BY o.book_id ORDER BY o.book_id`;

interface BookTotals {
  book_id: string;
  trades: number;
  wins: number;
  net_gbp: number;
  gross_win_gbp: number;
  gross_loss_gbp: number;
}

function statsOf(totals: BookTotals): ClosedTradeStatsWire {
  return {
    book_id: totals.book_id,
    trades: totals.trades,
    win_rate: totals.wins / totals.trades,
    expectancy_gbp: totals.net_gbp / totals.trades,
    profit_factor: totals.gross_loss_gbp > 0 ? totals.gross_win_gbp / totals.gross_loss_gbp : null,
    net_gbp: totals.net_gbp,
  };
}

export function readClosedTradeLedger(db: StoreHandle): PanelWire<ClosedTradeLedgerWire> {
  const totals = db.prepare(BOOK_TOTALS).all() as BookTotals[];
  if (totals.length === 0) return { status: 'empty' };
  return {
    status: 'fed',
    stats: totals.map(statsOf),
    newest: db.prepare(NEWEST_TRADES).all(NEWEST_ROWS) as ClosedTradeWire[],
  };
}
