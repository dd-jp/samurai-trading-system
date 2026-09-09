/**
 * SQLite-backed `BrokerStateStore` over `broker_brackets` /
 * `broker_observed_fills` (#287, migration `0007`). See
 * docs/specs/shared-sqlite-store-spec.md ("Consolidated Schema") and
 * broker-state-store.ts for why this seam is synchronous.
 *
 * Follows `SqliteAccountStateStore` (#276): a small focused class over the
 * shared handle, upserting with `ON CONFLICT ... DO UPDATE` so a re-write is
 * idempotent, and doing whatever merge logic exists IN SQL rather than
 * read-then-write — two adapters (or a retry racing itself) must not be able
 * to lose an update between a select and an insert.
 */

import type { SharedStore } from '../../shared/store/index.js';
import {
  fromStoredTimestamp,
  fromStoredTimestampOrNull,
  toStoredTimestamp,
} from '../../shared/store/index.js';
import type {
  BrokerBracketOrderIds,
  BrokerBracketPhase,
  BrokerBracketRecord,
  BrokerStateStore,
  BrokerVenue,
  UnpricedFillObservation,
  UnpricedFillRecord,
} from './broker-state-store.js';
import type { NormalizedFill } from './types.js';

interface BracketRow {
  venue: BrokerVenue;
  client_order_id: string;
  phase: BrokerBracketPhase;
  entry_order_id: string | null;
  stop_order_id: string | null;
  target_order_id: string | null;
  instrument: string | null;
  asset_class: 'crypto' | 'stocks' | null;
  side: 'buy' | 'sell' | null;
  size: number | null;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  time_in_force: string | null;
  armed_qty: number | null;
  arming_qty: number | null;
  arm_attempt: number;
}

interface ObservedFillRow {
  client_order_id: string;
  broker_fill_id: string;
  leg: NormalizedFill['leg'];
  price: number;
  qty: number;
  fee: number;
  timestamp: string;
}

interface UnpricedFillRow {
  client_order_id: string;
  broker_fill_id: string;
  leg: NormalizedFill['leg'];
  instrument: string;
  qty: number;
  first_seen_at: string;
  last_seen_at: string;
  alerted_at: string | null;
}

export class SqliteBrokerStateStore implements BrokerStateStore {
  constructor(private readonly db: SharedStore) {}

  loadBrackets(venue: BrokerVenue): BrokerBracketRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM broker_brackets WHERE venue = ? ORDER BY rowid')
      .all(venue) as BracketRow[];

