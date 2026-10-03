import {
  type TaxDisposalWire,
  type TaxHeldOutWire,
  type TaxLogWire,
  type TaxWire,
  V2_CONTRACT_VERSION,
} from '../../../../contracts/index.js';
import type { Clock } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import {
  dayFxSource,
  dayGbpUsd,
  FX_SOURCE_GBP,
  type FxObservation,
  londonDateOf,
} from '../data/index.js';
import type { TaxCashInLieuRow } from '../tax-cash-in-lieu.js';
import {
  buildTaxLog,
  type RateLookup,
  type TaxFillRow,
  type TaxLog,
  type TaxSplitRow,
  taxYearLog,
  taxYearOf,
  taxYearsOf,
} from '../tax-log.js';
import type { TaxQuery } from './records.js';

// The ruling (doc 66 carried constraints, ADR "Tax") converts each US trade at the day's rate,
// not the fixed 1 January rate the books use (U3); BoE XUDLUSS is the repo's only daily series
export function dayRateOf(
  fx: readonly FxObservation[],
  currency: string,
  date: string,
): RateLookup {
  if (currency === 'GBP') return { ok: true, quotePerGbp: 1, source: FX_SOURCE_GBP };
  if (currency !== 'USD') return { ok: false, reason: `no day-rate source for ${currency}` };
  const fix = dayGbpUsd(fx, date);
  return fix.ok ? { ok: true, quotePerGbp: fix.gbpUsd, source: dayFxSource(fix.fixDate) } : fix;
}

// Shadow and control books never trade at a broker, so only fills of broker-routed orders are
// disposals
const BROKER_FILLS = `
  SELECT f.fill_id, f.instrument, f.venue, f.leg, f.side, f.qty, f.trading_date, f.fill_date,
    f.currency, f.price_native, f.fee_native
  FROM v2_fills f JOIN v2_orders o ON o.client_order_id = f.client_order_id
  WHERE o.outcome NOT IN ('simulated', 'refused_dry_run')
  ORDER BY f.rowid`;

const BROKER_CASH_IN_LIEU = `
  SELECT venue, activity_id, instrument, activity_date, qty, amount_native, currency, status
  FROM v2_cash_in_lieu ORDER BY rowid`;

export function taxYearLabel(year: number): string {
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

const CSV_COLUMNS = [
  'disposal_date',
  'instrument',
  'venue',
  'qty',
  'proceeds_gbp',
  'cost_gbp',
  'gain_gbp',
  'rule',
  'acquisition_date',
  'currency',
  'fx_quote_per_gbp',
  'fx_source',
  'provisional',
  'cash_in_lieu',
  'cash_in_lieu_activity',
  'note',
] as const;

type CsvCell = string | number | boolean | null;

const CSV_QUOTED = ['"', ',', '\n'];

function csvField(value: CsvCell): string {
  const text = value === null ? '' : String(value);
  return CSV_QUOTED.some((char) => text.includes(char)) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(cells: Partial<Record<(typeof CSV_COLUMNS)[number], CsvCell>>): string {
  return CSV_COLUMNS.map((column) => csvField(cells[column] ?? null)).join(',');
}

function disposalLine(row: TaxDisposalWire): string {
  return csvLine({
    ...row,
    proceeds_gbp: row.proceeds_gbp.toFixed(2),
    cost_gbp: row.cost_gbp.toFixed(2),
    gain_gbp: row.gain_gbp.toFixed(2),
  });
}

function heldOutLine(held: TaxHeldOutWire): string {
  return csvLine({
    instrument: held.instrument,
    venue: held.venue,
    rule: 'held_out',
    note: `${held.fills} fills held out: ${held.reason}`,
  });
}

export function taxCsv(log: TaxLogWire): string {
  const lines = [
    CSV_COLUMNS.join(','),
    ...log.rows.map(disposalLine),
    ...log.held_out.map(heldOutLine),
  ];
  return `${lines.join('\n')}\n`;
}

export interface TaxCsv {
  readonly filename: string;
  readonly body: string;
}

export class TaxReader {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
    private readonly fx: () => readonly FxObservation[],
  ) {}

  read(query: TaxQuery): TaxWire {
    const { log, year } = this.#logFor(query);
    const yearLog = taxYearLog(log, year);
    const empty = yearLog.rows.length === 0 && yearLog.held_out.length === 0;
    return {
      contract_version: V2_CONTRACT_VERSION,
      year,
      years: taxYearsOf(log),
      disposals: empty ? { status: 'empty' } : { status: 'fed', ...yearLog },
    };
  }

  csv(query: TaxQuery): TaxCsv {
    const { log, year } = this.#logFor(query);
    return {
      filename: `samurai-tax-${taxYearLabel(year)}.csv`,
      body: taxCsv(taxYearLog(log, year)),
    };
  }

  #logFor(query: TaxQuery): { readonly log: TaxLog; readonly year: number } {
    const today = londonDateOf(this.clock.now().toISOString());
    const fills = this.db.prepare(BROKER_FILLS).all() as TaxFillRow[];
    const splits = this.db
      .prepare('SELECT instrument, split_date, ratio FROM v2_splits')
      .all() as TaxSplitRow[];
    const cashInLieu = this.db.prepare(BROKER_CASH_IN_LIEU).all() as TaxCashInLieuRow[];
    const fx = this.fx();
    const log = buildTaxLog(
      fills,
      splits,
      (currency, date) => dayRateOf(fx, currency, date),
      today,
      cashInLieu,
    );
    return { log, year: query.year ?? taxYearOf(today) };
  }
}
