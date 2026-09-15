/**
 * The one read behind #1518's CGT report: every fill on the LIVE arm's Saxo
 * GIA equity book, joined to its instrument/side, split into GBP-priced legs
 * ready for `matchDisposals` and the fills this report cannot price in
 * sterling without inventing an FX rate.
 *
 * `fills` carries no `instrument` column (`server/shared/types/records.ts`) —
 * it joins to whichever of `closed_trades` (a round-tripped lot) or
 * `open_positions` (a still-open one) shares its `idempotency_key`. BOTH are
 * read, not `closed_trades` alone: an open lot's entry fill is a real
 * acquisition the Section 104 pool must know about, and a partially-flattened
 * open lot has real disposal fills of its own — `closed_trades` sees neither.
 * A key CAN be in both tables at once — `closedTrade()` (ingest-fills.ts)
 * never deletes the matching `open_positions` row (the #1088 `LotRetirement`
 * doc: "`closed` is deliberately never swept"). Both PKs are single-column on
 * `idempotency_key`, so the two LEFT JOINs cannot fan out into duplicate rows
 * even then; the `??` below simply prefers `closed_trades` whenever a key
 * names a row in both (`sqlite-cgt-fill-source.test.ts` pins this case).
 *
 * Scoped to `arm = 'live'` (the control arm is simulated, never a real
 * disposal — CLAUDE.md's live/control split) and `asset_class = 'stocks'`
 * (this report is the Saxo GIA equity leg #1518 asks for; a pre-#705 crypto
 * disposal is a real historical CGT event too, but this ticket does not
 * cover it, and silently blending the two asset classes into one pool would
 * misstate both).
 *
 * Currency: `fee_currency` also names the currency `fills.price` (hence
 * `grossAmount`) is denominated in — both come off the same Saxo
 * `CurrencyCode` (`saxo-adapter.ts`'s `toCashFill`). GBP rows pass straight
 * through; a pence row (`isPenceCurrency`, `server/shared/book-currency.ts`
 * #1465 — GBX/gbx/GBp/p) is normalised ÷100 — defensive rather than
 * reachable today, since the adapter's own `CurrencyCode` already resolves to
 * GBP for a pence-quoted line before a fee is persisted (`saxo-price-unit.ts`'s
 * `price_to_contract_factor`). Anything else (USD on the pool lines the #1220
 * sterling gate keeps out of `tradeableUniverse()`) converts on `fills.fx_rate_to_gbp`
 * when a row carries one (#1521, migration 0060) — `grossAmount`/`charges`
 * multiplied by the stored rate, never re-derived or looked up here — and
 * only when that rate is strictly positive (round 1 review: a zero or
 * negative stored value is refused, not multiplied by, since it would
 * silently zero out or sign-flip a real disposal). A row with neither a book
 * currency nor a usable stored rate cannot be priced in sterling without
 * inventing an FX rate, so it is returned separately, in native currency,
 * carrying why (`fxRateToGbpSource`), rather than guessed into the matched
 * total or used to abort the whole report. Classification reuses
 * `isPenceCurrency`/`BOOK_CURRENCY` rather than a local GBP/GBX string
 * comparison — `book-currency.ts` checks
 * pence FIRST specifically because `GBp` (pence) upper-cases to `GBP` and a
 * naive case-insensitive pound test would 100x it.
 */

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
  /** Fills whose currency is neither GBP nor GBX — see this file's header. */
  unconverted: UnconvertedCgtFill[];
}

export class SqliteCgtFillSource {
  constructor(private readonly db: StoreHandle) {}

  /**
   * Every fill this report needs, classified into `matchDisposals`'s
   * `CgtFillLeg` shape (or set aside as `unconverted`). Refuses rather than
   * mis-reporting on two integrity faults that are not currency-related: an
   * unattributable fill, and a short-sale lot (this long-only matcher cannot
   * price one).
   */
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
      if (arm !== 'live' || assetClass !== 'stocks') continue;
      if (side !== 'buy') {
        throw new Error(
          `CGT: fill ${row.idempotency_key}/${row.broker_fill_id} is on a side='${side}' lot — ` +
            `short-sale CGT treatment differs from this long-only matcher and is not implemented.`,
        );
      }

      const fill = fromFillRow(row);
      const kind = fill.leg === 'entry' ? 'acquisition' : 'disposal';
      const currency = (row.fee_currency ?? BOOK_CURRENCY).trim();
      const rawGrossAmount = fill.price * fill.qty;
      const rawCharges = fill.fee;

      // Pence FIRST — see this file's header on why a case-insensitive GBP
      // comparison run first would swallow `GBp` and 100x it.
      const divisor = isPenceCurrency(currency)
        ? PENCE_PER_GBP
        : currency.toUpperCase() === BOOK_CURRENCY
          ? 1
          : undefined;

      if (divisor !== undefined) {
        legs.push(toLeg(fill, instrument, kind, rawGrossAmount / divisor, rawCharges / divisor));
      } else if (fill.fx_rate_to_gbp !== undefined && fill.fx_rate_to_gbp > 0) {
        // #1521: the venue's own rate, applied verbatim — never re-derived,
        // never blended with a spot lookup. See this file's header.
        legs.push(
          toLeg(
            fill,
            instrument,
            kind,
            rawGrossAmount * fill.fx_rate_to_gbp,
            rawCharges * fill.fx_rate_to_gbp,
          ),
        );
      } else {
        // A stored rate that is zero or negative is not a rate this module
        // will multiply by (round 1 review, recorded not fixed) — a zero
        // silently zeroes a real disposal, a negative flips its sign, and
        // both would confidently misreport a live CGT event. Fall through to
        // unconverted instead of trusting a value that fails a sign check no
        // real exchange rate can fail.
        const fxRateToGbpSource =
          fill.fx_rate_to_gbp !== undefined
            ? `invalid_stored_rate:${fill.fx_rate_to_gbp}`
            : (fill.fx_rate_to_gbp_source ?? 'no_rate_stored');
        unconverted.push({
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
        });
      }
    }
    return { legs, unconverted };
  }
}

/** ISO 4217 minor unit: 100 pence (GBX/gbx/GBp/p, see `isPenceCurrency`) makes 1 GBP. */
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
