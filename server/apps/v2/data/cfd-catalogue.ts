import { existsSync, readFileSync } from 'node:fs';
import { addDays } from './macro-calendar.js';
import type { QuoteCurrency } from './venues.js';

export const CFD_CATALOGUE_MAX_AGE_CALENDAR_DAYS = 3;
const DAYS_PER_YEAR = 365;

export type CfdAssetType = 'CfdOnStock' | 'CfdOnIndex' | 'CfdOnEtf';

export interface CfdInstrument {
  readonly symbol: string;
  readonly saxoSymbol: string;
  readonly uic: number;
  readonly assetType: CfdAssetType;
  readonly currency: QuoteCurrency;
  readonly priceToContractFactor: number;
  readonly tradable: boolean;
  readonly shortTradeDisabled: boolean;
  readonly borrowCostPerDay: number | undefined;
}

export interface CfdCatalogueSnapshot {
  readonly asOf: string;
  readonly instruments: readonly CfdInstrument[];
}

const ASSET_TYPES: readonly string[] = ['CfdOnStock', 'CfdOnIndex', 'CfdOnEtf'];
const CURRENCIES: readonly string[] = ['GBP', 'USD'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalBorrow(value: unknown): number | undefined | 'invalid' {
  if (value === null || value === undefined) return undefined;
  return isNonNegative(value) ? value : 'invalid';
}

interface RawInstrument {
  readonly symbol: string;
  readonly saxoSymbol: string;
  readonly uic: number;
  readonly assetType: CfdAssetType;
  readonly currency: QuoteCurrency;
  readonly priceToContractFactor: number;
  readonly tradable: boolean;
  readonly shortTradeDisabled: boolean;
}

const FIELD_CHECKS: readonly (readonly [keyof RawInstrument, (value: unknown) => boolean])[] = [
  ['symbol', (value) => typeof value === 'string' && value !== ''],
  ['saxoSymbol', (value) => typeof value === 'string'],
  ['uic', isPositive],
  ['assetType', (value) => ASSET_TYPES.includes(String(value))],
  ['currency', (value) => CURRENCIES.includes(String(value))],
  ['priceToContractFactor', isPositive],
  ['tradable', (value) => typeof value === 'boolean'],
  ['shortTradeDisabled', (value) => typeof value === 'boolean'],
];

function isRawInstrument(raw: unknown): raw is RawInstrument {
  return isRecord(raw) && FIELD_CHECKS.every(([key, valid]) => valid(raw[key]));
}

function parseInstrument(raw: unknown): CfdInstrument {
  const borrow = isRecord(raw) ? optionalBorrow(raw.borrowCostPerDay) : 'invalid';
  if (!isRawInstrument(raw) || borrow === 'invalid') {
    throw new Error(`CFD catalogue: malformed instrument ${JSON.stringify(raw)}`);
  }
  return {
    symbol: raw.symbol,
    saxoSymbol: raw.saxoSymbol,
    uic: raw.uic,
    assetType: raw.assetType,
    currency: raw.currency,
    priceToContractFactor: raw.priceToContractFactor,
    tradable: raw.tradable,
    shortTradeDisabled: raw.shortTradeDisabled,
    borrowCostPerDay: borrow,
  };
}

export class CfdCatalogue {
  readonly #bySymbol = new Map<string, CfdInstrument>();

  constructor(private readonly snapshot: CfdCatalogueSnapshot) {
    for (const instrument of snapshot.instruments) {
      this.#bySymbol.set(instrument.symbol, instrument);
    }
  }

  lookup(symbol: string): CfdInstrument | undefined {
    return this.#bySymbol.get(symbol);
  }

  freshOn(tradingDate: string): boolean {
    return addDays(this.snapshot.asOf, CFD_CATALOGUE_MAX_AGE_CALENDAR_DAYS) >= tradingDate;
  }
}

export function parseCfdCatalogue(text: string): CfdCatalogue {
  const body: unknown = JSON.parse(text);
  if (!isRecord(body) || typeof body.asOf !== 'string' || !Array.isArray(body.instruments)) {
    throw new Error('CFD catalogue: expected { asOf, instruments[] }');
  }
  return new CfdCatalogue({
    asOf: body.asOf,
    instruments: body.instruments.map(parseInstrument),
  });
}

export function loadCfdCatalogue(path: string): CfdCatalogue | undefined {
  if (!existsSync(path)) return undefined;
  return parseCfdCatalogue(readFileSync(path, 'utf8'));
}

export function borrowCostPerYear(instrument: CfdInstrument): number | undefined {
  return instrument.borrowCostPerDay === undefined
    ? undefined
    : instrument.borrowCostPerDay * DAYS_PER_YEAR;
}
