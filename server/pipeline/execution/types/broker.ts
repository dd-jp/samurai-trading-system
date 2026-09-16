/**
 * The broker seam: what a venue is asked to do and what it reports back,
 * normalised across Alpaca / ccxt / IBKR / Simulated.
 *
 * Split out of the single `execution/types.ts` so that adding a venue does not
 * dirty the file every consumer of `Execution` imports. `types.ts` remains a
 * re-export barrel, so no import site changed.
 */
import type { BrokerFillId, ExitReason, OrderState } from '../../../shared/index.js';

/**
 * The normalized abstract bracket Execution hands the adapter: entry +
 * attached stop + attached target, with one-cancels-other exit semantics
 * guaranteed at this boundary. How that guarantee is met is the adapter's
 * business and invisible above it — native bracket/OCA on Alpaca/IBKR,
 * Execution-managed emulation on ccxt, modelled deterministically by the
 * Simulated adapter.
 */
export interface NativeBracketRequest {
  /**
   * The broker-native idempotency handle: the venue itself rejects a
   * duplicate, which is the second of the two dedup layers (the local store
   * check in `execute()` is the first). Set to the OrderIntent's
   * `idempotency_key`.
   */
  client_order_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  size: number;
  /** Limit/entry price of the entry leg */
  entry: number;
  stop: number;
  target: number;
  time_in_force: string;
}

/** The adapter's acknowledgement of an accepted bracket */
export interface BrokerAck {
  client_order_id: string;
  /** Entry + attached legs (or the adapter's emulated ids) */
  broker_order_ids: string[];
  /** State as the venue reports it post-ack — normally 'submitted' */
  order_state: OrderState;
}

/**
 * A fill normalized out of broker-native shape. The Simulated adapter
 * produces these but does not consume them: advancing the state machine and
 * persisting `Fill` rows is `ingestFills()`'s job.
 */
export interface NormalizedFill {
  client_order_id: string;
  broker_fill_id: BrokerFillId;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  /**
   * ISO code the fee is denominated in. Absent means book currency (GBP,
   * ADR-0015). Set by an adapter whose venue charges in the traded line's
   * own SETTLEMENT currency (Saxo's `CurrencyCode`) — never the unit the
   * price is quoted in: a GBX line settles GBP.
   *
   * Persisted (`Fill.fee_currency`) and still NOT converted, deliberately: a
   * non-sterling value here is a CONTRADICTION, not a figure awaiting an FX
   * rate — `tradeableUniverse` excludes every non-sterling line. `ingestFills`
   * records it and raises `FEE_CURRENCY_NOT_BOOK_CURRENCY` at `error` rather
   * than refusing the fill, since the venue has already traded it.
   */
  fee_currency?: string;
  /**
   * The venue-applied rate to multiply a `fee_currency`-denominated
   * `price`/`fee` by to get GBP, WHEN the venue reports one. No current
   * adapter sets this — verified absent from Saxo's
   * `GET /cs/v1/audit/orderactivities` (this system's only source of Saxo
   * fill data). Exists so a future Saxo surface or adapter can supply it
   * without a further wire-shape change.
   */
  fx_rate_to_gbp?: number;
  /**
   * Why `fx_rate_to_gbp` is absent, e.g. `'not_reported_by_venue'`. Set by
   * an adapter alongside `fee_currency` whenever that currency isn't book currency.
   */
  fx_rate_to_gbp_source?: string;
  timestamp: Date;
  /**
   * Populated only by the Simulated adapter, mapped from `CostModel.fill`'s
   * `CostModelResult` (cross-spec GAP-F). Real broker fills have no modeled
   * breakdown, so it is absent there.
   */
  cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  /**
   * `qty`/`price` are the venue's CUMULATIVE filled quantity and average
   * price for `broker_fill_id`'s order, not an increment over a previous
   * poll. Alpaca's `getOrder` is the only polled shape that works this way
   * (one order, a running `filled_qty`) — without this flag,
   * `ingestFills()`'s `hasFill` dedup gate would skip a larger-`filled_qty`
   * observation as a duplicate of the same `broker_fill_id`, permanently
   * losing the increment and leaving `resizeProtectiveLegs` protecting a
   * stale, absolute quantity.
   *
   * Flagged here rather than reconciled in the adapter: `collectFill` is a
   * pure function of one order with no `SharedStore` access, so only
   * `ingestFills()` can see what's already persisted and compute the delta.
   *
   * TRANSPORT-ONLY — `toFill` does not persist this field; a stored `Fill`
   * row is always an increment by the time it is written.
   */
  qty_is_cumulative?: boolean;
  /**
   * Set by `redistributeOneFlatten` on a flatten's split fill, from the
   * journalled `flatten_submissions.exit_reason` — WHY the flatten this fill
   * belongs to was submitted. Unlike `qty_is_cumulative`, this one IS carried
   * through to the persisted `Fill` row so `closedTrade()` can read it back
   * regardless of which poll ingested it.
   */
  exit_reason?: ExitReason;
  /**
   * Set by `redistributeOneFlatten` from the FLATTEN's own
   * `flatten_submissions.idempotency_key` (not the lot's — the split fill is
   * re-keyed to the lot before persistence, which loses this link if not
   * carried separately). Persisted so a stored exit fill can be joined back
   * to the specific `flatten_submissions` row that priced it, without
   * guessing by timestamp when a lot has been partially flattened more than
   * once. Absent on non-exit fills.
   */
  flatten_idempotency_key?: string;
}

