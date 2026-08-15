/**
 * SQLite-backed `SharedStore` (server/pipeline/execution/types.ts) over `open_positions`,
 * `fills` and `closed_trades` (#193) — the real store behind Execution's
 * write-ahead port. See docs/specs/shared-sqlite-store-spec.md ("Execution"
 * schema section) and docs/specs/execution-spec.md ("Module: Idempotency &
 * Crash-Restart").
 *
 * Execution is these three tables' sole writer (cross-spec §4), so every
 * method here is a direct, un-negotiated read/write against them — no
 * business logic lives here, only the port-to-schema translation. `better-sqlite3`
 * is synchronous; the `Promise`-returning methods are the port's shape
 * (`SharedStore`), not evidence of async I/O.
 *
 * Two conventions carried from `SqliteSetupStore` (server/pipeline/trader/sqlite-setup-store.ts):
 *
 * 1. **Timestamps are ISO-8601 UTC TEXT** (`Date.toISOString()`) on write and
 *    read alike.
 * 2. **JSON columns** (`broker_order_ids`, `cost_breakdown_json`) round-trip
 *    through `JSON.stringify`/`JSON.parse` at this boundary only — the port
 *    never sees the serialized form.
 */

import type {
  ClosedTrade,
  Fill,
  LotHeldQuantity,
  OpenPosition,
  OrderState,
} from '../../shared/index.js';
import {
  type SharedStore as Db,
  isUniqueConstraintError,
  TERMINAL_ORDER_STATES,
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
 * Terminal `order_state`s — excluded from `getOpenPositions()`
 * (execution-spec.md). Defined in `shared/store/key-scheme-guard.ts`, which the
 * #686 rollout guard reads too; aliased here so the SQL below keeps its
 * original name.
 */
const TERMINAL_STATES: readonly OrderState[] = TERMINAL_ORDER_STATES;

/**
 * The only two leg predicates `fillSizesByLeg` will put in its SQL, chosen by
 * name rather than passed in as text (#568 review). Frozen so the lookup
 * cannot be mutated into a third value at runtime either.
 *
 * `'exit'` is `leg != 'entry'` rather than an enumeration of the closing
 * legs, so it stays the SQL spelling of `ingest-fills.ts`'s `isExitFill` and
 * cannot drift from it if a fourth leg is ever added.
 */
const LEG_PREDICATES = Object.freeze({
  entry: "leg = 'entry'",
  exit: "leg != 'entry'",
} as const);

/** Exported for `sqlite-store-harness.ts`, which reads the same row shape for its terminal-inclusive lookups. */
export interface OpenPositionRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  intent_type: 'entry' | 'scale_in';
  requested_size: number;
  filled_size: number;
  avg_entry_price: number;
  stop: number;
  target: number;
  order_state: OrderState;
  broker_order_ids: string;
  opened_at: string;
  decision_timestamp: string;
  conviction: number;
  converged: 0 | 1;
  /** NULL unless a #549 unprotected-residual episode is open — migration 0024. */
  residual_unprotected_since: string | null;
  /** NULL until that episode's operator alert was posted — migration 0024. */
  residual_rearm_alerted_at: string | null;
}

interface FillRow {
  idempotency_key: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: string;
  cost_breakdown_json: string | null;
}

/**
 * Thrown when the write-ahead INSERT loses a race for an idempotency key.
 *
 * A named type rather than a message prefix because `execute()` has to
 * DISCRIMINATE on it: a duplicate key means another caller already acted on
 * this decision (answer `deduped`), while any other failure means the
 * write-ahead did not happen and must not be mistaken for one. String-matching
 * that distinction would make the message load-bearing, and the first person to
 * reword it would silently turn real store failures into dedup responses.
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

/** `writeAheadFlatten`'s equivalent of `DuplicatePositionError` — see there for the reasoning. */
export class DuplicateFlattenSubmissionError extends Error {
  constructor(readonly idempotency_key: string) {
    super(
      `SqliteExecutionStore.writeAheadFlatten: a flatten submission already exists for ` +
        `idempotency_key '${idempotency_key}' — execute()'s findByKey gate should ` +
        'have prevented this write.',
    );
    this.name = 'DuplicateFlattenSubmissionError';
  }
}

export class SqliteExecutionStore implements SharedStore {
  constructor(private readonly db: Db) {}

