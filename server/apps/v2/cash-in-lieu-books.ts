import type { BrokerMode, Venue } from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';
import { isCfdVenue } from './data/index.js';
import {
  type CashInLieuPair,
  pairCashInLieu,
  standingCashInLieu,
  type TaxCashInLieuRow,
} from './tax-cash-in-lieu.js';
import type { TaxFillRow } from './tax-log.js';

interface CashInLieuEstimate extends TaxFillRow {
  readonly book_id: string;
  readonly fill_seq: number;
  readonly price_gbp: number;
  readonly broker_mode: BrokerMode;
}

interface CashInLieuRead extends TaxCashInLieuRow {
  readonly fx_quote_per_gbp: number;
  readonly fx_source: string;
}

interface PriorCorrection {
  readonly estimate_fill_id: string;
  readonly activity_id: string;
  readonly amount_native: number;
  readonly amount_gbp: number;
}

export interface CashInLieuCorrection {
  readonly book_id: string;
  readonly estimate_fill_id: string;
  readonly venue: string;
  readonly instrument: string;
  readonly activity_id: string;
  readonly activity_key: string;
  readonly amount_native: number;
  readonly amount_gbp: number;
  readonly fx_quote_per_gbp: number;
  readonly fx_source: string;
  readonly estimate_fill_seq: number;
  readonly broker_mode: BrokerMode;
  readonly trading_date: string;
}

interface CorrectionInputs {
  readonly estimates: readonly CashInLieuEstimate[];
  readonly reads: readonly CashInLieuRead[];
  readonly priors: readonly PriorCorrection[];
  readonly tradingDate: string;
}

interface Target {
  readonly cause: CashInLieuRead;
  readonly native: number;
  readonly gbp: number;
}

type Pairs = readonly CashInLieuPair<CashInLieuEstimate, CashInLieuRead>[];

const NEGLIGIBLE = 1e-9;

function signOf(estimate: CashInLieuEstimate): 1 | -1 {
  return estimate.side === 'sell' ? 1 : -1;
}

function activityKeyOf(read: CashInLieuRead): string {
  return `${read.venue}:${read.activity_id}:${read.status}`;
}

function byInstrument<T extends { readonly instrument: string; readonly venue: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (isCfdVenue(row.venue as Venue)) continue;
    groups.set(row.instrument, [...(groups.get(row.instrument) ?? []), row]);
  }
  return groups;
}

function pairedTarget(estimate: CashInLieuEstimate, pairs: Pairs): Target | undefined {
  const pair = pairs.find((candidate) => candidate.estimates.includes(estimate));
  if (pair === undefined) return undefined;
  const pairedQty = pair.estimates.reduce((total, fill) => total + fill.qty, 0);
  const native = (pair.row.amount_native * estimate.qty) / pairedQty;
  return { cause: pair.row, native, gbp: native / pair.row.fx_quote_per_gbp };
}

function estimateNative(estimate: CashInLieuEstimate): number {
  return signOf(estimate) * estimate.qty * (estimate.price_native as number);
}

function estimateGbp(estimate: CashInLieuEstimate): number {
  return signOf(estimate) * estimate.qty * estimate.price_gbp;
}

// An estimate no standing payment pairs any more, canceled or now shared by other estimates, goes
// back to the estimate itself (David 2026-10-16, every re-share is booked)
function reversedTarget(
  estimate: CashInLieuEstimate,
  reads: readonly CashInLieuRead[],
  priors: readonly PriorCorrection[],
): Target | undefined {
  const last = priors.at(-1);
  if (last === undefined) return undefined;
  const cause = reads
    .filter((read) => read.venue === estimate.venue && read.activity_id === last.activity_id)
    .at(-1);
  if (cause === undefined) return undefined;
  return { cause, native: estimateNative(estimate), gbp: estimateGbp(estimate) };
}

function booked(priors: readonly PriorCorrection[], field: 'amount_native' | 'amount_gbp'): number {
  return priors.reduce((total, prior) => total + prior[field], 0);
}

