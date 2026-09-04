import type { SettledOutcome } from '../lib/ledger.ts';
import { OUTCOME_WORD, SEAL_GLYPH } from '../lib/vocabulary.ts';

/**
 * A hanko seal — the one piece of motif the v3 design keeps beside the brand
 * mark. The glyph is decoration for the outcome word that always sits beside
 * it; the seal itself is announced by that word so the glyph is never the
 * only carrier.
 */
export function Seal({ outcome }: { outcome: SettledOutcome }) {
  return (
    <span className={`seal seal-${outcome}`} role="img" aria-label={OUTCOME_WORD[outcome]}>
      {SEAL_GLYPH[outcome]}
    </span>
  );
}
