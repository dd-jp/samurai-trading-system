/**
 * Cumulative-feed arithmetic — the pure core of `cumulativeTopUp`
 * (ingest-fills.ts, #842). Alpaca's `getOrder` reports a RUNNING `filled_qty`
 * and cumulative average under ONE order id (see
 * `NormalizedFill.qty_is_cumulative`); this turns one such observation plus
 * the rows already booked against that id into the INCREMENT still owed, or
 * `null` when nothing is owed.
 *
 * No store, no logger, no position. The caller owns the I/O around the
 * result: the degraded-price warning (`priceDegraded`), the non-sterling fee
 * page, and the `toFill` conversion. Kept pure so the money-path arithmetic
 * is testable with literals rather than a SQLite store and a scripted broker.
 */

import type { BrokerFillId, Fill } from '../../shared/index.js';
import { QTY_EPSILON_RELATIVE, toBrokerFillId } from '../../shared/index.js';
import type { NormalizedFill } from './types.js';

/**
 * Separates a top-up row's id from the base order id it tops up (#842).
 * `'#'` and not `':'` deliberately: the flatten split in
 * `redistributeFlattenFills` already owns `':'` for its per-lot suffix, and
 * the two schemes must stay decidable from the id alone.
 */
const TOP_UP_ID_SEPARATOR = '#';

/** A persisted (or this-poll) row of the same lot — the fields the difference is taken against */
export type BookedRow = Pick<Fill, 'broker_fill_id' | 'qty' | 'price' | 'fee'>;

/** One observation of a cumulative feed: `qty`, `price` and `fee` are all running totals */
export type CumulativeObservation = Pick<
  NormalizedFill,
  'broker_fill_id' | 'qty' | 'price' | 'fee'
>;

export interface CumulativeIncrement {
  /** `<base>#<cumulative qty>` — deterministic, so a re-poll at the same cumulative finds it booked and yields `null` */
  broker_fill_id: BrokerFillId;
  qty: number;
  /** The increment's own price when derivable, else the venue's cumulative average (see `priceDegraded`) */
  price: number;
  /** Clamped at 0: a shrinking venue fee total must not credit the lot income */
  fee: number;
  bookedQty: number;
  /** Raw, possibly non-finite or non-positive — reported for the operator when `priceDegraded` */
  derivedPrice: number;
  /**
   * The derived increment price was unusable and `price` fell back to the
   * venue's cumulative average. Quantity still books: unprotected shares are
   * the failure that costs money; an approximate last-tranche price only
   * skews `avg_entry_price` and the R-multiple.
   */
  priceDegraded: boolean;
}

/**
 * Why an extra row rather than amending the existing one: `fills` rows are
 * append-only by construction (`applyLotAdvance` inserts; there is no update
 * path, and the table's PK is `(idempotency_key, broker_fill_id)`), and every
 * derived figure — `filled_size`, `avg_entry_price`, realized PnL, the
 * residual sweep's `heldQuantityFromFills` — is REBUILT from the rows on every
 * poll. Appending the difference therefore repairs all of them at once, with
 * no migration: the base id keeps the exact value it was first written under,
 * so nothing already persisted is re-keyed and no in-flight lot is re-booked
 * across the deploy boundary.
 *
 * `booked` must be the lot's own rows (already lot-scoped) plus this poll's
 * new rows — not a `hasFill` existence check, which even scoped to the full
 * PK (#1320) only answers "ingested or not", never "by how much".
 */
export function cumulativeIncrement(
  booked: ReadonlyArray<BookedRow>,
  observation: CumulativeObservation,
): CumulativeIncrement | null {
  const base = observation.broker_fill_id;
  const prefix = `${base}${TOP_UP_ID_SEPARATOR}`;
  const priors = booked.filter(
    (row) => row.broker_fill_id === base || row.broker_fill_id.startsWith(prefix),
  );
  // With no prior row there is nothing to take a difference against, and
  // inventing the whole cumulative quantity as this lot's would double-book
  // whichever lot actually holds it
  if (priors.length === 0) return null;

  const bookedQty = priors.reduce((sum, row) => sum + row.qty, 0);
  const delta = observation.qty - bookedQty;
  // The same relative tolerance `coversQty` judges flatness by (ADR-0005) —
  // a second tolerance for the same float64 noise is how two surfaces come to
  // disagree about the same lot
  //
  // `delta < 0` — the venue reporting LESS than we have booked — falls out
  // here too, silently. It is venue/store divergence rather than a lost
  // increment, it is not the direction that leaves shares naked (protection
  // would be OVER-sized, not under), and there is no safe repair from here:
  // fill rows are append-only and un-booking a persisted fill on a venue
  // hiccup is strictly worse than carrying it. `reconcile()` owns divergence.
  if (!(delta > Math.abs(observation.qty) * QTY_EPSILON_RELATIVE)) return null;

  // `price` on a cumulative observation is the cumulative AVERAGE, so the
  // increment's own price is what makes the average true — and a
  // `weightedAvgPrice` over base + top-up then reproduces the venue's
  // reported average to within ADR-0005's summation bound, rather than
  // drifting toward whichever tranche was larger
  const bookedNotional = priors.reduce((sum, row) => sum + row.price * row.qty, 0);
  const derivedPrice = (observation.price * observation.qty - bookedNotional) / delta;
  const priceIsUsable = Number.isFinite(derivedPrice) && derivedPrice > 0;

  return {
    broker_fill_id: toBrokerFillId(`${prefix}${observation.qty}`),
    qty: delta,
    price: priceIsUsable ? derivedPrice : observation.price,
    // #1121: subtracted against `priors`' full persisted `fee` — the CHARGED
    // total, which is what makes this right under `chargeTopUpTo`'s top-up
    // (not addition) rule. Subtracting only the venue-reported component
    // instead would be WRONG here: a prior row's `fee` is
    // `max(venue, modelled)`, so it has already absorbed that row's share of
    // the venue's running total, and subtracting less than it would charge
    // the same venue money twice across increments. Worked through: priors
    // charged 0.5 against a venue cumulative of 0.8 leaves a 0.3 increment,
    // topped up to the modelled 0.5 — 1.0 in total for that example, not 1.3
    // Where the venue out-charges the model the same subtraction returns its
    // real delta untouched
    //
    // "One modelled commission in total" is a property of THAT example, not
    // of the mechanism (#1121): `max` runs per increment, so a venue whose
    // per-increment fee crosses the modelled share charges more than the
    // model once — 0.7 then 0.3 against a modelled 1.0 split 0.5/0.5 charges
    // 1.2. `chargeTopUpTo`'s doc carries the per-lot bound. Unreachable on
    // this path today: cumulative feeds are Alpaca-only and Alpaca reports
    // `fee: 0`
    fee: Math.max(0, observation.fee - priors.reduce((sum, row) => sum + row.fee, 0)),
    bookedQty,
    derivedPrice,
    priceDegraded: !priceIsUsable,
  };
}
