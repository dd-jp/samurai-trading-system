/**
 * Alpaca BrokerAdapter (ticket #84) — see docs/specs/execution-spec.md
 * ("Module: Broker Abstraction"): the MVP paper/live-equities path. Alpaca's
 * native bracket order (`order_class: 'bracket'`) gives the atomic
 * entry + one-cancels-other stop/target guarantee natively — FOR EQUITIES.
 * Crypto rejects every advanced order class (verified live, #550), so the
 * crypto half of the universe is emulated instead (#586):
 * `AlpacaCryptoLegEmulation` (alpaca-crypto-emulation.ts) keeps the same
 * guarantee by hand, journalled in `broker_brackets`, invisible above the
 * `BrokerAdapter` seam.
 *
 * The Alpaca trading client is injected (`AlpacaBrokerClient`), mirroring the
 * injected-client pattern already used for market data
 * (server/providers/market-data-service/sources/alpaca-source.ts): connection/auth is an
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
  type Logger,
  logCaughtFailure,
  SystemClock,
  TokenBucket,
} from '../../../shared/index.js';
import { sanitizeBrokerError } from '../broker-error.js';
import {
  type BrokerStateStore,
  InMemoryBrokerStateStore,
  toRequestFields,
  type UnpricedFillRecord,
} from '../broker-state-store.js';
import type { OcoDoubleFillAlertChannel } from '../oco-double-fill-alert.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../types.js';
import type { UnpricedFillAlertChannel } from '../unpriced-fill-alert.js';
import type { AlpacaBrokerClient, AlpacaOrder, AlpacaOrderLeg } from './alpaca-client.js';
import { AlpacaCryptoLegEmulation } from './alpaca-crypto-emulation.js';
// The shared normalization layer (PR #600 review): both this adapter and the
// crypto emulation consume it, and neither imports the other's runtime code
// back — the module split is what keeps that an acyclic graph.
import {
  collectFill,
  fromAlpacaSymbol,
  mapOrderState,
  toAlpacaSymbol,
  UnpricedFillError,
} from './alpaca-order-normalization.js';

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

/**
 * `LogEntry.trace_id` for every `fetchNewFills` failure this adapter logs
 * (#609). This adapter receives no per-call trace id the way `ExecutionInput`
 * does (`trace_id` there is threaded from `FILL_SYNC_TRACE_ID`/
 * `RECONCILE_TRACE_ID` — see that field's doc) — `BrokerAdapter.fetchNewFills`
 * takes only `since`, and importing an orchestrator-level constant into this
 * adapter would invert the module layering. A fixed, adapter-owned id is the
 * cheaper answer: every line this adapter ever logs is already scoped to
 * "the Alpaca fill sweep" by construction, so there is no second axis worth
 * threading one for.
 */
const ALPACA_FILL_SWEEP_TRACE_ID = 'alpaca-fetch-new-fills';

export interface AlpacaBrokerAdapterInput {
  client: AlpacaBrokerClient;
  /**
   * Optional so existing wiring (server/apps/orchestrator/production.ts) keeps
   * working; when absent the adapter still paces itself rather than running
   * unlimited — see the default below.
   */
  rateLimiter?: TokenBucket;
  /**
   * Durable home for the bracket index (#287). Optional for the same
   * compatibility reason as `rateLimiter`, but the two defaults are not
   * equivalent: that one is merely conservative, whereas the in-memory default
   * here IS the #295 bug. server/apps/orchestrator/production.ts injects
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
   * Where an emulated crypto OCO whose protective legs BOTH filled is
   * escalated (#586) — the double-fill window the owner accepted when
   * choosing emulation over Alpaca's crypto-rejected native order classes.
   * REQUIRED for `unpricedFillAlerts`' exact reason: the one seam whose
   * absence IS the failure mode does not get an optional default. See
   * oco-double-fill-alert.ts.
   */
  ocoDoubleFillAlerts: OcoDoubleFillAlertChannel;
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
  /**
   * Where a `fetchNewFills` sweep failure becomes locally diagnosable (#609)
   * — the same port-level decision #573 made on `ExecutionInput.logger`, and
   * for the same reason: `fetchNewFills`'s per-source `failures` array
   * (bracket/flatten/rearm broker errors, `recordUnpricedFill`/
   * `clearUnpricedFill` journal-write failures, the unpriced-fill alert
   * fallback's own delivery failure) was accumulated but had nowhere local to
   * go, so it was silently dropped on EVERY poll where the same sweep also
   * read a fill from another source — close to always on a live
   * multi-instrument universe (see the throw gate's own comment in
   * `fetchNewFills`).
   *
   * `AlpacaBrokerAdapterInput` is a DIFFERENT port from `ExecutionInput`
   * (`ingestFills()` calls this adapter, not the reverse — #608's sibling
   * enumeration recorded that as the reason this was filed as its own
   * ticket rather than folded into #573), so this is a second, independent
   * instance of the same decision, not a reuse of the field. It resolves the
   * same way: REQUIRED, not optional. An omitted seam at a composition root
   * is this repo's dominant defect class (`unpricedFillAlerts`/
   * `ocoDoubleFillAlerts` above already refuse a silent default for the
   * identical reason), and `production.ts` already builds one `logger` above
   * this adapter's construction site and now passes it through rather than
   * gaining a second, unrecorded one.
   *
   * Safe inside a catch, structurally: every call site here routes through
   * `logCaughtFailure` (`shared/safe-log.ts`), never `logger.log` directly,
   * so a throwing injected `Logger` cannot escape and re-open the very
   * abort blast radius #569/#573 closed on the execution port.
   */
  logger: Logger;
}

