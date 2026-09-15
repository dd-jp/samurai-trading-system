/**
 * The declared sizing ceiling (#511) as a type that cannot hold an unusable
 * figure: `NaN` reads as "no bound" through `Math.min` (#569), `0` clamps
 * every size to zero and a negative reaches `decide`'s arithmetic as a
 * negative size. A `CapitalCeilingUsd` in hand is proof `toCapitalCeilingUsd`
 * ran; the brand is compile-time only, so never mint one with `as`.
 */
export type CapitalCeilingUsd = number & { readonly __brand: 'CapitalCeilingUsd' };

/**
 * `source` is what the caller is asked to fix — a variable name or an
 * argument name, never a credential; the ceiling itself is not secret, and
 * quoting it back is what makes a typo visible
 */
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
