import type { CfdInstrument } from './cfd-catalogue.js';

// No S&P 500 ticker carries an underscore (Alpaca writes share classes as BRK.B), so a UK stock
// key can never clash with a US name in the catalogue, the bar store or the router (#1914)
const UK_STOCK_SUFFIX = '_XLON';

export function ukStockKey(saxoSymbol: string): string {
  return `${(saxoSymbol.split(':')[0] ?? '').toUpperCase()}${UK_STOCK_SUFFIX}`;
}

export function isUkStock(symbol: string): boolean {
  return symbol.length > UK_STOCK_SUFFIX.length && symbol.endsWith(UK_STOCK_SUFFIX);
}

export function ukStockTidm(symbol: string): string {
  return isUkStock(symbol) ? symbol.slice(0, -UK_STOCK_SUFFIX.length) : symbol;
}

export interface UkStockScreens {
  readonly minAdvGbp: number;
  readonly maxSpreadBps: number;
  readonly minPricePence: number;
}

export type UkStockScreenOutcome =
  | 'pass'
  | 'not_tradable'
  | 'no_quote'
  | 'price'
  | 'adv'
  | 'spread';

const PENCE_PER_POUND = 100;

function quoteOf(instrument: CfdInstrument) {
  const { bid, ask, averageVolume30Days } = instrument;
  if (bid === undefined || ask === undefined || averageVolume30Days === undefined) return undefined;
  if (!(bid > 0 && ask >= bid)) return undefined;
  return { bid, ask, mid: (bid + ask) / 2, averageVolume30Days };
}

export function screenUkStock(
  instrument: CfdInstrument,
  screens: UkStockScreens,
): UkStockScreenOutcome {
  if (!instrument.tradable) return 'not_tradable';
  const quote = quoteOf(instrument);
  if (quote === undefined) return 'no_quote';
  if (quote.mid * PENCE_PER_POUND < screens.minPricePence) return 'price';
  if (quote.averageVolume30Days * quote.mid < screens.minAdvGbp) return 'adv';
  const spreadBps = ((quote.ask - quote.bid) / quote.mid) * 10_000;
  return spreadBps > screens.maxSpreadBps ? 'spread' : 'pass';
}

// The spread is read on the pre-open delayed quote and moves day to day; a pool that followed it
// would drop a name, let its bars go stale, then take it back
export function inUkStockBarPool(instrument: CfdInstrument, screens: UkStockScreens): boolean {
  if (!isUkStock(instrument.symbol)) return false;
  const outcome = screenUkStock(instrument, screens);
  return outcome === 'pass' || outcome === 'spread';
}

export function inUkStockUniversePool(instrument: CfdInstrument, screens: UkStockScreens): boolean {
  return isUkStock(instrument.symbol) && screenUkStock(instrument, screens) === 'pass';
}

export function ukStockScreenCounts(
  instruments: readonly CfdInstrument[],
  screens: UkStockScreens,
): Readonly<Record<UkStockScreenOutcome, number>> {
  const counts: Record<UkStockScreenOutcome, number> = {
    pass: 0,
    not_tradable: 0,
    no_quote: 0,
    price: 0,
    adv: 0,
    spread: 0,
  };
  for (const instrument of instruments) {
    if (isUkStock(instrument.symbol)) counts[screenUkStock(instrument, screens)] += 1;
  }
  return counts;
}
