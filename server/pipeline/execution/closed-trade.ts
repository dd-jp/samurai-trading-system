/**
 * Closed-trade reconstruction — the `ClosedTrade` record `applyLotAdvance`
 * persists the poll a lot round-trips to flat, rebuilt from the lot's own
 * persisted fills (`advanceLot`, ingest-fills.ts). Pure: entry and exit
 * averages, signed gross, fees, how the trade ended, and whether every leg the
 * modelled-cost mechanism covers was actually charged (#1121 AC5). ADR-0005
 * carries the float64 reasoning for the sums here.
 */

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

  // The fill that took the lot flat — it names how the trade ended and when.
  const closing = exitFills[exitFills.length - 1] as ExitFill;
  const avgExitPrice = weightedAvgPrice(exitFills);

  // Signed against the direction of the lot: a short earns the fall.
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
    // The lot's INITIAL stop, carried from the bracket — R's denominator is
    // the risk taken at open.
    stop: position.stop,
    filled_size: filledSize,
    realized_pnl_net: gross - feesTotal,
    fees_total: feesTotal,
    opened_at: position.opened_at,
    closed_at: closing.timestamp,
    // #793: 'stop'/'target' already name a bracket hit precisely — left as
    // `closing.leg`. A flatten-originated close (`closing.leg === 'exit'`)
    // additionally carries `exit_reason` (migration 0031) naming WHICH of
    // the three in-process reasons it was; that is the more specific answer
    // and wins whenever it is present. Falls back to the bare `'exit'` leg
    // only for a row this system genuinely never recorded a reason for — the
    // pre-0031 legacy case (see the migration's own doc; not invented here).
    close_reason: closing.exit_reason ?? closing.leg,
    modelled_cost_charged: modelledCostCharged(entryFills, exitFills),
  };
}

/**
 * #1121 AC5: whether every leg of this round trip that the modelled-cost
 * mechanism COVERS carries the `cost_breakdown` the charge is taken from —
 * which, since `chargeTopUpTo` only ever fires alongside setting it, is the
 * same question as "was this lot charged the modelled cost on every leg it
 * could be".
 *
 * Derived from the fills, not stamped as a literal, because going through
 * `toFill` is not the same as being charged by it: `modelledEntryCostFor` is
 * nullable (no submit-time snapshot) and `redistributeOneFlatten`'s is too, so
 * a live lot can close having paid nothing. Stamping `1` on those said the
 * opposite of what happened — worse than the pre-fix state, since the row then
 * certifies a cost basis it is not on.
 *
 * COVERAGE, and why `'stop'`/`'target'` legs do not veto: no modelled estimate
 * exists for a protective leg on either arm (see `toFill`'s "What this still
 * does not cover", #1301). Vetoing on them would drop live trades BECAUSE they
 * exited on a stop — selection on outcome, since stops are the losers, which is
 * a worse and far less visible bias than the exit-leg under-charge it would be
 * papering over. So coverage is the entry legs plus flatten (`'exit'`) legs,
 * which is exactly the set both arms price.
 *
 * The control arm always answers `true`: `SimulatedBrokerAdapter` prices its
 * own fills and stamps `cost_breakdown` on every one of them.
 */
export function modelledCostCharged(
  entryFills: readonly Fill[],
  exitFills: readonly ExitFill[],
): boolean {
  return [...entryFills, ...exitFills.filter((fill) => fill.leg === 'exit')].every(
    (fill) => fill.cost_breakdown !== undefined,
  );
}
