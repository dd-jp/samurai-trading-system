import type { OrderSide, V2Bar } from '../../../contracts/index.js';

export interface LimitEntry {
  readonly side: OrderSide;
  readonly limit: number;
  readonly stop: number | undefined;
}

export type LimitEntryOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'filled';
      readonly bar: V2Bar;
      readonly price: number;
      readonly crossesSpread: boolean;
      readonly stoppedAt: number | undefined;
    };

interface QuotedBar {
  readonly open: number;
  readonly low: number;
  readonly high: number;
}

function quoted(bar: V2Bar): QuotedBar {
  const toQuoted = bar.rawClose / bar.close;
  return { open: bar.open * toQuoted, low: bar.low * toQuoted, high: bar.high * toQuoted };
}

function limitFill(
  entry: LimitEntry,
  bar: QuotedBar,
): { price: number; crossesSpread: boolean } | undefined {
  if (entry.side === 'buy') {
    if (bar.low > entry.limit) return undefined;
    return { price: Math.min(bar.open, entry.limit), crossesSpread: bar.open < entry.limit };
  }
  if (bar.high < entry.limit) return undefined;
  return { price: Math.max(bar.open, entry.limit), crossesSpread: bar.open > entry.limit };
}

function stopOnFillBar(entry: LimitEntry, price: number, bar: QuotedBar): number | undefined {
  if (entry.stop === undefined) return undefined;
  if (entry.side === 'buy') return bar.low <= entry.stop ? Math.min(entry.stop, price) : undefined;
  return bar.high >= entry.stop ? Math.max(entry.stop, price) : undefined;
}

export function simulateLimitEntry(entry: LimitEntry, bars: readonly V2Bar[]): LimitEntryOutcome {
  if (bars.length === 0) return { kind: 'pending' };
  for (const bar of bars) {
    const prices = quoted(bar);
    const fill = limitFill(entry, prices);
    if (fill !== undefined) {
      return { kind: 'filled', bar, ...fill, stoppedAt: stopOnFillBar(entry, fill.price, prices) };
    }
  }
  return { kind: 'cancelled' };
}
