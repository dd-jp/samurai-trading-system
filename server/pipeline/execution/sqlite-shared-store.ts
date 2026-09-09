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
 * 1. **Timestamps are ISO-8601 UTC TEXT**, written through
 *    `toStoredTimestamp` and read back through `fromStoredTimestamp`
 *    (`shared/store/sqlite-utils.ts`, #837 M7). Those helpers are where the
 *    fixed-width form is held, and `ORDER BY opened_at` below is a TEXT sort
 *    that is chronological only because of it. The store tests here do NOT
 *    catch a uniform format regression — every write and bound parameter
 *    flows through the same helper, so rows stay mutually consistent even if
 *    the format drifts. The write-side `STORED_TIMESTAMP` regex inside
 *    `toStoredTimestamp` is the actual enforcement point (#884); don't relax
 *    it on the strength of these tests staying green.
 * 2. **JSON columns** (`broker_order_ids`, `cost_breakdown_json`) round-trip
 *    through `JSON.stringify`/`JSON.parse` at this boundary only — the port
 *    never sees the serialized form.
 *
 * ## `open_positions` row lifecycle (#1088)
 *
 * A row is write-ahead INSERTed at `pending` by `writeAheadPosition`, before
 * the broker call — so a crash in that gap always leaves a recoverable
 * record (`reconcile()`, #86). From there it moves through exactly one of
 * two paths:
 *
 * - **Never lands**: `pending` → `rejected` when `reconcile()` asks the
 *   venue and the venue authoritatively has no such order (the write-ahead
 *   died, or was cancelled before ack). Also reachable directly from
 *   `pending`/`submitted` as `cancelled` or `expired` when the venue reports
 *   one of those states instead. None of these ever advance again — no code
 *   path resubmits a terminal lot under its own key (a NEW decision, if one
 *   is made, gets a NEW `idempotency_key`, per `computeIdempotencyKey`'s
 *   `(instrument, bar, side, arm)` hash).
 * - **Lands and fills**: `pending` → `submitted` → `partially_filled` →
 *   `filled` (`ingestFills`, driven by persisted `Fill` rows, never by this
 *   store's own state) → `closed` on round-trip-to-flat, atomically with a
 *   `closed_trades` row (`applyLotAdvance`'s single transaction). `closed`
 *   is therefore the one terminal state that is never reached with
 *   `filled_size = 0`.
 *
 * `getOpenPositions()` (below) excludes all four terminal states from every
 * live read — crash recovery, Risk's exposure caps, the dashboard — so a
 * terminal row sitting in the table is inert to every reader; it does not
 * corrupt anything downstream. Before #1088, though, nothing ever removed
 * one: the table was an unbounded, growing journal, and a `rejected` row
 * accumulated indefinitely (observed: 10 terminal rows to 1 live row, one
 * `rejected` row eight days old). That is a RETENTION defect, not a
 * correctness one — the fix (`sweepTerminalPositions`, called from
 * `reconcile()`) deletes what is provably safe to lose and leaves the rest:
 *
 * - `rejected`/`cancelled`/`expired` rows with `filled_size = 0` were never
 *   real positions — no fill, no `closed_trades` row, ever. Their
 *   originating decision is separately, durably logged (`debate_log`,
 *   `verdict_log`), so nothing HMRC/CGT-relevant is lost. Age-gated (see
 *   `sweepTerminalPositions`'s own doc, types/store.ts) so a hard-delete
 *   cannot free an `idempotency_key` a still-plausible crash-restart replay
 *   would reuse.
 * - `closed` rows are RETAINED, not swept — see `sweepTerminalPositions`'s
 *   doc for why (the #1001 submit-time snapshot columns have no
 *   `closed_trades` counterpart, and CLAUDE.md's HMRC/CGT "track everything"
 *   retention requirement makes deleting them a separate decision).
 * - A terminal row with `filled_size > 0` that never reached `closed` (this
 *   should not occur; nothing in this file writes one) is left untouched
 *   rather than guessed at.
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
import { toBrokerFillId } from '../../shared/index.js';
import {
  type SharedStore as Db,
  fromStoredTimestamp,
  fromStoredTimestampOrNull,
  isUniqueConstraintError,
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
 * Terminal `order_state`s — excluded from `getOpenPositions()`
 * (execution-spec.md). Defined in `shared/store/key-scheme-guard.ts`, which the
 * #686 rollout guard reads too; aliased here so the SQL below keeps its
 * original name.
 */
const TERMINAL_STATES: readonly OrderState[] = TERMINAL_ORDER_STATES;

/**
 * The subset of `TERMINAL_STATES` `sweepTerminalPositions` deletes —
 * `TERMINAL_ORDER_STATES` minus `closed` (#1088). See that method's doc
 * (types/store.ts) and this file's "row lifecycle" section above for why
 * `closed` is excluded.
 */
const SWEEPABLE_TERMINAL_STATES: readonly OrderState[] = TERMINAL_ORDER_STATES.filter(
  (state) => state !== 'closed',
);

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
  /** #1001, migration 0037 — see `OpenPosition.decision_price`. */
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: string | null;
  modelled_cost_breakdown_json: string | null;
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
  /** #793, migration 0031 — see `Fill.exit_reason`. */
  exit_reason: ExitReason | null;
  /** #1001, migration 0037 — see `Fill.flatten_idempotency_key`. */
  flatten_idempotency_key: string | null;
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
  /**
   * Which arm's book this instance reads and writes (#753).
   *
   * **One class, two instances — never two classes.** #753's acceptance
   * criterion is that both arms share the same exit rule and the same stop
   * *asserted, not configured twice*, and the same argument applies one layer
   * down: a second store implementation for the control arm would be a second
   * place for the two arms' persistence to drift. So the arm is a CONSTRUCTOR
   * ARGUMENT to the one store, and every behaviour below is literally the same
   * code for both arms.
   *
   * It does exactly two things. It is stamped onto the tables that make up
   * the trade record (`open_positions`, `closed_trades`, and — migration
   * 0050, #1124 — `flatten_submissions`), and it filters the three SCAN
   * queries built over them — `getOpenPositions()`, `getUnprotectedResidualLots()`
   * and `getUnresolvedFlattens()`. Those scans are what feed the live arm's
   * exposure caps, its whole-book valuation, its residual-protection sweep
   * and its flatten-reconcile sweep, so filtering them is what keeps the
   * control arm from consuming the live arm's headroom, tripping its
   * breakers, or having ITS OWN broker asked about the OTHER arm's order
   * (#1124: unfiltered, this scan let the live arm's `reconcile()` ask the
   * real venue about a control-arm `client_order_id` it never received —
   * genuinely, correctly "no such order" from the WRONG adapter, not a race
   * in `SimulatedBrokerAdapter`'s own book). The arms share a tape; they
   * must not share a book.
   *
   * Key-based reads and writes are deliberately unfiltered — `arm` is a hash
   * input to `idempotency_key` (#753, `computeIdempotencyKey`), so the two arms
   * occupy disjoint key spaces and a key lookup cannot cross arms.
   *
   * Defaults to `'live'`, so every existing construction keeps exactly the
   * behaviour it had.
   */
  private readonly arm: TradingArm;

  /**
   * The declared ceiling `sizingEquity` (direct-bind.ts) clamped THIS arm's
   * asks against, stamped onto every row this instance writes — #1112 AC5,
   * migration 0045.
   *
   * Same reasoning as `arm` immediately above: the writer's identity is the
   * fact being recorded, not a field carried on the `OpenPosition`/
   * `ClosedTrade` object, so a caller cannot mislabel a row by constructing
   * one with the wrong value. `undefined` (stored as `NULL`) means no
   * ceiling was declared when this instance was built — the true state of
   * every construction before #1112 and of every non-paper, non-live
   * construction since (backtest, `smoke-run.ts`, `place-soak-position.ts`),
   * which is exactly why it defaults to `undefined` rather than to a
   * sentinel number.
   *
   * Carries whatever value `ProductionConfig.capitalCeilingUsd` held: a
   * declared USD figure on a live run, and since #1180 a CONVERTED one on a
   * paper run (`LIVE_BOOK_SIZING_USD`, the GBP book times
   * `SIZING_USD_PER_GBP`) where it used to be the raw GBP book. Migration
   * 0052 normalized the rows stamped before that conversion, so equality over
   * the column still holds across the change. The column
   * (`sizing_capital_ceiling`) is named without a currency suffix because it
   * records the declared ceiling's value, not a claim about its unit.
   */
  private readonly sizingCapitalCeiling: number | undefined;

  constructor(
    private readonly db: Db,
    arm: TradingArm = 'live',
    sizingCapitalCeiling?: number,
  ) {
    this.arm = arm;
    this.sizingCapitalCeiling = sizingCapitalCeiling;
  }

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
             conviction, converged, arm,
             decision_price, quote_bid, quote_ask, quote_mid, quote_observed_at,
             modelled_cost_breakdown_json, sizing_capital_ceiling
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // #753: this INSTANCE's arm, not a field off the position — the
          // writer's identity is the fact being recorded, and reading it off
          // the row would let a mislabelled `OpenPosition` file a control lot
          // into the live arm's book.
          this.arm,
          // #1001, migration 0037 — best-effort submit-time snapshot; see
          // `OpenPosition`'s own field docs (records.ts) for what each is.
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
          // #1112 AC5, migration 0045 — see `sizingCapitalCeiling`'s own doc.
          this.sizingCapitalCeiling ?? null,
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
        // #753: arm-scoped. This is the read the Trader's position awareness,
        // `computePortfolioView` and every Risk exposure cap run on, so an
        // unfiltered scan here would put the control arm's lots into the live
        // arm's book — halving its headroom and letting a control drawdown
        // move a live breaker.
        `SELECT * FROM open_positions
          WHERE arm = ? AND order_state NOT IN (${placeholders})
          ORDER BY opened_at`,
      )
      .all(this.arm, ...TERMINAL_STATES) as OpenPositionRow[];
    return rows.map(fromPositionRow);
  }

  /** See `SharedStore.sweepTerminalPositions` (types/store.ts) for the full contract. */
  async sweepTerminalPositions(cutoff: Date): Promise<number> {
    const placeholders = SWEEPABLE_TERMINAL_STATES.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        // #753: arm-scoped, same reason as every other scan in this class —
        // a control-arm row must never be swept (or left unswept) by the
        // live arm's cadence, or vice-versa.
        `DELETE FROM open_positions
          WHERE arm = ? AND order_state IN (${placeholders})
            AND filled_size = 0 AND decision_timestamp < ?`,
      )
      .run(this.arm, ...SWEEPABLE_TERMINAL_STATES, toStoredTimestamp(cutoff));
    return result.changes;
  }

  /**
   * Dedup gate for the fill feed's re-offered fills. Matched on the FULL
   * `fills` primary key — `(idempotency_key, broker_fill_id)` — not on
   * `broker_fill_id` alone (#1320), for the same reason
   * `pruneIngestedObservedFills` (sqlite-broker-state-store.ts) already
   * matches the full key on this same table: `fills` has no venue column
   * and `broker_fill_id` is venue-assigned, so two venues (or, short of a
   * second live venue, two lots sharing one id string — see the flatten
   * split's `:${lotKey}` suffix in `ingest-fills.ts`) could otherwise let
   * one lot's ingested fill be misread as covering another's.
   *
   * Takes one object rather than two positional strings (#1328): the old
   * two-argument form no longer compiles, closing a POSITIONAL swap. A
   * mislabeled object (both fields swapped under the correct key names) is
   * now also caught at compile time (#1334): `broker_fill_id` is branded
   * `BrokerFillId`, so `{ idempotency_key: fill.broker_fill_id,
   * broker_fill_id: position.idempotency_key }` no longer typechecks even
   * though both source fields are still plain strings before `toBrokerFillId`
   * runs. Declared via `SharedStore['hasFill']`'s own parameter type rather
   * than restated inline, so this signature cannot drift from the port's.
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
   * table's PK, so a duplicate write — which `hasFill` is meant to prevent —
   * surfaces as a constraint violation rather than silently double-counting.
   */
  private insertFill(fill: Fill): void {
    try {
      this.db
        .prepare(
          `INSERT INTO fills (
             idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp, cost_breakdown_json,
             exit_reason, flatten_idempotency_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // #753 — this instance's arm, for the reason `writeAheadPosition`
          // states. THIS is the column `SELECT ... WHERE arm = 'control'` reads
          // and the one the arm comparison report groups on, which is what makes
          // "the control arm's trades are distinguishable in the trade record" a
          // queryable property rather than an inference.
          this.arm,
          // #1112 AC5, migration 0045 — see `sizingCapitalCeiling`'s own doc.
          // A window that mixes NULL and non-NULL (or two different non-NULL)
          // values here mixes two sizing regimes into one `return_pct`.
          this.sizingCapitalCeiling ?? null,
          // #1121 AC5, migration 0049 — what actually happened to THIS lot's
          // fills, computed at close time by `closedTrade()` in
          // `ingest-fills.ts`, never a literal. Going through `toFill`'s #1121
          // path is not the same as being charged by it: the modelled snapshot
          // it spends is nullable (pre-migration-0037 lot, or a failed
          // `captureSubmitSnapshot`), and a `1` stamped on such a row would
          // certify a cost basis the row is not on.
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
          // Both columns projected from the SAME array in the same statement,
          // so the pairing they encode positionally cannot be wrong here.
          // `getFlattenAttribution` re-establishes it on the way out.
          JSON.stringify(submission.lot_held_quantities.map((lot) => lot.idempotency_key)),
          JSON.stringify(submission.lot_held_quantities.map((lot) => lot.held)),
          submission.exit_reason,
          // #1001, migration 0037 — see `FlattenSubmissionWriteAhead`'s own
          // field docs (types/store.ts).
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
          // #1124, migration 0050 — this INSTANCE's arm, the same posture
          // `writeAheadPosition`/`insertClosedTrade` already take: the
          // writer's identity is the fact being recorded, not a field the
          // caller can mislabel via `FlattenSubmissionWriteAhead`.
          this.arm,
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
        toStoredTimestamp(resolved_at),
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
      .run(reason, toStoredTimestamp(resolved_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.resolveFlattenError: no write-ahead record for '${idempotency_key}'`,
      );
    }
  }

  /**
   * Pure read — see `SharedStore.isRetryableFlattenError` for the invariant
   * this backs (a fresh retry key is only safe over a row PROVABLY dead at
   * the venue). A key naming no row at all is `false`, same as a
   * `'submitting'`/`'submitted'` row: only `'error'` clears the walk in
   * `execute.ts`'s `resolveExitRetryKey` to try this exact candidate again.
   */
  async isRetryableFlattenError(idempotency_key: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT status FROM flatten_submissions WHERE idempotency_key = ?')
      .get(idempotency_key) as { status: string } | undefined;
    return row?.status === 'error';
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
        `SELECT lot_idempotency_keys, lot_held_quantities, exit_reason, size,
                modelled_cost_breakdown_json
           FROM flatten_submissions WHERE idempotency_key = ?`,
      )
      .get(idempotency_key) as
      | {
          lot_idempotency_keys: string | null;
          lot_held_quantities: string | null;
          exit_reason: ExitReason | null;
          size: number;
          modelled_cost_breakdown_json: string | null;
        }
      | undefined;
    if (row === undefined || row.lot_idempotency_keys === null) return null;

    // #1001, migration 0037 — the flatten's own submit-time modelled cost
    // breakdown, prorated and attached to each named lot's split exit fill
    // by `redistributeOneFlatten` (ingest-fills.ts). `null` for a flatten row
    // written before this migration, or whose submit-time capture failed.
    //
    // #1014 review, finding 4: VALIDATED, not cast — the same defect class
    // #509 closed repo-wide, and the same one the `lot_idempotency_keys`
    // block below already guards against. See
    // `parseModelledCostBreakdownColumn` for why this one degrades to `null`
    // where those two throw.
    const modelledCostBreakdown = parseModelledCostBreakdownColumn(
      row.modelled_cost_breakdown_json,
    );

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
      return {
        lot_idempotency_keys: keys,
        lot_held_quantities: null,
        exit_reason: row.exit_reason,
        modelled_cost_breakdown: modelledCostBreakdown,
        size: row.size,
      };
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

    return {
      lot_idempotency_keys: keys,
      lot_held_quantities: paired,
      exit_reason: row.exit_reason,
      modelled_cost_breakdown: modelledCostBreakdown,
      size: row.size,
    };
  }

  /**
   * `reconcile()`'s worklist (#519, #526) — see `SharedStore.getUnresolvedFlattens`
   * for the bound this query implements: `'submitting'` outright, or
   * `'submitted'` rows not yet confirmed swept (`fills_swept_at IS NULL`).
   * `'error'` rows are excluded by the `status IN (...)` clause itself —
   * that status means the flatten provably never reached the broker, so
   * there is nothing left to ask the venue.
   *
   * `arm`-scoped since migration 0050 (#1124) — this is a SCAN, not a
   * key-based lookup, and this class's own arm-scoping doc (above) is
   * explicit that only key-based reads/writes may skip the filter. Left
   * unfiltered, this call handed EACH arm's periodic `reconcile()` the
   * OTHER arm's still-unresolved rows, so it asked its own broker about a
   * `client_order_id` that broker never received — see the migration's own
   * doc for the exact failure this produced (#1124's "undetermined, then
   * adopted 7-8s later" observation).
   */
  async getUnresolvedFlattens(): Promise<UnresolvedFlattenSubmission[]> {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, instrument, status
           FROM flatten_submissions
          WHERE arm = ?
            AND (status = 'submitting'
             OR (status = 'submitted' AND fills_swept_at IS NULL))`,
      )
      .all(this.arm) as Array<{
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
      .run(toStoredTimestamp(swept_at), idempotency_key);

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
      .run(toStoredTimestamp(observed_at), idempotency_key);

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
      .run(toStoredTimestamp(alerted_at), idempotency_key);

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
        // #753: arm-scoped, for the reason `getOpenPositions()` is — the #549
        // sweep re-arms protection on THIS arm's lots, and an arm's sweep must
        // not act on the other arm's book.
        `SELECT * FROM open_positions
          WHERE arm = ?
            AND residual_unprotected_since IS NOT NULL
            AND order_state NOT IN (${placeholders})
          ORDER BY opened_at`,
      )
      .all(this.arm, ...TERMINAL_STATES) as OpenPositionRow[];

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
        unprotected_since: fromStoredTimestamp(row.residual_unprotected_since),
        alerted_at: fromStoredTimestampOrNull(row.residual_rearm_alerted_at),
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

/**
 * #1014 review, finding 4: the guarded read of a `modelled_cost_breakdown_json`
 * column — #1001's own, on `flatten_submissions` and on `open_positions`.
 *
 * The defect this closes is the one #509 closed repo-wide and
 * `getFlattenAttribution` already guards for its other two columns: a value
 * cast to a type with no runtime check, failing far from the cause. Two ways
 * this column can be bad — invalid JSON (a truncated write, a corrupted page)
 * and valid JSON of the wrong shape (a future migration writing something
 * else into it) — and an `as` cast catches neither: the first throws a
 * `SyntaxError` from deep inside `getFlattenAttribution` on the fill-ingest
 * path, and the second sails straight through into arithmetic that quietly
 * produces `NaN` money.
 *
 * DEGRADES TO `null` rather than throwing, which is where it deliberately
 * parts company with the two sibling guards a few lines above it. Those two
 * columns are the MONEY path — `lot_idempotency_keys` and
 * `lot_held_quantities` decide which lot gets which share of a fill, so a
 * corrupted one has no safe interpretation and must fail closed. This column
 * is INSTRUMENTATION: it is the estimate a later analysis diffs a realised
 * fill against (#1001), it is already `null` for every pre-migration-0037 row
 * and for every order whose best-effort submit-time capture failed, and every
 * consumer already handles that null. Throwing here would let a corrupted
 * instrumentation byte abort the ingest of a REAL FILL — trading the thing
 * that matters for the thing that measures it, which is exactly backwards.
 * So a bad value is treated as the absence it effectively is.
 *
 * `NaN`/`Infinity` are rejected along with the wrong types: JSON cannot encode
 * them, so their presence means the column was written by something other than
 * this file's `JSON.stringify`, and letting one through would poison the
 * prorated figures `redistributeOneFlatten` derives from it.
 */
function parseModelledCostBreakdownColumn(
  raw: string | null,
): FlattenAttribution['modelled_cost_breakdown'] {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const candidate: Record<string, unknown> = parsed as Record<string, unknown>;

  // Read one by one and REBUILT below rather than returned as the parsed
  // object: what leaves this function is then constructed from four values
  // this function has personally checked are finite numbers, so the return
  // type is earned rather than asserted — no `as` on the result, which is the
  // whole point of the #509 pattern.
  const spread_cost = candidate['spread_cost'];
  const commission = candidate['commission'];
  const slippage = candidate['slippage'];
  const market_impact = candidate['market_impact'];
  if (
    !isFiniteNumber(spread_cost) ||
    !isFiniteNumber(commission) ||
    !isFiniteNumber(slippage) ||
    !isFiniteNumber(market_impact)
  ) {
    return null;
  }

  return { spread_cost, commission, slippage, market_impact };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function fromPositionRow(row: OpenPositionRow): OpenPosition {
  const modelledCostBreakdown = parseModelledCostBreakdownColumn(row.modelled_cost_breakdown_json);

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
    opened_at: fromStoredTimestamp(row.opened_at),
    decision_timestamp: fromStoredTimestamp(row.decision_timestamp),
    conviction: row.conviction,
    converged: row.converged === 1,
    // #1001, migration 0037 — omitted (not `null`) on a pre-migration row or
    // an uncaptured best-effort read, matching `fromFillRow`'s own convention
    // for `cost_breakdown`/`exit_reason` below.
    ...(row.decision_price === null ? {} : { decision_price: row.decision_price }),
    ...(row.quote_bid === null ? {} : { quote_bid: row.quote_bid }),
    ...(row.quote_ask === null ? {} : { quote_ask: row.quote_ask }),
    ...(row.quote_mid === null ? {} : { quote_mid: row.quote_mid }),
    ...(row.quote_observed_at === null
      ? {}
      : { quote_observed_at: fromStoredTimestamp(row.quote_observed_at) }),
    // #1014 review, finding 4: the same guarded read `getFlattenAttribution`
    // uses — this is the "identical `fromPositionRow` block" the review names,
    // and an unvalidated cast here would throw on a corrupted row inside
    // whichever caller happened to load the position (`reconcile`, the
    // residual sweep, `ingestFills`). A bad value reads as absent, which is
    // the same thing every pre-migration-0037 row already looks like.
    ...(modelledCostBreakdown === null ? {} : { modelled_cost_breakdown: modelledCostBreakdown }),
  };
}

function fromFillRow(row: FillRow): Fill {
  return {
    idempotency_key: row.idempotency_key,
    broker_fill_id: toBrokerFillId(row.broker_fill_id),
    leg: row.leg,
    price: row.price,
    qty: row.qty,
    fee: row.fee,
    timestamp: fromStoredTimestamp(row.timestamp),
    ...(row.cost_breakdown_json === null
      ? {}
      : {
          cost_breakdown: JSON.parse(row.cost_breakdown_json) as NonNullable<
            Fill['cost_breakdown']
          >,
        }),
    ...(row.exit_reason === null ? {} : { exit_reason: row.exit_reason }),
    ...(row.flatten_idempotency_key === null
      ? {}
      : { flatten_idempotency_key: row.flatten_idempotency_key }),
  };
}
