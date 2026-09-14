/**
 * The one read behind #1518's CGT report: every fill on the LIVE arm's Saxo
 * GIA equity book, joined to its instrument/side.
 *
 * `fills` carries no `instrument` column (`server/shared/types/records.ts`) —
 * it joins to whichever of `closed_trades` (a round-tripped lot) or
 * `open_positions` (a still-open one) shares its `idempotency_key`. BOTH are
 * read, not `closed_trades` alone: an open lot's entry fill is a real
 * acquisition the Section 104 pool must know about, and a partially-flattened
 * open lot has real disposal fills of its own — `closed_trades` sees neither
 * (#1518 code review). The two tables cannot both match a fill's key with a
 * nonzero row — `closedTrade()` (ingest-fills.ts) is the only writer of
 * `closed_trades` and never deletes the matching `open_positions` row (the
 * #1088 `LotRetirement` doc: "`closed` is deliberately never swept"), so
 * `closed_trades` is preferred by construction whenever a key is in both.
 *
 * Scoped to `arm = 'live'` (the control arm is simulated, never a real
 * disposal — CLAUDE.md's live/control split) and `asset_class = 'stocks'`
 * (this report is the Saxo GIA equity leg #1518 asks for; a pre-#705 crypto
 * disposal is a real historical CGT event too, but this ticket does not
 * cover it, and silently blending the two asset classes into one pool would
 * misstate both).
 */

import { type FillRow, fromFillRow, type StoreHandle } from '../../shared/store/index.js';
import type { CgtFillLeg } from './cgt-disposal-matching.js';

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

export class SqliteCgtFillSource {
  constructor(private readonly db: StoreHandle) {}

  /**
   * Every fill this instrument report needs, classified into `matchDisposals`'s
   * `CgtFillLeg` shape. Refuses rather than mis-reporting (advisor review):
   * an unattributable fill, a short-sale lot, or a non-GBP fee would each
   * otherwise produce a confidently wrong number on a document headed for
   * HMRC rather than a missing one.
   */
  getLiveEquityFillLegs(): CgtFillLeg[] {
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
      if (row.fee_currency !== null && !isGbp(row.fee_currency)) {
        throw new Error(
          `CGT: fill ${row.idempotency_key}/${row.broker_fill_id} reports a ${row.fee_currency} fee — ` +
            `this report sums fees as GBP and cannot convert a non-book-currency charge.`,
        );
      }

      const fill = fromFillRow(row);
      legs.push({
        instrument,
        kind: fill.leg === 'entry' ? 'acquisition' : 'disposal',
        date: fill.timestamp,
        quantity: fill.qty,
        grossAmount: fill.price * fill.qty,
        charges: fill.fee,
        idempotency_key: fill.idempotency_key,
        broker_fill_id: fill.broker_fill_id,
      });
    }
    return legs;
  }
}

function isGbp(currency: string): boolean {
  return currency.trim().toUpperCase() === 'GBP';
}
