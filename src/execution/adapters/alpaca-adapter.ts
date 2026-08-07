/**
 * Alpaca BrokerAdapter (ticket #84) — see docs/specs/execution-spec.md
 * ("Module: Broker Abstraction"): the MVP paper/live-equities path. Alpaca's
 * native bracket order (`order_class: 'bracket'`) gives the atomic
 * entry + one-cancels-other stop/target guarantee natively, so this adapter
 * does no OCO emulation of its own — unlike the ccxt adapter (#85).
 *
 * The Alpaca trading client is injected (`AlpacaClient`), mirroring the
 * injected-client pattern already used for market data
 * (src/market-data-service/sources/alpaca-source.ts): connection/auth is an
 * ops concern (trade-only key, withdrawals disabled, IP-whitelisted per
 * CONTEXT.md invariant 3), not something this adapter constructs.
 *
 * `fetchNewFills` is not yet part of the `BrokerAdapter` interface (only
 * `submitBracket` is — see types.ts) but is exposed the same way
 * `SimulatedBrokerAdapter` exposes it: #83's `ingestFills()` is the future
 * caller. Alpaca's `getOrder` reports cumulative `filled_qty` /
 * `filled_avg_price` per order, not one event per partial fill, so a leg
 * that fills in two tranches between polls is normalized here as a single
 * fill carrying the cumulative filled quantity as of the poll that first
 * observes it — finer-grained partial-fill history requires Alpaca's trade
 * updates/activities stream, which is out of scope for this ticket.
 *
 * #287/#295 made the bracket index durable. Alpaca is the one venue where
 * that index is a CACHE rather than the truth — `getOrder` asks the venue
 * directly and the native bracket is the state machine — but the cache is
 * still load-bearing for `fetchNewFills`, which polls only what is in it. See
 * `state` on the input below for why the cache had to be persisted anyway.
 */
import {
  type Clock,
  DEFAULT_VENUE_PACING,
  type OrderState,
  SystemClock,
  TokenBucket,
} from '../../shared/index.js';
import { sanitizeBrokerError } from '../broker-error.js';
import {
  type BrokerStateStore,
  InMemoryBrokerStateStore,
  toRequestFields,
  type UnpricedFillObservation,
  type UnpricedFillRecord,
} from '../broker-state-store.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../types.js';
import type { UnpricedFillAlertChannel } from '../unpriced-fill-alert.js';
import type { AlpacaClient, AlpacaOrder, AlpacaOrderLeg } from './alpaca-client.js';

/**
 * How long a fill may sit unpriced before it stops being "the venue is briefly
 * behind" and becomes "a lot is stuck and nobody knows" (#298).
 *
 * 15 minutes, against a 15-second fill poll (`DEFAULT_FILL_POLL_INTERVAL_MS`
 * in orchestrator/production.ts): ~60 consecutive polls, all reporting a
 * positive `filled_qty` with no `filled_avg_price`. That is far outside any
 * plausible settlement lag on a venue that prices market orders instantly, and
 * still short enough that an operator hears about it inside one trading hour
 * rather than at the end of an unattended 14-day soak (#238).
 *
 * A default, not a constant: `AlpacaBrokerAdapterInput.unpricedFillAgeOutMs`
 * overrides it, and `ProductionConfig.unpricedFillAgeOutMs` threads it from the
 * composition root.
 */
export const DEFAULT_UNPRICED_FILL_AGE_OUT_MS = 15 * 60_000;

export interface AlpacaBrokerAdapterInput {
  client: AlpacaClient;
  /**
   * Optional so existing wiring (src/orchestrator/production.ts) keeps
   * working; when absent the adapter still paces itself rather than running
   * unlimited — see the default below.
   */
  rateLimiter?: TokenBucket;
  /**
   * Durable home for the bracket index (#287). Optional for the same
   * compatibility reason as `rateLimiter`, but the two defaults are not
   * equivalent: that one is merely conservative, whereas the in-memory default
   * here IS the #295 bug. src/orchestrator/production.ts injects
   * `SqliteBrokerStateStore`.
   *
   * Alpaca's index is a cache of a venue-authoritative lookup, so persisting
   * it is a WARM-UP rather than a source of truth — unlike ccxt, where the
   * persisted phase IS the truth. It is persisted anyway because the warm-up
   * is what `fetchNewFills` iterates: `getOrder` repopulates the cache, but
   * `reconcile()` only calls `getOrder` for lots that are still in-flight
   * (`pending`/`submitted`), so a `partially_filled` lot whose exit legs have
   * not filled yet is never re-cached and its fills are never polled again.
   *
   * The alternative considered and rejected: derive `fetchNewFills`' worklist
   * from `open_positions`, which already carries `idempotency_key` and
   * `broker_order_ids` and is arguably the more correct source. It would give
   * this adapter a dependency on the `SharedStore` seam it currently has no
   * business knowing about, and it changes MVP-path behaviour on a ticket
   * whose own priority note says the Alpaca path is not the one it is fixing.
   */
  state?: BrokerStateStore;
  /**
   * Where a permanently-unpriced fill is escalated (#298). REQUIRED, unlike
   * every other seam here, and the asymmetry is deliberate: this ticket's
   * acceptance criterion is that such a fill "cannot leave a lot stuck with no
   * operator-visible signal", and an optional channel is exactly how that
   * signal goes missing. `state`'s optional in-memory default is the cautionary
   * precedent — the comment above calls that default "the #295 bug" — so the
   * one seam whose absence IS the failure mode does not get one.
   *
   * Log-only is a legitimate implementation (`LoggingUnpricedFillAlertChannel`,
   * the production default until a `TelegramClient` is wired at the composition
   * root, #275); silence is not.
   */
  unpricedFillAlerts: UnpricedFillAlertChannel;
  /**
   * How long a fill may stay unpriced before it is escalated. Defaults to
   * `DEFAULT_UNPRICED_FILL_AGE_OUT_MS`.
   */
  unpricedFillAgeOutMs?: number;
  /**
   * Reads the age-out clock. Injected rather than `new Date()` so a test can
   * age a fill without sleeping, and so the adapter measures time the same way
   * the rest of the system does. Defaults to `SystemClock`.
   */
  clock?: Clock;
}

