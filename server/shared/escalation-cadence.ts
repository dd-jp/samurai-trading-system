/**
 * The one bounded-repeat rule every "alert after N consecutive, then every
 * M" site runs: fires at `after`, then at `after + every`, `after + 2·every`,
 * … while the count keeps climbing. Each site keeps its own two constants
 * and its own counter (they key and reset differently); only the judgement
 * is shared, so no site can drift to a different arithmetic.
 */
export interface EscalationCadence {
  /** Consecutive count at which the first alert fires */
  readonly after: number;
  /** Further consecutive counts between repeats */
  readonly every: number;
}

export function escalatesAt(consecutive: number, cadence: EscalationCadence): boolean {
  if (consecutive < cadence.after) return false;
  return (consecutive - cadence.after) % cadence.every === 0;
}
