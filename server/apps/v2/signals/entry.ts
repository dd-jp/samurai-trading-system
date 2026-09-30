import type { SignalWire } from '../../../../contracts/index.js';
import { SIGNAL_MIN_REWARD_R } from '../signal/index.js';

export interface SignalEntryPlan {
  readonly limit: number;
  readonly trigger: number | undefined;
  readonly stop: number;
  readonly target: number;
  readonly riskPerShare: number;
}

export type SignalEntryRefusal = 'last_close_at_or_below_stop';

export type SignalEntryVerdict =
  | { readonly ok: true; readonly plan: SignalEntryPlan }
  | { readonly ok: false; readonly refusal: SignalEntryRefusal; readonly detail: string };

type SignalLevels = Pick<SignalWire, 'entry' | 'targets' | 'stop'>;

export function entryRange(entry: SignalWire['entry']): { low: number; high: number } {
  return typeof entry === 'number'
    ? { low: entry, high: entry }
    : { low: entry[0], high: entry[1] };
}

export function bracketTarget(limit: number, stop: number, targets: readonly number[]): number {
  const floor = limit + SIGNAL_MIN_REWARD_R * (limit - stop);
  const target = targets.find((candidate) => candidate >= floor) ?? targets.at(-1);
  if (target === undefined) throw new Error('bracketTarget: a signal has at least one target');
  return target;
}

// A buy-stop enters as a stop-limit parent (accepted on Alpaca paper 2026-09-30, legs held): it
// triggers at the zone low and never fills above the limit, so R sized on the limit is the worst case
export function planSignalEntry(signal: SignalLevels, lastClose: number): SignalEntryVerdict {
  const { low, high } = entryRange(signal.entry);
  if (lastClose <= signal.stop) {
    return {
      ok: false,
      refusal: 'last_close_at_or_below_stop',
      detail: `last close ${lastClose} is at or below the stop ${signal.stop}`,
    };
  }
  return {
    ok: true,
    plan: {
      limit: high,
      trigger: low > lastClose ? low : undefined,
      stop: signal.stop,
      target: bracketTarget(high, signal.stop, signal.targets),
      riskPerShare: high - signal.stop,
    },
  };
}
