/**
 * Survivorship-free universe validation (ticket #88). See
 * docs/specs/cost-model-backtest-spec.md ("Module: Backtest Harness" —
 * survivorship) and user story 9: the harness *requires* survivorship-free
 * data so a replay is not run only on today's winners.
 *
 * The harness asserts the contract; it does not source the data. Cross-spec
 * contract #5 puts the survivorship-free historical store on the Market Data
 * Service, which owns the real `InstrumentRegistry` implementation — this
 * module only holds the seam the harness checks against.
 */

export interface DateRange {
  start: Date;
  end: Date;
}

/** One instrument's point-in-time listing status over the replay window. */
export interface InstrumentListing {
  symbol: string;
  /**
   * When the instrument was delisted/removed. `undefined` means it was still
   * listed at the end of the window. A delisted name is exactly the kind of
   * loser a survivorship-biased universe silently drops.
   */
  delisted_at?: Date;
}

/**
 * Point-in-time membership of the universe *definition* over a window — for
 * example "the S&P 500 constituents as known at each point in the window",
 * not "the constituents as of today". The registry must therefore report the
 * names that were members during the window and have since been delisted or
 * removed; a registry that only reports survivors cannot support this check.
 */
export interface InstrumentRegistry {
  membershipDuring(window: DateRange): Promise<InstrumentListing[]>;
}

/** Thrown when the configured universe has had delisted/removed names dropped. */
export class SurvivorshipViolationError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `Survivorship-biased universe: ${missing.length} instrument(s) were members during the ` +
        `replay window but were delisted/removed and are absent from the configured universe ` +
        `(${missing.join(', ')}). Replaying only the survivors manufactures an edge; add the ` +
        `delisted names or widen the registry's window.`,
    );
    this.name = 'SurvivorshipViolationError';
  }
}

/**
 * Asserts the configured universe retains every name that was a member during
 * the window and was delisted/removed within it.
 *
 * Only *delisted* members are required: a universe legitimately narrower than
 * the registry's membership (replaying one instrument, say) is a selection
 * choice, whereas a universe that keeps the still-listed members and omits the
 * delisted ones is survivorship bias by construction. Names still listed at
 * the end of the window are therefore not required to be present, and extra
 * names beyond the registry's membership are left alone.
 */
export async function assertSurvivorshipFree(
  universe: readonly string[],
  window: DateRange,
  registry: InstrumentRegistry,
): Promise<void> {
  const configured = new Set(universe);
  const membership = await registry.membershipDuring(window);

  const missing = membership
    .filter((listing) => listing.delisted_at !== undefined)
    .map((listing) => listing.symbol)
    .filter((symbol) => !configured.has(symbol));

  if (missing.length > 0) {
    throw new SurvivorshipViolationError(missing);
  }
}
