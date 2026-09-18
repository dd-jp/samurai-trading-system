import type { PositionRow } from '@contracts';

export interface OpenRiskRow {
  position: PositionRow;
  notional: number;
  stopDistance: number;
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
