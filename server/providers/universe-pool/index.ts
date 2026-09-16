/**
 * Universe pool — the LSE ETP roster (ADR-0016) and the lookups over it.
 * See docs/coding-standards.md: cross-module imports go through this barrel,
 * not `universe-pool/lse-etp-pool.js` directly.
 */

export type { LseEtpPoolRow } from './lse-etp-pool.js';
export {
  buildRoutingMap,
  LSE_ETP_POOL,
  liveSizingSubclassFor,
  resolveMiSubject,
  screeningInstrumentFor,
  tradeableUniverse,
} from './lse-etp-pool.js';