function correctionOf(
  estimate: CashInLieuEstimate,
  pairs: Pairs,
  inputs: CorrectionInputs,
): CashInLieuCorrection | undefined {
  const priors = inputs.priors.filter((prior) => prior.estimate_fill_id === estimate.fill_id);
  const target = pairedTarget(estimate, pairs) ?? reversedTarget(estimate, inputs.reads, priors);
  if (target === undefined) return undefined;
  const amountNative = target.native - estimateNative(estimate) - booked(priors, 'amount_native');
  const amountGbp = target.gbp - estimateGbp(estimate) - booked(priors, 'amount_gbp');
  if (Math.abs(amountNative) < NEGLIGIBLE && Math.abs(amountGbp) < NEGLIGIBLE) return undefined;
  return {
    book_id: estimate.book_id,
    estimate_fill_id: estimate.fill_id,
    venue: estimate.venue,
    instrument: estimate.instrument,
    activity_id: target.cause.activity_id,
    activity_key: activityKeyOf(target.cause),
    amount_native: amountNative,
    amount_gbp: amountGbp,
    fx_quote_per_gbp: target.cause.fx_quote_per_gbp,
    fx_source: target.cause.fx_source,
    estimate_fill_seq: estimate.fill_seq,
    broker_mode: estimate.broker_mode,
    trading_date: inputs.tradingDate,
  };
}

function instrumentCorrections(
  estimates: readonly CashInLieuEstimate[],
  standing: readonly CashInLieuRead[],
  inputs: CorrectionInputs,
): CashInLieuCorrection[] {
  const pairs = pairCashInLieu(estimates, standing);
  if (typeof pairs === 'string') return [];
  return estimates
    .filter((estimate) => estimate.price_native !== null)
    .flatMap((estimate) => correctionOf(estimate, pairs, inputs) ?? []);
}

// David 2026-10-15/16 (#2001): book cash follows the broker's amount, shared pro rata over the
// estimates it pairs and converted at the reading row's rate; a held-out instrument writes nothing,
// so its earlier corrections stand
function cashInLieuCorrections(inputs: CorrectionInputs): CashInLieuCorrection[] {
  const standing = byInstrument(standingCashInLieu(inputs.reads));
  return [...byInstrument(inputs.estimates)].flatMap(([instrument, estimates]) =>
    instrumentCorrections(estimates, standing.get(instrument) ?? [], inputs),
  );
}

export interface CashInLieuBookLedger {
  pending(tradingDate: string): readonly CashInLieuCorrection[];
  record(correction: CashInLieuCorrection): void;
}

// Only a broker-routed order's estimate is paid by the broker (api/tax.ts BROKER_FILLS)
const ESTIMATES = `
  SELECT f.fill_id, f.fill_seq, f.book_id, f.instrument, f.venue, f.leg, f.side, f.qty,
    f.trading_date, f.fill_date, f.currency, f.price_native, f.fee_native, f.price_gbp,
    f.broker_mode
  FROM v2_fills f JOIN v2_orders o ON o.client_order_id = f.client_order_id
  WHERE f.leg = 'cash_in_lieu' AND o.outcome NOT IN ('simulated', 'refused_dry_run')
  ORDER BY f.fill_seq`;

const READS_BEFORE = `
  SELECT venue, activity_id, instrument, activity_date, qty, amount_native, currency, status,
    fx_quote_per_gbp, fx_source
  FROM v2_cash_in_lieu WHERE trading_date < ? ORDER BY rowid`;

const PRIORS = `
  SELECT estimate_fill_id, activity_id, amount_native, amount_gbp
  FROM v2_cash_in_lieu_adjustments ORDER BY adjustment_id`;

export class SqliteCashInLieuBooks implements CashInLieuBookLedger {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  // A read journals after its own day's cycle, so a day takes only the reads of earlier days
  // (David 2026-10-16, (e))
  pending(tradingDate: string): readonly CashInLieuCorrection[] {
    return cashInLieuCorrections({
      estimates: this.db.prepare(ESTIMATES).all() as CashInLieuEstimate[],
      reads: this.db.prepare(READS_BEFORE).all(tradingDate) as CashInLieuRead[],
      priors: this.db.prepare(PRIORS).all() as PriorCorrection[],
      tradingDate,
    });
  }

  record(correction: CashInLieuCorrection): void {
    this.db
      .prepare(
        `INSERT INTO v2_cash_in_lieu_adjustments (book_id, estimate_fill_id, venue, instrument,
           activity_id, activity_key, amount_native, amount_gbp, fx_quote_per_gbp, fx_source,
           estimate_fill_seq, broker_mode, fills_before, trading_date, recorded_at)
         VALUES (@book_id, @estimate_fill_id, @venue, @instrument, @activity_id, @activity_key,
           @amount_native, @amount_gbp, @fx_quote_per_gbp, @fx_source, @estimate_fill_seq,
           @broker_mode, (SELECT COUNT(*) FROM v2_fills WHERE trading_date = @trading_date),
           @trading_date, @recorded_at)`,
      )
      .run({ ...correction, recorded_at: toStoredTimestamp(this.clock.now()) });
  }
}
