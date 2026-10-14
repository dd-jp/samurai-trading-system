import { describe, expect, it } from 'vitest';
import { LSE_LINES } from '../signal/index.js';
import type { CfdInstrument } from './cfd-catalogue.js';
import {
  isUkStock,
  screenUkStock,
  type UkStockScreenOutcome,
  type UkStockScreens,
  ukStockKey,
  ukStockScreenCounts,
  ukStockTidm,
} from './uk-stocks.js';

const SCREENS: UkStockScreens = { minAdvGbp: 5_000_000, maxSpreadBps: 25, minPricePence: 100 };

function ukStock(overrides: Partial<CfdInstrument> = {}): CfdInstrument {
  return {
    symbol: 'RR_XLON',
    saxoSymbol: 'RR:xlon',
    uic: 900,
    assetType: 'CfdOnStock',
    currency: 'GBP',
    priceToContractFactor: 0.01,
    tradable: true,
    shortTradeDisabled: false,
    borrowCostPerDay: undefined,
    priceCurrency: 'GBX',
    bid: 4.999,
    ask: 5.001,
    averageVolume30Days: 1_000_000,
    ...overrides,
  };
}

function without(key: 'bid' | 'ask' | 'averageVolume30Days'): CfdInstrument {
  const { [key]: _, ...rest } = ukStock();
  return rest;
}

describe('ukStockKey', () => {
  it('keeps the ticker, upper-cased, and swaps the exchange suffix for _XLON', () => {
    expect(ukStockKey('RR:xlon')).toBe('RR_XLON');
    expect(ukStockKey('CPG_NEW:xlon')).toBe('CPG_NEW_XLON');
    expect(ukStockKey('bt.a:xlon')).toBe('BT.A_XLON');
  });

  it('never yields a key a US universe symbol or an LSE line can equal', () => {
    expect(isUkStock(ukStockKey('TSCO:xlon'))).toBe(true);
    expect(isUkStock('TSCO')).toBe(false);
    expect(isUkStock('_XLON')).toBe(false);
    expect(isUkStock('BRK.B')).toBe(false);
    for (const { tidm } of LSE_LINES) expect(isUkStock(tidm)).toBe(false);
  });
});

describe('ukStockTidm', () => {
  it('takes the exchange key back off a UK stock and leaves any other symbol alone', () => {
    expect(ukStockTidm('RR_XLON')).toBe('RR');
    expect(ukStockTidm('CPG_NEW_XLON')).toBe('CPG_NEW');
    expect(ukStockTidm('VOD')).toBe('VOD');
  });
});

describe('screenUkStock', () => {
  it('passes a liquid, tight, pound-plus stock', () => {
    expect(screenUkStock(ukStock(), SCREENS)).toBe('pass');
  });

  it.each<[string, CfdInstrument, UkStockScreenOutcome]>([
    ['not tradable', ukStock({ tradable: false }), 'not_tradable'],
    ['no bid', without('bid'), 'no_quote'],
    ['no ask', without('ask'), 'no_quote'],
    ['no volume', without('averageVolume30Days'), 'no_quote'],
    ['a zero bid', ukStock({ bid: 0 }), 'no_quote'],
    ['a crossed quote', ukStock({ bid: 5.01, ask: 5 }), 'no_quote'],
    ['a sub-pound price', ukStock({ bid: 0.999, ask: 0.999, averageVolume30Days: 1e9 }), 'price'],
    ['a thin 30-day volume', ukStock({ averageVolume30Days: 999_000 }), 'adv'],
    ['a wide spread', ukStock({ bid: 4.99, ask: 5.01 }), 'spread'],
  ])('refuses %s', (_, instrument, outcome) => {
    expect(screenUkStock(instrument, SCREENS)).toBe(outcome);
  });

  it('holds each floor inclusive: £1, £5m a day, 25 bps', () => {
    expect(
      screenUkStock(ukStock({ bid: 1, ask: 1, averageVolume30Days: 5_000_000 }), SCREENS),
    ).toBe('pass');
    expect(screenUkStock(ukStock({ bid: 4.99375, ask: 5.00625 }), SCREENS)).toBe('pass');
    expect(screenUkStock(ukStock({ bid: 4.9937, ask: 5.0063 }), SCREENS)).toBe('spread');
  });
});

describe('ukStockScreenCounts', () => {
  it('counts only UK stock rows, by outcome', () => {
    const counts = ukStockScreenCounts(
      [
        ukStock(),
        ukStock({ symbol: 'BP_XLON', tradable: false }),
        ukStock({ symbol: 'AAPL', currency: 'USD', tradable: false }),
      ],
      SCREENS,
    );
    expect(counts).toEqual({
      pass: 1,
      not_tradable: 1,
      no_quote: 0,
      price: 0,
      adv: 0,
      spread: 0,
    });
  });
});
