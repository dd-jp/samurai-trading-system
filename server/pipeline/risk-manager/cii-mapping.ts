/**
 * Samurai-owned static instrument -> country/region mapping for the CII soft
 * signal (ticket #205). See docs/specs/risk-manager-spec.md ("Module: CII
 * Soft Signal"): independent of and not trusting WorldMonitor's own tagging
 * — lives alongside the v1 static concentration buckets. Country codes match
 * whatever WorldMonitor's `wm.risk(countryCode)` expects (ADR-0002 §5); an
 * instrument absent from this table has no CII exposure and is simply
 * skipped by the soft-signal check, not defaulted to a country.
 */
const INSTRUMENT_COUNTRY: Record<string, string> = {
  // Russian ADRs / Russia-exposed instruments.
  YNDX: 'RU',
  MBT: 'RU',
  // Middle East-exposed energy majors.
  ARAMCO: 'SA',
  // China-exposed instruments.
  BABA: 'CN',
  JD: 'CN',
};

/** Returns the static country/region code for an instrument, or null if unmapped. */
export function countryForInstrument(instrument: string): string | null {
  return INSTRUMENT_COUNTRY[instrument] ?? null;
}

/**
 * Distinct country/region codes this mapping ever resolves to (#182). WorldMonitor's own CII
 * covers 31 "Tier-1" countries (docs/research/archive/2026-07-22-worldmonitor-as-mi-source.md), but that list
 * isn't enumerable through `CiiScoreProvider` (no discovery method — see cii-consumer.ts) and
 * isn't reproduced here. Snapshotting exactly this mapping's codes instead is the defensible
 * subset for #182's eventual goal (correlating CII against *Samurai's own* asset drawdowns):
 * a country absent from this mapping has no instrument to correlate against anyway.
 */
export function trackedCountries(): string[] {
  return [...new Set(Object.values(INSTRUMENT_COUNTRY))];
}
