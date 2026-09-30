import { existsSync, readFileSync } from 'node:fs';
import { addDays } from './macro-calendar.js';
import type { QuoteCurrency } from './venues.js';

export const CFD_CATALOGUE_PATH = 'data/saxo-cfd-catalogue.json';
export const CFD_CATALOGUE_MAX_AGE_CALENDAR_DAYS = 3;
// Measured on the live infoprices/list, 2026-09-30: Saxo's USD CfdBorrowingCost is the annual
// rate / 360 (0.5% reads 0.0000138889 a day), its GBP one the annual rate / 365 (ISF's 2%)
const BORROW_DAY_COUNT: Readonly<Record<QuoteCurrency, number>> = { USD: 360, GBP: 365 };

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
  return Object(value) === value;
}

function isPositive(value: unknown): value is number {
  return Number.isFinite(value) && (value as number) > 0;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value)
  );
}

function isNonNegative(value: unknown): value is number {
  return Number.isFinite(value) && (value as number) >= 0;
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
  readonly borrowCostPerDay?: number | null;
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
  ['borrowCostPerDay', (value) => value === undefined || value === null || isNonNegative(value)],
];

function isRawInstrument(raw: unknown): raw is RawInstrument {
  return isRecord(raw) && FIELD_CHECKS.every(([key, valid]) => valid(raw[key]));
}

function parseInstrument(raw: unknown): CfdInstrument {
  if (!isRawInstrument(raw)) {
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
    borrowCostPerDay: raw.borrowCostPerDay ?? undefined,
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
    const { asOf } = this.snapshot;
    return asOf <= tradingDate && addDays(asOf, CFD_CATALOGUE_MAX_AGE_CALENDAR_DAYS) >= tradingDate;
  }
}

export function parseCfdCatalogue(text: string): CfdCatalogue {
  const body: unknown = JSON.parse(text);
  if (!isRecord(body) || !isIsoDate(body.asOf) || !Array.isArray(body.instruments)) {
    throw new Error('CFD catalogue: expected { asOf, instruments[] }');
  }
  const instruments = body.instruments.map(parseInstrument);
  const symbols = new Set(instruments.map((instrument) => instrument.symbol));
  if (symbols.size !== instruments.length) throw new Error('CFD catalogue: duplicate symbol');
  return new CfdCatalogue({ asOf: body.asOf, instruments });
}

export function loadCfdCatalogue(path: string): CfdCatalogue | undefined {
  if (!existsSync(path)) return undefined;
  return parseCfdCatalogue(new TextDecoder().decode(readFileSync(path)));
}

export function borrowCostPerYear(instrument: CfdInstrument): number | undefined {
  return instrument.borrowCostPerDay === undefined
    ? undefined
    : instrument.borrowCostPerDay * BORROW_DAY_COUNT[instrument.currency];
}
