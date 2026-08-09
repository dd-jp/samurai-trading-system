/**
 * Domain vocabulary shared by both runtimes.
 *
 * These unions were previously defined inside server modules
 * (`shared/types/primitives.ts`, `debate-engine/types.ts`,
 * `shared/store/open-shared-store.ts`, `shared/types/records.ts`) and reached
 * the browser only because the wire shapes that reference them imported them
 * from there — which is what made the client's TypeScript program include
 * server source. They live here now, and those modules re-export from this
 * file, so there is exactly one definition and the old import paths keep
 * working.
 *
 * Nothing in `contracts/` may import from a sibling of this directory. That is
 * the invariant the whole module exists to hold: if the wire contract can
 * reach into the server, the client can too, and the boundary is decorative.
 */

/** Which market an instrument trades in. Drives session/calendar handling. */
export type AssetClass = 'crypto' | 'stocks';

/** A directional stance — an analyst's, or a debate's conclusion. */
export type Direction = 'bullish' | 'bearish' | 'neutral';

/**
 * The three store modes, as a runtime array because `resolveStoreMode` both
 * validates against it and names it in its error text.
 */
export const STORE_MODES = ['paper', 'live', 'backtest'] as const;

export type StoreMode = (typeof STORE_MODES)[number];

/** Lifecycle of a broker order, from intent through terminal state. */
export type OrderState =
  | 'pending'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'closed'
  | 'cancelled'
  | 'rejected'
  | 'expired';
