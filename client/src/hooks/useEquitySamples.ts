/**
 * The equity-sampling rule (#1141, F7): dedupes an unchanged poll (same
 * `observed_at` AND same `equity`), refuses non-finite equity, skips when
 * the balance is absent, and caps the series at `MAX_EQUITY_SAMPLES` by
 * dropping from the front. Previously reachable only by rendering `<App/>`.
 */
import { useEffect, useState } from 'react';
import type { WireSnapshot } from './useSnapshot.ts';

export const MAX_EQUITY_SAMPLES = 120;

export interface EquitySample {
  observed_at: string | null;
  equity: number;
}

export function useEquitySamples(snapshot: WireSnapshot | null): readonly EquitySample[] {
  const [samples, setSamples] = useState<readonly EquitySample[]>([]);

  useEffect(() => {
    if (snapshot === null) return;
    const alpaca = snapshot.providers.alpaca;
    const balance = alpaca.balance;
    if (balance === null || !Number.isFinite(balance.equity)) return;
    setSamples((prev) => {
      const last = prev[prev.length - 1];
      if (
        last !== undefined &&
        last.observed_at === alpaca.observed_at &&
        last.equity === balance.equity
      ) {
        return prev;
      }
      return [...prev, { observed_at: alpaca.observed_at, equity: balance.equity }].slice(
        -MAX_EQUITY_SAMPLES,
      );
    });
  }, [snapshot]);

  return samples;
}
