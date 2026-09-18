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
