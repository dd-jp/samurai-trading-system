import type { OrderSide, V2Bar } from '../../../contracts/index.js';

export interface LimitEntry {
  readonly side: OrderSide;
  readonly limit: number;
  readonly stop: number | undefined;
  readonly trigger?: number | undefined;
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

function stopLimitFill(
  entry: LimitEntry,
  trigger: number,
  bar: QuotedBar,
): { price: number; crossesSpread: boolean } | undefined {
  const buy = entry.side === 'buy';
  if (buy ? bar.high < trigger : bar.low > trigger) return undefined;
  const triggeredAt = buy ? Math.max(bar.open, trigger) : Math.min(bar.open, trigger);
  const withinLimit = buy ? triggeredAt <= entry.limit : triggeredAt >= entry.limit;
  return withinLimit ? { price: triggeredAt, crossesSpread: true } : limitFill(entry, bar);
}

function entryFill(
  entry: LimitEntry,
  bar: QuotedBar,
): { price: number; crossesSpread: boolean } | undefined {
  return entry.trigger === undefined
    ? limitFill(entry, bar)
    : stopLimitFill(entry, entry.trigger, bar);
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
    const fill = entryFill(entry, prices);
    if (fill !== undefined) {
      return { kind: 'filled', bar, ...fill, stoppedAt: stopOnFillBar(entry, fill.price, prices) };
    }
  }
  return { kind: 'cancelled' };
}

export function simulateMarketExit(bars: readonly V2Bar[]): number | undefined {
  const [first] = bars;
  return first === undefined ? undefined : quoted(first).open;
}
