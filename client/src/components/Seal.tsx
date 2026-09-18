import type { SettledOutcome } from '../lib/ledger.ts';
import { OUTCOME_WORD, SEAL_GLYPH } from '../lib/vocabulary.ts';

export function Seal({ outcome }: { outcome: SettledOutcome }) {
  return (
    <span className={`seal seal-${outcome}`} role="img" aria-label={OUTCOME_WORD[outcome]}>
      {SEAL_GLYPH[outcome]}
    </span>
  );
}
