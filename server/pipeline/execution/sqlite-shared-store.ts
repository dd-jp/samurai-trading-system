/**
 * SQLite-backed `SharedStore` over `open_positions`, `fills` and
 * `closed_trades` (#193) — Execution's sole writer; no business logic here,
 * only schema translation. Timestamps are ISO-8601 UTC TEXT via
 * `toStoredTimestamp`/`fromStoredTimestamp` (sorts correctly as TEXT). JSON
 * columns round-trip via stringify/parse at this boundary only.
 */

import type {
  ClosedTrade,
  ExitReason,
  Fill,
  LotHeldQuantity,
  OpenPosition,
  OrderState,
  TradingArm,
} from '../../shared/index.js';
import {
  type FillRow,
  fromFillRow,
  fromOpenPositionRow,
  fromStoredTimestamp,
  fromStoredTimestampOrNull,
  isUniqueConstraintError,
  type OpenPositionRow,
  parseModelledCostBreakdownColumn,
  type StoreHandle,
  TERMINAL_ORDER_STATES,
  toStoredTimestamp,
} from '../../shared/store/index.js';
import type {
  FlattenAttribution,
  FlattenSubmissionWriteAhead,
  LotAdvance,
  SharedStore,
  UnprotectedResidualLot,
  UnresolvedFlattenSubmission,
} from './types.js';

/**
 * `TERMINAL_ORDER_STATES` minus `closed` and `abandoned` (#1088, #1186) —
 * sweeping `abandoned` would delete `abandon_reason` on the very next
 * reconcile pass, since its age gate is already past cutoff when written.
 */
const SWEEPABLE_TERMINAL_STATES: readonly OrderState[] = TERMINAL_ORDER_STATES.filter(
  (state) => state !== 'closed' && state !== 'abandoned',
);

/**
 * Frozen so `fillSizesByLeg`'s SQL predicate can't be mutated at runtime
 * (#568). `'exit'` is `leg != 'entry'` so it can't drift from
 * `ingest-fills.ts`'s `isExitFill` if a fourth leg is added.
 */
const LEG_PREDICATES = Object.freeze({
  entry: "leg = 'entry'",
  exit: "leg != 'entry'",
} as const);

/**
 * Thrown when the write-ahead INSERT loses a race for an idempotency key.
 * A named type, not a message prefix, so `execute()` can discriminate a
 * dedup (`deduped`) from a genuine store failure without string-matching.
 */
export class DuplicatePositionError extends Error {
  constructor(readonly idempotency_key: string) {
    super(
      `SqliteExecutionStore.writeAheadPosition: a position already exists for ` +
        `idempotency_key '${idempotency_key}' — execute()'s findByKey gate should ` +
        'have prevented this write.',
    );
    this.name = 'DuplicatePositionError';
  }
}

/** `writeAheadFlatten`'s equivalent of `DuplicatePositionError` — see there for the reasoning */
class DuplicateFlattenSubmissionError extends Error {
  constructor(readonly idempotency_key: string) {
    super(
      `SqliteExecutionStore.writeAheadFlatten: a flatten submission already exists for ` +
        `idempotency_key '${idempotency_key}' — execute()'s findByKey gate should ` +
        'have prevented this write.',
    );
    this.name = 'DuplicateFlattenSubmissionError';
  }
}

/**
 * Thrown when a flatten is refused because another flatten on the same
 * instrument is unresolved (#1214) — two live flattens could reverse the
 * position (#516). Callers discriminate on this to stand down quietly rather
 * than report a broken journal.
 */
export class UnresolvedFlattenForInstrumentError extends Error {
  constructor(
    readonly idempotency_key: string,
    readonly instrument: string,
    readonly blocking_key: string,
  ) {
    super(
      `SqliteExecutionStore.writeAheadFlatten: refusing to journal flatten ` +
        `'${idempotency_key}' — flatten '${blocking_key}' on '${instrument}' is still ` +
        'unresolved, and two live flattens on one instrument can reverse the position (#516).',
    );
    this.name = 'UnresolvedFlattenForInstrumentError';
  }
}

