/**
 * `renderPositions` — CLI Positions view (#97, docs/specs/cli-spec.md
 * "Module: Views"). Renders every open position with unrealized PnL computed
 * from the current mark (`QueryStore.getMark`) — never a stale entry-time
 * value. Pure function of `(QueryStore, asOf)`, matching `renderDebates`'s
 * one-seam-per-view convention.
 */
import type { OpenPosition } from '../shared/types.js';
import type { QueryStore } from './types.js';

/**
 * Freeze §4: always `filled_size`, never `requested_size` — a partially
 * filled lot is marked, and its PnL computed, at what actually filled.
 */
function unrealizedPnl(position: OpenPosition, markPrice: number): number {
  const diff =
    position.side === 'buy'
      ? markPrice - position.avg_entry_price
      : position.avg_entry_price - markPrice;
  return diff * position.filled_size;
}

export function renderPositions(store: QueryStore, asOf: Date): string {
  const positions = store.getOpenPositions(asOf);

  const lines: string[] = ['=== Positions ==='];

  if (positions.length === 0) {
    lines.push('No open positions.');
  } else {
    for (const position of positions) {
      const mark = store.getMark(position.instrument, asOf);
      const pnl = unrealizedPnl(position, mark.price);
      lines.push(
        `${position.instrument}  ${position.side}  size=${position.filled_size}  entry=${position.avg_entry_price}  stop=${position.stop}  target=${position.target}  mark=${mark.price}  unrealized_pnl=${pnl}`,
      );
    }
  }

  return lines.join('\n');
}