/**
 * The venue's own account of an order, normalized — reconciliation's unit of
 * truth. Deliberately thinner than `NormalizedFill`: reconcile settles
 * whether the bracket LANDED and in what state, never what it paid. Prices
 * and fees stay `ingestFills()`'s business, reconstructed from `Fill` rows.
 */
export interface NormalizedOrder {
  client_order_id: string;
  /** Entry + attached legs, as the venue reports them now */
  broker_order_ids: string[];
  order_state: OrderState;
  /** Cumulative filled quantity per the venue */
  filled_qty: number;
}

/**
 * One position as the VENUE reports it (execution-spec.md's
 * `NormalizedPosition`). Deliberately thin: this is the venue's own account
 * of what it holds, and it carries none of the system's context — no
 * `debate_id`, no bracket, no conviction — because the venue has none of
 * that. A row here that the store does not know about cannot be turned into
 * an `OpenPosition` without inventing all of it.
 */
export interface NormalizedPosition {
  instrument: string;
  /** Signed by direction: a short shows as a negative quantity, as venues report it */
  qty: number;
  side: 'buy' | 'sell';
  /** Venue's average entry price, or null where the venue does not report one */
  avg_entry_price: number | null;
}

/**
 * The broker boundary — nothing above it knows which venue, or whether the
 * mode is live, paper or backtest.
 *
 * `cancel`/`submitFlatten`/`getOpenPositions` exist because
 * [ADR-0007](../../docs/adr/0007-fully-automatic-execution.md) removed the
 * human approval gate: an operator watching a position they dislike had no
 * way to cancel a working order or flatten a lot, and the only remaining
 * stop was a set of circuit breakers three of which could not fire.
 */