export class AlpacaBrokerAdapter implements BrokerAdapter {
  /** client_order_id -> the bracket parent's Alpaca order id. */
  private readonly brackets = new Map<string, string>();
  /**
   * client_order_id -> the flatten's own Alpaca order id (#517), tracked
   * in-memory only — see `fetchNewFills`'s "flatten sweep" comment for the
   * full rationale: why this is a SEPARATE map from `brackets`, and why
   * (UNLIKE `brackets`) an entry here is pruned once its order goes
   * terminal, rather than kept for the process lifetime.
   *
   * A restart still empties this map, same as before #519/#526 — what
   * changed is that it is no longer the ONLY way an entry gets in: this
   * process's OWN `submitFlatten` calls still populate it directly, and
   * `resumeFlatten` (below) re-populates it for an entry a PRIOR process
   * submitted, driven by `reconcile()`'s `flatten_submissions` sweep. The map
   * itself stays in-memory-only by design (`resumeFlatten`'s doc) — durability
   * lives in the journal, not in a second copy of this cache.
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
  /**
   * The crypto path (#586): Alpaca rejects every advanced order class for
   * crypto (verified live, #550), so crypto brackets are emulated — plain
   * entry, plain protective legs armed on the entry fill, sibling cancelled
   * by the sweep — with every transition journalled in the SAME
   * `BrokerStateStore` this adapter's native index uses. The file-top claim
   * that "this adapter does no OCO emulation of its own" is therefore now
   * equities-only.
   */
  private readonly emulation: AlpacaCryptoLegEmulation;
  /** #609 — see `AlpacaBrokerAdapterInput.logger`'s doc for why this has no default. */
  private readonly logger: Logger;

