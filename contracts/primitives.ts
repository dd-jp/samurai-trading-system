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

/**
 * The dimension ADR-0018 prices against, one level finer than `AssetClass`.
 *
 * ADR-0018 D2 pools thresholds "per asset-class subclass", and D3/D5 then give
 * three of them different numbers: the 3x index ETP takes a +2.00/-2.16
 * bracket at ~35% of the leg, the 3x single-stock ETP a +6.00/-6.25 bracket at
 * ~25%, and crypto's brackets are explicitly not set by that ADR. `AssetClass`
 * cannot express the split - both ETP subclasses are `'stocks'` - so neither
 * the brackets nor the sizing can be keyed on it.
 *
 * Deliberately NOT a leverage number plus a shape. The measured figures are
 * per-subclass constants, not a function of leverage: ADR-0018 D3's corollary
 * is that "it is not leverage that improves the economics - it is bracket
 * width relative to a fixed cost", and the single-stock bracket is wider than
 * the index one despite identical 3x leverage, because its round trip is 2.3x
 * larger. A `leverage: 3` field would invite deriving what was measured.
 *
 * **`'crypto'` stays, and it is not a leftover.** Every review pass on #712
 * read it as one — reasonably, since ADR-0014's same-day amendment puts crypto
 * out of Samurai's scope "not parked, not staged" — so the reason is recorded
 * here rather than re-argued each round. Three things keep it load-bearing:
 *
 * 1. **`SubclassDeploymentCap.cap` is TOTAL over this union, and that totality
 *    is the safety property.** A subclass missing from the record is not "no
 *    cap", it is a runtime `undefined` that the risk gate now has to throw on
 *    (see `perSubclassDeploymentCap`). Dropping the member does not delete the
 *    question, it deletes the compiler's insistence that someone answer it.
 * 2. **`crypto: null` is an ANSWER, and the only place it is written down.**
 *    It says "doc 18's study covers the two leveraged-ETP subclasses and
 *    measured no envelope here" — as distinct from a number nobody got round
 *    to. That distinction is exactly what ADR-0018 D5 warns must not be lost,
 *    and there is nowhere else in the type system to say it.
 * 3. **`AssetClass` still carries `'crypto'` and so does the running system.**
 *    `DEFAULT_UNIVERSE` holds BTC-USD, the backtest fixtures do, and
 *    `per_asset_class_cap.crypto` still bounds it. A crypto instrument can
 *    therefore still reach the risk gate; removing the subclass would make
 *    that instrument inexpressible in a pool file while remaining tradeable in
 *    a paper profile — a worse gap than the dead member, and a silent one.
 *
 * Out of scope for the PRODUCT is not the same as absent from the RECORD:
 * ADR-0018 D4 itself still enumerates three pooled pairs and notes the crypto
 * one is never selected. This union mirrors the ADR it is named for. If crypto
 * is ever removed from `AssetClass`, remove it here in the same change - that
 * is the coupling to watch, not this member on its own.
 */
export type InstrumentSubclass = 'index_etp_3x' | 'single_stock_etp_3x' | 'crypto';

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
