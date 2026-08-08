/**
 * The adapters' durable state seam (#287, closing #294/#295) — migration
 * `0007_broker_adapter_state.sql`.
 *
 * Every live adapter keeps a working set in memory (the ccxt emulation's
 * bracket Map, IBKR's leg reverse-index, Alpaca's parent-order-id index) and
 * writes through to this store so a restart can rebuild it. The Maps are not
 * replaced by the store: the ccxt emulation's exactly-once sibling cancel
 * depends on claiming a phase transition with no `await` in between, so the
 * hot path has to stay in-process.
 *
 * SYNCHRONOUS ON PURPOSE, and this is the load-bearing design decision of the
 * whole ticket. Every method here is called from inside one of those
 * synchronous claims (`advanceEntry`, `advanceExits`, `resizeProtectiveLegs`
 * in ccxt-adapter.ts, each of which documents that "everything from here to
 * the phase write is synchronous"). An async seam would insert an await into
 * that window and reopen the double-arm / double-cancel races those claims
 * exist to close. better-sqlite3 is synchronous, so nothing is given up —
 * `SqliteAccountStateStore` (#276) is the same shape for the same reason.
 */
import type { NativeBracketRequest, NormalizedFill } from './types.js';

/**
 * Which adapter owns a row. In the primary key of both tables, so two adapters
 * wired over one database can never read each other's brackets even if a
 * client order id were reused across venues.
 */
export type BrokerVenue = 'ccxt' | 'ibkr' | 'alpaca';

/**
 * The emulated lifecycle (originally ccxt's; now Alpaca's crypto emulation,
 * #586); always `'armed'` on a native-bracket path.
 *
 * `submitting` is the write-ahead phase (#312): journalled BEFORE the venue
 * call, so a crash between `createOrder` and the journal leaves a row naming
 * the order that may exist rather than a live venue order nothing knows about.
 *
 * It is deliberately NOT `pending_entry` with a null `entry_order_id` — that
 * is indistinguishable from an ordinary bracket whose id has not been recorded
 * yet, since `recordBracketOrderIds` COALESCEs and a null there already means
 * "no news".
 *
 * `cancelling_sibling` (#586, migration 0022) is the same write-ahead rule
 * applied to the OCO edge: one protective leg has been observed filled and the
 * surviving sibling's cancel is owed to the venue. Journalled BEFORE the
 * cancel call, so a crash in that window leaves a row that says a live resting
 * order still needs killing, rather than an `armed` that hides the fill or a
 * `resolved` that hides the sibling.
 */
export type BrokerBracketPhase =
  | 'submitting'
  | 'pending_entry'
  | 'arming'
  | 'armed'
  | 'cancelling_sibling'
  | 'resolved';

/**
 * One persisted bracket. See the migration for per-venue column applicability
 * — in short, ccxt uses all of it, Alpaca and IBKR use the identity plus the
 * venue order ids because their venue owns the state machine.
 */
export interface BrokerBracketRecord {
  venue: BrokerVenue;
  client_order_id: string;
  phase: BrokerBracketPhase;
  entry_order_id: string | null;
  stop_order_id: string | null;
  target_order_id: string | null;
  /**
   * The originating `NativeBracketRequest`, or null on a row learned from the
   * venue rather than from a submit (Alpaca/IBKR `getOrder`), which knows the
   * order ids and not the request that produced them.
   */
  request: BrokerBracketRequestFields | null;
  armed_qty: number | null;
  arming_qty: number | null;
  arm_attempt: number;
}

/**
 * The request fields an adapter needs to re-place a leg after a restart:
 * everything in `NativeBracketRequest` except the client order id, which is
 * the row's own key.
 *
 * DERIVED from `NativeBracketRequest` rather than re-listed, so a field added
 * there is a compile error here instead of a column that silently stops being
 * journalled — the same spec/code drift class this repo treats as its own
 * defect.
 */
export type BrokerBracketRequestFields = Omit<NativeBracketRequest, 'client_order_id'>;

/** The journalled half of a bracket request — the one place it is spelled out. */
export function toRequestFields(order: NativeBracketRequest): BrokerBracketRequestFields {
  const { client_order_id: _clientOrderId, ...fields } = order;
  return fields;
}

/** The venue order ids a rehydration path learns without the request. */
export interface BrokerBracketOrderIds {
  entry_order_id: string | null;
  stop_order_id: string | null;
  target_order_id: string | null;
}

/**
 * A fill the venue reports filled but cannot price (#298) — the observation an
 * adapter records instead of booking a fabricated price.
 *
 * `instrument` is denormalized from the bracket parent because the alert built
 * from this row has to be actionable on its own: an operator reading it needs
 * the symbol and the quantity, not a foreign key.
 */
