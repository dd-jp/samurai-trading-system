import type { MarketData } from '../../../contracts/index.js';
import { describeThrownSafely, type Logger } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { addDays, type BarsSource } from './data/index.js';
import { rebuildDecisionOutcomes } from './decision-outcomes.js';

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

// Reporting only, and the run's trials are already counted when it settles, so a failure here
// leaves profit factor unmeasured rather than failing a run that cannot be recounted
export function settledTradePnl(
  db: StoreHandle,
  market: MarketData,
  dates: readonly string[],
  bookIds: readonly string[],
  logger: Logger,
): number[][] | undefined {
  try {
    rebuildDecisionOutcomes(db, windowBars(market, dates.at(-1) as string, dates.length));
    const select = db.prepare(
      `SELECT realised_pnl_gbp FROM v2_decision_outcomes WHERE book_id = ?
        ORDER BY exit_date, outcome_id`,
    );
    return bookIds.map((bookId) =>
      (select.all(bookId) as { realised_pnl_gbp: number }[]).map((row) => row.realised_pnl_gbp),
    );
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
