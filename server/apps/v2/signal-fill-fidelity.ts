import type { StoreHandle } from '../../shared/store/index.js';
import { openReadOnlyStore } from '../../shared/store/index.js';
import { setExitCodeWhenInvoked, writeOrFail } from '../../tools/cli-entrypoint.js';
import { V2_STORE_PATH } from './index.js';
import { SIGNALS_SLEEVE_ID } from './signal/index.js';

export type FillPairing =
  | 'paired'
  | 'no_broker_primary'
  | 'no_shadow'
  | 'primary_unfilled'
  | 'shadow_unfilled'
  | 'both_unfilled';

const PAIRINGS: readonly FillPairing[] = [
  'paired',
  'no_broker_primary',
  'no_shadow',
  'primary_unfilled',
  'shadow_unfilled',
  'both_unfilled',
];

export interface SignalEntryRow {
  readonly signal_id: string;
  readonly instrument: string;
  readonly variant: string;
  readonly at_broker: number;
  readonly filled_qty: number | null;
  readonly filled_value_native: number | null;
}

export interface SignalFillPair {
  readonly signalId: string;
  readonly instrument: string;
  readonly pairing: FillPairing;
  readonly primaryPrice: number | undefined;
  readonly shadowPrice: number | undefined;
  readonly deltaBps: number | undefined;
}

export interface SignalFillSummary {
  readonly counts: Readonly<Record<FillPairing, number>>;
  readonly meanBps: number | undefined;
  readonly medianBps: number | undefined;
  readonly meanAbsBps: number | undefined;
}

interface Legs {
  readonly instrument: string;
  primary?: number | null;
  shadow?: number | null;
}

// Only a primary order Alpaca accepted outside a dry run has a broker fill to compare; the no-veto
// book is the shadow. Prices are native USD, so FX never enters the delta
const SIGNAL_ENTRIES_SQL = `
  SELECT json_extract(d.payload, '$.signal_id') AS signal_id, o.instrument, b.variant,
         (b.variant = 'primary' AND o.venue = 'alpaca' AND o.dry_run = 0
           AND o.outcome IN ('submitted', 'cancelled')) AS at_broker,
         (SELECT SUM(f.qty) FROM v2_fills f
           WHERE f.client_order_id = o.client_order_id AND f.leg = 'entry') AS filled_qty,
         (SELECT SUM(f.qty * f.price_native) FROM v2_fills f
           WHERE f.client_order_id = o.client_order_id AND f.leg = 'entry') AS filled_value_native
    FROM v2_orders o
    JOIN v2_books b ON b.book_id = o.book_id
    JOIN v2_decisions d ON d.decision_id = o.decision_id
   WHERE b.sleeve_id = '${SIGNALS_SLEEVE_ID}' AND b.variant IN ('primary', 'no-veto')
     AND o.leg = 'entry' AND o.trading_date BETWEEN ? AND ?
     AND json_extract(d.payload, '$.signal_id') IS NOT NULL
   ORDER BY o.trading_date, o.rowid`;

export function readSignalEntries(
  db: StoreHandle,
  window: { readonly from: string; readonly to: string },
): readonly SignalEntryRow[] {
  return db.prepare(SIGNAL_ENTRIES_SQL).all(window.from, window.to) as SignalEntryRow[];
}

function averagePrice(row: SignalEntryRow): number | null {
  if (row.filled_qty === null || row.filled_qty <= 0 || row.filled_value_native === null) {
    return null;
  }
  return row.filled_value_native / row.filled_qty;
}

function pairingOf(primary: number | null | undefined, shadow: number | null | undefined) {
  if (primary === undefined) return 'no_broker_primary';
  if (shadow === undefined) return 'no_shadow';
  if (primary === null) return shadow === null ? 'both_unfilled' : 'primary_unfilled';
  return shadow === null ? 'shadow_unfilled' : 'paired';
}

