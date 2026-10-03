export interface DateRange {
  start: Date;
  end: Date;
}

export interface InstrumentListing {
  symbol: string;
  delisted_at?: Date;
}

export interface InstrumentRegistry {
  membershipDuring(window: DateRange): Promise<InstrumentListing[]>;
}

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
