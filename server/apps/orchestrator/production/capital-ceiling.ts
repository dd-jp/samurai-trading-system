export type CapitalCeilingUsd = number & { readonly __brand: 'CapitalCeilingUsd' };

export function toCapitalCeilingUsd(value: number, source: string): CapitalCeilingUsd {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Orchestrator cannot start: ${source} must be a positive, finite number of US dollars, ` +
        `but it is ${String(value)}. Refusing to fall back to a default ceiling — this is the ` +
        'one figure a live run may not guess at.',
    );
  }
  return value as CapitalCeilingUsd;
}
