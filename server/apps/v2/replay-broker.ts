import type {
  BrokerBook,
  BrokerBookReader,
  BrokerOpenOrder,
  OrderState,
  ReconcileDiff,
  StopReplaceStep,
  Venue,
} from '../../../contracts/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  ProtectiveReplaceRequest,
} from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { ProtectiveReplaceError } from './execution/index.js';

interface SentOrder {
  readonly outcome: string;
  readonly detail: string | null;
}

interface BrokerFillRow {
  readonly fill_id: string;
  readonly client_order_id: string;
  readonly leg: NormalizedFill['leg'];
  readonly qty: number;
  readonly price_gbp: number;
  readonly fee_gbp: number;
  readonly filled_at: string | null;
  readonly recorded_at: string;
}

interface FlattenFills {
  readonly size: number | null;
  readonly filled: number | null;
  readonly today: number;
}

function adjacent(value: number, step: bigint): number {
  const view = new Float64Array([value]);
  const bits = new BigInt64Array(view.buffer);
  bits[0] = (bits[0] as bigint) + step;
  return view[0] as number;
}

const ULP_STEPS = [0n, 1n, -1n, 2n, -2n, 3n, -3n, 4n, -4n] as const;
const LATEST = '9999-12-31T23:59:59.999Z';

// The cycle books a broker fill at price ÷ rate; the journal keeps only the quotient, so the
// native price is the nearest double whose quotient reproduces the journalled bits
export function nativeAmountFor(gbp: number, quotePerGbp: number): number {
  const guess = gbp * quotePerGbp;
  return (
    ULP_STEPS.map((step) => adjacent(guess, step)).find(
      (candidate) => candidate / quotePerGbp === gbp,
    ) ?? guess
  );
}

export interface JournalBrokerDay {
  readonly db: StoreHandle;
  readonly tradingDate: string;
  readonly venue: Venue;
  readonly quotePerGbp: number;
}

export class JournalReplayBroker implements BrokerAdapter {
  #sweeps = 0;

  constructor(private readonly day: JournalBrokerDay) {}

  submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    return this.#answer(order.client_order_id);
  }

  submitFlatten(
    _instrument: string,
    _side: 'buy' | 'sell',
    _size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    return this.#answer(clientOrderId);
  }

  getOrder(): Promise<NormalizedOrder | null> {
    return Promise.resolve(null);
  }

  resumeFlatten(clientOrderId: string): Promise<NormalizedOrder | null> {
    return Promise.resolve({
      client_order_id: clientOrderId,
      broker_order_ids: [],
      order_state: this.#flattenState(clientOrderId),
      filled_qty: 0,
    });
  }

  fetchNewFills(): Promise<NormalizedFill[]> {
    const { db, tradingDate, venue, quotePerGbp } = this.day;
    this.#sweeps += 1;
    const cut = this.#sweeps === 1 ? this.#firstReconcileAt() : LATEST;
    const rows = db
      .prepare(
        `SELECT fill_id, client_order_id, leg, qty, price_gbp, fee_gbp, filled_at, recorded_at
         FROM v2_fills
         WHERE trading_date = ? AND venue = ? AND substr(fill_id, 1, length(?)) <> ?
           AND recorded_at <= ?
         ORDER BY rowid`,
      )
      .all(tradingDate, venue, `${venue}:sim-`, `${venue}:sim-`, cut) as BrokerFillRow[];
    return Promise.resolve(
      rows.map((row) => ({
        client_order_id: row.client_order_id,
        broker_fill_id: toBrokerFillId(row.fill_id.slice(venue.length + 1)),
        leg: row.leg,
        price: nativeAmountFor(row.price_gbp, quotePerGbp),
        qty: row.qty,
        fee: nativeAmountFor(row.fee_gbp, quotePerGbp),
        timestamp: new Date(row.filled_at ?? row.recorded_at),
      })),
    );
  }

  resizeProtectiveLegs(): Promise<void> {
    return Promise.resolve();
  }

  rearmProtectiveLegs(entryClientOrderId: string, instrument: string): Promise<void> {
    const rearm = this.day.db
      .prepare(
        `SELECT r.outcome, json_extract(r.payload, '$.detail') AS detail
           FROM v2_orders r JOIN v2_orders e ON e.client_order_id = ?
          WHERE r.book_id = e.book_id AND r.instrument = ? AND r.trading_date = ?
            AND substr(r.client_order_id, -6) = '-rearm'`,
      )
      .get(entryClientOrderId, instrument, this.day.tradingDate) as SentOrder | undefined;
    if (rearm?.outcome === 'rejected') return Promise.reject(new Error(rearm.detail ?? ''));
    return Promise.resolve();
  }

  replaceProtectiveLegs({
    entryClientOrderId,
    instrument,
  }: ProtectiveReplaceRequest): Promise<void> {
    const sent = this.day.db
      .prepare(
        `SELECT r.outcome, json_extract(r.payload, '$.detail') AS detail,
                json_extract(r.payload, '$.failed_step') AS step
           FROM v2_orders r JOIN v2_orders e ON e.client_order_id = ?
          WHERE r.book_id = e.book_id AND r.instrument = ? AND r.trading_date = ?
            AND substr(r.client_order_id, -7) = '-restop'`,
      )
      .get(entryClientOrderId, instrument, this.day.tradingDate) as
      | (SentOrder & { readonly step: StopReplaceStep | null })
      | undefined;
    if (sent?.outcome !== 'rejected') return Promise.resolve();
    return Promise.reject(
      new ProtectiveReplaceError(sent.step ?? 'cancel', sent.detail ?? '', { cause: undefined }),
    );
  }

  cancel(clientOrderId: string): Promise<void> {
    const row = this.day.db
      .prepare(
        `SELECT json_extract(payload, '$.cancelled') AS cancelled FROM v2_orders
         WHERE client_order_id = ?`,
      )
      .get(clientOrderId) as { cancelled: string | null } | undefined;
    if (row?.cancelled === this.day.tradingDate) return Promise.resolve();
    return Promise.reject(
      new Error(`replay: ${clientOrderId} was not cancelled on ${this.day.tradingDate}`),
    );
  }

  getOpenPositions(): Promise<NormalizedPosition[]> {
    return Promise.resolve([]);
  }

  #answer(clientOrderId: string): Promise<BrokerAck> {
    const sent = this.day.db
      .prepare(
        `SELECT outcome, json_extract(payload, '$.detail') AS detail FROM v2_orders
         WHERE client_order_id = ? AND trading_date = ?`,
      )
      .get(clientOrderId, this.day.tradingDate) as SentOrder | undefined;
    if (sent === undefined) {
      return Promise.reject(
        new Error(`replay: ${clientOrderId} was not sent on ${this.day.tradingDate}`),
      );
    }
    if (sent.outcome === 'rejected') return Promise.reject(new Error(sent.detail ?? ''));
    return Promise.resolve({
      client_order_id: clientOrderId,
      broker_order_ids: [],
      order_state: (sent.detail ?? 'submitted') as OrderState,
    });
  }

  // The cycle reconciles after its first sweep, so a fill journalled after the day's first
  // reconcile was booked at the second sweep and must not be visible to the decisions or exits
  #firstReconcileAt(): string {
    const row = this.day.db
      .prepare('SELECT MIN(recorded_at) AS at FROM v2_reconciles WHERE trading_date = ?')
      .get(this.day.tradingDate) as { at: string | null };
    return row.at ?? LATEST;
  }

  #flattenState(clientOrderId: string): OrderState {
    const { db, tradingDate } = this.day;
    const rearmed = db
      .prepare(
        `SELECT 1 FROM v2_orders WHERE trading_date = ?
           AND json_extract(payload, '$.exit_client_order_id') = ?`,
      )
      .get(tradingDate, clientOrderId);
    if (rearmed !== undefined) return 'cancelled';
    const flatten = db
      .prepare(
        `SELECT json_extract(o.payload, '$.size') AS size,
           (SELECT SUM(f.qty) FROM v2_fills f
             WHERE f.client_order_id = o.client_order_id
               AND (f.trading_date < @date OR (f.trading_date = @date AND f.recorded_at <= @cut)))
             AS filled,
           EXISTS (SELECT 1 FROM v2_fills f
             WHERE f.client_order_id = o.client_order_id AND f.trading_date = @date
               AND f.recorded_at <= @cut) AS today
         FROM v2_orders o WHERE o.client_order_id = @id`,
      )
      .get({ date: tradingDate, id: clientOrderId, cut: this.#firstReconcileAt() }) as
      | FlattenFills
      | undefined;
    if (flatten?.today !== 1) return 'submitted';
    return (flatten.filled ?? 0) < (flatten.size ?? 0) ? 'partially_filled' : 'filled';
  }
}