function pairOf(signalId: string, legs: Legs): SignalFillPair {
  const pairing: FillPairing = pairingOf(legs.primary, legs.shadow);
  const primaryPrice = legs.primary ?? undefined;
  const shadowPrice = legs.shadow ?? undefined;
  const deltaBps =
    pairing === 'paired'
      ? (((primaryPrice as number) - (shadowPrice as number)) / (shadowPrice as number)) * 10_000
      : undefined;
  return { signalId, instrument: legs.instrument, pairing, primaryPrice, shadowPrice, deltaBps };
}

function addLeg(legs: Legs, row: SignalEntryRow): void {
  if (row.variant === 'no-veto') legs.shadow = averagePrice(row);
  else if (row.at_broker === 1) legs.primary = averagePrice(row);
}

export function pairSignalFills(rows: readonly SignalEntryRow[]): readonly SignalFillPair[] {
  const bySignal = new Map<string, Legs>();
  for (const row of rows) {
    const legs = bySignal.get(row.signal_id) ?? { instrument: row.instrument };
    addLeg(legs, row);
    bySignal.set(row.signal_id, legs);
  }
  return [...bySignal].map(([signalId, legs]) => pairOf(signalId, legs));
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return mean(sorted.slice(middle - 1, middle + 1));
}

export function summariseSignalFills(pairs: readonly SignalFillPair[]): SignalFillSummary {
  const counts = Object.fromEntries(PAIRINGS.map((pairing) => [pairing, 0])) as Record<
    FillPairing,
    number
  >;
  for (const pair of pairs) counts[pair.pairing] += 1;
  const deltas = pairs.flatMap((pair) => (pair.deltaBps === undefined ? [] : [pair.deltaBps]));
  return {
    counts,
    meanBps: mean(deltas),
    medianBps: median(deltas),
    meanAbsBps: mean(deltas.map(Math.abs)),
  };
}

function bps(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${value.toFixed(1)} bps`;
}

function price(value: number | undefined): string {
  return value === undefined ? '-' : value.toFixed(4);
}

function pairLine(pair: SignalFillPair): string {
  return `${pair.signalId} ${pair.instrument} ${pair.pairing}: real ${price(pair.primaryPrice)}, shadow ${price(pair.shadowPrice)}, delta ${bps(pair.deltaBps)}`;
}

export function formatSignalFillFidelity(pairs: readonly SignalFillPair[]): string {
  if (pairs.length === 0) return 'no signals entries in the window';
  const summary = summariseSignalFills(pairs);
  const { counts } = summary;
  return [
    `${counts.paired} paired: mean ${bps(summary.meanBps)}, median ${bps(summary.medianBps)}, mean absolute ${bps(summary.meanAbsBps)} (positive: the real leg paid more than the shadow)`,
    `unpaired: no broker primary ${counts.no_broker_primary}, no shadow ${counts.no_shadow}, primary unfilled ${counts.primary_unfilled}, shadow unfilled ${counts.shadow_unfilled}, both unfilled ${counts.both_unfilled}`,
    'per signal:',
    ...pairs.map(pairLine),
  ].join('\n');
}

export interface SignalFillFidelityInputs {
  readonly storePath: string;
  readonly from: string;
  readonly to: string;
}

export function reportSignalFillFidelity(
  inputs: SignalFillFidelityInputs,
  openStore: (path: string) => StoreHandle = openReadOnlyStore,
): string {
  const db = openStore(inputs.storePath);
  try {
    return formatSignalFillFidelity(pairSignalFills(readSignalEntries(db, inputs)));
  } finally {
    db.close();
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function windowDate(name: string, value: string | undefined): string {
  if (value !== undefined && ISO_DATE.test(value)) return value;
  throw new Error(
    `usage: v2:signal-fill-fidelity <from YYYY-MM-DD> <to YYYY-MM-DD> [store]; bad ${name} ${value ?? '(missing)'}`,
  );
}

export function main(
  argv: readonly string[],
  write: (line: string) => void,
  report: (inputs: SignalFillFidelityInputs) => string = reportSignalFillFidelity,
): Promise<number> {
  const [from, to, storePath = V2_STORE_PATH] = argv;
  return writeOrFail(write, async () =>
    report({ storePath, from: windowDate('from', from), to: windowDate('to', to) }),
  );
}

await setExitCodeWhenInvoked(import.meta.url, () => main(process.argv.slice(2), console.log));
