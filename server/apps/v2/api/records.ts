import {
  type ReconcileRunWire,
  type ReconcileWire,
  V2_CONTRACT_VERSION,
} from '../../../../contracts/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';

export const RECONCILE_RUNS_SHOWN = 60;
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

interface ReconcileRow extends Omit<ReconcileRunWire, 'book_ids' | 'diffs'> {
  readonly book_ids: string;
  readonly diffs: string;
}

export class ReconcileReader {
  constructor(private readonly db: StoreHandle) {}

  read(): ReconcileWire {
    const runs = this.#runs();
    return {
      contract_version: V2_CONTRACT_VERSION,
      reconcile: runs.length === 0 ? { status: 'empty' } : { status: 'fed', runs },
    };
  }

  #runs(): ReconcileRunWire[] {
    // The dashboard opens stores from before migration 0075 (it needs only 0070), where the
    // table does not exist yet: that is an empty log, not a fault
    const table = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'v2_reconciles'")
      .get();
    if (table === undefined) return [];
    const rows = this.db
      .prepare(
        `SELECT trading_date, venue, source, status, book_ids, diffs, detail, recorded_at
           FROM v2_reconciles ORDER BY reconcile_id DESC LIMIT ?`,
      )
      .all(RECONCILE_RUNS_SHOWN) as ReconcileRow[];
    return rows.map((row) => ({
      ...row,
      book_ids: JSON.parse(row.book_ids),
      diffs: JSON.parse(row.diffs),
    }));
  }
}
