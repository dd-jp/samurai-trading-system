/**
 * The `rearmProtectiveLegs` refusal a retry can never take back (#1214).
 *
 * `BrokerAdapter.rearmProtectiveLegs` (types/broker.ts) already requires an
 * adapter that cannot express an entry-less protective pair to THROW rather
 * than no-op. What the seam could not say is whether a given throw is a bad
 * minute at the venue or a settled capability gap — and both callers
 * (`maybeRearmResidual` in residual-protection.ts, `sweepResidualProtection` in
 * residual-protection-sweep.ts) read every throw as the former: they log
 * "retry failed", keep the #549 marker, and re-attempt on the next poll,
 * forever. On Saxo, whose pool lines all report `IsOcoOrderSupported: false`
 * (doc 43), that attempt cannot ever succeed, so the operator's one page
 * reads as transient, and the log carries a per-poll failure line for what is
 * actually a fixed fact about the venue.
 *
 * A thrown, typed error rather than a `BrokerAdapter` capability flag,
 * deliberately: the Saxo refusal happens BEFORE any client call, so
 * attempting costs nothing and a post-hoc discriminator carries exactly the
 * same information. A flag would only earn its place on the interface — and
 * in every test double that implements it — if the attempt cost a venue round
 * trip. That choice is also what lets a refusal the venue's CAPABILITIES
 * cannot predict carry the same meaning — see the next paragraph.
 *
 * NOT ONLY A VENUE-WIDE CAPABILITY GAP (#1346/#1570). The discriminant means
 * "no retry of this call can protect this residual", and a refusal can earn
 * that per LOT as well as per venue: the Alpaca adapter consumes a
 * `client_order_id` permanently (measured, docs/research/43 round 3), so once
 * a lot has spent every re-arm wire id `MAX_REARM_ATTEMPTS` allows it, every
 * later pass is refused for a fixed reason too. Routing that through this type
 * is deliberate — the remedy below is identical, and a second permanent-gap
 * category would give the operator a second page to learn and this repo a
 * third classification to keep in step. What the two cases do NOT share is
 * blast radius: a venue gap condemns every lot, a spent-ids gap condemns one.
 * `venue` is what says which.
 *
 * This module does not decide what to do about a naked residual; it only lets
 * a caller tell a permanent gap from a transient failure.
 * What is DONE about it was decided by the owner on 2026-09-08 (#1214, option
 * 2 of the three the ticket listed): the residual is re-flattened, not
 * re-armed and not merely alerted — see `reflattenResidual`
 * (residual-reflatten.ts), which both consumers reach from their
 * `isProtectiveRearmUnsupported` branch.
 */

/**
 * INVARIANT: an adapter must throw this OUTSIDE its `sanitizeBrokerError`
 * wrapper (`this.call`). That boundary keeps only the fields `BrokerError`
 * chose (broker-error.ts) and drops everything else, so routing this through
 * it erases the discriminant below and silently restores the
 * "permanent gap reads as transient" behaviour this module exists to end.
 * Both halves are pinned: `protective-rearm-unsupported.test.ts` for the
 * erasure, `saxo-adapter.test.ts` for the live adapter throwing outside it.
 */
export class ProtectiveRearmUnsupportedError extends Error {
  /**
   * Read by `isProtectiveRearmUnsupported` in preference to `instanceof`:
   * this error crosses no realm today, but a duck-typed check also lets a
   * future adapter's own error hierarchy carry the same meaning without
   * inheriting from this class, and cannot break on a duplicated module
   * instance
   */
  readonly protectiveRearmUnsupported = true;
  /**
   * Which venue refused permanently — 'saxo' for the capability gap, 'alpaca'
   * for a lot that has spent every re-arm wire id. Composed here, never from a
   * response body.
   */
  readonly venue: string;

  constructor(venue: string, message: string) {
    super(message);
    this.name = 'ProtectiveRearmUnsupportedError';
    this.venue = venue;
  }
}

export function isProtectiveRearmUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { protectiveRearmUnsupported?: unknown }).protectiveRearmUnsupported === true;
}