export interface UnpricedFillObservation {
  client_order_id: string;
  /** The venue order id the fill would have been booked under. */
  broker_fill_id: string;
  leg: NormalizedFill['leg'];
  instrument: string;
  /** The quantity the venue claims filled — what makes this a contradiction. */
  qty: number;
}

/** A persisted `UnpricedFillObservation` plus its age-out clock. */
export interface UnpricedFillRecord extends UnpricedFillObservation {
  /** Set once, on first observation. Never advanced — this IS the clock. */
  first_seen_at: Date;
  /** Refreshed each sweep that still sees it unpriced; diagnostic only. */
  last_seen_at: Date;
  /** Null until an age-out alert has been delivered for this fill. */
  alerted_at: Date | null;
}

export interface BrokerStateStore {
  /** Every bracket this venue has ever recorded, oldest first. */
  loadBrackets(venue: BrokerVenue): BrokerBracketRecord[];
  /** Full-row upsert — the submit path and every ccxt phase transition. */
  saveBracket(record: BrokerBracketRecord): void;
  /**
   * Partial upsert for the REHYDRATION paths: record the venue's order ids for
   * a client order id whose original request this process never saw. Leaves
   * the request columns untouched (null on insert) rather than inventing them.
   */
  recordBracketOrderIds(
    venue: BrokerVenue,
    clientOrderId: string,
    ids: BrokerBracketOrderIds,
  ): void;
  /** The observed-fill journal for this venue, oldest first. */
  loadObservedFills(venue: BrokerVenue): NormalizedFill[];
  /** Idempotent on `(venue, client_order_id, broker_fill_id)`. */
  saveObservedFill(venue: BrokerVenue, fill: NormalizedFill): void;
  /**
   * Drops observed fills that `ingestFills()` has already consumed, returning
   * how many rows went (#313). The table is otherwise append-only and grows
   * for the life of the deployment.
   *
   * **The retention rule, and why it is this simple.** #313 expected the rule
   * to be delicate — "a row is safe to drop once the venue's fill feed can no
   * longer re-offer that fill" — because dropping one early looked like it
   * would reintroduce double-counted fills. It cannot. Dedup does not live in
   * this table: `ingestFills()` gates on `SharedStore.hasFill`, which reads
   * `fills`, a permanent ledger. `broker_observed_fills` is only the ccxt
   * adapter's crash-durable QUEUE — its whole job is that a fill observed by a
   * process which died before ingesting it survives the restart.
   *
   * So a row's purpose is discharged the moment its `broker_fill_id` appears
   * in `fills`, and after that a re-offer is caught by `hasFill` whether or not
   * the queue row still exists. No `since` window, no lot terminal state.
   */
  pruneIngestedObservedFills(venue: BrokerVenue): number;
  /**
   * Notes that this fill is still unpriced as of `seenAt` (#298).
   *
   * FIRST WRITE WINS on `first_seen_at`: a re-observation refreshes
   * `last_seen_at` and the observation's mutable fields and leaves the clock
   * alone. That is the whole point — a fill re-offered unpriced on every poll,
   * across restarts, must accumulate age rather than resetting it.
   */
  recordUnpricedFill(venue: BrokerVenue, observation: UnpricedFillObservation, seenAt: Date): void;
  /** Every still-unresolved unpriced fill for this venue, oldest first. */
  loadUnpricedFills(venue: BrokerVenue): UnpricedFillRecord[];
  /** Records that the age-out alert for this fill was actually delivered. */
  markUnpricedFillAlerted(
    venue: BrokerVenue,
    clientOrderId: string,
    brokerFillId: string,
    alertedAt: Date,
  ): void;
  /** Drops the row: the venue priced the fill and it has been ingested. */
  clearUnpricedFill(venue: BrokerVenue, clientOrderId: string, brokerFillId: string): void;
}

/**
 * The no-persistence implementation — semantically identical to the
 * process-local Maps the adapters used before this ticket.
 *
 * It is the constructor DEFAULT so existing wiring and test doubles keep
 * working, but note the asymmetry with the adapters' `rateLimiter` default:
 * that default is merely conservative, whereas THIS default IS the bug #287
 * exists to fix. Production wiring must inject `SqliteBrokerStateStore`
 * (server/apps/orchestrator/production.ts does, for the Alpaca MVP path) or the
 * adapter silently starts every run with empty state while real positions sit
 * open at the broker — the same quiet failure `sharedStorePath` throws to
 * prevent.
 */
export class InMemoryBrokerStateStore implements BrokerStateStore {
  private readonly brackets = new Map<string, BrokerBracketRecord>();
  private readonly fills = new Map<string, NormalizedFill & { venue: BrokerVenue }>();
  private readonly unpriced = new Map<string, UnpricedFillRecord & { venue: BrokerVenue }>();

