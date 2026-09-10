/**
 * What a lot still HOLDS at the venue (#568) — the one definition both halves
 * of the exit path size against.
 *
 * `OpenPosition.filled_size` is the lot's cumulative ENTRY quantity
 * (`ingestFills()` sums `leg === 'entry'` fills into it) and is never reduced
 * by an exit fill. That is correct as a record of what the entry filled, and
 * wrong as an answer to "how much can we still sell". A partially-flattened
 * lot stays open — `getOpenPositions()` excludes only terminal states — so
 * between the partial flatten and the close it reads as its FULL original
 * size while the venue holds the residual, and an exit sized off it sells
 * into a position that is no longer there: a REVERSE position with no lot, no
 * bracket and no protective leg, the hazard #516/#525 exist to prevent.
 *
 * Held quantity is therefore `filled_size − Σ exit-leg fill quantity`, derived
 * from the fill record (`isExitFill`, below) rather than from a persisted
 * running total. The fills stay the single source of truth: a lot already partially
 * flattened before this code shipped reads correctly on its first evaluation,
 * with nothing to backfill.
 *
 * The READ is part of the derivation, not the caller's business (see
 * `heldQuantitiesFor`): the Trader sizes the exit and Execution re-derives it
 * to guard the submission on EXACT equality, so the two must run the same
 * keys through the same query — a promise made in prose does not hold a
 * bit-identical comparison up.
 */
import type { Fill, OpenPosition } from './types.js';

/** A fill on a closing leg — everything that is not the entry. */
export type ExitFill = Fill & { leg: 'stop' | 'target' | 'exit' };

export function isExitFill(fill: Fill): fill is ExitFill {
  return fill.leg !== 'entry';
}

export function totalQty(fills: readonly Fill[]): number {
  return fills.reduce((sum, fill) => sum + fill.qty, 0);
}

/** Size-weighted average price of `fills`; 0 when they carry no quantity. */
export function weightedAvgPrice(fills: readonly Fill[]): number {
  const qty = totalQty(fills);
  if (qty === 0) return 0;
  return fills.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / qty;
}

/** One lot's held quantity — see `heldQuantities`. */
export interface LotHeldQuantity {
  idempotency_key: string;
  /**
   * `filled_size` minus the exit-leg quantity already recorded against the
   * lot. Negative means the store's own fill record says more was closed than
   * ever opened — a divergence to refuse on, never to clamp away (see
   * `executeExit`, which is the last checkpoint before funds move).
   */
  held: number;
}

/**
 * Held quantity per lot, keys and read included, so both callers cannot drift:
 * `reader` is `SharedStore.getExitFillSizes` (the Trader gets it narrowed to
 * this one function on `TraderInput`), and it is called here with the lots'
 * own keys rather than by each caller in its own way.
 *
 * Per lot, not pre-summed: a negative on one lot must not be silently netted
 * against a positive on another. That netting is the very failure mode this
 * module exists to close — two sides computing the same wrong total agree
 * with each other and pass every cross-check. `executeExit` is where a
 * negative is refused outright (it is the last checkpoint before funds move);
 * the Trader's own sizing skips a non-positive TOTAL and leaves the loud
 * refusal to that guard rather than making a second, quieter judgement.
 *
 * "Missing is absent" is `getExitFillSizes`' answer for a lot with no exit
 * fill on record, which reads here as zero closed.
 */
export async function heldQuantitiesFor(
  lots: readonly OpenPosition[],
  reader: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>,
): Promise<LotHeldQuantity[]> {
  const exitFillSizes = await reader(lots.map((lot) => lot.idempotency_key));
  return lots.map((lot) => ({
    idempotency_key: lot.idempotency_key,
    held: lot.filled_size - (exitFillSizes.get(lot.idempotency_key) ?? 0),
  }));
}

/**
 * The instrument's total held quantity. Deliberately carries a negative
 * straight through rather than hiding it, so a caller that skipped the per-lot
 * check gets a total that is visibly too small instead of one that looks
 * plausible.
 */
export function totalHeldQuantity(held: readonly LotHeldQuantity[]): number {
  return held.reduce((sum, lot) => sum + lot.held, 0);
}

/**
 * Relative tolerance on the quantity comparisons, because both sides are
 * float64 sums of decimal `Fill.qty` rows and two sums of the SAME total
 * differ unless the tranches happen to share a summation order: entry
 * tranches of 0.3 + 0.3 + 0.4 total exactly 1, while exit tranches of
 * 0.7 + 0.2 + 0.1 total 0.9999999999999999. A bare `>=` therefore reads a
 * fully-exited lot as still open — forever, since no further fill is coming:
 * no `ClosedTrade` for the Feedback Loop, and a phantom lot left in
 * `getOpenPositions()` consuming Risk's exposure caps.
 *
 * The margin over float noise, measured against the same (n+2)·2^-53 bound
 * ADR-0005 §1 derives (n products, an n-term naive summation, one division),
 * is 88x at n = 100 fills (1.13e-14) and 36x at the 250-fills-per-leg worst
 * case (2.80e-14) — comfortable, but tens of times, NOT orders of
 * magnitude: a workload past ~9,000 fills on one leg would need this
 * constant revisited. The margin in the other direction is the wide one: a
 * residue of 1e-12 of a lot is orders below any venue's minimum quantity
 * increment, so it does not exist at the broker either and a lot that reads
 * flat here is flat there too. The tolerance has to carry that argument on
 * its own — `reconcile()` (#86) only inspects `pending`/`submitted` lots, so
 * it never revisits one this code has marked terminal.
 * See [ADR-0005](../../docs/adr/0005-money-math-precision.md).
 */
export const QTY_EPSILON_RELATIVE = 1e-12;

/**
 * `actual >= target`, tolerant of float64 summation noise on either side.
 * The ONE flatness judgement for every surface that asks it — the observing
 * fill poll, the #549 sweep, `nextState`'s filled/partially_filled split —
 * so no two of them can disagree by an algebraic rearrangement that is not
 * guaranteed the same float64 answer (ADR-0005).
 */
export function coversQty(actual: number, target: number): boolean {
  return actual >= target - Math.abs(target) * QTY_EPSILON_RELATIVE;
}

/**
 * A lot's held quantity recomputed from its FULL persisted fill record, the
 * shape the residual-protection path reasons over. Same `held` as
 * `heldQuantitiesFor` derives from the persisted `filled_size` column; the
 * two agree while `filled_size` is the sum of the entry fills, which is
 * exactly what `ingestFills()` writes into it.
 */
export interface RecordedHeldQuantity {
  /** Σ entry-leg fill quantity. */
  filledSize: number;
  /** Σ closing-leg fill quantity. */
  exitQty: number;
  held: number;
}

export function heldQuantityFromFills(fills: readonly Fill[]): RecordedHeldQuantity {
  const filledSize = totalQty(fills.filter((fill) => fill.leg === 'entry'));
  const exitQty = totalQty(fills.filter(isExitFill));
  return { filledSize, exitQty, held: filledSize - exitQty };
}

/** Round-tripped to flat under the one tolerance — nothing left at the venue. */
export function isFlat(recorded: Pick<RecordedHeldQuantity, 'filledSize' | 'exitQty'>): boolean {
  return coversQty(recorded.exitQty, recorded.filledSize);
}