export class AlpacaBrokerAdapter implements BrokerAdapter {
  /** client_order_id -> the bracket parent's Alpaca order id. */
  private readonly brackets = new Map<string, string>();
  /**
   * client_order_id -> the flatten's own Alpaca order id (#517), tracked
   * in-memory only (#526 tracks making it durable) — see `fetchNewFills`'s
   * "flatten sweep" comment for the full rationale: why this is a SEPARATE
   * map from `brackets`, why in-memory is an accepted gap rather than an
   * oversight, and why (UNLIKE `brackets`) an entry here is pruned once its
   * order goes terminal, rather than kept for the process lifetime.
   */
  private readonly flattens = new Map<string, string>();
  /**
   * lot's `idempotency_key` -> the re-armed OCO's Alpaca order id (#525).
   * Keyed by the LOT, not by the OCO's own wire `client_order_id`
   * (`${lotKey}:rearm`) — `fetchNewFills`'s rearm sweep below tags fills
   * under THIS key, so they land in `ingestFills()`'s ordinary per-position
   * bucket with no routing of their own, the same way a bracket's own fills
   * do. In-memory only, the same accepted gap `flattens` documents: a
   * restart between a successful re-arm and its eventual fill loses
   * visibility until reconcile learns about it (`rearmProtectiveLegs`'s doc
   * comment).
   */
  private readonly rearmedLegs = new Map<string, string>();
  /**
   * #299 moved the NUMBER out of this file into `DEFAULT_VENUE_PACING.alpaca`
   * (shared/http/venue-pacing.ts), overridable per deployment via
   * `SAMURAI_PACING_ALPACA_*` — a rate limit is a property of the account, not
   * of this class, and two operators on different tiers cannot both be right
   * about a literal compiled in here.
   *
   * **`DEFAULT_VENUE_PACING.alpaca` is a FALLBACK for direct construction, and
   * it CHANGED in #299: 5 burst / 3.0 sustained -> 10 burst / 1.5 sustained.**
   * The production composition root always passes `rateLimiter` explicitly
   * (`production.ts`, from `resolveVenuePacing()`), so this default is not what
   * a running system paces on — but a consumer constructing the adapter
   * directly now gets twice the burst and half the sustained rate of the
   * previous in-file literal, which is worth knowing before relying on either.
   * Both in-repo callers inject their own limiter; nothing depends on this
   * shape today.
   *
   * The two numbers moved in opposite directions on purpose, because they are
   * set on different axes with different evidence:
   *
   * - SUSTAINED 1.5/s is 45% of Alpaca's documented 200 requests/minute PER
   *   ACCOUNT ceiling (verified at alpaca.markets/support/usage-limit-api-calls
   *   = 3.33/s), which `resolveVenuePacing` enforces as an upper bound on any
   *   override. It is not just under the ceiling because the market-data client
   *   draws on the same per-account budget and is paced by no bucket (#391).
   * - BURST 10 has NO documented Alpaca figure behind it — none could be found
   *   — so it is derived from our own workload instead: `fetchNewFills` issues
   *   one `getOrder` per open bracket through this bucket, so a sweep of the
   *   ADR-0001 universe plus a concurrent `submitBracket` is
   *   `DEFAULT_UNIVERSE.length + 1`, which a test pins the capacity against.
   *
   * Why an unverified burst is a tolerable risk where an unverified sustained
   * rate would not be: over-burst returns a 429, which `withRetry` handles and
   * the bucket then paces, whereas a BAN comes from sustained abuse — the axis
   * that has a verified ceiling and sits at 45% of it.
   */
  private readonly rateLimiter: TokenBucket;
  private readonly state: BrokerStateStore;
  private readonly clock: Clock;
  private readonly unpricedFillAgeOutMs: number;

  constructor(private readonly input: AlpacaBrokerAdapterInput) {
    this.rateLimiter = input.rateLimiter ?? new TokenBucket(DEFAULT_VENUE_PACING.alpaca);
    this.state = input.state ?? new InMemoryBrokerStateStore();
    this.clock = input.clock ?? new SystemClock();
    this.unpricedFillAgeOutMs = input.unpricedFillAgeOutMs ?? DEFAULT_UNPRICED_FILL_AGE_OUT_MS;

    // Synchronous, in the constructor: the first `fetchNewFills` sweep after a
    // restart iterates this map, and an empty one reports "no new fills" —
    // indistinguishable, above the adapter, from a quiet market.
    for (const record of this.state.loadBrackets('alpaca')) {
      if (record.entry_order_id === null) continue;
      this.brackets.set(record.client_order_id, record.entry_order_id);
    }
  }

