import type { MarketData } from '../../../contracts/index.js';
import { describeThrownSafely, type Logger } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { addDays, type BarsSource } from './data/index.js';
import { type OutcomeRebuild, rebuildDecisionOutcomes } from './decision-outcomes.js';

export function profitFactor(pnl: readonly number[]): number | null {
  const wins = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = pnl.filter((value) => value < 0).reduce((sum, value) => sum - value, 0);
  return losses > 0 ? wins / losses : null;
}

// Twice the run's sessions: an entry on the first session settles off the bar before it, and a
// venue on another exchange calendar trades more sessions than the reference counts
function windowBars(market: MarketData, to: string, sessions: number): BarsSource {
  const before = addDays(to, 1);
  return {
    load: (symbol) => {
      const bars = market.barsBefore(symbol, before, 2 * sessions);
      return bars.length === 0 ? undefined : { symbol, bars };
    },
  };
}

export interface SettledTrades {
  readonly pnl: readonly number[];
  readonly unsettled: number;
}

export function unsettledIn(rebuild: OutcomeRebuild, bookId: string): number {
  return (
    rebuild.pending.filter((close) => close.bookId === bookId).length +
    rebuild.anomalous.filter((close) => close.bookId === bookId).length +
    rebuild.unmatched.filter((key) => key.startsWith(`${bookId}|`)).length
  );
}

// Reporting only, and the run's trials are already counted when it settles, so a failure here
// leaves profit factor unmeasured rather than failing a run that cannot be recounted
export function settledTradePnl(
  db: StoreHandle,
  market: MarketData,
  dates: readonly string[],
  bookIds: readonly string[],
  logger: Logger,
): SettledTrades[] | undefined {
  try {
    const rebuild = rebuildDecisionOutcomes(
      db,
      windowBars(market, dates.at(-1) as string, dates.length),
    );
    const select = db.prepare(
      `SELECT realised_pnl_gbp FROM v2_decision_outcomes WHERE book_id = ?
        ORDER BY exit_date, outcome_id`,
    );
    const books = bookIds.map((bookId) => ({
      pnl: (select.all(bookId) as { realised_pnl_gbp: number }[]).map(
        (row) => row.realised_pnl_gbp,
      ),
      unsettled: unsettledIn(rebuild, bookId),
    }));
    warnUnsettled(logger, books);
    return books;
  } catch (error) {
    logger.log({
      trace_id: 'v2-backtest',
      stage: 'v2',
      level: 'warn',
      event: 'v2_backtest_trade_pnl_failed',
      message: `trade P&L not settled, profit factor unmeasured: ${describeThrownSafely(error)}`,
    });
    return undefined;
  }
}

function warnUnsettled(logger: Logger, books: readonly SettledTrades[]): void {
  const unsettled = books.reduce((sum, book) => sum + book.unsettled, 0);
  if (unsettled === 0) return;
  logger.log({
    trace_id: 'v2-backtest',
    stage: 'v2',
    level: 'warn',
    event: 'v2_backtest_trades_unsettled',
    message: `${unsettled} closed trade(s) did not settle and are left out of profit factor`,
  });
}