export interface BrokerAdapter {
  submitBracket(order: NativeBracketRequest): Promise<BrokerAck>;
  /**
   * The venue's current account of a prior order, or `null` if the venue
   * AUTHORITATIVELY has no such order — which lets `reconcile()` settle a
   * write-ahead record whose broker call never landed. The null contract is
   * narrow: an adapter that merely cannot determine the answer MUST throw,
   * never return null — reconcile reads null as "never placed" and marks the
   * lot `rejected`, so returning null on ignorance would bury a live position.
   *
   * `instrument` is passed because a symbol-keyed venue (ccxt) cannot look an
   * order up without it, and after a restart the adapter's in-memory state is
   * gone while the store record still carries it.
   */
  getOrder(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null>;
  /**
   * The flatten-sweep counterpart of `getOrder` — `reconcile()`'s ONLY
   * caller, for every `flatten_submissions` row its `getUnresolvedFlattens()`
   * worklist names. Same null/throw contract as `getOrder`. The
   * re-populating side effect is the point: a live adapter's flatten-sweep
   * worklist is process-local and empty after a restart, so without this
   * call `fetchNewFills` polls nothing for a flatten a crash stranded
   * mid-sweep. Kept SEPARATE from `getOrder` because that method's own
   * implementation re-populates `brackets`, which is never pruned — routing
   * a flatten through it would leak it into the bracket sweep permanently.
   */
  resumeFlatten(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null>;
  /**
   * The venue's fill feed. Inclusive of `since` and never dated before it,
   * so a backtest cannot see a fill ahead of simulated T. Re-offering an
   * already-returned fill is expected — `ingestFills()`'s `hasFill` gate
   * dedups on the full `(idempotency_key, broker_fill_id)` pair.
   *
   * NOT PROMISED: that a lot's fills are dated MONOTONICALLY across calls. A
   * lot is not one ordered stream — entry, stop, target and exit legs fill
   * under the SAME `idempotency_key`, and a protective leg can fire while the
   * entry is still filling — so a later call can hand back an EARLIER
   * timestamp than an earlier one did. Callers must never raise `since` past
   * a timestamp already ingested for a lot; an under-fetch is unrecoverable
   * (`broker_fill_id` dedup only guards the opposite direction).
   */
  fetchNewFills(since: Date): Promise<NormalizedFill[]>;
  /**
   * Size the protective legs to the entry's CUMULATIVE filled quantity — an
   * over-sized stop protects phantom quantity, an under-sized one leaves
   * part of the lot naked (execution-spec.md story 13). On this seam because
   * `OpenPosition` carries no leg-quantity field: resizing is a venue-side
   * act. Adapters whose native brackets track the entry (Alpaca/IBKR)
   * satisfy it by doing nothing.
   */
  resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void>;
  /**
   * Re-arms protective legs on a residual position whose legs were CANCELLED
   * outright — the case `resizeProtectiveLegs` can't cover, since a
   * cancelled bracket has no legs left to resize. `executeExit` cancels a
   * held lot's legs before every flatten; a partial flatten fill needs this
   * to re-establish protection on what's still held. `qty` is the RESIDUAL
   * still open; `stop`/`target` are the lot's unchanged price levels.
   *
   * `clientOrderId` is the lot's OWN `idempotency_key`, passed through
   * unchanged by the only caller (`ingestFills`). A fresh id is still needed
   * at the venue (Alpaca refuses a reused client order id permanently) —
   * deriving it is the ADAPTER's job: `AlpacaBrokerAdapter` suffixes it,
   * `SimulatedBrokerAdapter` keys on the id as passed. An adapter that
   * generated its own fresh id would break `fetchNewFills`'s lot-keyed
   * sweep, which tags fills under THIS `clientOrderId`.
   *
   * Throws on failure — the caller turns it into a fallback alert. An
   * adapter that cannot express this must throw too, never silently no-op,
   * which would report success for a residual that is still naked.
   */
  rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void>;
  /**
   * Flattens exposure with a plain market order. `side` is the CLOSING side,
   * so a long is flattened with `sell`. Deliberately not a bracket — arming
   * protective legs on an order meant to reach zero would leave a resting
   * stop behind after the position is gone. `clientOrderId` is the caller's
   * idempotency key, so a retried flatten is a venue-side no-op rather than
   * a double exit, safe to call from a crash-restart path.
   */
  submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck>;
  /**
   * Cancels a working order and every leg attached to it. Idempotent by
   * contract: cancelling an order already cancelled, filled or unknown to
   * the venue resolves rather than throwing — the caller cannot know the
   * venue's state at the instant it calls, and a throw on "too late" would
   * make the tool unusable exactly when it's needed. `instrument` is passed
   * for `getOrder`'s reason: a symbol-keyed venue (ccxt) needs it to address an order.
   */
  cancel(clientOrderId: string, instrument: string): Promise<void>;
  /**
   * Everything the venue believes it holds. The other direction of
   * reconciliation: `reconcile()` walks the STORE's open lots and asks the
   * venue about each, which cannot see a position the venue holds that the
   * store never recorded (a write-ahead that died before persisting, or a
   * hand-placed order) — such a lot is invisible to Risk's exposure caps
   * indefinitely otherwise (execution-spec.md "Idempotency & Crash-Restart").
   */
  getOpenPositions(): Promise<NormalizedPosition[]>;
  /**
   * True when this adapter prices its OWN fills through a `CostModel` and
   * reports a `cost_breakdown` on every fill it emits. Without this flag,
   * `captureSubmitSnapshot` would independently run `CostModel.fill` too —
   * two writers for one number, free to disagree under non-determinism — so
   * it skips its own pricing and lets the adapter's breakdown stand as the
   * single source. Declared as a capability rather than detected with
   * `instanceof`, per "strategy code must not know which broker it's talking
   * to" (CLAUDE.md's Broker Plan). Absent/false on every real-venue adapter,
   * which reports what it charged rather than what a model predicted.
   */
  readonly prices_own_fills?: boolean;
}