  /**
   * The single door to the injected client: pacing before the call (C2),
   * credential-safe error conversion after it (H1). Alpaca's REST errors quote
   * the failed request — including the `APCA-API-KEY-ID` header on an auth
   * failure — and `execute()` copies a thrown message straight into a logged
   * `ExecutionResult.reason`.
   */
  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    await this.rateLimiter.acquire();
    try {
      return await fn();
    } catch (cause) {
      throw sanitizeBrokerError('alpaca', operation, cause);
    }
  }

  /**
   * The flatten (#429) — a plain market order, never a bracket.
   *
   * `time_in_force: 'ioc'` is the one value Alpaca accepts for a MARKET order
   * on both venues: equities take `day`/`ioc`/`fok` and crypto takes
   * `gtc`/`ioc`, so `ioc` is the intersection and this adapter serves both.
   * It is also the right semantics for an emergency exit — fill what the book
   * offers now, leave nothing resting.
   *
   * The honest caveat: a thin book can leave the flatten PARTIAL, and a repeat
   * call under the same `clientOrderId` is a venue-side no-op by design, so
   * finishing the job needs a fresh key. That is the correct trade — the
   * alternative is a resting order the operator has to remember to clean up.
   *
   * Not written to `this.state` (the DURABLE bracket index): a flatten has no
   * legs to arm, resize or reconcile, and half-formed bracket-shaped state
   * for one is exactly the wrong shape (migration 0019's comment). It IS
   * tracked in the in-memory `flattens` map below (#517) — without that,
   * `fetchNewFills` has no way to learn this order exists at all, since it
   * only ever polls `brackets`/`flattens`, never the venue's full order list.
   * See `fetchNewFills`'s "flatten sweep" comment for why in-memory is the
   * right amount of durability here.
   */
  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    const response = await this.call('submitFlatten', () =>
      this.input.client.submitMarketOrder({
        symbol: toAlpacaSymbol(instrument),
        side,
        qty: String(size),
        time_in_force: 'ioc',
        client_order_id: clientOrderId,
      }),
    );

    this.flattens.set(clientOrderId, response.id);

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [response.id],
      order_state: mapOrderState(response.status),
    };
  }

  /**
   * Cancels the order and, on a bracket, its attached legs with it — Alpaca
   * cancels a parent's children as part of cancelling the parent. ALSO
   * cancels a re-armed residual's protective OCO (#525 follow-up), which
   * the lookup above cannot find on its own: `rearmProtectiveLegs` submits
   * that order under `${clientOrderId}:rearm`, a DIFFERENT client order id
   * from the lot's own — so without this second half, a re-armed lot's OCO
   * would stay live at the venue through every future call to this method,
   * ready to fire into whatever flatten this cancel is clearing the way
   * for and open a reverse position, exactly the #516 hazard this method
   * exists to prevent, reintroduced one level down.
   *
   * Resolves rather than throwing when the venue has nothing under an id:
   * `getOrderByClientOrderId` returning null means it was never placed or is
   * long gone, and the transport treats `404`/`422` the same way. The caller
   * cannot know the venue's state at the instant it calls, and a cancel that
   * throws on "too late" fails precisely in the race it exists to handle.
   * That posture does NOT extend to a genuine transport/auth failure on
   * either half: `this.call()` lets that propagate uncaught, so a cancel
   * that could not confirm either leg is gone throws — `executeExit`
   * refuses the flatten rather than sending a market order while it is
   * unknown whether the legs it was meant to clear are actually gone.
   *
   * Resolves the ORIGINAL bracket's Alpaca id through the venue rather than
   * the local `brackets` map, for `getOrder`'s reason: that map is
   * populated only by `submitBracket` in this process, so after a restart
   * it is empty. The re-armed OCO takes the CHEAP path first —
   * `rearmedLegs` when this process is the one that placed it, no network
   * round trip needed — and falls back to the SAME venue lookup, by the
   * derived id, when the map has nothing: the only way to find a re-arm
   * placed before a restart, since `rearmedLegs` is in-memory only. A null
   * result there is the ordinary case (no re-arm ever happened for this
   * lot) and is not an error.
   */
  async cancel(clientOrderId: string, _instrument: string): Promise<void> {
    const order = await this.call('cancel', () =>
      this.input.client.getOrderByClientOrderId(clientOrderId),
    );
    if (order !== null) {
      await this.call('cancel', () => this.input.client.cancelOrder(order.id));
      this.brackets.delete(clientOrderId);
    }

    const rearmedOrder = await this.resolveRearmedOrder(clientOrderId);
    if (rearmedOrder !== null) {
      await this.call('cancel', () => this.input.client.cancelOrder(rearmedOrder));
      // Deleted only now, after the cancel is confirmed — not before, and
      // not merely on finding it: a `cancelOrder` throw above must leave
      // the map (and the venue) exactly as they were, so a retried cancel
      // finds the same order again rather than believing it already gone.
      this.rearmedLegs.delete(clientOrderId);
    }
  }

  /**
   * The re-armed OCO's Alpaca order id for `clientOrderId`'s lot, or `null`
   * if none exists — the two-path resolution `cancel()`'s doc comment
   * describes. Split out so `cancel()`'s own body reads as "cancel the
   * bracket, then cancel the re-arm" rather than burying the fallback
   * chain inline.
   */
  private async resolveRearmedOrder(clientOrderId: string): Promise<string | null> {
    const inProcess = this.rearmedLegs.get(clientOrderId);
    if (inProcess !== undefined) return inProcess;

    const rearmOrder = await this.call('cancel', () =>
      this.input.client.getOrderByClientOrderId(`${clientOrderId}:rearm`),
    );
    return rearmOrder?.id ?? null;
  }

  /**
   * Everything the venue believes it holds (#429) — the direction of
   * reconciliation `getOrder` cannot serve.
   *
   * A row whose `qty` does not parse is dropped rather than reported as NaN:
   * downstream this feeds an exposure comparison, and NaN compares false
   * against everything, so a poisoned row would silently read as "no
   * divergence" — the exact answer it must not give.
   */
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    const positions = await this.call('getOpenPositions', () => this.input.client.getPositions());

    return positions.flatMap((position) => {
      const qty = Number(position.qty);
      if (!Number.isFinite(qty) || qty === 0) return [];
      const avgEntry = Number(position.avg_entry_price);
      return [
        {
          instrument: fromAlpacaSymbol(position.symbol),
          qty,
          side: position.side === 'long' ? ('buy' as const) : ('sell' as const),
          avg_entry_price: Number.isFinite(avgEntry) ? avgEntry : null,
        },
      ];
    });
  }

  /**
   * VERIFIED 2026-08-07 against live Alpaca paper: crypto rejects
   * `order_class: 'bracket'` outright — `422 {"code":42210000,"message":
   * "crypto orders not allowed for advanced order_class: otoco"}`. Also
   * confirmed: `order.instrument` reaches Alpaca unconverted
   * (`DEFAULT_UNIVERSE`'s `BTC-USD`, not the `BTC/USD` the trading API
   * wants), which alone fails first with `422 {"message":"asset \"BTC-USD\"
   * not found"}` — before the order-class rejection is ever reached. No
   * crypto bracket entry can succeed today; either defect alone is fatal.
   * Full probe transcript: #550. Symbol-conversion fix: #585. Order-class
   * fix: #586.
   */
  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    const response = await this.call('submitBracket', () =>
      this.input.client.submitOrder({
        symbol: toAlpacaSymbol(order.instrument, order.asset_class),
        side: order.side,
        qty: String(order.size),
        limit_price: String(order.entry),
        time_in_force: order.time_in_force,
        client_order_id: order.client_order_id,
        order_class: 'bracket',
        take_profit: { limit_price: String(order.target) },
        stop_loss: { stop_price: String(order.stop) },
      }),
    );

    this.brackets.set(order.client_order_id, response.id);

    const legIds = (response.legs ?? []).map((leg) => leg.id);

    // `phase: 'armed'` — on a native-bracket venue there is no local state
    // machine to be partway through; the bracket is live from this call.
    this.state.saveBracket({
      venue: 'alpaca',
      client_order_id: order.client_order_id,
      phase: 'armed',
      entry_order_id: response.id,
      ...legOrderIds(response.legs),
      request: toRequestFields(order),
      armed_qty: null,
      arming_qty: null,
      arm_attempt: 0,
    });

    return {
      client_order_id: order.client_order_id,
      broker_order_ids: [response.id, ...legIds],
      order_state: mapOrderState(response.status),
    };
  }

  /**
   * The reconciliation lookup (#86), by OUR client order id — deliberately
   * NOT via the `brackets` map. That map is populated only by `submitBracket`
   * in this process, so after the crash-restart this method exists to serve
   * it is empty; answering from it would report every live order as absent
   * and let `reconcile()` mark real positions `rejected`. The venue is asked
   * directly instead.
   *
   * A null here is therefore Alpaca's own answer, not this adapter's
   * ignorance, which is what the `BrokerAdapter.getOrder` contract requires
   * before reconcile may treat it as "never placed". A transport failure
   * throws out of the client and is left to propagate, exactly as that
   * contract wants.
   */
  // `_instrument` is unused here but declared to match `BrokerAdapter.getOrder`
  // — Alpaca looks an order up by client id alone, while a symbol-keyed venue
  // (ccxt) cannot. Omitting it left callers unable to pass the argument the
  // port says to pass.
  async getOrder(clientOrderId: string, _instrument: string): Promise<NormalizedOrder | null> {
    const order = await this.call('getOrder', () =>
      this.input.client.getOrderByClientOrderId(clientOrderId),
    );
    if (order === null) return null;

    // Re-populating the map lets a post-restart `fetchNewFills` find this
    // bracket again — the reconciliation sweep is the only thing that knows
    // these orders still exist. Journalled too, via the partial-upsert path:
    // this call knows the venue's order ids but NOT the request that produced
    // them, and writing invented request values would be worse than none.
    this.brackets.set(clientOrderId, order.id);
    this.state.recordBracketOrderIds('alpaca', clientOrderId, {
      entry_order_id: order.id,
      ...legOrderIds(order.legs),
    });

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [order.id, ...(order.legs ?? []).map((leg) => leg.id)],
      order_state: mapOrderState(order.status),
      filled_qty: Number.parseFloat(order.filled_qty),
    };
  }

  /**
   * A no-op: Alpaca's native bracket attaches the protective legs to the
   * parent entry, so the venue keeps their quantity in step as the parent
   * fills. Re-sizing from here would fight the venue over leg quantity — the
   * same reason this adapter does no OCO emulation of its own. The seam is
   * still honoured; a native bracket meets it by having already met it.
   */
  async resizeProtectiveLegs(): Promise<void> {
    // Intentionally empty — see above.
  }

  /**
   * Re-arms a residual left by a partial flatten (#525) — `executeExit`
   * cancelled this lot's ENTIRE bracket (entry-side legs included) before
   * submitting the flatten (#516), so unlike `resizeProtectiveLegs` above
   * there is no live native bracket left to fight over quantity: the venue
   * genuinely holds nothing protecting this position any more.
   *
   * `order_class: 'oco'` (Alpaca's protective-legs-only shape, #525) rather
   * than another `submitBracket`: this residual is already held, and a
   * bracket's entry leg would try to buy/sell it again.
   *
   * The id sent to the VENUE is a FRESH one this method derives itself
   * (`${clientOrderId}:rearm`), never reused verbatim — that original id
   * already named the now-cancelled bracket, and whether the venue permits
   * reusing a client order id whose prior order is terminal is unverified.
   * Sidestepping the question is cheaper than betting on either answer. This
   * is distinct from the `clientOrderId` PARAMETER this method receives,
   * which is the lot's own `idempotency_key` unchanged — see
   * `BrokerAdapter.rearmProtectiveLegs`'s doc (types/broker.ts) for that
   * contract.
   *
   * Tracked in `rearmedLegs`, keyed by the LOT's own `idempotency_key` (not
   * the wire id) — `fetchNewFills`'s sweep below tags fills under this key
   * directly, so `ingestFills()`'s ordinary per-position routing picks them
   * up with no knowledge a re-arm was ever involved. In-memory only, the
   * same accepted gap `flattens` documents: a restart between a successful
   * re-arm and its eventual fill loses visibility until reconcile learns
   * about it — genuinely open, not closed by this ticket.
   *
   * `recordBracketOrderIds` is called best-effort so the durable index at
   * least carries the OCO's own order ids — and it does MORE than merely
   * "carry" them: `SqliteBrokerStateStore`'s upsert COALESCEs each column
   * independently (`excluded.x` wins whenever it is non-null), and every id
   * passed here except `entry_order_id` is non-null, so `stop_order_id` and
   * `target_order_id` are OVERWRITTEN with the re-arm's own ids on the SAME
   * row (still keyed by `clientOrderId`). Only `entry_order_id` survives from
   * before — this call passes `null` for it, so COALESCE keeps the ORIGINAL
   * cancelled entry's id. `target_order_id` therefore now holds the OCO's
   * PARENT order id (`response.id` below), not a take-profit LEG id the way a
   * native bracket's `target_order_id` does — an OCO has no separate
   * take-profit child; see the comment on `recordBracketOrderIds`'s call
   * below for why `.legs` is not used for it. The restart gap above still
   * stands (nothing durable maps `rearmedLegs`'s in-memory
   * `clientOrderId -> OCO id` back to "this was a re-arm, not the original
   * bracket"), but this row is not merely inert either — #548 tracks
   * whether that makes it a usable restart-recovery hook.
   *
   * VERIFIED 2026-08-07 against live Alpaca paper, two stacked defects: (1)
   * this method's own wire shape (top-level `limit_price` for take-profit)
   * is rejected for EVERY asset class — `422 {"code":40010001,"message":"oco
   * orders require take_profit.limit_price"}` on both `BTC/USD` and `SPY`;
   * (2) with the shape corrected, crypto is separately rejected at the
   * order-class level — `422 {"code":42210000,"message":"crypto orders not
   * allowed for advanced order_class: oco"}` — while the equity control
   * passes that check. A crypto (and, until #1 is fixed, equity) residual
   * is alert-only today, never re-armed. Full probe transcript: #550.
   * Wire-shape + order-class fix: #586.
   */
  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void> {
    const rearmClientOrderId = `${clientOrderId}:rearm`;
    // The CLOSING side, mirroring `submitFlatten`'s own convention — `side`
    // here is the lot's HELD side (the `BrokerAdapter.rearmProtectiveLegs`
    // contract), so the order that reduces it takes the opposite one.
    const closingSide = side === 'buy' ? 'sell' : 'buy';

    const response = await this.call('rearmProtectiveLegs', () =>
      this.input.client.submitOcoOrder({
        symbol: toAlpacaSymbol(instrument),
        side: closingSide,
        qty: String(qty),
        limit_price: String(target),
        time_in_force: 'gtc',
        client_order_id: rearmClientOrderId,
        order_class: 'oco',
        stop_loss: { stop_price: String(stop) },
      }),
    );

    this.rearmedLegs.set(clientOrderId, response.id);
    // NOT `...legOrderIds(response.legs)`: that helper finds the target leg
    // by scanning `.legs` for a `type: 'limit'` entry, which is where a
    // BRACKET's take-profit child lives. An OCO's take-profit is the TOP
    // LEVEL order itself (`response.id`) — `.legs` here holds only the ONE
    // stop-loss child — so `target_order_id` is set directly rather than
    // reusing that scan and silently recording `null`.
    this.state.recordBracketOrderIds('alpaca', clientOrderId, {
      entry_order_id: null,
      stop_order_id: legOrderIds(response.legs).stop_order_id,
      target_order_id: response.id,
    });
  }

  /**
   * The fill feed `ingestFills()` drains, in the same shape
   * `SimulatedBrokerAdapter.fetchNewFills` already produces. Point-in-time:
   * never returns a fill dated before `since`.
   *
   * Sweeps `brackets` AND `flattens` (#517) — before this, a flatten's own
   * order was never polled here at all: `submitFlatten` reached the venue but
   * entered neither map, so its fill was invisible to `ingestFills()` no
   * matter what that function did with it. Each flatten fill is tagged
   * `leg: 'exit'`, never `'entry'`, so `ingestFills()`'s own attribution can
   * tell it apart from a bracket's entry fill without needing to know which
   * adapter produced it.
   *
   * Each bracket is isolated. `ingestFills()` awaits this as ONE call before
   * advancing ANY lot, and `brackets` iterates in insertion order, so an
   * unhandled throw here does not just lose one order's fills — it aborts the
   * whole account's ingestion cycle, and a bracket that Alpaca persistently
   * reports malformed would starve every bracket submitted after it, stop-outs
   * included. Refusing to book one bad fill must not cost the sweep.
   *
   * The isolation is per BRACKET, not per `collectFill`: a bracket whose entry
   * price cannot be recorded must not have its exit legs booked either, or the
   * lot's accounting is built on a fill that was rejected.
   *
   * A refused unpriced fill is additionally REMEMBERED (#298) before the sweep
   * returns, and escalated once it has been unpriced too long — see
   * `escalateAgedUnpricedFills`. Skipping is the right answer for the transient
   * case and, on its own, silence for the permanent one.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const fills: NormalizedFill[] = [];
    const failures: unknown[] = [];
    /**
     * Counted apart from `failures.length`, which now also collects journal and
     * alert-delivery failures (#298). Reporting those as "brackets failed"
     * would send an operator reading the soak log to the venue to investigate
     * orders that were never the problem.
     */
    let bracketFailures = 0;

    // Snapshot, as #297 already did for `CcxtBrokerAdapter.syncBrackets` (M3):
    // the `getOrder` below awaits inside this loop, and a Map iterator DOES
    // visit entries inserted mid-iteration — so a bracket submitted during the
    // sweep would be drained by a pass whose `since` window predates it, and
    // its fills silently dropped. The snapshot fixes each pass's worklist at
    // entry (PR #290 review, deepseek).
    for (const [clientOrderId, entryOrderId] of [...this.brackets]) {
      try {
        const entry = await this.call('fetchNewFills', () =>
          this.input.client.getOrder(entryOrderId),
        );

        const instrument = fromAlpacaSymbol(symbolOf(entry));
        collectFill(entry, 'entry', clientOrderId, instrument, since, fills);
        for (const leg of entry.legs ?? []) {
          collectFill(leg, legName(leg), clientOrderId, instrument, since, fills);
        }
      } catch (error) {
        // Skipped, not swallowed: this bracket contributes nothing to THIS
        // sweep and is retried on the next one. That is the same shape as an
        // order the venue has not reported yet, and `ingestFills()` dedups on
        // `broker_fill_id`, so re-polling costs nothing.
        if (error instanceof UnpricedFillError) {
          // Durable, and stamped with the FIRST sighting: this is the clock the
          // age-out runs on, and it has to survive the restart that a 14-day
          // unattended soak will contain several of.
          //
          // Guarded, because this runs INSIDE the per-bracket catch: a throw
          // from the journal here would escape the isolation entirely and abort
          // the account's whole sweep — turning one venue anomaly into the
          // stop-outs-for-everyone starvation this loop exists to prevent.
          //
          // NEITHER `failures.push(error)` NOR `bracketFailures += 1` runs for
          // an UnpricedFillError itself (#524 review, deepseek) — it is a
          // MODELLED, EXPECTED condition (#298's whole reason for existing:
          // the age-out clock just above, and the eventual alert through
          // `escalateAgedUnpricedFills` -> `unpriced-fill-channel.ts`), not a
          // failure, which is exactly what this catch's OWN first comment
          // already says ("skipped, not swallowed... retried on the next
          // one"). Counting it here contradicted that: `failures.length > 0`
          // below is what decides whether a `fills`-less call THROWS, so one
          // unpriced fill — on a poll where nothing else happened to produce
          // a fill — silently caused the exact "stop-outs-for-everyone"
          // abort this isolation exists to prevent, for EVERY bracket in the
          // sweep, not just the unpriced one. A journal-write failure
          // (`stateError`, below) is a genuinely different, new failure and
          // still counts.
          try {
            this.state.recordUnpricedFill('alpaca', error.observation, this.clock.now());
          } catch (stateError) {
            failures.push(stateError);
            bracketFailures += 1;
          }
        } else {
          failures.push(error);
          bracketFailures += 1;
        }
      }
    }

    // The flatten sweep (#517) — structurally the bracket loop above with
    // `entry.legs` dropped (a flatten has none) and `leg: 'exit'` fixed
    // rather than derived per-leg. Kept as its own loop, over its own
    // `flattens` map, rather than folded into the one above: a flatten is
    // never a bracket (`submitFlatten`'s own docstring), and merging the
    // maps would make the loop above fetch `entry.legs` for an order that
    // has none.
    //
    // `flattens` IS IN-MEMORY ONLY, unlike `brackets` (which the constructor
    // warms from `this.state.loadBrackets('alpaca')`, because a bracket can
    // legitimately still be waiting on a stop/target fill days after a
    // restart). A flatten is a plain IOC market order: by the time this
    // process could poll it again, the venue has already resolved it one way
    // or another, so the ONLY window not surviving a restart costs is the
    // narrow one between `submitFlatten` returning and this sweep next
    // running. That window is real and NOT closed here: a crash inside it
    // strands the flatten's fill unattributed exactly as it was before #517,
    // and this loop never even attempts the order, because it was never
    // added to `flattens` in the first place. Closing it needs `reconcile()`
    // to learn about `flatten_submissions` rows — tracked as #526 rather
    // than built here, mirroring `executeExit`'s own note in execute.ts that
    // a lost `submitFlatten` response is "left for reconcile to resolve
    // later" even though reconcile does not yet do that either.
    //
    // Entries ARE removed once their order reaches a terminal state (#524
    // review, deepseek: "the flatten poll set grows monotonically for the
    // whole [14-day soak] run" against a ~200 req/min account-wide budget
    // `alpaca-http-client.ts` warns can starve LIVE ORDER PLACEMENT if
    // exhausted — a resource leak that degrades the soak itself, not a
    // tidiness item). Deliberately ASYMMETRIC with `brackets`, which is
    // still never pruned: a bracket can go on mattering after its entry
    // fills (`resizeProtectiveLegs`, the stop/target legs), so "terminal"
    // has no single moment for it. A flatten is a one-shot IOC market
    // order — once it stops being `'submitted'` it will NEVER change again,
    // including `'partially_filled'`: whatever did not fill immediately was
    // cancelled by the venue, not left resting, so there is no later fill
    // this entry could still deliver. Pruning happens below, INSIDE the
    // `try`, only once `collectFill` has already run for this poll — the
    // no-lookahead-preserving reason `advanceLot`'s own filter lives where
    // it does in ingest-fills.ts applies here too: pruning first and
    // collecting second would silently drop the terminal fill this exact
    // ticket exists to stop dropping.
    //
    // What this does NOT wait for: confirmation that `ingestFills()`
    // actually PERSISTED the fill this call handed it. This adapter has no
    // `SharedStore` access to confirm that (`AlpacaBrokerAdapterInput.state`
    // above documents that boundary as deliberate), so there is a narrow
    // residual window — if `ingestFills()` goes on to fail, this poll, for a
    // reason unrelated to this flatten, AFTER this fill was handed off but
    // BEFORE its target lot's own advance is durably written — where the
    // fill is not re-offered on the next poll, because this entry is
    // already gone. That window is strictly narrower than the restart gap
    // above (it needs an in-process failure on the EXACT poll a flatten
    // resolves, not any later restart), and closing it needs the same
    // `reconcile()`-learns-`flatten_submissions` work #526 already tracks
    // rather than a second mechanism invented here.
    let flattenFailures = 0;
    for (const [clientOrderId, orderId] of [...this.flattens]) {
      try {
        const order = await this.call('fetchNewFills', () => this.input.client.getOrder(orderId));
        collectFill(order, 'exit', clientOrderId, fromAlpacaSymbol(symbolOf(order)), since, fills);
        if (mapOrderState(order.status) !== 'submitted') {
          this.flattens.delete(clientOrderId);
        }
      } catch (error) {
        // Same isolation, same UnpricedFillError bookkeeping, and (#524
        // review, deepseek) the SAME non-counting of an UnpricedFillError
        // itself as a failure, as the bracket loop above — see its comments
        // for the full reasoning, which applies unchanged here. Getting this
        // right matters at least as much here as there: an unpriced flatten
        // fill on a poll where no bracket produced one either would
        // otherwise abort the WHOLE sweep, brackets included, not just the
        // flatten. Note what this means for the prune above: a fill this
        // catch reaches for is, by construction, one `collectFill` never
        // finished normalizing, so the `mapOrderState`/`delete` line is never
        // reached for it — an unpriced flatten is retried next poll, same as
        // an unpriced bracket, never pruned mid-unpriced.
        if (error instanceof UnpricedFillError) {
          try {
            this.state.recordUnpricedFill('alpaca', error.observation, this.clock.now());
          } catch (stateError) {
            failures.push(stateError);
            flattenFailures += 1;
          }
        } else {
          failures.push(error);
          flattenFailures += 1;
        }
      }
    }

    // The re-arm sweep (#525) — structurally the flatten loop above, with
    // two differences: keyed by the LOT's own `idempotency_key` (not the
    // OCO's wire id, so a fill lands in `ingestFills()`'s ordinary
    // per-position bucket with no routing of its own — see `rearmedLegs`'
    // doc), and the top-level order is tagged `'target'` rather than
    // `'exit'`/`'entry'`: an OCO's parent order IS the take-profit leg
    // (Alpaca's own shape, `rearmProtectiveLegs`'s doc), not a market order
    // with nothing attached. Its one child leg (the stop-loss) is tagged via
    // `legName`, same as a bracket's legs above. Both satisfy
    // `isExitFill`/`Fill.leg !== 'entry'` in ingest-fills.ts, so a rearmed
    // leg firing correctly reduces the lot and can close it.
    //
    // Pruned once terminal, same asymmetry with `brackets` as `flattens`
    // documents and for the same reason: an OCO here protects a residual
    // that is either still open (worth polling again) or done (a single
    // fire-or-cancel event, never resting again after that).
    let rearmFailures = 0;
    for (const [lotKey, orderId] of [...this.rearmedLegs]) {
      try {
        const order = await this.call('fetchNewFills', () => this.input.client.getOrder(orderId));
        const instrument = fromAlpacaSymbol(symbolOf(order));
        collectFill(order, 'target', lotKey, instrument, since, fills);
        for (const leg of order.legs ?? []) {
          collectFill(leg, legName(leg), lotKey, instrument, since, fills);
        }
        if (mapOrderState(order.status) !== 'submitted') {
          this.rearmedLegs.delete(lotKey);
        }
      } catch (error) {
        // Same isolation and UnpricedFillError bookkeeping as the bracket
        // and flatten loops above.
        if (error instanceof UnpricedFillError) {
          try {
            this.state.recordUnpricedFill('alpaca', error.observation, this.clock.now());
          } catch (stateError) {
            failures.push(stateError);
            rearmFailures += 1;
          }
        } else {
          failures.push(error);
          rearmFailures += 1;
        }
      }
    }

    // The venue caught up: this fill priced, was collected above, and is about
    // to be booked, so its anomaly row is resolved. Done here rather than in
    // `collectFill` so the normalizer stays a pure function of one order.
    try {
      for (const fill of fills) {
        this.state.clearUnpricedFill('alpaca', fill.client_order_id, fill.broker_fill_id);
      }
    } catch (stateError) {
      // Same reasoning as above, and cheaper still to survive: a stale row only
      // risks one redundant alert, whereas losing the sweep loses real fills.
      failures.push(stateError);
    }

    // Before the throw below, and unconditionally: escalation must not depend
    // on whether some OTHER bracket happened to produce a fill this sweep.
    await this.escalateAgedUnpricedFills(failures);

    // Progress wins when there is any: dropping good fills to report a bad
    // bracket would re-create the account-wide stall this isolation removes.
    // A wholly-failed sweep is the one case where throwing costs nothing — and
    // it must not be reported as the "no new fills" that an empty array means.
    if (fills.length === 0 && failures.length > 0) {
      throw new AggregateError(
        failures,
        `Alpaca fetchNewFills: ${failures.length} failure(s) during the sweep ` +
          `(${bracketFailures} bracket(s), ${flattenFailures} flatten(s), ` +
          `${rearmFailures} rearm(s) failed); no fills could be read`,
      );
    }

    return fills;
  }

  /**
   * The age-out (#298). Sweeps the RECORDED anomalies rather than only the ones
   * this pass happened to re-observe: whether the venue still reports the order,
   * whether it is still in the bracket index, and whether it falls inside
   * `ingestFills()`'s `since` window are all things the escalation must not
   * depend on. Table-driven, so the clock keeps running either way.
   *
   * What it DOES depend on is being called — `ingestFills()` returns before
   * touching the broker when there are no open positions, so no sweep runs and
   * nothing ages. That is not a hole for the case this exists to catch: a stuck
   * lot is by definition non-terminal, so it keeps `getOpenPositions()`
   * non-empty and the poll firing until someone resolves it.
   *
   * Alerts ONCE per fill, recorded durably: a permanent venue anomaly must not
   * page an operator every 15 seconds for the rest of the soak. `alerted_at` is
   * written only AFTER the channel accepted the alert, so a channel outage is
   * retried on the next sweep instead of being marked as delivered — the
   * "do not silently give up" half of the requirement.
   */
  private async escalateAgedUnpricedFills(failures: unknown[]): Promise<void> {
    const now = this.clock.now();

    let recorded: readonly UnpricedFillRecord[];
    try {
      recorded = this.state.loadUnpricedFills('alpaca');
    } catch (stateError) {
      // The sweep's fills are still good; only the escalation is blind this
      // pass, and the rows outlive the failure, so the next sweep escalates.
      failures.push(stateError);
      return;
    }

    for (const record of recorded) {
      if (record.alerted_at !== null) continue;

      const unpricedForMs = now.getTime() - record.first_seen_at.getTime();
      if (unpricedForMs < this.unpricedFillAgeOutMs) continue;

      try {
        await this.input.unpricedFillAlerts.postUnpricedFillAlert({
          venue: 'alpaca',
          client_order_id: record.client_order_id,
          broker_fill_id: record.broker_fill_id,
          leg: record.leg,
          instrument: record.instrument,
          qty: record.qty,
          first_seen_at: record.first_seen_at,
          unpriced_for_ms: unpricedForMs,
          age_out_ms: this.unpricedFillAgeOutMs,
        });
      } catch {
        // The channel's own error is READ AND DISCARDED, never re-thrown or
        // attached — `BrokerError`'s posture (broker-error.ts), and it applies
        // just as hard here: a Telegram/Discord transport failure quotes the
        // request it failed on, and that URL carries the bot token. What is
        // replaced cannot leak. The row stays unalerted, so the next sweep
        // retries delivery.
        failures.push(
          new Error(
            `Alpaca unpriced-fill alert delivery failed for order ${record.broker_fill_id} ` +
              `(${record.leg} leg of '${record.client_order_id}')`,
          ),
        );
        // Unrecorded, so the next sweep tries again — the alert this fill is
        // owed has not been spent.
        continue;
      }

      try {
        this.state.markUnpricedFillAlerted(
          'alpaca',
          record.client_order_id,
          record.broker_fill_id,
          now,
        );
      } catch (stateError) {
        // Delivered but not recorded: the next sweep will alert again. Noisy,
        // never silent — the direction to fail in.
        failures.push(stateError);
      }
    }
  }
}