export class SqliteExecutionStore implements SharedStore {
  /**
   * Which arm's book this instance reads/writes (#753). One class, two
   * instances — never two classes, so persistence can't drift between arms.
   * Stamped on every row and filters the SCAN queries; key-based reads/writes
   * are unfiltered since `arm` is already hashed into `idempotency_key`.
   */
  private readonly arm: TradingArm;

  /**
   * The declared ceiling this instance's asks were clamped against, stamped
   * on every row it writes (#1112 AC5). `undefined` means no ceiling was
   * declared (pre-#1112, or a non-paper/non-live construction).
   */
  private readonly sizingCapitalCeiling: number | undefined;

  constructor(
    private readonly db: StoreHandle,
    arm: TradingArm = 'live',
    sizingCapitalCeiling?: number,
  ) {
    this.arm = arm;
    this.sizingCapitalCeiling = sizingCapitalCeiling;
  }

  /**
   * True if an order already exists under this key. Checks both
   * `open_positions` (entry/scale_in) and `flatten_submissions` (exit, #508)
   * — an exit writes no `OpenPosition`, so only the second table catches a replay.
   */
  async findByKey(idempotency_key: string): Promise<boolean> {
    const positionRow = this.db
      .prepare('SELECT 1 FROM open_positions WHERE idempotency_key = ?')
      .get(idempotency_key);
    if (positionRow !== undefined) return true;

    const flattenRow = this.db
      .prepare('SELECT 1 FROM flatten_submissions WHERE idempotency_key = ?')
      .get(idempotency_key);
    return flattenRow !== undefined;
  }