  constructor(private readonly input: AlpacaBrokerAdapterInput) {
    this.rateLimiter = input.rateLimiter ?? new TokenBucket(DEFAULT_VENUE_PACING.alpaca);
    this.state = input.state ?? new InMemoryBrokerStateStore();
    this.clock = input.clock ?? new SystemClock();
    this.unpricedFillAgeOutMs = input.unpricedFillAgeOutMs ?? DEFAULT_UNPRICED_FILL_AGE_OUT_MS;
    this.logger = input.logger;

    this.emulation = new AlpacaCryptoLegEmulation({
      client: input.client,
      state: this.state,
      clock: this.clock,
      call: (operation, fn) => this.call(operation, fn),
      doubleFillAlerts: input.ocoDoubleFillAlerts,
    });

    // Synchronous, in the constructor: the first `fetchNewFills` sweep after a
    // restart iterates this map, and an empty one reports "no new fills" —
    // indistinguishable, above the adapter, from a quiet market.
    for (const record of this.state.loadBrackets('alpaca')) {
      // Emulated crypto rows belong to the emulation, which rehydrated them
      // in its own constructor above — polling them here too would sweep the
      // same orders twice and drive no state machine.
      if (record.request?.asset_class === 'crypto') continue;
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
    // An emulated crypto bracket has no parent whose cancellation takes the
    // legs with it — the legs are independent plain orders only the
    // emulation's journal knows the ids of (#586). Delegated wholesale; the
    // `:rearm` lookup below is the EQUITY OCO's naming scheme and does not
    // apply (emulated re-arm legs are cancelled by the same journal walk).
    if (this.emulation.owns(clientOrderId)) {
      await this.emulation.cancelAll(clientOrderId);
      return;
    }

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
   * VERIFIED 2026-08-07 against live Alpaca paper (#550): crypto rejects
   * `order_class: 'bracket'` outright — `422 {"code":42210000,"message":
   * "crypto orders not allowed for advanced order_class: otoco"}` — so a
   * crypto instrument NEVER takes the native path below. It routes to the
   * emulation (#586, owner's recorded option (a)): a plain limit entry now,
   * the two protective legs journalled and armed as plain crypto orders once
   * the fill sweep observes the entry fill, the sibling cancelled by the
   * sweep when one leg fires. Same `BrokerAck` above the seam either way.
   * Symbol-conversion fix: #585.
   */
  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    if (order.asset_class === 'crypto') {
      return this.emulation.submitEntry(order);
    }

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

    // An emulated crypto bracket (#586) is already journalled and swept by
    // the emulation — re-populating the native map here would double-poll it
    // and stamp native-shaped ids over emulation state. The venue's answer
    // about the ENTRY still stands; the leg ids come from the journal, since
    // a plain crypto entry carries no `legs` for `legOrderIds` to read.
    if (this.emulation.owns(clientOrderId)) {
      return {
        client_order_id: clientOrderId,
        broker_order_ids: this.emulation.brokerOrderIds(clientOrderId),
        order_state: mapOrderState(order.status),
        filled_qty: Number.parseFloat(order.filled_qty),
      };
    }

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

    return normalizeOrder(clientOrderId, order);
  }

  /**
   * The flatten-sweep counterpart of `getOrder` (#519, #526) — see
   * `BrokerAdapter.resumeFlatten`'s doc (types/broker.ts) for the null/throw
   * contract and why this is a separate method rather than a second call
   * into `getOrder`.
   *
   * Re-populates `flattens`, NOT `brackets` — the whole reason this exists
   * as its own method. The very next `fetchNewFills` sweep then polls this
   * order through the ordinary flatten loop, which prices whatever fill it
   * finds (or none) and prunes the entry itself once the order goes
   * terminal, exactly as it already does for a flatten this SAME process
   * submitted — this method only has to get the order id back into that map,
   * not duplicate any of what happens to it afterward.
   *
   * NOT written to `this.state` (the durable bracket index), for
   * `submitFlatten`'s own reason: a flatten has no legs to arm or resize,
   * and half-formed bracket-shaped state for one is the wrong shape
   * (migration 0019's comment).
   */
  async resumeFlatten(clientOrderId: string, _instrument: string): Promise<NormalizedOrder | null> {
    const order = await this.call('resumeFlatten', () =>
      this.input.client.getOrderByClientOrderId(clientOrderId),
    );
    if (order === null) return null;

    this.flattens.set(clientOrderId, order.id);

    return normalizeOrder(clientOrderId, order);
  }

  /**
   * A no-op on BOTH paths, for different reasons. Equities: Alpaca's native
   * bracket attaches the protective legs to the parent entry, so the venue
   * keeps their quantity in step as the parent fills, and re-sizing from
   * here would fight the venue over leg quantity. Emulated crypto (#586):
   * the emulation arms its legs only once the entry goes TERMINAL, sized to
   * the entry's final cumulative fill — so by the time legs exist there is
   * no later entry fill left to resize for, and before they exist there is
   * nothing to resize. The honest cost of that design is a window where a
   * PARTIALLY-filled, still-working crypto entry holds quantity with no legs
   * armed yet; closing it would mean arming early and re-arming per fill
   * (ccxt's resize path), which is #549-adjacent work, not this seam's.
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
   * VERIFIED 2026-08-07 against live Alpaca paper (#550), fixed here (#586):
   * (1) the previous wire shape put the take-profit price at the TOP LEVEL,
   * which Alpaca rejects for EVERY asset class — `422 {"code":40010001,
   * "message":"oco orders require take_profit.limit_price"}` on both
   * `BTC/USD` and `SPY`; the price is now nested under `take_profit`, the
   * verified-required shape. (2) crypto is separately rejected at the
   * order-class level — `422 {"code":42210000,"message":"crypto orders not
   * allowed for advanced order_class: oco"}` — so a crypto residual never
   * reaches `submitOcoOrder` at all: it takes the emulated path (two plain
   * orders on a fresh journalled arming episode; see
   * `AlpacaCryptoLegEmulation.rearm`, whose leg ids and sweep the emulation
   * owns end to end — nothing lands in `rearmedLegs`, which stays the
   * EQUITY OCO's index). A crypto residual whose bracket the journal does
   * not know refuses (throws) rather than guessing, and the caller's #525
   * fallback alert fires — the contract's required posture.
   */
  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void> {
    // `owns` is the authoritative test (the journal knows every emulated
    // bracket, durably); the syntactic `-USD` fallback catches the crypto
    // residual whose journal row is missing, which must REFUSE loudly
    // rather than fall through to an order class the venue is verified to
    // reject — a thrown 422 here would read as a transient venue error.
    if (this.emulation.owns(clientOrderId)) {
      return this.emulation.rearm(clientOrderId, instrument, side, qty, stop, target);
    }
    if (instrument.endsWith('-USD')) {
      throw new Error(
        `Alpaca adapter cannot re-arm crypto residual '${clientOrderId}' (${instrument}): no ` +
          'journalled emulated bracket exists for this lot, and the native OCO order class is ' +
          'rejected for crypto (verified, #550). The residual stays alert-only.',
      );
    }

    const rearmClientOrderId = `${clientOrderId}:rearm`;

    // ADOPT-OR-PLACE (#549, the #600/#603 posture): the wire id above is
    // deterministic, so before submitting, ask the venue whether a prior
    // attempt's OCO already lives under it — a re-arm that succeeded
    // venue-side and then crashed (or lost its journaling) before the caller
    // could confirm it would otherwise be DOUBLE-submitted by the
    // residual-protection sweep's retry, or (Alpaca rejecting the duplicate
    // client_order_id) read as a fresh failure and page the operator about a
    // residual that is in fact protected.
    //
    // Adoption is CONDITIONAL on the prior matching THIS request (#549
    // review): the wire id is per-lot and reused across attempts, so a
    // still-resting prior sized for a DIFFERENT residual (further exit fills
    // landed between the crashed attempt and this retry) must not be treated
    // as confirmed protection — an oversized stop over-closes into a reverse
    // position, the exact #516 hazard. A resting mismatch is CANCELLED here
    // and the fresh place below replaces it; only `qty` can genuinely drift
    // (the contract fixes `stop`/`target` to the lot's own unchanged
    // levels), but all three are compared, and a prior whose price fields
    // are missing fails the match — replacing real protection costs a
    // round-trip, adopting stale protection costs money.
    //
    // A `filled` OR `partially_filled` prior is adopted regardless of the
    // match (#549 review): an OCO's fills are EXIT fills — every share it
    // filled has already closed that much of the position — so what remains
    // resting (`qty − filled_qty`) is exactly what that episode still holds.
    // The caller's `residual` is computed off the STORE, which has not
    // necessarily ingested those very fills yet (the re-arm sweep in
    // `fetchNewFills` below is what offers them), so a partially-consumed
    // prior would compare against a stale figure: cancel-and-replace sized
    // to that figure would re-arm quantity that is already closed —
    // over-protection, whose leg fires into a smaller position and opens a
    // reverse one (#516's hazard, from the other direction). Once the fills
    // DO ingest, the recomputed residual and the prior's resting remainder
    // agree by construction. A `cancelled`/`rejected`/`expired` prior
    // protects nothing, so the code falls through and places afresh — if
    // the venue then refuses the reused client_order_id, that throw is the
    // honest answer and takes the caller's existing alert path.
    //
    // ADOPTION IS ALLOWLISTED on the RAW venue status (#549 review, round 3):
    // `mapOrderState` folds every unrecognized status — `done_for_day`,
    // `replaced`, `stopped`, `pending_cancel`... — into 'submitted', so a
    // blocklist of dead states would let a matching-but-not-resting prior be
    // adopted as protection while nothing rests at the venue: exactly the
    // naked-residual-believed-protected hazard this method exists to close.
    // Only statuses that mean RESTING may satisfy the match branch; anything
    // unrecognized takes the cancel-and-replace path, where `cancelOrder`'s
    // tolerance of already-terminal orders makes the defensive cancel free.
    const RESTING_STATUSES = ['new', 'accepted', 'pending_new', 'accepted_for_bidding'];
    const prior = await this.call('rearmProtectiveLegs', () =>
      this.input.client.getOrderByClientOrderId(rearmClientOrderId),
    );
    if (
      prior !== null &&
      !['cancelled', 'rejected', 'expired'].includes(mapOrderState(prior.status))
    ) {
      const priorState = mapOrderState(prior.status);
      if (
        priorState === 'filled' ||
        priorState === 'partially_filled' ||
        (RESTING_STATUSES.includes(prior.status) && rearmOrderMatches(prior, qty, stop, target))
      ) {
        this.rearmedLegs.set(clientOrderId, prior.id);
        // Same column semantics as the fresh-place path below — the OCO's
        // parent id IS the take-profit (see that path's `.legs` note).
        this.state.recordBracketOrderIds('alpaca', clientOrderId, {
          entry_order_id: null,
          stop_order_id: legOrderIds(prior.legs).stop_order_id,
          target_order_id: prior.id,
        });
        return;
      }
      // Live but stale-sized: retire it before placing the right-sized
      // replacement. `cancelOrder` resolves on 404/422 (already-terminal),
      // so losing the race to the prior's own fill is not a failure here —
      // the replacement submit below is what would surface a real problem.
      await this.call('rearmProtectiveLegs', () => this.input.client.cancelOrder(prior.id));
    }

    // The CLOSING side, mirroring `submitFlatten`'s own convention — `side`
    // here is the lot's HELD side (the `BrokerAdapter.rearmProtectiveLegs`
    // contract), so the order that reduces it takes the opposite one.
    const closingSide = side === 'buy' ? 'sell' : 'buy';

    const response = await this.call('rearmProtectiveLegs', () =>
      this.input.client.submitOcoOrder({
        symbol: toAlpacaSymbol(instrument),
        side: closingSide,
        qty: String(qty),
        time_in_force: 'gtc',
        client_order_id: rearmClientOrderId,
        order_class: 'oco',
        take_profit: { limit_price: String(target) },
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
    // running.
    //
    // THAT WINDOW IS NOW CLOSED, not by this map becoming durable, but by
    // `reconcile()` learning about `flatten_submissions` rows (#519/#526):
    // on startup (and whenever `reconcile()` next runs), it reads every
    // unresolved journal row and calls `resumeFlatten` for each, which
    // re-populates THIS map from the venue's own record of the order —
    // see `resumeFlatten`'s doc above. A crash inside the window still
    // empties this map exactly as before; what changed is that the map is no
    // longer the only place that memory lived.
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
    // already gone.
    //
    // #519/#526 close this ACROSS A RESTART: `flatten_submissions`'s
    // `fills_swept_at` (migration 0023) is deliberately NOT set by
    // `ingestFills()` merely because a raw fill was observed — only once
    // every lot the flatten named has durably applied its share — so THIS
    // exact failure leaves the journal row unresolved, and the next
    // `reconcile()` pass's `resumeFlatten` call re-adds the order here for
    // another attempt. What stays open is the WITHIN-PROCESS gap: this
    // codebase has no recurring `reconcile()` cadence today (it runs at
    // startup only — see orchestrator/fill-sync.ts's file doc), so a fill
    // lost this way is not re-offered until the next restart, not the next
    // poll. Adding a cadence is a scheduling decision out of scope for
    // either ticket; the mechanism here is ready for one whenever it exists.
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

    // The emulated-crypto sweep (#586) — polls each emulated bracket's plain
    // entry/stop/target orders, offers their fills (tagged 'entry'/'stop'/
    // 'target' under the lot's own key, so `ingestFills()`'s ordinary
    // routing books them with no knowledge an emulation exists), and drives
    // the journalled phase machine: arm the legs on the entry fill, cancel
    // the sibling when one leg fires, resume any episode a dead process left
    // mid-transition. Isolation and UnpricedFillError bookkeeping are the
    // same as the three loops above — see the emulation module.
    const emulationFailures = await this.emulation.sweep(since, fills, failures);

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

    // #609: make every accumulated failure locally diagnosable BEFORE the
    // throw/return split below decides — that split is exactly where the bug
    // lived: on any poll where `fills.length > 0`, `failures` fell out of
    // scope entirely unreported (a `recordUnpricedFill`/`clearUnpricedFill`
    // journal-write failure, a non-`UnpricedFillError` broker error on one
    // bracket/flatten/rearm, `escalateAgedUnpricedFills`'s own named
    // alert-delivery replacement), which on a live multi-instrument universe
    // is close to always. Logging here, unconditionally on `failures.length`,
    // fixes exactly that: a clean sweep (`failures.length === 0`) logs
    // nothing, and a partial success — fills read from one source, a failure
    // on another — now emits one line per failure regardless of whether the
    // sweep goes on to throw below. Diagnosis-only: this does not change what
    // `fetchNewFills` returns or whether it throws, only whether a failure
    // that already happened leaves a local trace. `logCaughtFailure` is the
    // same safe-inside-a-catch helper #573 wired onto `ExecutionInput`.
    for (const failure of failures) {
      logCaughtFailure(
        this.logger,
        {
          trace_id: ALPACA_FILL_SWEEP_TRACE_ID,
          stage: 'execution',
          level: 'error',
          message: 'Alpaca fetchNewFills: per-source failure',
        },
        failure,
        {
          // Batching at this one discard point (rather than #573's per-catch
          // style) loses which of the four loops this failure came from — all
          // four funnel through the same `this.call('fetchNewFills', ...)`
          // operation name. These counts restore that, and `fills_read` is the
          // one that names the #609 case specifically: >0 here is exactly the
          // "fills.length > 0 discarded failures silently" bug this fixes.
          bracket_failures: bracketFailures,
          flatten_failures: flattenFailures,
          rearm_failures: rearmFailures,
          emulation_failures: emulationFailures,
          fills_read: fills.length,
        },
      );
    }

    // Progress wins when there is any: dropping good fills to report a bad
    // bracket would re-create the account-wide stall this isolation removes.
    // A wholly-failed sweep is the one case where throwing costs nothing — and
    // it must not be reported as the "no new fills" that an empty array means.
    if (fills.length === 0 && failures.length > 0) {
      throw new AggregateError(
        failures,
        `Alpaca fetchNewFills: ${failures.length} failure(s) during the sweep ` +
          `(${bracketFailures} bracket(s), ${flattenFailures} flatten(s), ` +
          `${rearmFailures} rearm(s), ${emulationFailures} emulated crypto bracket(s) failed); ` +
          'no fills could be read',
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
 * The bracket's protective children, split by kind for the journal. Null where
 * Alpaca reports no such leg — which it legitimately does once a leg has been
 * cancelled — rather than an empty string standing in for "don't know".
 */
/**
 * Whether a prior re-arm OCO found under the deterministic `:rearm` wire id
 * protects exactly what THIS attempt would place (#549 review) — same `qty`,
 * same take-profit limit (the OCO's TOP-LEVEL `limit_price` — an OCO's
 * take-profit is the parent order itself, `rearmProtectiveLegs`' own `.legs`
 * note), same stop trigger on the stop child. Field comparisons are
 * `Number(...) === value`: the request stringified these exact numbers on the
 * way out (`String(qty)` etc.), and JS number->string->number round-trips
 * losslessly, so a genuine match compares exactly. A prior missing any price
 * field (Alpaca always returns them; a partial double might not) FAILS the
 * match — replacing real protection costs one round-trip, adopting
 * unverifiable protection costs money.
 */
function rearmOrderMatches(prior: AlpacaOrder, qty: number, stop: number, target: number): boolean {
  if (Number(prior.qty) !== qty) return false;
  if (prior.limit_price == null || Number(prior.limit_price) !== target) return false;
  const stopLeg = prior.legs?.find((leg) => leg.type === 'stop');
  if (stopLeg?.stop_price == null || Number(stopLeg.stop_price) !== stop) return false;
  return true;
}

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

/**
 * The shared normalization `getOrder`/`resumeFlatten` both apply to a raw
 * Alpaca order — factored out because the two methods diverge only in WHICH
 * in-process map they warm on the way out (`brackets` vs `flattens`), never
 * in the shape returned to the caller.
 */
function normalizeOrder(clientOrderId: string, order: AlpacaOrder): NormalizedOrder {
  return {
    client_order_id: clientOrderId,
    broker_order_ids: [order.id, ...(order.legs ?? []).map((leg) => leg.id)],
    order_state: mapOrderState(order.status),
    filled_qty: Number.parseFloat(order.filled_qty),
  };
}

function legName(leg: AlpacaOrderLeg): 'target' | 'stop' {
  // The take-profit leg is a limit order; the stop-loss leg is a stop order.
  return leg.type === 'limit' ? 'target' : 'stop';
}
