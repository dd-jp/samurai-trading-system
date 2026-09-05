/**
 * The verdict-ledger accumulation rule (#1141, F7). Folds each polled
 * snapshot's pipeline view into `lib/ledger.ts`'s pure transition, so the
 * rule — not just `updateLedger` in isolation — is testable without
 * rendering `<App/>`.
 */
import { useEffect, useState } from 'react';
import { createLedger, type LedgerEntry, updateLedger } from '../lib/ledger.ts';
import type { WireSnapshot } from './useSnapshot.ts';

export function useLedger(snapshot: WireSnapshot | null): readonly LedgerEntry[] {
  const [ledger, setLedger] = useState(createLedger);

  useEffect(() => {
    if (snapshot === null) return;
    setLedger((state) => updateLedger(state, snapshot.pipeline));
  }, [snapshot]);

  return ledger.entries;
}