  loadBrackets(venue: BrokerVenue): BrokerBracketRecord[] {
    return [...this.brackets.values()].filter((record) => record.venue === venue);
  }

  saveBracket(record: BrokerBracketRecord): void {
    const existing = this.brackets.get(key(record.venue, record.client_order_id));
    this.brackets.set(key(record.venue, record.client_order_id), {
      ...record,
      // Mirrors the SQL implementation's `COALESCE(excluded, existing)` on the
      // request columns: a save that carries no request must never blank one a
      // submit recorded. Kept in step deliberately — a test double that is
      // merely *nearly* the real store is how a suite certifies a bug.
      request: record.request ?? existing?.request ?? null,
    });
  }

  recordBracketOrderIds(
    venue: BrokerVenue,
    clientOrderId: string,
    ids: BrokerBracketOrderIds,
  ): void {
    const existing = this.brackets.get(key(venue, clientOrderId));
    this.brackets.set(key(venue, clientOrderId), {
      venue,
      client_order_id: clientOrderId,
      phase: existing?.phase ?? 'armed',
      request: existing?.request ?? null,
      armed_qty: existing?.armed_qty ?? null,
      arming_qty: existing?.arming_qty ?? null,
      arm_attempt: existing?.arm_attempt ?? 0,
      // COALESCE per id, mirroring the SQL implementation: a venue lookup that
      // reports no child (because the venue has since cancelled it) must not
      // blank an id a submit recorded, or IBKR's `legs` index loses it on the
      // next restart and its executions go unclaimed — #295, reinstated.
      entry_order_id: ids.entry_order_id ?? existing?.entry_order_id ?? null,
      stop_order_id: ids.stop_order_id ?? existing?.stop_order_id ?? null,
      target_order_id: ids.target_order_id ?? existing?.target_order_id ?? null,
    });
  }

  loadObservedFills(venue: BrokerVenue): NormalizedFill[] {
    return [...this.fills.values()]
      .filter((fill) => fill.venue === venue)
      .map(({ venue: _venue, ...fill }) => fill);
  }

  /**
   * Stands in for the `fills` ledger the SQLite store joins against — this
   * double has no `SharedStore` behind it. Tests add an id here to say "this
   * one has been ingested"; `pruneIngestedObservedFills` then drops exactly
   * those, which is what the SQL subquery does against a real `fills` table.
   *
   * A modelled set rather than a no-op prune: a port implementation that
   * silently keeps everything would let a caller pass its own tests while the
   * real store behaved differently.
   */
  readonly ingestedFillIds = new Set<string>();

  pruneIngestedObservedFills(venue: BrokerVenue): number {
    let pruned = 0;
    for (const [key, fill] of this.fills) {
      if (fill.venue === venue && this.ingestedFillIds.has(fill.broker_fill_id)) {
        this.fills.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  saveObservedFill(venue: BrokerVenue, fill: NormalizedFill): void {
    this.fills.set(`${venue}|${fill.client_order_id}|${fill.broker_fill_id}`, {
      ...fill,
      venue,
    });
  }

  recordUnpricedFill(venue: BrokerVenue, observation: UnpricedFillObservation, seenAt: Date): void {
    const rowKey = fillKey(venue, observation.client_order_id, observation.broker_fill_id);
    const existing = this.unpriced.get(rowKey);
    this.unpriced.set(rowKey, {
      ...observation,
      venue,
      // Mirrors the SQL implementation's untouched `first_seen_at` on conflict.
      // Kept in step deliberately: a test double whose clock resets where the
      // real store's does not is how a suite certifies the bug it was written
      // to catch.
      first_seen_at: existing?.first_seen_at ?? seenAt,
      last_seen_at: seenAt,
      alerted_at: existing?.alerted_at ?? null,
    });
  }

  loadUnpricedFills(venue: BrokerVenue): UnpricedFillRecord[] {
    return [...this.unpriced.values()]
      .filter((row) => row.venue === venue)
      .map(({ venue: _venue, ...row }) => row);
  }

  markUnpricedFillAlerted(
    venue: BrokerVenue,
    clientOrderId: string,
    brokerFillId: string,
    alertedAt: Date,
  ): void {
    const existing = this.unpriced.get(fillKey(venue, clientOrderId, brokerFillId));
    if (existing === undefined) return;
    existing.alerted_at = alertedAt;
  }

  clearUnpricedFill(venue: BrokerVenue, clientOrderId: string, brokerFillId: string): void {
    this.unpriced.delete(fillKey(venue, clientOrderId, brokerFillId));
  }
}

function key(venue: BrokerVenue, clientOrderId: string): string {
  return `${venue}|${clientOrderId}`;
}

function fillKey(venue: BrokerVenue, clientOrderId: string, brokerFillId: string): string {
  return `${venue}|${clientOrderId}|${brokerFillId}`;
}