/**
 * The bracket parent's symbol, or `'unknown'` when the venue omitted it.
 *
 * `AlpacaOrder.symbol` is declared non-optional, so this only fires on a
 * payload that already contradicts the contract — and that is exactly when the
 * age-out matters most. The alternative, letting `undefined` reach a NOT NULL
 * column, would trade a slightly less informative alert for no alert at all.
 * `'unknown'` over `''` because it survives being read aloud in a message.
 */
function symbolOf(order: AlpacaOrder): string {
  return typeof order.symbol === 'string' && order.symbol.length > 0 ? order.symbol : 'unknown';
}

/**
 * A fill the venue reports filled and cannot price. Carries the observation so
 * `fetchNewFills` can start (or continue) its age-out clock — the plain `Error`
 * this replaces left the sweep nothing to remember it by.
 *
 * Thrown rather than returned so the existing per-bracket isolation is
 * unchanged: a bracket whose entry cannot be priced must not have its exit legs
 * booked either.
 */
class UnpricedFillError extends Error {
  readonly observation: UnpricedFillObservation;

  constructor(message: string, observation: UnpricedFillObservation) {
    super(message);
    this.name = 'UnpricedFillError';
    this.observation = observation;
  }
}

/**
 * The bracket's protective children, split by kind for the journal. Null where
 * Alpaca reports no such leg — which it legitimately does once a leg has been
 * cancelled — rather than an empty string standing in for "don't know".
 */