  /**
   * True if an order already exists under this key. Two tables, because two
   * write-ahead paths use this one key space: `open_positions` for entry/
   * scale_in (a `Fill` never exists without the `OpenPosition` row
   * `execute()` write-aheads first, so an existing fill implies an existing,
   * still-present position row) and `flatten_submissions` for exit (#508
   * review, PR #516) — an exit has no bracket and writes no `OpenPosition`,
   * so without this second check a replayed exit would sail past this gate
   * every time.
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
   * a recoverable `pending` row (#86 reconciles it). A duplicate key surfaces
   * as `DuplicatePositionError` rather than being silently upserted: the row
   * that won the race is another caller's in-flight order, and overwriting it
   * would erase the broker ids reconciliation needs. `execute()`'s `findByKey`
   * gate normally prevents this; the PK is the backstop for two callers that
   * both pass that gate before either has written.
   */
  async writeAheadPosition(position: OpenPosition): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO open_positions (
             idempotency_key, debate_id, instrument, asset_class, side, intent_type,
             requested_size, filled_size, avg_entry_price, stop, target,
             order_state, broker_order_ids, opened_at, decision_timestamp,
             conviction, converged
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          position.opened_at.toISOString(),
          position.decision_timestamp.toISOString(),
          position.conviction,
          position.converged ? 1 : 0,
        );
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new DuplicatePositionError(position.idempotency_key);
      }
      throw cause;
    }
  }

  /** Persist the post-ack transition (`pending` → `submitted`), or reconcile's adopted state. */
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

  /** Non-terminal lots only (execution-spec.md) — deterministic order for callers that iterate. */
  async getOpenPositions(): Promise<OpenPosition[]> {
    const placeholders = TERMINAL_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM open_positions WHERE order_state NOT IN (${placeholders}) ORDER BY opened_at`,
      )
      .all(...TERMINAL_STATES) as OpenPositionRow[];
    return rows.map(fromPositionRow);
  }

  /** Dedup gate for the fill feed's re-offered fills. */
  async hasFill(broker_fill_id: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM fills WHERE broker_fill_id = ?').get(broker_fill_id);
    return row !== undefined;
  }

  /**
   * One row per (partial) fill. `(idempotency_key, broker_fill_id)` is the
   * table's PK, so a duplicate write — which `hasFill` is meant to prevent —
   * surfaces as a constraint violation rather than silently double-counting.
   */
  private insertFill(fill: Fill): void {
    try {
      this.db
        .prepare(
          `INSERT INTO fills (
             idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp, cost_breakdown_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fill.idempotency_key,
          fill.broker_fill_id,
          fill.leg,
          fill.price,
          fill.qty,
          fill.fee,
          fill.timestamp.toISOString(),
          fill.cost_breakdown === undefined ? null : JSON.stringify(fill.cost_breakdown),
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
   * Every fill for a lot, in ingestion order — `rowid` (SQLite's implicit
   * insertion-order column) breaks ties that same-millisecond timestamps
   * cannot, which is what lets `ingestFills()` reconstruct realized size and
   * avg price deterministically rather than trusting a running total.
   */
  async getFills(idempotency_key: string): Promise<Fill[]> {
    const rows = this.db
      .prepare('SELECT * FROM fills WHERE idempotency_key = ? ORDER BY rowid')
      .all(idempotency_key) as FillRow[];
    return rows.map(fromFillRow);
  }

  /**
   * #517's batch read: one `SUM(qty) ... GROUP BY` query for every named lot
   * rather than N `getFills` round-trips. Shape follows
   * `SqliteQueryStore.getMarks`' precedent (dashboard/sqlite-query-store.ts)
   * — the placeholder list is built from `idempotency_keys.length`, never
   * from the strings themselves, so the values stay bound parameters; a key
   * with no persisted entry fill has no `GROUP BY` row and is therefore
   * simply absent from the returned `Map`.
   */
  async getEntryFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>> {
    return this.fillSizesByLeg(idempotency_keys, 'entry');
  }

  /**
   * #568's mirror of the above over the CLOSING legs — the quantity to
   * subtract from `filled_size` to get what a lot still holds (see
   * `shared/held-quantity.ts`). `leg != 'entry'` rather than an enumeration of
   * the three closing legs, so it stays the SQL spelling of
   * `ingest-fills.ts`'s `isExitFill` and cannot drift from it if a fourth leg
   * is ever added.
   */
  async getExitFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>> {
    return this.fillSizesByLeg(idempotency_keys, 'exit');
  }

  /**
   * The batch read both of the above are.
   *
   * The caller names a SIDE (`'entry' | 'exit'`), and the SQL fragment is
   * chosen from a frozen table here (#568 review). It used to take the
   * fragment itself as a two-literal union, which was safe in practice — the
   * method is private and both call sites are above — but rested on a type
   * that does not exist at runtime: one `as` cast, or a plain-JS caller after
   * a build step, and an arbitrary string reaches the SQL text of a
   * live-money store. A lookup cannot be talked into a value that is not in
   * the table, whatever the type says.
   *
   * The idempotency keys were never interpolated and still are not — they
   * stay bound parameters, with the placeholder list built from `length`
   * alone.
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
   * is the table's PK, so a second write for the same lot — which would mean
   * `ingestFills()` closed it twice — surfaces as a constraint violation
   * rather than a silent overwrite.
   */
  private insertClosedTrade(trade: ClosedTrade): void {
    try {
      this.db
        .prepare(
          `INSERT INTO closed_trades (
             idempotency_key, debate_id, instrument, asset_class, side,
             entry, stop, filled_size, realized_pnl_net, fees_total,
             opened_at, closed_at, close_reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          trade.opened_at.toISOString(),
          trade.closed_at.toISOString(),
          trade.close_reason,
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
   * One poll's advance of a lot, in a single transaction — the fills, the
   * recomputed lot state, and (on round-trip-to-flat) the `ClosedTrade`
   * commit together or not at all. A crash mid-advance rolls back cleanly,
   * so the next poll's `hasFill` gate sees none of it and re-ingests the
   * re-offered fills; the un-transacted version of this left a lot whose
   * persisted fills said one thing and whose `filled_size` said another,
   * forever (`hasFill` skipped the repair).
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
   * Write-ahead: INSERT at `'submitting'` before `broker.submitFlatten` is
   * called — `writeAheadPosition`'s reasoning applies unchanged, only the
   * table differs. A duplicate key surfaces as `DuplicateFlattenSubmissionError`
   * for the same reason `writeAheadPosition` distinguishes it: `execute()`'s
   * `findByKey` gate normally prevents this, so a collision here means a
   * concurrent caller won the same race, not a generic write failure.
   */
  async writeAheadFlatten(submission: FlattenSubmissionWriteAhead): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO flatten_submissions (
             idempotency_key, instrument, asset_class, side, size,
             status, submitted_at, lot_idempotency_keys, lot_held_quantities
           ) VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?, ?)`,
        )
        .run(
          submission.idempotency_key,
          submission.instrument,
          submission.asset_class,
          submission.side,
          submission.size,
          submission.submitted_at.toISOString(),
          // Both columns projected from the SAME array in the same statement,
          // so the pairing they encode positionally cannot be wrong here.
          // `getFlattenAttribution` re-establishes it on the way out.
          JSON.stringify(submission.lot_held_quantities.map((lot) => lot.idempotency_key)),
          JSON.stringify(submission.lot_held_quantities.map((lot) => lot.held)),
        );
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new DuplicateFlattenSubmissionError(submission.idempotency_key);
      }
      throw cause;
    }
  }

  /** Persist the post-ack transition (`'submitting'` → `'submitted'`). */
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
        resolved_at.toISOString(),
        idempotency_key,
      );

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.resolveFlattenSubmitted: no write-ahead record for '${idempotency_key}'`,
      );
    }
  }

  /** Persist `'submitting'` → `'error'` — see `SharedStore.resolveFlattenError` for when this applies. */
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
      .run(reason, resolved_at.toISOString(), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.resolveFlattenError: no write-ahead record for '${idempotency_key}'`,
      );
    }
  }

  /**
   * #517's read, widened by #571: which lot(s) a flatten submission was
   * journalled to close, and what each of them HELD when it was submitted.
   * `null` covers both "no such flatten" and "a flatten row written before
   * migration 0020" — `ingestFills()` treats them identically (cannot
   * attribute), so this does not distinguish them further.
   *
   * `lot_held_quantities` reads `null` on its own for a row written before
   * migration 0021 — attributable, but only by the pre-#571 entry-total
   * split. Both columns come back in ONE query: the length agreement between
   * them is an invariant of the row, so the one place that can check it is
   * the one place that reads it.
   */
  async getFlattenAttribution(idempotency_key: string): Promise<FlattenAttribution | null> {
    const row = this.db
      .prepare(
        `SELECT lot_idempotency_keys, lot_held_quantities
           FROM flatten_submissions WHERE idempotency_key = ?`,
      )
      .get(idempotency_key) as
      | { lot_idempotency_keys: string | null; lot_held_quantities: string | null }
      | undefined;
    if (row === undefined || row.lot_idempotency_keys === null) return null;

    // Validated, not cast — the same defect class #509 closed repo-wide
    // (a value cast to a type with no runtime check, failing far from the
    // cause). An unvalidated `as string[]` here would let a corrupted row —
    // or a future migration that writes a different JSON shape into this
    // column — blow up deep inside `ingestFills()`'s allocation loop with no
    // indication of which `flatten_submissions` row was the cause. Every
    // failure message names `idempotency_key` (this method's own argument,
    // generated by this codebase's own content-hash, never venue- or
    // user-supplied text) and deliberately does NOT include the raw column
    // value: since #507, an uncaught throw here is durably recorded to
    // `audit_log`, and the raw content is exactly the kind of untrusted
    // payload that record must not carry.
    const keys = parseJsonColumn(idempotency_key, 'lot_idempotency_keys', row.lot_idempotency_keys);
    if (!Array.isArray(keys) || !keys.every((entry) => typeof entry === 'string')) {
      throw new Error(
        `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.lot_idempotency_keys for ` +
          `'${idempotency_key}' is not a JSON array of strings`,
      );
    }

    if (row.lot_held_quantities === null) {
      return { lot_idempotency_keys: keys, lot_held_quantities: null };
    }

    const held = parseJsonColumn(idempotency_key, 'lot_held_quantities', row.lot_held_quantities);
    // The two columns encode their pairing positionally, so a length
    // disagreement would attribute a lot's quantity to a DIFFERENT lot —
    // silently, and on the money path. Checked before anything is paired, so
    // what this returns needs no re-checking by its caller.
    if (!Array.isArray(held) || held.length !== keys.length) {
      throw new Error(
        `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.lot_held_quantities for ` +
          `'${idempotency_key}' is not a JSON array of one quantity per journalled lot ` +
          `(${keys.length})`,
      );
    }

    // Non-negative as well as finite, because this is a quantity the split
    // hands to the money path: `executeExit` refuses an over-exited lot BEFORE
    // writing this row, so a negative here is a corrupted record, not a state
    // the system can reach. Refusing it (fail closed) is the same posture
    // `executeExit` takes rather than clamping it to something
    // plausible-looking — a share silently skipped as "nothing to allocate"
    // would strand that lot's quantity with no signal at all.
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

    return { lot_idempotency_keys: keys, lot_held_quantities: paired };
  }

  /**
   * `reconcile()`'s worklist (#519, #526) — see `SharedStore.getUnresolvedFlattens`
   * for the bound this query implements: `'submitting'` outright, or
   * `'submitted'` rows not yet confirmed swept (`fills_swept_at IS NULL`).
   * `'error'` rows are excluded by the `status IN (...)` clause itself —
   * that status means the flatten provably never reached the broker, so
   * there is nothing left to ask the venue.
   */
  async getUnresolvedFlattens(): Promise<UnresolvedFlattenSubmission[]> {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, instrument, status
           FROM flatten_submissions
          WHERE status = 'submitting'
             OR (status = 'submitted' AND fills_swept_at IS NULL)`,
      )
      .all() as Array<{
      idempotency_key: string;
      instrument: string;
      status: 'submitting' | 'submitted';
    }>;

    return rows.map((row) => ({
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      status: row.status,
    }));
  }

  /**
   * A fresher venue answer on an ALREADY-`'submitted'` row — see the doc on
   * `SharedStore.recordFlattenOrderStateObserved` for why this must not
   * touch `resolved_at`/`status` the way `resolveFlattenSubmitted` does.
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

  /** Bounds `getUnresolvedFlattens()` above — see `SharedStore.markFlattenFillsSwept`'s doc for when this may be called. */
  async markFlattenFillsSwept(idempotency_key: string, swept_at: Date): Promise<void> {
    const result = this.db
      .prepare('UPDATE flatten_submissions SET fills_swept_at = ? WHERE idempotency_key = ?')
      .run(swept_at.toISOString(), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markFlattenFillsSwept: no flatten_submissions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  /**
   * #549's durable marker — see `SharedStore.markResidualUnprotected`.
   * COALESCE keeps the FIRST observation time, so a re-mark of an already
   * open episode changes nothing (and never resets the alert dedup either).
   * Throws when no such lot exists: a marker written against a key
   * `open_positions` does not hold protects nothing, and silently succeeding
   * would let the caller believe it is covered by the sweep.
   */
  async markResidualUnprotected(idempotency_key: string, observed_at: Date): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE open_positions
            SET residual_unprotected_since = COALESCE(residual_unprotected_since, ?)
          WHERE idempotency_key = ?`,
      )
      .run(observed_at.toISOString(), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markResidualUnprotected: no open_positions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  /**
   * Clears the #549 marker AND its alert-dedup timestamp together — see
   * `SharedStore.confirmResidualProtected` for why this is the only clear
   * path and why it is a no-op on an unmarked/unknown lot (unlike
   * `markResidualUnprotected` above, which must not silently succeed).
   */
  async confirmResidualProtected(idempotency_key: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE open_positions
            SET residual_unprotected_since = NULL, residual_rearm_alerted_at = NULL
          WHERE idempotency_key = ?`,
      )
      .run(idempotency_key);
  }

  /**
   * The #549 once-per-episode alert dedup — see `SharedStore.markResidualAlerted`
   * for the first-writer-wins contract this WHERE clause implements: the
   * write lands only while the episode is still un-alerted, and `changes`
   * reports whether THIS call was the one that landed it.
   */
  async markResidualAlerted(idempotency_key: string, alerted_at: Date): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE open_positions
            SET residual_rearm_alerted_at = ?
          WHERE idempotency_key = ? AND residual_rearm_alerted_at IS NULL`,
      )
      .run(alerted_at.toISOString(), idempotency_key);

    return result.changes > 0;
  }

  /**
   * The #549 sweep's worklist — non-terminal lots still marked unprotected,
   * in `opened_at` order for the same determinism `getOpenPositions()` gives
   * its own iterating callers.
   */
  async getUnprotectedResidualLots(): Promise<UnprotectedResidualLot[]> {
    const placeholders = TERMINAL_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM open_positions
          WHERE residual_unprotected_since IS NOT NULL
            AND order_state NOT IN (${placeholders})
          ORDER BY opened_at`,
      )
      .all(...TERMINAL_STATES) as OpenPositionRow[];

    return rows.map((row) => {
      // Non-null by the WHERE clause — a null here means the row (or the
      // query) is corrupted, and mapping it to some default would hand the
      // sweep a fabricated observation time. Fail loudly instead (#549
      // review); the sweep's caller treats an unreadable worklist as "no
      // pass", which is the honest answer.
      if (row.residual_unprotected_since === null) {
        throw new Error(
          `SqliteExecutionStore.getUnprotectedResidualLots: row '${row.idempotency_key}' ` +
            'matched the marker query but residual_unprotected_since reads NULL',
        );
      }
      return {
        position: fromPositionRow(row),
        unprotected_since: new Date(row.residual_unprotected_since),
        alerted_at:
          row.residual_rearm_alerted_at === null ? null : new Date(row.residual_rearm_alerted_at),
      };
    });
  }
}

/**
 * `JSON.parse` for one `flatten_submissions` column, failing with the row and
 * column named and the raw value withheld — see `getFlattenAttribution` for
 * why the value never appears in the message.
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

export function fromPositionRow(row: OpenPositionRow): OpenPosition {
  return {
    idempotency_key: row.idempotency_key,
    debate_id: row.debate_id,
    instrument: row.instrument,
    asset_class: row.asset_class,
    side: row.side,
    intent_type: row.intent_type,
    requested_size: row.requested_size,
    filled_size: row.filled_size,
    avg_entry_price: row.avg_entry_price,
    stop: row.stop,
    target: row.target,
    order_state: row.order_state,
    broker_order_ids: JSON.parse(row.broker_order_ids) as string[],
    opened_at: new Date(row.opened_at),
    decision_timestamp: new Date(row.decision_timestamp),
    conviction: row.conviction,
    converged: row.converged === 1,
  };
}

function fromFillRow(row: FillRow): Fill {
  return {
    idempotency_key: row.idempotency_key,
    broker_fill_id: row.broker_fill_id,
    leg: row.leg,
    price: row.price,
    qty: row.qty,
    fee: row.fee,
    timestamp: new Date(row.timestamp),
    ...(row.cost_breakdown_json === null
      ? {}
      : {
          cost_breakdown: JSON.parse(row.cost_breakdown_json) as NonNullable<
            Fill['cost_breakdown']
          >,
        }),
  };
}
