export interface EscalationCadence {
  readonly after: number;
  readonly every: number;
}

export function escalatesAt(consecutive: number, cadence: EscalationCadence): boolean {
  if (consecutive < cadence.after) return false;
  return (consecutive - cadence.after) % cadence.every === 0;
}