  /**
   * Write-ahead: INSERT before the broker call, so a crash in the gap leaves
   * a recoverable `pending` row (#86 reconciles it). A duplicate key throws
   * `DuplicatePositionError` rather than upserting, to avoid erasing broker ids.
   */
  async writeAheadPosition(position: OpenPosition): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO open_positions (
             idempotency_key, debate_id, instrument, asset_class, side, intent_type,
             requested_size, filled_size, avg_entry_price, stop, target,
             order_state, broker_order_ids, opened_at, decision_timestamp,
             conviction, converged, arm,
             decision_price, quote_bid, quote_ask, quote_mid, quote_observed_at,
             modelled_cost_breakdown_json, modelled_protective_exit_cost_breakdown_json,
             sizing_capital_ceiling
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          position.idempotency_key,
          position.debate_id,
          position.instrument,
          position.asset_class,
          position.side,
          position.intent_type,
          position.requested_size,
          position.filled_size,
          position.avg_entry_price,
          position.stop,
          position.target,
          position.order_state,
          JSON.stringify(position.broker_order_ids),
          toStoredTimestamp(position.opened_at),
          toStoredTimestamp(position.decision_timestamp),
          position.conviction,
          position.converged ? 1 : 0,
          // #753: this instance's arm — see the `arm` field's doc above
          this.arm,
          // #1001 — best-effort submit-time snapshot, see `OpenPosition`'s field docs
          position.decision_price ?? null,
          position.quote_bid ?? null,
          position.quote_ask ?? null,
          position.quote_mid ?? null,
          position.quote_observed_at === undefined
            ? null
            : toStoredTimestamp(position.quote_observed_at),
          position.modelled_cost_breakdown === undefined
            ? null
            : JSON.stringify(position.modelled_cost_breakdown),
          // #1301 — the protective legs' own cost estimate, same capture pass
          position.modelled_protective_exit_cost_breakdown === undefined
            ? null
            : JSON.stringify(position.modelled_protective_exit_cost_breakdown),
          // #1112 AC5 — see `sizingCapitalCeiling`'s own doc
          this.sizingCapitalCeiling ?? null,
        );
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new DuplicatePositionError(position.idempotency_key);
      }
      throw cause;
    }
  }

  /** Persist the post-ack transition (`pending` → `submitted`), or reconcile's adopted state */
  async updatePositionState(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE open_positions SET order_state = ?, broker_order_ids = ? WHERE idempotency_key = ?`,
      )
      .run(update.order_state, JSON.stringify(update.broker_order_ids), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.updatePositionState: no write-ahead record for '${idempotency_key}'`,
      );
    }
  }

  /** Non-terminal lots only (execution-spec.md) — deterministic order for callers that iterate */
  async getOpenPositions(): Promise<OpenPosition[]> {
    const placeholders = TERMINAL_ORDER_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        // #753: arm-scoped — an unfiltered scan would put the control arm's
        // lots into the live arm's book
        `SELECT * FROM open_positions
          WHERE arm = ? AND order_state NOT IN (${placeholders})
          ORDER BY opened_at`,
      )
      .all(this.arm, ...TERMINAL_ORDER_STATES) as OpenPositionRow[];
    return rows.map(fromOpenPositionRow);
  }

  /** See `SharedStore.sweepTerminalPositions` (types/store.ts) for the full contract */
  async sweepTerminalPositions(cutoff: Date): Promise<number> {
    const placeholders = SWEEPABLE_TERMINAL_STATES.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        // #753: arm-scoped, same reason as every other scan in this class
        `DELETE FROM open_positions
          WHERE arm = ? AND order_state IN (${placeholders})
            AND filled_size = 0 AND decision_timestamp < ?`,
      )
      .run(this.arm, ...SWEEPABLE_TERMINAL_STATES, toStoredTimestamp(cutoff));
    return result.changes;
  }

  /** See `SharedStore.abandonWedgedZeroFillLot` (types/store.ts) for the full contract */
  async abandonWedgedZeroFillLot(idempotency_key: string, reason: string): Promise<boolean> {
    const result = this.db
      .prepare(
        // #753: arm-scoped, though a wedge can occur on either arm.
        // WHERE-guarded on the exact wedge shape so a race can't overwrite a
        // lot that un-wedged itself between read and write; mirrors
        // `isWedgedZeroFillLot` (key-scheme-guard.ts) in SQL — keep in sync (#1601)
        `UPDATE open_positions
            SET order_state = 'abandoned', abandon_reason = ?
          WHERE arm = ? AND idempotency_key = ?
            AND order_state IN ('filled', 'partially_filled') AND filled_size = 0`,
      )
      .run(reason, this.arm, idempotency_key);
    return result.changes > 0;
  }

  /**
   * Dedup gate matched on the full `fills` PK — `(idempotency_key,
   * broker_fill_id)`, not `broker_fill_id` alone (#1320) — since
   * `broker_fill_id` is venue-assigned and not unique across lots.
   */
  async hasFill({
    idempotency_key,
    broker_fill_id,
  }: Parameters<SharedStore['hasFill']>[0]): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 FROM fills WHERE idempotency_key = ? AND broker_fill_id = ?')
      .get(idempotency_key, broker_fill_id);
    return row !== undefined;
  }

  /**
   * One row per (partial) fill. `(idempotency_key, broker_fill_id)` is the
   * PK, so a duplicate write surfaces as a constraint violation, not double-counting.
   */
  private insertFill(fill: Fill): void {
    try {
      this.db
        .prepare(
          `INSERT INTO fills (
             idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp, cost_breakdown_json,
             exit_reason, flatten_idempotency_key, fee_currency, fx_rate_to_gbp, fx_rate_to_gbp_source
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fill.idempotency_key,
          fill.broker_fill_id,
          fill.leg,
          fill.price,
          fill.qty,
          fill.fee,
          toStoredTimestamp(fill.timestamp),
          fill.cost_breakdown === undefined ? null : JSON.stringify(fill.cost_breakdown),
          fill.exit_reason ?? null,
          fill.flatten_idempotency_key ?? null,
          fill.fee_currency ?? null,
          fill.fx_rate_to_gbp ?? null,
          fill.fx_rate_to_gbp_source ?? null,
        );
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new Error(
          `SqliteExecutionStore.applyLotAdvance: broker_fill_id '${fill.broker_fill_id}' was ` +
            `already ingested for '${fill.idempotency_key}' — ingestFills()'s hasFill gate should ` +
            'have prevented this write.',
          { cause },
        );
      }
      throw cause;
    }
  }

  /**
   * Every fill for a lot, in ingestion order — `rowid` breaks ties
   * same-millisecond timestamps can't, so `ingestFills()` can reconstruct
   * state deterministically.
   */
  async getFills(idempotency_key: string): Promise<Fill[]> {
    const rows = this.db
      .prepare('SELECT * FROM fills WHERE idempotency_key = ? ORDER BY rowid')
      .all(idempotency_key) as FillRow[];
    return rows.map(fromFillRow);
  }

  /**
   * #517: one `SUM(qty) ... GROUP BY` query for every named lot rather than
   * N `getFills` round-trips. A key with no persisted entry fill is absent
   * from the returned map.
   */
  async getEntryFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>> {
    return this.fillSizesByLeg(idempotency_keys, 'entry');
  }

  /** #568's mirror of `getEntryFillSizes` over the closing legs (see `shared/held-quantity.ts`). */
  async getExitFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>> {
    return this.fillSizesByLeg(idempotency_keys, 'exit');
  }

  /**
   * The shared batch read behind both methods above. The SQL fragment is
   * chosen from a frozen table (#568), never taken as a literal, so an
   * `as`-cast caller can't reach arbitrary SQL text on a live-money store.
   */
  private async fillSizesByLeg(
    idempotency_keys: readonly string[],
    side: 'entry' | 'exit',
  ): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    if (idempotency_keys.length === 0) return sizes;

    const legPredicate = LEG_PREDICATES[side];
    const placeholders = idempotency_keys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, SUM(qty) AS qty
           FROM fills
          WHERE idempotency_key IN (${placeholders}) AND ${legPredicate}
          GROUP BY idempotency_key`,
      )
      .all(...idempotency_keys) as { idempotency_key: string; qty: number }[];

    for (const row of rows) {
      sizes.set(row.idempotency_key, row.qty);
    }
    return sizes;
  }

  private updateLotState(
    idempotency_key: string,
    update: { filled_size: number; avg_entry_price: number; order_state: OrderState },
  ): void {
    this.db
      .prepare(
        `UPDATE open_positions
            SET filled_size = ?, avg_entry_price = ?, order_state = ?
          WHERE idempotency_key = ?`,
      )
      .run(update.filled_size, update.avg_entry_price, update.order_state, idempotency_key);
  }

  /**
   * The realized record, written once on round-trip-to-flat. `idempotency_key`
   * is the PK, so a second write for the same lot is a constraint violation.
   */
  private insertClosedTrade(trade: ClosedTrade): void {
    try {
      this.db
        .prepare(
          `INSERT INTO closed_trades (
             idempotency_key, debate_id, instrument, asset_class, side,
             entry, stop, filled_size, realized_pnl_net, fees_total,
             opened_at, closed_at, close_reason, arm, sizing_capital_ceiling,
             modelled_cost_charged
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trade.idempotency_key,
          trade.debate_id,
          trade.instrument,
          trade.asset_class,
          trade.side,
          trade.entry,
          trade.stop,
          trade.filled_size,
          trade.realized_pnl_net,
          trade.fees_total,
          toStoredTimestamp(trade.opened_at),
          toStoredTimestamp(trade.closed_at),
          trade.close_reason,
          // #753 — this instance's arm; what makes arm comparison queryable
          this.arm,
          // #1112 AC5 — see `sizingCapitalCeiling`'s own doc
          this.sizingCapitalCeiling ?? null,
          // #1121 AC5 — what actually happened to this lot's fills, computed
          // at close time by `closedTrade()`; nullable pre-migration-0037
          trade.modelled_cost_charged ? 1 : 0,
        );
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new Error(
          `SqliteExecutionStore.applyLotAdvance: a closed trade already exists for ` +
            `idempotency_key '${trade.idempotency_key}' — a lot closes exactly once, ` +
            'on round-trip-to-flat.',
          { cause },
        );
      }
      throw cause;
    }
  }

  /**
   * One poll's advance of a lot, in a single transaction — fills, lot state,
   * and (on round-trip-to-flat) the `ClosedTrade` commit together or not at all.
   */
  async applyLotAdvance(advance: LotAdvance): Promise<void> {
    this.db.transaction(() => {
      for (const fill of advance.fills) {
        this.insertFill(fill);
      }
      if (advance.position_update !== undefined) {
        this.updateLotState(advance.idempotency_key, advance.position_update);
      }
      if (advance.closed_trade !== undefined) {
        this.insertClosedTrade(advance.closed_trade);
      }
    })();
  }

  /**
   * Write-ahead: INSERT at `'submitting'` before `broker.submitFlatten`
   * (mirrors `writeAheadPosition`). The one-flatten-per-instrument check
   * (#1214) runs in the SAME transaction as the INSERT — a caller-side read
   * first would leave a race window between two concurrent submitters.
   */
  async writeAheadFlatten(submission: FlattenSubmissionWriteAhead): Promise<void> {
    try {
      this.db.transaction(() => {
        const blocking = this.db
          .prepare(
            `SELECT idempotency_key FROM flatten_submissions
              WHERE arm = ?
                AND instrument = ?
                AND idempotency_key <> ?
                AND (status = 'submitting'
                 OR (status = 'submitted' AND fills_swept_at IS NULL))
              LIMIT 1`,
          )
          .get(this.arm, submission.instrument, submission.idempotency_key) as
          | { idempotency_key: string }
          | undefined;
        if (blocking !== undefined) {
          throw new UnresolvedFlattenForInstrumentError(
            submission.idempotency_key,
            submission.instrument,
            blocking.idempotency_key,
          );
        }
        this.insertFlattenWriteAhead(submission);
      })();
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new DuplicateFlattenSubmissionError(submission.idempotency_key);
      }
      throw cause;
    }
  }

  private insertFlattenWriteAhead(submission: FlattenSubmissionWriteAhead): void {
    this.db
      .prepare(
        `INSERT INTO flatten_submissions (
             idempotency_key, instrument, asset_class, side, size,
             status, submitted_at, lot_idempotency_keys, lot_held_quantities, exit_reason,
             decision_price, quote_bid, quote_ask, quote_mid, quote_observed_at,
             modelled_cost_breakdown_json, arm
           ) VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        submission.idempotency_key,
        submission.instrument,
        submission.asset_class,
        submission.side,
        submission.size,
        toStoredTimestamp(submission.submitted_at),
        // Both columns projected from the same array — the positional
        // pairing is re-established by `getFlattenAttribution`
        JSON.stringify(submission.lot_held_quantities.map((lot) => lot.idempotency_key)),
        JSON.stringify(submission.lot_held_quantities.map((lot) => lot.held)),
        submission.exit_reason,
        // #1001 — see `FlattenSubmissionWriteAhead`'s field docs
        submission.decision_price,
        submission.quote_bid,
        submission.quote_ask,
        submission.quote_mid,
        submission.quote_observed_at === null
          ? null
          : toStoredTimestamp(submission.quote_observed_at),
        submission.modelled_cost_breakdown === null
          ? null
          : JSON.stringify(submission.modelled_cost_breakdown),
        // #1124 — this instance's arm, same posture as `writeAheadPosition`
        this.arm,
      );
  }

  /** Persist the post-ack transition (`'submitting'` → `'submitted'`) */
  async resolveFlattenSubmitted(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
    resolved_at: Date,
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE flatten_submissions
            SET status = 'submitted', order_state = ?, broker_order_ids = ?, resolved_at = ?
          WHERE idempotency_key = ?`,
      )
      .run(
        update.order_state,
        JSON.stringify(update.broker_order_ids),
        toStoredTimestamp(resolved_at),
        idempotency_key,
      );

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.resolveFlattenSubmitted: no write-ahead record for '${idempotency_key}'`,
      );
    }
  }

  /** Persist → `'error'` — see `SharedStore.resolveFlattenError` for when this applies */
  async resolveFlattenError(
    idempotency_key: string,
    reason: string,
    resolved_at: Date,
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE flatten_submissions
            SET status = 'error', reason = ?, resolved_at = ?
          WHERE idempotency_key = ?`,
      )
      .run(reason, toStoredTimestamp(resolved_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.resolveFlattenError: no write-ahead record for '${idempotency_key}'`,
      );
    }
  }

  /**
   * Pure read backing the invariant that a retry key is only safe over a row
   * provably dead at the venue (#1214) — only `'error'` clears the retry walk.
   */
  async isRetryableFlattenError(idempotency_key: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT status FROM flatten_submissions WHERE idempotency_key = ?')
      .get(idempotency_key) as { status: string } | undefined;
    return row?.status === 'error';
  }

  /**
   * #517/#571: which lot(s) a flatten closed, and what each held when
   * submitted. `null` covers "no such flatten" and pre-migration rows alike.
   */
  async getFlattenAttribution(idempotency_key: string): Promise<FlattenAttribution | null> {
    const row = this.db
      .prepare(
        `SELECT lot_idempotency_keys, lot_held_quantities, exit_reason, size,
                instrument, side, modelled_cost_breakdown_json
           FROM flatten_submissions WHERE idempotency_key = ?`,
      )
      .get(idempotency_key) as
      | {
          lot_idempotency_keys: string | null;
          lot_held_quantities: string | null;
          exit_reason: ExitReason | null;
          size: number;
          instrument: string;
          side: 'buy' | 'sell';
          modelled_cost_breakdown_json: string | null;
        }
      | undefined;
    if (row === undefined || row.lot_idempotency_keys === null) return null;

    // #1001 — the flatten's own submit-time cost breakdown, prorated per lot
    // by `redistributeOneFlatten`. Validated not cast (#1014 finding 4, #509).
    const modelledCostBreakdown = parseModelledCostBreakdownColumn(
      row.modelled_cost_breakdown_json,
    );

    // Validated, not cast (#509) — an unvalidated `as string[]` would blow up
    // deep inside `ingestFills()`'s allocation loop with no clear cause. The
    // raw value is withheld from the error since it reaches `audit_log` (#507).
    const keys = parseJsonColumn(idempotency_key, 'lot_idempotency_keys', row.lot_idempotency_keys);
    if (!Array.isArray(keys) || !keys.every((entry) => typeof entry === 'string')) {
      throw new Error(
        `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.lot_idempotency_keys for ` +
          `'${idempotency_key}' is not a JSON array of strings`,
      );
    }

    if (row.lot_held_quantities === null) {
      return {
        lot_idempotency_keys: keys,
        lot_held_quantities: null,
        exit_reason: row.exit_reason,
        instrument: row.instrument,
        side: row.side,
        modelled_cost_breakdown: modelledCostBreakdown,
        size: row.size,
      };
    }

    const held = parseJsonColumn(idempotency_key, 'lot_held_quantities', row.lot_held_quantities);
    // The two columns encode pairing positionally — a length mismatch would
    // attribute a lot's quantity to a different lot
    if (!Array.isArray(held) || held.length !== keys.length) {
      throw new Error(
        `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.lot_held_quantities for ` +
          `'${idempotency_key}' is not a JSON array of one quantity per journalled lot ` +
          `(${keys.length})`,
      );
    }

    // Non-negative and finite: `executeExit` refuses an over-exited lot
    // before writing this row, so anything else is a corrupted record.
    const paired: LotHeldQuantity[] = [];
    for (const [index, key] of keys.entries()) {
      const quantity: unknown = held[index];
      if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
        throw new Error(
          `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.lot_held_quantities ` +
            `for '${idempotency_key}' holds an entry that is not a finite non-negative number`,
        );
      }
      paired.push({ idempotency_key: key, held: quantity });
    }

    return {
      lot_idempotency_keys: keys,
      lot_held_quantities: paired,
      exit_reason: row.exit_reason,
      instrument: row.instrument,
      side: row.side,
      modelled_cost_breakdown: modelledCostBreakdown,
      size: row.size,
    };
  }

  /**
   * `reconcile()`'s worklist (#519, #526): `'submitting'`, or `'submitted'`
   * not yet swept. `arm`-scoped since #1124 — unfiltered, each arm's
   * reconcile asked its own broker about the OTHER arm's `client_order_id`.
   * `writeAheadFlatten`'s one-flatten-per-instrument guard runs this same predicate.
   */
  async getUnresolvedFlattens(): Promise<UnresolvedFlattenSubmission[]> {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, instrument, status, submitted_at, order_state, cancel_attempted_at,
                terminal_unswept_checked_at
           FROM flatten_submissions
          WHERE arm = ?
            AND (status = 'submitting'
             OR (status = 'submitted' AND fills_swept_at IS NULL))`,
      )
      .all(this.arm) as Array<{
      idempotency_key: string;
      instrument: string;
      status: 'submitting' | 'submitted';
      submitted_at: string;
      order_state: OrderState | null;
      cancel_attempted_at: string | null;
      terminal_unswept_checked_at: string | null;
    }>;

    return rows.map((row) => ({
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      status: row.status,
      submitted_at: new Date(row.submitted_at),
      order_state: row.order_state,
      cancel_attempted_at:
        row.cancel_attempted_at === null ? null : new Date(row.cancel_attempted_at),
      terminal_unswept_checked_at:
        row.terminal_unswept_checked_at === null ? null : new Date(row.terminal_unswept_checked_at),
    }));
  }

  /**
   * A fresher venue answer on an already-`'submitted'` row — must not touch
   * `resolved_at`/`status` the way `resolveFlattenSubmitted` does.
   */
  async recordFlattenOrderStateObserved(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE flatten_submissions
            SET order_state = ?, broker_order_ids = ?
          WHERE idempotency_key = ?`,
      )
      .run(update.order_state, JSON.stringify(update.broker_order_ids), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.recordFlattenOrderStateObserved: no flatten_submissions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  /** Migration 0062's throttle input — see `SharedStore.markFlattenCancelAttempted` */
  async markFlattenCancelAttempted(idempotency_key: string, attempted_at: Date): Promise<void> {
    const result = this.db
      .prepare('UPDATE flatten_submissions SET cancel_attempted_at = ? WHERE idempotency_key = ?')
      .run(toStoredTimestamp(attempted_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markFlattenCancelAttempted: no flatten_submissions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  /** Migration 0063's window start and throttle — see `SharedStore.markFlattenTerminalUnsweptChecked` */
  async markFlattenTerminalUnsweptChecked(
    idempotency_key: string,
    checked_at: Date,
  ): Promise<void> {
    const result = this.db
      .prepare(
        'UPDATE flatten_submissions SET terminal_unswept_checked_at = ? WHERE idempotency_key = ?',
      )
      .run(toStoredTimestamp(checked_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markFlattenTerminalUnsweptChecked: no flatten_submissions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  /** Bounds `getUnresolvedFlattens()` above — see `SharedStore.markFlattenFillsSwept`'s doc for when this may be called */
  async markFlattenFillsSwept(idempotency_key: string, swept_at: Date): Promise<void> {
    const result = this.db
      .prepare('UPDATE flatten_submissions SET fills_swept_at = ? WHERE idempotency_key = ?')
      .run(toStoredTimestamp(swept_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markFlattenFillsSwept: no flatten_submissions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  /**
   * #549's durable marker. COALESCE keeps the first observation time. Throws
   * on an unknown lot — silently succeeding would falsely imply sweep coverage.
   */
  async markResidualUnprotected(idempotency_key: string, observed_at: Date): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE open_positions
            SET residual_unprotected_since = COALESCE(residual_unprotected_since, ?)
          WHERE idempotency_key = ?`,
      )
      .run(toStoredTimestamp(observed_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markResidualUnprotected: no open_positions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  /**
   * Clears the #549 marker and its alert-dedup timestamp together. A no-op
   * on an unmarked/unknown lot, unlike `markResidualUnprotected` above.
   */
  async confirmResidualProtected(idempotency_key: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE open_positions
            SET residual_unprotected_since = NULL,
                residual_rearm_alerted_at = NULL,
                residual_rearm_unsupported_alerted_at = NULL
          WHERE idempotency_key = ?`,
      )
      .run(idempotency_key);
  }

  /**
   * #549's once-per-episode alert dedup — first-writer-wins: the write lands
   * only while the episode is un-alerted; `changes` reports who won.
   */
  async markResidualAlerted(idempotency_key: string, alerted_at: Date): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE open_positions
            SET residual_rearm_alerted_at = ?
          WHERE idempotency_key = ? AND residual_rearm_alerted_at IS NULL`,
      )
      .run(toStoredTimestamp(alerted_at), idempotency_key);

    return result.changes > 0;
  }

  /**
   * Same first-writer-wins dedup as `markResidualAlerted`, over its own
   * column — a pre-attempt page can't block this, and vice versa.
   */
  async markResidualRearmUnsupportedAlerted(
    idempotency_key: string,
    alerted_at: Date,
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE open_positions
            SET residual_rearm_unsupported_alerted_at = ?
          WHERE idempotency_key = ? AND residual_rearm_unsupported_alerted_at IS NULL`,
      )
      .run(toStoredTimestamp(alerted_at), idempotency_key);

    return result.changes > 0;
  }

  /**
   * Point-read of `residual_rearm_unsupported_alerted_at`. No matching row
   * reads the same as `null` — both mean "never alerted".
   */
  async getResidualRearmUnsupportedAlertedAt(idempotency_key: string): Promise<Date | null> {
    const row = this.db
      .prepare(
        `SELECT residual_rearm_unsupported_alerted_at
           FROM open_positions WHERE idempotency_key = ?`,
      )
      .get(idempotency_key) as { residual_rearm_unsupported_alerted_at: string | null } | undefined;

    return row === undefined
      ? null
      : fromStoredTimestampOrNull(row.residual_rearm_unsupported_alerted_at);
  }

  /** The #549 sweep's worklist — non-terminal lots still marked unprotected. */
  async getUnprotectedResidualLots(): Promise<UnprotectedResidualLot[]> {
    const placeholders = TERMINAL_ORDER_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        // #753: arm-scoped, same reason as `getOpenPositions()`
        `SELECT * FROM open_positions
          WHERE arm = ?
            AND residual_unprotected_since IS NOT NULL
            AND order_state NOT IN (${placeholders})
          ORDER BY opened_at`,
      )
      .all(this.arm, ...TERMINAL_ORDER_STATES) as OpenPositionRow[];

    return rows.map((row) => {
      // Non-null by the WHERE clause — fail loudly on a corrupted row rather
      // than fabricate an observation time (#549 review)
      if (row.residual_unprotected_since === null) {
        throw new Error(
          `SqliteExecutionStore.getUnprotectedResidualLots: row '${row.idempotency_key}' ` +
            'matched the marker query but residual_unprotected_since reads NULL',
        );
      }
      return {
        position: fromOpenPositionRow(row),
        unprotected_since: fromStoredTimestamp(row.residual_unprotected_since),
        alerted_at: fromStoredTimestampOrNull(row.residual_rearm_alerted_at),
        rearm_unsupported_alerted_at: fromStoredTimestampOrNull(
          row.residual_rearm_unsupported_alerted_at,
        ),
      };
    });
  }
}

/**
 * `JSON.parse` for one `flatten_submissions` column; the raw value is
 * withheld from the error — see `getFlattenAttribution`.
 */
function parseJsonColumn(idempotency_key: string, column: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.${column} for ` +
        `'${idempotency_key}' is not valid JSON`,
      { cause },
    );
  }
}
