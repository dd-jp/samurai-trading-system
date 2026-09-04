/**
 * The Glance tab's arithmetic, kept pure so it is tested without a DOM.
 *
 * Everything here is presentation arithmetic over figures the wire already
 * carries — sums and ratios of `positions[]` and `closed_trades[]`. Nothing is
 * a domain computation the server should own: no P&L is re-derived from
 * prices, no risk is re-measured. The one judgement call is what "today"
 * means, and it is the snapshot's own UTC date, never the browser's clock.
 */
import type { ClosedTradeRow, PositionRow } from '@contracts';
import { formatDateUtc, UNKNOWN } from './format.ts';

export interface PnlToday {
  /** Net realized P&L of the closed trades whose `closed_at` falls on the snapshot's UTC date. */
  realized: number;
  /** Sum of `unrealized_pnl` over every open position — marked, not settled. */
  unrealized: number;
  /** `realized + unrealized`. */
  total: number;
  /** Fees on today's closed trades. Already inside `realized`; shown so the drag is visible. */
  costs: number;
  closedCount: number;
  openCount: number;
}

function utcDay(iso: string): string | null {
  const day = formatDateUtc(iso);
  return day === UNKNOWN ? null : day;
}

export function pnlToday(
  positions: readonly PositionRow[],
  closedTrades: readonly ClosedTradeRow[],
  asOf: string,
): PnlToday {
  const today = utcDay(asOf);
  const closedToday = closedTrades.filter(
    (trade) => today !== null && utcDay(trade.closed_at) === today,
  );
  const realized = closedToday.reduce((sum, trade) => sum + trade.realized_pnl_net, 0);
  const costs = closedToday.reduce((sum, trade) => sum + trade.fees_total, 0);
  const unrealized = positions.reduce((sum, position) => sum + position.unrealized_pnl, 0);
  return {
    realized,
    unrealized,
    total: realized + unrealized,
    costs,
    closedCount: closedToday.length,
    openCount: positions.length,
  };
}

export interface OpenRiskRow {
  position: PositionRow;
  /** `filled_size × mark_price` — what the position is worth now. */
  notional: number;
  /**
   * Fraction of the mark price between here and the stop, in the direction
   * the stop lies: `(mark − stop) / mark` long, `(stop − mark) / mark` short.
   * Negative means the mark is already through the stop.
   */
  stopDistance: number;
  /**
   * Where the mark sits on the stop→target line, 0 at the stop and 1 at the
   * target, clamped. `null` when the bracket has no width, which is not a
   * position this system opens but is a row the wire can carry.
   */
  progress: number | null;
}

export function openRiskRow(position: PositionRow): OpenRiskRow {
  const { mark_price: mark, stop, target, side } = position;
  const long = side === 'buy';
  const stopDistance = mark === 0 ? Number.NaN : long ? (mark - stop) / mark : (stop - mark) / mark;
  const width = target - stop;
  const raw = width === 0 || !Number.isFinite(width) ? null : (mark - stop) / width;
  return {
    position,
    notional: position.filled_size * mark,
    stopDistance,
    progress: raw === null ? null : Math.min(1, Math.max(0, raw)),
  };
}

export function deployedNotional(positions: readonly PositionRow[]): number {
  return positions.reduce((sum, position) => sum + openRiskRow(position).notional, 0);
}
