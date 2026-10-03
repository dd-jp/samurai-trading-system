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
import { markingRun } from './replay-book.js';

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

function replaceRefusal(step: StopReplaceStep | null, detail: string): Error {
  return step === null
    ? new Error(detail)
    : new ProtectiveReplaceError(step, detail, { cause: undefined });
}

const ALL_ROWS = Number.MAX_SAFE_INTEGER;

export class JournalReplayBroker implements BrokerAdapter {
  #sweeps = 0;
  readonly #restops = new Map<string, number>();
  readonly #reads = new Map<string, number>();

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

  // Each read the replayed cycle makes re-serves in turn the reads of the run that marked the day;
  // a date another run read on is flagged before the replay runs. One with no recording fails,
  // since a default would decide the replay differently from the run
  getOrder(clientOrderId: string): Promise<NormalizedOrder | null> {
    const index = this.#reads.get(clientOrderId) ?? 0;
    this.#reads.set(clientOrderId, index + 1);
    const { db, tradingDate } = this.day;
    const read = db
      .prepare(
        `SELECT filled_qty, error FROM v2_fill_reads
         WHERE trading_date = @date AND client_order_id = @id AND run_id = @run
         ORDER BY read_id LIMIT 1 OFFSET @index`,
      )
      .get({
        date: tradingDate,
        id: clientOrderId,
        run: markingRun(db, tradingDate)?.runId ?? null,
        index,
      }) as { filled_qty: number | null; error: string | null } | undefined;
    if (read === undefined) {
      return Promise.reject(
        new Error(
          `replay: row_missing: no journalled fill read ${index + 1} of ${clientOrderId} on ${this.day.tradingDate}`,
        ),
      );
    }
    if (read.error !== null) return Promise.reject(new Error(read.error));
    if (read.filled_qty === null) return Promise.resolve(null);
    return Promise.resolve({
      client_order_id: clientOrderId,
      broker_order_ids: [],
      order_state: 'submitted',
      filled_qty: read.filled_qty,
    });
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
    let cut: number;
    try {
      cut = this.#sweepCut(this.#sweeps);
    } catch (error) {
      return Promise.reject(error);
    }
    const rows = db
      .prepare(
        `SELECT fill_id, client_order_id, leg, qty, price_gbp, fee_gbp, filled_at, recorded_at
         FROM v2_fills
         WHERE trading_date = ? AND venue = ? AND substr(fill_id, 1, length(?)) <> ?
           AND fill_seq <= ?
         ORDER BY fill_seq`,
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
        timestamp: new Date(row.filled_at ?? row.recorded_at).toISOString(),
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

  // Each replace the replayed cycle sends re-serves the journalled attempt with the same suffix
  replaceProtectiveLegs({
    entryClientOrderId,
    instrument,
    qty,
  }: ProtectiveReplaceRequest): Promise<number> {
    const attempt = this.#restops.get(entryClientOrderId) ?? 0;
    this.#restops.set(entryClientOrderId, attempt + 1);
    const suffix = attempt === 0 ? '-restop' : `-restop-${attempt + 1}`;
    const sent = this.day.db
      .prepare(
        `SELECT r.outcome, json_extract(r.payload, '$.detail') AS detail,
                json_extract(r.payload, '$.failed_step') AS step
           FROM v2_orders r JOIN v2_orders e ON e.client_order_id = ?
          WHERE r.book_id = e.book_id AND r.instrument = ? AND r.trading_date = ?
            AND substr(r.client_order_id, -length(?)) = ?`,
      )
      .get(entryClientOrderId, instrument, this.day.tradingDate, suffix, suffix) as
      | (SentOrder & { readonly step: StopReplaceStep | null })
      | undefined;
    if (sent?.outcome !== 'rejected') return Promise.resolve(sent?.detail === 'closed' ? 0 : qty);
    return Promise.reject(replaceRefusal(sent.step, sent.detail ?? ''));
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

  // Sweep N serves the fills the marking run's sweep N had booked, so a flatten pass after the
  // marks is not served. A day journalled before sweeps were recorded swept once before its first
  // reconcile and once at the close
  #sweepCut(sweep: number): number {
    const { db, tradingDate } = this.day;
    const recorded = db
      .prepare(
        `SELECT last_fill_seq AS cut FROM v2_fill_sweeps
         WHERE trading_date = ? AND run_id = ? ORDER BY sweep_id`,
      )
      .all(tradingDate, markingRun(db, tradingDate)?.runId ?? null) as { cut: number }[];
    if (recorded.length === 0)
      return sweep === 1 ? this.#seqAt(this.#firstReconcileAt()) : ALL_ROWS;
    const row = recorded[sweep - 1];
    if (row === undefined) {
      throw new Error(`replay: row_missing: no journalled fill sweep ${sweep} on ${tradingDate}`);
    }
    return row.cut;
  }

  #seqAt(at: string): number {
    const row = this.day.db
      .prepare('SELECT COALESCE(MAX(fill_seq), 0) AS cut FROM v2_fills WHERE recorded_at <= ?')
      .get(at) as { cut: number };
    return row.cut;
  }

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
               AND (f.trading_date < @date OR (f.trading_date = @date AND f.fill_seq <= @cut)))
             AS filled,
           EXISTS (SELECT 1 FROM v2_fills f
             WHERE f.client_order_id = o.client_order_id AND f.trading_date = @date
               AND f.fill_seq <= @cut) AS today
         FROM v2_orders o WHERE o.client_order_id = @id`,
      )
      .get({ date: tradingDate, id: clientOrderId, cut: this.#sweepCut(1) }) as
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
const CASH_KINDS: ReadonlySet<string> = new Set(['cash', 'cash_unverified']);

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

function mirroredStaleStops(row: { status: string; diffs: string }): ReconcileDiff[] | undefined {
  const diffs = JSON.parse(row.diffs) as ReconcileDiff[];
  const found = row.status === 'clean' || (row.status !== 'read_failed' && diffs.length > 0);
  const mirrored = diffs.every(
    (entry) => CASH_KINDS.has(entry.kind) || STALE_STOP_KINDS.has(entry.kind),
  );
  return found && mirrored ? diffs : undefined;
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

// Only a journalled reconcile whose positions and orders matched, or differed only by stale or
// missing stops, is mirrored, with the broker cash it read, so the replay reruns its cash check;
// any other blocks the replayed books' entries as it blocked the journalled ones
export class JournalReplayBrokerBooks implements BrokerBookReader {
  constructor(
    private readonly db: StoreHandle,
    private readonly tradingDate: string,
    private readonly mirror: (venue: Venue) => MirroredBook,
  ) {}

  read(venue: Venue): Promise<BrokerBook> {
    const row = this.db
      .prepare(
        `SELECT status, detail, diffs, cash_quote FROM v2_reconciles
         WHERE trading_date = ? AND venue = ? AND source = 'broker'
         ORDER BY reconcile_id LIMIT 1`,
      )
      .get(this.tradingDate, venue) as
      | { status: string; detail: string; diffs: string; cash_quote: number | null }
      | undefined;
    const stale = row === undefined ? undefined : mirroredStaleStops(row);
    if (row === undefined || stale === undefined) {
      const status = row === undefined ? 'not run' : `${row.status}: ${row.detail}`;
      return Promise.reject(
        new Error(`replay: the journalled ${venue} reconcile on ${this.tradingDate} was ${status}`),
      );
    }
    const book = this.mirror(venue);
    return Promise.resolve({
      positions: [...book.positions].map(([instrument, qty]) => ({ instrument, qty })),
      openOrders: [...book.openOrders, ...mirroredStops(book.positions, stale)],
      cashQuote: row.cash_quote ?? 0,
    });
  }
}