function legOrderIds(legs: AlpacaOrderLeg[] | undefined): {
  stop_order_id: string | null;
  target_order_id: string | null;
} {
  const all = legs ?? [];
  return {
    stop_order_id: all.find((leg) => legName(leg) === 'stop')?.id ?? null,
    target_order_id: all.find((leg) => legName(leg) === 'target')?.id ?? null,
  };
}

function legName(leg: AlpacaOrderLeg): 'target' | 'stop' {
  // The take-profit leg is a limit order; the stop-loss leg is a stop order.
  return leg.type === 'limit' ? 'target' : 'stop';
}

/**
 * `instrument` comes from the BRACKET PARENT, not from `order`: `AlpacaOrderLeg`
 * carries no `symbol`, and an alert that cannot name the symbol is not
 * actionable. A bracket's legs trade the parent's symbol by construction.
 */
function collectFill(
  order: AlpacaOrder | AlpacaOrderLeg,
  leg: NormalizedFill['leg'],
  clientOrderId: string,
  instrument: string,
  since: Date,
  fills: NormalizedFill[],
): void {
  const filledQty = Number.parseFloat(order.filled_qty);

  // `NaN <= 0` is FALSE, so an unparseable quantity ('', 'N/A', anything
  // non-numeric) would sail past the guard below and be booked as `qty: NaN` —
  // which then silently propagates through weighted-average pricing, realized
  // PnL and the R-multiple, poisoning every figure it touches without ever
  // failing. Checked before the ordering guard for exactly that reason.
  if (!Number.isFinite(filledQty)) {
    throw new Error(
      `Alpaca order ${order.id} (${leg} leg of '${clientOrderId}') reports an unparseable ` +
        `filled_qty '${order.filled_qty}'`,
    );
  }

  if (filledQty <= 0 || order.filled_at === null) {
    return;
  }

  const filledAt = new Date(order.filled_at);
  if (filledAt.getTime() < since.getTime()) {
    return;
  }

  // A positive filled quantity with no average price is Alpaca contradicting
  // itself, and there is no safe way to record it: a zero price is not a
  // conservative guess but a fabricated one, and it flows straight into
  // realized PnL, the R-multiple and the feedback loop's weighting — a lot
  // booked at 0 reads as a total loss or an infinite gain depending on side.
  // Same posture the ccxt adapter takes in `toFill`: refuse rather than
  // silently degrade, and let the poll retry once the venue is coherent.
  //
  // "Let the poll retry" is only half an answer, though, and the other half is
  // #298: if the venue NEVER prices this fill, retrying forever is silence.
  // The typed error carries what the caller needs to start an age-out clock on
  // it — refusing to book the fill and refusing to notice are different things.
  if (order.filled_avg_price === null) {
    throw new UnpricedFillError(
      `Alpaca order ${order.id} (${leg} leg of '${clientOrderId}') reports filled_qty ` +
        `${order.filled_qty} but no filled_avg_price to record`,
      {
        client_order_id: clientOrderId,
        broker_fill_id: order.id,
        leg,
        instrument,
        qty: filledQty,
      },
    );
  }

  fills.push({
    client_order_id: clientOrderId,
    broker_fill_id: order.id,
    leg,
    price: Number.parseFloat(order.filled_avg_price),
    qty: filledQty,
    // Alpaca is commission-free on US equities; crypto fee attribution is
    // deferred (out of scope for this ticket's entry/stop-out equities path).
    fee: 0,
    timestamp: filledAt,
  });
}

