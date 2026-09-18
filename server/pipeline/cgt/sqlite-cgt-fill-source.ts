import { BOOK_CURRENCY, type Fill, isPenceCurrency } from '../../shared/index.js';
import { type FillRow, fromFillRow, type StoreHandle } from '../../shared/store/index.js';
import type { CgtFillLeg, UnconvertedCgtFill } from './cgt-disposal-matching.js';

interface FillJoinRow extends FillRow {
  c_instrument: string | null;
  c_asset_class: 'crypto' | 'stocks' | null;
  c_side: 'buy' | 'sell' | null;
  c_arm: 'live' | 'control' | null;
  o_instrument: string | null;
  o_asset_class: 'crypto' | 'stocks' | null;
  o_side: 'buy' | 'sell' | null;
  o_arm: 'live' | 'control' | null;
}

export interface CgtFillLegs {
  legs: CgtFillLeg[];
  unconverted: UnconvertedCgtFill[];
}

export class SqliteCgtFillSource {
  constructor(private readonly db: StoreHandle) {}

  getLiveEquityFillLegs(): CgtFillLegs {
    const rows = this.db
      .prepare(
        `SELECT f.idempotency_key AS idempotency_key,
                f.broker_fill_id  AS broker_fill_id,
                f.leg             AS leg,
                f.price           AS price,
                f.qty             AS qty,
                f.fee             AS fee,
                f.timestamp       AS timestamp,
                f.cost_breakdown_json AS cost_breakdown_json,
                f.exit_reason     AS exit_reason,
                f.flatten_idempotency_key AS flatten_idempotency_key,
                f.fee_currency    AS fee_currency,
                f.fx_rate_to_gbp  AS fx_rate_to_gbp,
                f.fx_rate_to_gbp_source AS fx_rate_to_gbp_source,
                c.instrument      AS c_instrument,
                c.asset_class     AS c_asset_class,
                c.side            AS c_side,
                c.arm             AS c_arm,
                o.instrument      AS o_instrument,
                o.asset_class     AS o_asset_class,
                o.side            AS o_side,
                o.arm             AS o_arm
           FROM fills f
           LEFT JOIN closed_trades c ON c.idempotency_key = f.idempotency_key
           LEFT JOIN open_positions o ON o.idempotency_key = f.idempotency_key
          ORDER BY f.timestamp, f.idempotency_key, f.broker_fill_id`,
      )
      .all() as FillJoinRow[];

    const legs: CgtFillLeg[] = [];
    const unconverted: UnconvertedCgtFill[] = [];
    for (const row of rows) {
      const classified = classifyFillRow(row);
      if (classified === null) continue;
      if ('leg' in classified) legs.push(classified.leg);
      else unconverted.push(classified.unconverted);
    }
    return { legs, unconverted };
  }
}

function classifyFillRow(
  row: FillJoinRow,
): { leg: CgtFillLeg } | { unconverted: UnconvertedCgtFill } | null {
  const instrument = row.c_instrument ?? row.o_instrument;
  const assetClass = row.c_asset_class ?? row.o_asset_class;
  const side = row.c_side ?? row.o_side;
  const arm = row.c_arm ?? row.o_arm;

  if (instrument === null || assetClass === null || side === null || arm === null) {
    throw new Error(
      `CGT: fill ${row.idempotency_key}/${row.broker_fill_id} names no instrument — it is in ` +
        `neither closed_trades nor open_positions, so it cannot be reported.`,
    );
  }
  if (arm !== 'live' || assetClass !== 'stocks') return null;
  if (side !== 'buy') {
    throw new Error(
      `CGT: fill ${row.idempotency_key}/${row.broker_fill_id} is on a side='${side}' lot — ` +
        `short-sale CGT treatment differs from this long-only matcher and is not implemented.`,
    );
  }

  const fill = fromFillRow(row);
  const kind = fill.leg === 'entry' ? 'acquisition' : 'disposal';
  return priceFillInGbp(fill, instrument, kind);
}

function priceFillInGbp(
  fill: Fill,
  instrument: string,
  kind: CgtFillLeg['kind'],
): { leg: CgtFillLeg } | { unconverted: UnconvertedCgtFill } {
  const currency = (fill.fee_currency ?? BOOK_CURRENCY).trim();
  const rawGrossAmount = fill.price * fill.qty;
  const rawCharges = fill.fee;

  const divisor = isPenceCurrency(currency)
    ? PENCE_PER_GBP
    : currency.toUpperCase() === BOOK_CURRENCY
      ? 1
      : undefined;

  if (divisor !== undefined) {
    return { leg: toLeg(fill, instrument, kind, rawGrossAmount / divisor, rawCharges / divisor) };
  }
  if (fill.fx_rate_to_gbp !== undefined && fill.fx_rate_to_gbp > 0) {
    return {
      leg: toLeg(
        fill,
        instrument,
        kind,
        rawGrossAmount * fill.fx_rate_to_gbp,
        rawCharges * fill.fx_rate_to_gbp,
      ),
    };
  }

  const fxRateToGbpSource =
    fill.fx_rate_to_gbp !== undefined
      ? `invalid_stored_rate:${fill.fx_rate_to_gbp}`
      : (fill.fx_rate_to_gbp_source ?? 'no_rate_stored');
  return {
    unconverted: {
      instrument,
      kind,
      date: fill.timestamp,
      quantity: fill.qty,
      grossAmount: rawGrossAmount,
      charges: rawCharges,
      currency,
      fxRateToGbpSource,
      idempotency_key: fill.idempotency_key,
      broker_fill_id: fill.broker_fill_id,
    },
  };
}

const PENCE_PER_GBP = 100;

function toLeg(
  fill: Fill,
  instrument: string,
  kind: CgtFillLeg['kind'],
  grossAmount: number,
  charges: number,
): CgtFillLeg {
  return {
    instrument,
    kind,
    date: fill.timestamp,
    quantity: fill.qty,
    grossAmount,
    charges,
    idempotency_key: fill.idempotency_key,
    broker_fill_id: fill.broker_fill_id,
  };
}
