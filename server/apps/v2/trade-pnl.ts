import type { MarketData } from '../../../contracts/index.js';
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

export function settledTradePnl(
  db: StoreHandle,
  market: MarketData,
  dates: readonly string[],
  bookIds: readonly string[],
): number[][] {
  rebuildDecisionOutcomes(db, windowBars(market, dates.at(-1) as string, dates.length));
  const select = db.prepare(
    `SELECT realised_pnl_gbp FROM v2_decision_outcomes WHERE book_id = ?
      ORDER BY exit_date, outcome_id`,
  );
  return bookIds.map((bookId) =>
    (select.all(bookId) as { realised_pnl_gbp: number }[]).map((row) => row.realised_pnl_gbp),
  );
}