/**
 * Alpaca's crypto trading endpoints reject dash-form symbols outright — an
 * order for `'BTC-USD'` gets a `422 asset "BTC-USD" not found` (#550, PR
 * #584, empirically verified) — and only accept slash form (`'BTC/USD'`).
 * Equities are unaffected either way (`'AAPL'` has no separator to convert).
 *
 * This is the ONE seam that must translate: the rest of the system speaks
 * dash-form crypto exclusively (ADR-0001's `BrokerAdapter` abstraction;
 * `DEFAULT_UNIVERSE`/`SMOKE_TEST_UNIVERSE` in orchestrator/scheduler.ts and
 * orchestrator/production.ts both spell it `'BTC-USD'`/`'ETH-USD'`), and no
 * conversion existed anywhere in the trading path before this ticket. Mirrors
 * the already-verified conversion the market-data path independently arrived
 * at for the same reason (`toAlpacaCryptoSymbol`,
 * market-data-service/sources/alpaca-http-client.ts, #358) — same `-USD`
 * suffix rule, same believed-correct-because-verified posture. That path is
 * untouched by this change and does its own conversion on its own requests;
 * this function does not call it, to keep the two modules' seams independent.
 *
 * `submitBracket` carries an explicit `asset_class` on `NativeBracketRequest`
 * and is asked directly rather than guessing from the symbol's shape.
 * `submitFlatten`/`rearmProtectiveLegs` receive only a bare `instrument`
 * string on the `BrokerAdapter` interface — no `asset_class` alongside it —
 * so `assetClass` is `undefined` at those two call sites and this falls back
 * to the syntactic `-USD`-suffix rule.
 *
 * That fallback is safe for every instrument this adapter is configured to
 * ever see: `DEFAULT_UNIVERSE`/`SMOKE_TEST_UNIVERSE` list crypto ONLY as
 * `'BTC-USD'`/`'ETH-USD'` (both `-USD`-suffixed) and equities ONLY as bare
 * tickers with no separator at all (`'SPY'`, `'QQQ'`, `'AAPL'`, `'TSLA'`) — so
 * a `-USD` suffix unambiguously means crypto today. It would NOT misfire on a
 * dotted-class equity ticker such as `'BRK.B'` (no `-USD` suffix, so it
 * passes through unchanged) — the narrower "`-USD` suffix" test is
 * deliberately chosen over a broader "contains a dash" one for exactly this
 * reason, even though neither rule can currently be exercised by a dashed
 * equity ticker, since the configured universes have none. If a future
 * instrument violates either assumption (a `-USD`-suffixed equity, or a
 * crypto pair this adapter must submit through `submitFlatten`/
 * `rearmProtectiveLegs` without ever having gone through `submitBracket`
 * first), this must become explicit-list or asset-class-driven instead of
 * syntactic.
 */
