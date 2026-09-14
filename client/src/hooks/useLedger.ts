/**
 * The verdict-ledger accumulation rule (#1141, F7). Folds each polled
 * snapshot's pipeline view into `lib/ledger.ts`'s pure transition, so the
 * rule — not just `updateLedger` in isolation — is testable without
 * rendering `<App/>`.
 *
 * Takes a non-null `WireSnapshot` (#1520): it runs below the root's
 * cold-start gate, so "no snapshot yet" is not a state it can observe.
 */
import { useEffect, useState } from 'react';
import { createLedger, type LedgerEntry, updateLedger } from '../lib/ledger.ts';
import type { WireSnapshot } from './useSnapshot.ts';

export function useLedger(snapshot: WireSnapshot): readonly LedgerEntry[] {
  const [ledger, setLedger] = useState(createLedger);

  useEffect(() => {
    setLedger((state) => updateLedger(state, snapshot.pipeline));
  }, [snapshot]);

  return ledger.entries;
}
