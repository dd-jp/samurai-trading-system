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
   * oversight, and why entries are never removed.
   */
  private readonly flattens = new Map<string, string>();
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
        symbol: instrument,
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
   * cancels a parent's children as part of cancelling the parent.
   *
   * Resolves rather than throwing when the venue has nothing under this id:
   * `getOrderByClientOrderId` returning null means it was never placed or is
   * long gone, and the transport treats `404`/`422` the same way. The caller
   * cannot know the venue's state at the instant it calls, and a cancel that
   * throws on "too late" fails precisely in the race it exists to handle.
   *
   * Resolves the Alpaca id through the venue rather than the local `brackets`
   * map, for `getOrder`'s reason: that map is populated only by `submitBracket`
   * in this process, so after a restart it is empty.
   */
  async cancel(clientOrderId: string, _instrument: string): Promise<void> {
    const order = await this.call('cancel', () =>
      this.input.client.getOrderByClientOrderId(clientOrderId),
    );
    if (order === null) return;

    await this.call('cancel', () => this.input.client.cancelOrder(order.id));
    this.brackets.delete(clientOrderId);
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
          instrument: position.symbol,
          qty,
          side: position.side === 'long' ? ('buy' as const) : ('sell' as const),
          avg_entry_price: Number.isFinite(avgEntry) ? avgEntry : null,
        },
      ];
    });
  }

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    const response = await this.call('submitBracket', () =>
      this.input.client.submitOrder({
        symbol: order.instrument,
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

        const instrument = symbolOf(entry);
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
          try {
            this.state.recordUnpricedFill('alpaca', error.observation, this.clock.now());
          } catch (stateError) {
            failures.push(stateError);
          }
        }
        failures.push(error);
        bracketFailures += 1;
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
    // Entries are never removed once a flatten resolves — deliberately
    // symmetric with `brackets`, which is likewise never pruned after a
    // bracket goes terminal (only `cancel()` removes an entry from either
    // map). A closed flatten costs one extra `getOrder` call per sweep for
    // the rest of the process's life, the same standing cost a
    // filled-and-closed bracket already has.
    let flattenFailures = 0;
    for (const [clientOrderId, orderId] of [...this.flattens]) {
      try {
        const order = await this.call('fetchNewFills', () => this.input.client.getOrder(orderId));
        collectFill(order, 'exit', clientOrderId, symbolOf(order), since, fills);
      } catch (error) {
        // Same isolation and same UnpricedFillError bookkeeping as the
        // bracket loop above — see its comments for the reasoning, which
        // applies unchanged here.
        if (error instanceof UnpricedFillError) {
          try {
            this.state.recordUnpricedFill('alpaca', error.observation, this.clock.now());
          } catch (stateError) {
            failures.push(stateError);
          }
        }
        failures.push(error);
        flattenFailures += 1;
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
          `(${bracketFailures} bracket(s), ${flattenFailures} flatten(s) failed); ` +
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
