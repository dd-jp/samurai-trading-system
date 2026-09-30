import type { SignalWire } from '../../../../contracts/index.js';
import { SIGNAL_MIN_REWARD_R } from '../signal/index.js';

export interface SignalEntryPlan {
  readonly limit: number;
  readonly stop: number;
  readonly target: number;
  readonly riskPerShare: number;
}

export type SignalEntryRefusal = 'entry_is_buy_stop' | 'last_close_at_or_below_stop';

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

// The Alpaca adapter submits a limit parent only, and Alpaca's documentation shows no stop parent
// in a bracket: an entry wholly above the last close would go in as a marketable limit, buying
// below the level the signal waits for, so it is refused until a stop parent is verified (#1941)
export function planSignalEntry(signal: SignalLevels, lastClose: number): SignalEntryVerdict {
  const { low, high } = entryRange(signal.entry);
  if (lastClose <= signal.stop) {
    return {
      ok: false,
      refusal: 'last_close_at_or_below_stop',
      detail: `last close ${lastClose} is at or below the stop ${signal.stop}`,
    };
  }
  if (low > lastClose) {
    return {
      ok: false,
      refusal: 'entry_is_buy_stop',
      detail: `entry ${low} is above the last close ${lastClose}: a buy-stop, and no stop-parent bracket is verified on Alpaca`,
    };
  }
  return {
    ok: true,
    plan: {
      limit: high,
      stop: signal.stop,
      target: bracketTarget(high, signal.stop, signal.targets),
      riskPerShare: high - signal.stop,
    },
  };
}
