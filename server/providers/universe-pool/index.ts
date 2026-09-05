/**
 * Universe pool — the LSE ETP roster (ADR-0016) and the lookups over it.
 * See docs/coding-standards.md: cross-module imports go through this barrel,
 * not `universe-pool/lse-etp-pool.js` directly.
 */

export type {
  EtpDirection,
  LiquidityGateStatus,
  LseEtpPoolRow,
  RowProvenance,
  SaxoTradeability,
} from './lse-etp-pool.js';
export {
  assertKnownSubclass,
  assertValidFallbackSubset,
  assertValidPool,
  buildRoutingMap,
  countRankableUnderlyings,
  FALLBACK_DEFAULT_MAX_ROWS,
  gateAdmits,
  KNOWN_SUBCLASSES,
  LSE_ETP_POOL,
  liquidityGateStatus,
  liveSizingSubclassFor,
  resolveMiSubject,
  screeningInstrumentFor,
  UnknownSubclassError,
} from './lse-etp-pool.js';