function toAlpacaSymbol(instrument: string, assetClass?: 'crypto' | 'stocks'): string {
  const isCrypto = assetClass === undefined ? instrument.endsWith('-USD') : assetClass === 'crypto';
  if (!isCrypto || !instrument.endsWith('-USD')) return instrument;
  return `${instrument.slice(0, -'-USD'.length)}/USD`;
}

/**
 * The read-back inverse of `toAlpacaSymbol`: `'BTC/USD'` -> `'BTC-USD'`.
 * Applied to every symbol the venue hands back before it reaches anything
 * that compares it against, or stores it under, the repo's own instrument
 * identity — `getOpenPositions` (Risk's exposure caps, `reconcile()`'s
 * store-vs-venue diff) and `fetchNewFills`'s three `symbolOf` call sites
 * (bracket, flatten, re-arm sweeps), which feed the age-out alert an operator
 * reads. Nothing above this adapter's boundary may ever see Alpaca's slash
 * form — the same ADR-0001 abstraction `toAlpacaSymbol` documents above.
 *
 * Narrowed to a `/USD`-suffix test, mirroring `toAlpacaSymbol`'s own
 * `-USD`-suffix rule on the way out, rather than "contains a slash" — no
 * equity symbol Alpaca returns contains a `/` today, so a broader rule would
 * currently behave identically, but the narrower one is what keeps this
 * function from silently mangling a future non-crypto venue symbol that
 * happens to contain a `/` for some other reason (Alpaca has no such symbol
 * today; a hypothetical options contract or foreign-listing spelling might).
 * Review comment on PR #588.
 */
function fromAlpacaSymbol(symbol: string): string {
  return symbol.endsWith('/USD') ? `${symbol.slice(0, -'/USD'.length)}-USD` : symbol;
}

function mapOrderState(status: string): OrderState {
  switch (status) {
    case 'filled':
      return 'filled';
    case 'partially_filled':
      return 'partially_filled';
    case 'canceled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    // 'new' | 'accepted' | 'pending_new' | 'accepted_for_bidding' and any
    // other acknowledgement status: the bracket has landed at the venue but
    // nothing has filled yet, which is 'submitted' in our state machine.
    default:
      return 'submitted';
  }
}
