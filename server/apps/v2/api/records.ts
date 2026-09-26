import {
  type NotYetFedWire,
  type ReconcileWire,
  type TaxWire,
  V2_CONTRACT_VERSION,
} from '../../../../contracts/index.js';

const RECONCILE_OWNER: NotYetFedWire = {
  status: 'not-yet-fed',
  owner: 'Step 4 / Step 3e',
  ticket: '#1784',
};
const TAX_OWNER: NotYetFedWire = { status: 'not-yet-fed', owner: 'Step 4', ticket: '#1746' };
const TAX_PARAMS: ReadonlySet<string> = new Set(['year', 'format']);
const FORMATS: ReadonlySet<string> = new Set(['json', 'csv']);

export interface TaxQuery {
  readonly year: number | null;
  readonly format: 'json' | 'csv';
}

export type TaxQueryResult =
  | { readonly ok: true; readonly query: TaxQuery }
  | { readonly ok: false; readonly reason: string };

function parseYear(raw: string | null): number | null | undefined {
  if (raw === null) return null;
  return /^20\d{2}$/.test(raw) ? Number(raw) : undefined;
}

function unexpectedParam(params: URLSearchParams): string | undefined {
  for (const key of new Set(params.keys())) {
    if (!TAX_PARAMS.has(key)) return 'unknown parameter; allowed: year, format';
    if (params.getAll(key).length > 1) return `${key} is given more than once`;
  }
  return undefined;
}

export function parseTaxQuery(params: URLSearchParams): TaxQueryResult {
  const unexpected = unexpectedParam(params);
  if (unexpected !== undefined) return { ok: false, reason: unexpected };
  const year = parseYear(params.get('year'));
  if (year === undefined) return { ok: false, reason: 'year is invalid' };
  const format = params.get('format') ?? 'json';
  if (!FORMATS.has(format)) return { ok: false, reason: 'format is invalid' };
  return { ok: true, query: { year, format: format as TaxQuery['format'] } };
}

export function reconcileWire(): ReconcileWire {
  return { contract_version: V2_CONTRACT_VERSION, reconcile: RECONCILE_OWNER };
}

export function taxWire(query: TaxQuery): TaxWire {
  return { contract_version: V2_CONTRACT_VERSION, year: query.year, disposals: TAX_OWNER };
}

export const TAX_CSV_NOT_FED = `tax log not yet fed: ${TAX_OWNER.owner} (${TAX_OWNER.ticket})`;