export interface MirroredBook {
  readonly positions: ReadonlyMap<string, number>;
  readonly openOrders: readonly BrokerOpenOrder[];
}

function protectiveStops(positions: ReadonlyMap<string, number>): BrokerOpenOrder[] {
  return [...positions]
    .filter(([, qty]) => qty !== 0)
    .map(([instrument, qty]) => ({
      clientOrderId: `replay-${instrument}-stop`,
      instrument,
      protects: qty > 0 ? 'long' : 'short',
      qty: Math.abs(qty),
      stopPrice: null,
    }));
}

const STALE_STOP_KINDS: ReadonlySet<string> = new Set([
  'protective_qty',
  'protective_price',
  'position_unprotected',
]);

// A reconcile whose only differences were stale or missing stops is mirrored with those stops, so
// the replay finds them and re-runs the replacement or re-arm the journalled cycle sent (#1990)
function staleStop(stop: BrokerOpenOrder, diffs: readonly ReconcileDiff[]): BrokerOpenOrder {
  const mine = diffs.filter((entry) => entry.instrument === stop.instrument);
  const qty = mine.find((entry) => entry.kind === 'protective_qty');
  const price = mine.find((entry) => entry.kind === 'protective_price');
  return {
    ...stop,
    clientOrderId: price?.order_id ?? stop.clientOrderId,
    qty: qty?.broker ?? stop.qty,
    stopPrice: price?.broker ?? stop.stopPrice,
  };
}

function staleStopsOnly(row: { status: string; diffs: string }): ReconcileDiff[] | undefined {
  if (row.status !== 'mismatch') return undefined;
  const diffs = JSON.parse(row.diffs) as ReconcileDiff[];
  const onlyStale = diffs.length > 0 && diffs.every((entry) => STALE_STOP_KINDS.has(entry.kind));
  return onlyStale ? diffs : undefined;
}

function mirroredStops(
  positions: ReadonlyMap<string, number>,
  diffs: readonly ReconcileDiff[],
): BrokerOpenOrder[] {
  const unguarded = new Set(
    diffs.filter((entry) => entry.kind === 'position_unprotected').map((entry) => entry.instrument),
  );
  return protectiveStops(positions)
    .filter((stop) => !unguarded.has(stop.instrument))
    .map((stop) => staleStop(stop, diffs));
}

// Only a clean journalled reconcile, or one that found only stale or missing stops, is mirrored;
// any other status blocks the replayed books' entries as it blocked the journalled ones
export class JournalReplayBrokerBooks implements BrokerBookReader {
  constructor(
    private readonly db: StoreHandle,
    private readonly tradingDate: string,
    private readonly mirror: (venue: Venue) => MirroredBook,
  ) {}

  read(venue: Venue): Promise<BrokerBook> {
    const row = this.db
      .prepare(
        `SELECT status, detail, diffs FROM v2_reconciles
         WHERE trading_date = ? AND venue = ? AND source = 'broker'
         ORDER BY reconcile_id LIMIT 1`,
      )
      .get(this.tradingDate, venue) as
      | { status: string; detail: string; diffs: string }
      | undefined;
    const stale = row === undefined ? undefined : staleStopsOnly(row);
    if (row?.status !== 'clean' && stale === undefined) {
      const status = row === undefined ? 'not run' : `${row.status}: ${row.detail}`;
      return Promise.reject(
        new Error(`replay: the journalled ${venue} reconcile on ${this.tradingDate} was ${status}`),
      );
    }
    const book = this.mirror(venue);
    return Promise.resolve({
      positions: [...book.positions].map(([instrument, qty]) => ({ instrument, qty })),
      openOrders: [...book.openOrders, ...mirroredStops(book.positions, stale ?? [])],
      cashQuote: 0,
    });
  }
}