    return rows.map(fromBracketRow);
  }

  saveBracket(record: BrokerBracketRecord): void {
    const request = record.request;
    this.db
      .prepare(
        `INSERT INTO broker_brackets (
           venue, client_order_id, phase,
           entry_order_id, stop_order_id, target_order_id,
           instrument, asset_class, side, size,
           entry_price, stop_price, target_price, time_in_force,
           armed_qty, arming_qty, arm_attempt, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(venue, client_order_id) DO UPDATE SET
           phase = excluded.phase,
           entry_order_id = excluded.entry_order_id,
           stop_order_id = excluded.stop_order_id,
           target_order_id = excluded.target_order_id,
           -- A full save always carries the request it was built from, but a
           -- row may already exist from a venue-side rehydration that had
           -- none. COALESCE keeps whichever side actually knows it: a later
           -- rehydration must never blank a request a submit recorded.
           instrument = COALESCE(excluded.instrument, broker_brackets.instrument),
           asset_class = COALESCE(excluded.asset_class, broker_brackets.asset_class),
           side = COALESCE(excluded.side, broker_brackets.side),
           size = COALESCE(excluded.size, broker_brackets.size),
           entry_price = COALESCE(excluded.entry_price, broker_brackets.entry_price),
           stop_price = COALESCE(excluded.stop_price, broker_brackets.stop_price),
           target_price = COALESCE(excluded.target_price, broker_brackets.target_price),
           time_in_force = COALESCE(excluded.time_in_force, broker_brackets.time_in_force),
           armed_qty = excluded.armed_qty,
           arming_qty = excluded.arming_qty,
           arm_attempt = excluded.arm_attempt,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.venue,
        record.client_order_id,
        record.phase,
        record.entry_order_id,
        record.stop_order_id,
        record.target_order_id,
        request?.instrument ?? null,
        request?.asset_class ?? null,
        request?.side ?? null,
        request?.size ?? null,
        request?.entry ?? null,
        request?.stop ?? null,
        request?.target ?? null,
        request?.time_in_force ?? null,
        record.armed_qty,
        record.arming_qty,
        record.arm_attempt,
        toStoredTimestamp(new Date()),
      );
  }

  /**
   * The rehydration path: the venue's order ids for a client order id whose
   * request this process never saw. `phase` defaults to `'armed'` on insert —
   * true for the two venues that use this path (Alpaca/IBKR native brackets,
   * whose legs are live from the first call) — and is left ALONE on conflict,
   * because a ccxt row's phase is emulation state that no venue lookup is
   * entitled to overwrite.
   */
  recordBracketOrderIds(
    venue: BrokerVenue,
    clientOrderId: string,
    ids: BrokerBracketOrderIds,
  ): void {
    this.db
      .prepare(
        `INSERT INTO broker_brackets (
           venue, client_order_id, phase,
           entry_order_id, stop_order_id, target_order_id,
           arm_attempt, updated_at
         ) VALUES (?, ?, 'armed', ?, ?, ?, 0, ?)
         ON CONFLICT(venue, client_order_id) DO UPDATE SET
           -- COALESCE, matching saveBracket's treatment of the request columns
           -- and for a sharper reason. A venue lookup reports the legs it can
           -- still see, so a child the venue has since cancelled comes back
           -- null - and blanking a known id here would drop it from IBKR's
           -- leg reverse index on the next restart, which is exactly #295's
           -- "fetchExecutions' reports are silently dropped as not ours".
           -- A venue order id we once knew is never forgotten: executions
           -- already booked under it are still ours to attribute.
           entry_order_id = COALESCE(excluded.entry_order_id, broker_brackets.entry_order_id),
           stop_order_id = COALESCE(excluded.stop_order_id, broker_brackets.stop_order_id),
           target_order_id = COALESCE(excluded.target_order_id, broker_brackets.target_order_id),
           updated_at = excluded.updated_at`,
      )
      .run(
        venue,
        clientOrderId,
        ids.entry_order_id,
        ids.stop_order_id,
        ids.target_order_id,
        toStoredTimestamp(new Date()),
      );
  }

  loadObservedFills(venue: BrokerVenue): NormalizedFill[] {
    const rows = this.db
      .prepare(
        `SELECT client_order_id, broker_fill_id, leg, price, qty, fee, timestamp
         FROM broker_observed_fills WHERE venue = ? ORDER BY rowid`,
      )
      .all(venue) as ObservedFillRow[];

    return rows.map((row) => ({
      client_order_id: row.client_order_id,
      broker_fill_id: row.broker_fill_id,
      leg: row.leg,
      price: row.price,
      qty: row.qty,
      fee: row.fee,
      timestamp: fromStoredTimestamp(row.timestamp),
      // No `cost_breakdown`: only the Simulated adapter produces one, and it
      // has no venue state to persist.
    }));
  }

  pruneIngestedObservedFills(venue: BrokerVenue): number {
    // The queue row's only job is surviving a crash between observing a fill
    // and ingesting it. Once `fills` holds the id that job is done, and a
    // re-offer is caught by `SharedStore.hasFill` reading that same table —
    // so this cannot reintroduce a double-count no matter how early it runs.
    //
    // Correlated subquery rather than a join or an id list from the caller:
    // `fills` lives in this same database (one handle serves both, see
    // `openSharedStore`), and the alternative would have the caller loading
    // every ingested id into memory to hand back down.
    // Matched on the FULL `fills` primary key — `(idempotency_key,
    // broker_fill_id)` — not on `broker_fill_id` alone (PR #459 review).
    // `fills` has no venue column, and `broker_fill_id` is venue-assigned, so
    // two venues can issue the same id string. An id-only match would then let
    // one venue's ingested fill prune ANOTHER venue's queue row that has not
    // been ingested, losing it if the process dies before the next poll —
    // precisely the crash this queue exists to survive.
    //
    // The join is exact because `client_order_id` IS the lot's
    // `idempotency_key` (`NativeBracketRequest`: "Set to the OrderIntent's
    // idempotency_key", and `execute.ts` does), and a lot belongs to one venue.
    const result = this.db
      .prepare(
        `DELETE FROM broker_observed_fills
         WHERE venue = ?
           AND EXISTS (
             SELECT 1 FROM fills
             WHERE fills.idempotency_key = broker_observed_fills.client_order_id
               AND fills.broker_fill_id = broker_observed_fills.broker_fill_id
           )`,
      )
      .run(venue);
    return result.changes;
  }

  saveObservedFill(venue: BrokerVenue, fill: NormalizedFill): void {
    this.db
      .prepare(
        `INSERT INTO broker_observed_fills (
           venue, client_order_id, broker_fill_id, leg, price, qty, fee, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(venue, client_order_id, broker_fill_id) DO UPDATE SET
           -- A re-poll re-offers the same aggregate fill with a grown
           -- quantity; the latest observation wins, exactly as the in-memory
           -- queue's later entry did.
           leg = excluded.leg,
           price = excluded.price,
           qty = excluded.qty,
           fee = excluded.fee,
           timestamp = excluded.timestamp`,
      )
      .run(
        venue,
        fill.client_order_id,
        fill.broker_fill_id,
        fill.leg,
        fill.price,
        fill.qty,
        fill.fee,
        toStoredTimestamp(fill.timestamp),
      );
  }

  /**
   * The age-out clock's write (#298). `first_seen_at` is absent from the
   * `DO UPDATE SET` list on purpose and that omission is the feature: a fill
   * re-offered unpriced on every poll — and across restarts, which is what
   * makes this durable rather than a Map — must accumulate age, not reset it.
   * `alerted_at` is left alone for the same reason: a re-observation is not a
   * new anomaly.
   */
  recordUnpricedFill(venue: BrokerVenue, observation: UnpricedFillObservation, seenAt: Date): void {
    this.db
      .prepare(
        `INSERT INTO broker_unpriced_fills (
           venue, client_order_id, broker_fill_id, leg, instrument, qty,
           first_seen_at, last_seen_at, alerted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(venue, client_order_id, broker_fill_id) DO UPDATE SET
           leg = excluded.leg,
           instrument = excluded.instrument,
           -- Alpaca reports CUMULATIVE filled quantity, so a later observation
           -- of the same order may legitimately be larger. The latest reading
           -- wins; the clock does not move.
           qty = excluded.qty,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        venue,
        observation.client_order_id,
        observation.broker_fill_id,
        observation.leg,
        observation.instrument,
        observation.qty,
        toStoredTimestamp(seenAt),
        toStoredTimestamp(seenAt),
      );
  }

  loadUnpricedFills(venue: BrokerVenue): UnpricedFillRecord[] {
    const rows = this.db
      .prepare(
        `SELECT client_order_id, broker_fill_id, leg, instrument, qty,
                first_seen_at, last_seen_at, alerted_at
           FROM broker_unpriced_fills WHERE venue = ? ORDER BY first_seen_at, rowid`,
      )
      .all(venue) as UnpricedFillRow[];

    return rows.map((row) => ({
      client_order_id: row.client_order_id,
      broker_fill_id: row.broker_fill_id,
      leg: row.leg,
      instrument: row.instrument,
      qty: row.qty,
      first_seen_at: fromStoredTimestamp(row.first_seen_at),
      last_seen_at: fromStoredTimestamp(row.last_seen_at),
      alerted_at: fromStoredTimestampOrNull(row.alerted_at),
    }));
  }

  markUnpricedFillAlerted(
    venue: BrokerVenue,
    clientOrderId: string,
    brokerFillId: string,
    alertedAt: Date,
  ): void {
    this.db
      .prepare(
        `UPDATE broker_unpriced_fills SET alerted_at = ?
          WHERE venue = ? AND client_order_id = ? AND broker_fill_id = ?`,
      )
      .run(toStoredTimestamp(alertedAt), venue, clientOrderId, brokerFillId);
  }

  clearUnpricedFill(venue: BrokerVenue, clientOrderId: string, brokerFillId: string): void {
    this.db
      .prepare(
        `DELETE FROM broker_unpriced_fills
          WHERE venue = ? AND client_order_id = ? AND broker_fill_id = ?`,
      )
      .run(venue, clientOrderId, brokerFillId);
  }
}

function fromBracketRow(row: BracketRow): BrokerBracketRecord {
  const hasRequest =
    row.instrument !== null &&
    row.asset_class !== null &&
    row.side !== null &&
    row.size !== null &&
    row.entry_price !== null &&
    row.stop_price !== null &&
    row.target_price !== null &&
    row.time_in_force !== null;

  return {
    venue: row.venue,
    client_order_id: row.client_order_id,
    phase: row.phase,
    entry_order_id: row.entry_order_id,
    stop_order_id: row.stop_order_id,
    target_order_id: row.target_order_id,
    // All-or-nothing: a half-populated request cannot re-place a leg, and
    // presenting one would let a caller read a price that was never requested.
    request: hasRequest
      ? {
          instrument: row.instrument as string,
          asset_class: row.asset_class as 'crypto' | 'stocks',
          side: row.side as 'buy' | 'sell',
          size: row.size as number,
          entry: row.entry_price as number,
          stop: row.stop_price as number,
          target: row.target_price as number,
          time_in_force: row.time_in_force as string,
        }
      : null,
    armed_qty: row.armed_qty,
    arming_qty: row.arming_qty,
    arm_attempt: row.arm_attempt,
  };
}
