import type { InstrumentDetails } from './saxo-api.js';

export type QuoteUnit = 'GBX' | 'GBP' | 'USD';

export interface SaxoLine {
  readonly tidm: string;
  readonly uic: number;
  readonly assetType: 'Etf' | 'Etc';
  readonly unit: QuoteUnit;
  readonly role: string;
}

export interface SplicedLine extends SaxoLine {
  readonly unit: 'GBX' | 'GBP';
  readonly spliceFrom: SaxoLine & { readonly unit: 'USD' };
}

export const LSE_MOMENTUM_LINES: readonly (SaxoLine | SplicedLine)[] = [
  { tidm: 'ISF', uic: 4361, assetType: 'Etf', unit: 'GBX', role: 'UK large cap' },
  { tidm: 'VMID', uic: 1207647, assetType: 'Etf', unit: 'GBP', role: 'UK mid cap' },
  { tidm: 'CUKS', uic: 435060, assetType: 'Etf', unit: 'GBX', role: 'UK small cap' },
  { tidm: 'IUSA', uic: 19727, assetType: 'Etf', unit: 'GBX', role: 'US large cap' },
  { tidm: 'CUS1', uic: 53915, assetType: 'Etf', unit: 'GBX', role: 'US small cap' },
  { tidm: 'IEUX', uic: 53888, assetType: 'Etf', unit: 'GBX', role: 'Europe ex-UK' },
  { tidm: 'IJPN', uic: 19726, assetType: 'Etf', unit: 'GBX', role: 'Japan' },
  { tidm: 'CPJ1', uic: 969857, assetType: 'Etf', unit: 'GBX', role: 'Pacific ex-Japan' },
  { tidm: 'IEEM', uic: 21528, assetType: 'Etf', unit: 'GBX', role: 'Emerging markets' },
  { tidm: 'IITU', uic: 9404259, assetType: 'Etf', unit: 'GBX', role: 'US tech sector' },
  {
    tidm: 'IHCU',
    uic: 25583531,
    assetType: 'Etf',
    unit: 'GBX',
    role: 'US health sector',
    spliceFrom: {
      tidm: 'IUHC',
      uic: 4925944,
      assetType: 'Etf',
      unit: 'USD',
      role: 'US health sector (USD LSE line, same fund IE00B43HR379)',
    },
  },
  { tidm: 'IESU', uic: 56577302, assetType: 'Etf', unit: 'GBX', role: 'US energy sector' },
  { tidm: 'UIFS', uic: 9140117, assetType: 'Etf', unit: 'GBX', role: 'US financials sector' },
  {
    tidm: 'ICDU',
    uic: 56577120,
    assetType: 'Etf',
    unit: 'GBX',
    role: 'US consumer-discretionary sector',
  },
  { tidm: 'SPGP', uic: 117643, assetType: 'Etf', unit: 'GBX', role: 'Gold producers' },
  { tidm: 'SPOG', uic: 3669356, assetType: 'Etf', unit: 'GBX', role: 'Oil and gas producers' },
  { tidm: 'IUKP', uic: 37368, assetType: 'Etf', unit: 'GBX', role: 'UK property' },
  { tidm: 'IGLT', uic: 52706, assetType: 'Etf', unit: 'GBP', role: 'Gilts, all maturities' },
  { tidm: 'INXG', uic: 205626, assetType: 'Etf', unit: 'GBP', role: 'Index-linked gilts' },
  { tidm: 'SLXX', uic: 275764, assetType: 'Etf', unit: 'GBP', role: 'Sterling corporate bonds' },
  { tidm: 'VUTY', uic: 7962187, assetType: 'Etf', unit: 'GBP', role: 'US Treasuries' },
  { tidm: 'SGLN', uic: 54130, assetType: 'Etc', unit: 'GBX', role: 'Gold (ETC)' },
  { tidm: 'SSLN', uic: 117644, assetType: 'Etc', unit: 'GBX', role: 'Silver (ETC)' },
  {
    tidm: 'CMFP',
    uic: 12264631,
    assetType: 'Etf',
    unit: 'GBX',
    role: 'Broad commodities',
    spliceFrom: {
      tidm: 'COMF',
      uic: 46434,
      assetType: 'Etf',
      unit: 'USD',
      role: 'Broad commodities (USD LSE line, same fund IE00B4WPHX27)',
    },
  },
];

export function isSpliced(line: SaxoLine | SplicedLine): line is SplicedLine {
  return 'spliceFrom' in line;
}

export function gbpPerQuotedUnit(unit: QuoteUnit): number {
  if (unit === 'GBX') return 0.01;
  if (unit === 'GBP') return 1;
  throw new Error(`gbpPerQuotedUnit: ${unit} needs an FX rate, not a unit factor`);
}

export function assertUnitMatchesSaxo(line: SaxoLine, details: InstrumentDetails): void {
  const expected = line.unit === 'USD' ? 1 : gbpPerQuotedUnit(line.unit);
  if (details.priceToContractFactor !== expected) {
    throw new Error(
      `${line.tidm}: LSE list says ${line.unit} (factor ${expected}) but Saxo PriceToContractFactor is ${details.priceToContractFactor}`,
    );
  }
}
