import { describe, expect, it } from 'vitest';
import { type CfdCatalogue, parseCfdCatalogue } from './data/index.js';
import { ukStockPoolFor } from './index.js';

const TRADING_DATE = '2026-10-15';

interface Row {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  readonly averageVolume30Days: number;
}

function catalogueOf(rows: readonly Row[], asOf: string = TRADING_DATE): CfdCatalogue {
  return parseCfdCatalogue(
    JSON.stringify({
      asOf,
      instruments: rows.map((row, index) => ({
        symbol: row.symbol,
        saxoSymbol: `${row.symbol}:xlon`,
        uic: 100 + index,
        assetType: 'CfdOnStock',
        currency: 'GBP',
        priceToContractFactor: 0.01,
        tradable: true,
        shortTradeDisabled: false,
        borrowCostPerDay: null,
        bid: row.bid,
        ask: row.ask,
        averageVolume30Days: row.averageVolume30Days,
      })),
    }),
  );
}

const LIQUID = { bid: 5, ask: 5.001, averageVolume30Days: 10_000_000 };
const ROWS: Row[] = [
  { symbol: 'RR_XLON', ...LIQUID },
  { symbol: 'WIDE_XLON', bid: 5, ask: 5.5, averageVolume30Days: 10_000_000 },
  { symbol: 'THIN_XLON', bid: 5, ask: 5.001, averageVolume30Days: 1_000 },
  { symbol: 'PENNY_XLON', bid: 0.5, ask: 0.5001, averageVolume30Days: 100_000_000 },
  { symbol: 'AAPL', ...LIQUID },
];

describe('ukStockPoolFor (#1914)', () => {
  it('pools no UK stock while the switch is shut', () => {
    expect(ukStockPoolFor(catalogueOf(ROWS), 'uk_stock_cfd_disabled')).toBeUndefined();
  });

  it('pools the UK stocks that pass all three screens, spread included, once the switch is open', () => {
    expect(ukStockPoolFor(catalogueOf(ROWS), undefined)?.(TRADING_DATE)).toEqual(['RR_XLON']);
  });

  it('pools nothing from a missing catalogue or one not fresh on the trading date', () => {
    expect(ukStockPoolFor(undefined, undefined)?.(TRADING_DATE)).toEqual([]);
    expect(ukStockPoolFor(catalogueOf(ROWS, '2026-10-01'), undefined)?.(TRADING_DATE)).toEqual([]);
  });
});
