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
 * from the fill record (`leg !== 'entry'` — the same discriminator
 * `ingest-fills.ts`'s `isExitFill` uses) rather than from a persisted running
 * total. The fills stay the single source of truth: a lot already partially
 * flattened before this code shipped reads correctly on its first evaluation,
 * with nothing to backfill.
 *
 * The READ is part of the derivation, not the caller's business (see
 * `heldQuantitiesFor`): the Trader sizes the exit and Execution re-derives it
 * to guard the submission on EXACT equality, so the two must run the same
 * keys through the same query — a promise made in prose does not hold a
 * bit-identical comparison up.
 */
import type { OpenPosition } from './types.js';

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
