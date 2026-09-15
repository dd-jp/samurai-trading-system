/**
 * The Glance tab's arithmetic, kept pure so it is tested without a DOM.
 *
 * Everything here is presentation arithmetic over figures the wire already
 * carries — sums and ratios of `positions[]`. Nothing is a domain computation
 * the server should own: no P&L is re-derived from prices, no risk is
 * re-measured. The P&L headline itself (`snapshot.pnl`, #1595) is computed
 * server-side and rendered as-is — see `GlanceTab.tsx`'s `PnlCard`.
 */
import type { PositionRow } from '@contracts';

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
