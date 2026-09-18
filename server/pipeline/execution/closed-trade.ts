import type { ClosedTrade, ExitFill, Fill, OpenPosition } from '../../shared/index.js';
import { weightedAvgPrice } from '../../shared/index.js';

export function closedTrade(
  position: OpenPosition,
  lot: {
    filledSize: number;
    avgEntryPrice: number;
    entryFills: readonly Fill[];
    exitFills: readonly ExitFill[];
  },
): ClosedTrade {
  const { filledSize, avgEntryPrice, entryFills, exitFills } = lot;

  const closing = exitFills.at(-1);
  if (closing === undefined) {
    throw new Error(`closedTrade: ${position.idempotency_key} is flat with no exit fill recorded`);
  }
  const avgExitPrice = weightedAvgPrice(exitFills);

  const gross =
    position.side === 'buy'
      ? (avgExitPrice - avgEntryPrice) * filledSize
      : (avgEntryPrice - avgExitPrice) * filledSize;
  const feesTotal = [...entryFills, ...exitFills].reduce((sum, fill) => sum + fill.fee, 0);

  return {
    idempotency_key: position.idempotency_key,
    debate_id: position.debate_id,
    instrument: position.instrument,
    asset_class: position.asset_class,
    side: position.side,
    entry: avgEntryPrice,
    stop: position.stop,
    filled_size: filledSize,
    realized_pnl_net: gross - feesTotal,
    fees_total: feesTotal,
    opened_at: position.opened_at,
    closed_at: closing.timestamp,
    close_reason: closing.exit_reason ?? closing.leg,
    modelled_cost_charged: modelledCostCharged(entryFills, exitFills),
  };
}

export function modelledCostCharged(
  entryFills: readonly Fill[],
  exitFills: readonly ExitFill[],
): boolean {
  return [...entryFills, ...exitFills].every((fill) => fill.cost_breakdown !== undefined);
}
