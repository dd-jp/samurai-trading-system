/**
 * Alpaca BrokerAdapter — the paper/live-equities path (docs/specs/execution-spec.md).
 * Native `order_class: 'bracket'` gives atomic entry + OCO stop/target for
 * equities; crypto rejects it (#550) and is emulated instead via `AlpacaCryptoLegEmulation`.
 */
import {
  type Clock,
  DEFAULT_VENUE_PACING,
  type Logger,
  logCaughtFailure,
  SystemClock,
  safeLog,
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
import { ProtectiveRearmUnsupportedError } from '../protective-rearm-unsupported.js';
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
// Shared by this adapter and the crypto emulation — the module split keeps
// the import graph acyclic (PR #600 review).
import {
  collectFill,
  fromAlpacaSymbol,
  mapOrderState,
  resolveFilledAt,
  toAlpacaSymbol,
  UnpricedFillError,
} from './alpaca-order-normalization.js';
import {
  formatTickPrice,
  roundBracketToTick,
  roundProtectiveLegsToTick,
} from './us-equity-price-tick.js';

/**
 * 15 minutes, against a 15-second fill poll (`DEFAULT_FILL_POLL_INTERVAL_MS`):
 * ~60 consecutive unpriced polls before a stuck fill is escalated (#298).
 * Overridable via `AlpacaBrokerAdapterInput.unpricedFillAgeOutMs`.
 */
export const DEFAULT_UNPRICED_FILL_AGE_OUT_MS = 15 * 60_000;

/**
 * Fixed trace id for every `fetchNewFills` failure (#609): this adapter gets no
 * per-call trace id, and importing an orchestrator-level constant would invert
 * module layering.
 */
const ALPACA_FILL_SWEEP_TRACE_ID = 'alpaca-fetch-new-fills';

/**
 * Wire ids a lot's re-arms may consume before refusing. MEASURED 2026-09-15
 * (#1346, docs/research/43 round 3): Alpaca refuses a reused `client_order_id`
 * PERMANENTLY, so each cancelled re-arm burns its id for good. Indexed from
 * zero (`4` = attempts `0..3`).
 */
const MAX_REARM_ATTEMPTS = 4;

/**
 * Attempt 0 keeps the bare `:rearm` suffix so an OCO placed before #1346 is
 * still found by the walks below. One colon only, so no splitter mistakes
 * which half is the lot key.
 */
const rearmWireId = (clientOrderId: string, attempt: number): string =>
  attempt === 0 ? `${clientOrderId}:rearm` : `${clientOrderId}:rearm-${attempt}`;

/**
 * Which attempt a venue row's `client_order_id` belongs to, or null. Exact
 * match, not `startsWith`: a prefix can also match a different lot whose key
 * begins with this one.
 */
const rearmAttemptOf = (clientOrderId: string, wireId: string): number | null => {
  for (let attempt = 0; attempt < MAX_REARM_ATTEMPTS; attempt += 1) {
    if (rearmWireId(clientOrderId, attempt) === wireId) return attempt;
  }
  return null;
};

export interface AlpacaBrokerAdapterInput {
  client: AlpacaBrokerClient;
  /** Optional for backward compat; when absent the adapter paces itself — see default below. */
  rateLimiter?: TokenBucket;
  /**
   * Durable home for the bracket index (#287) — in-memory default IS the #295
   * bug. Persisted because `reconcile()` only re-caches still-in-flight lots,
   * so a `partially_filled` lot's exit legs would otherwise never be polled again.
   */
  state?: BrokerStateStore;
  /**
   * Where a permanently-unpriced fill is escalated (#298). REQUIRED, not
   * optional — an optional channel is exactly how the signal goes missing.
   * Log-only is a legitimate implementation; silence is not.
   */
  unpricedFillAlerts: UnpricedFillAlertChannel;
  /**
   * Where an emulated crypto OCO whose protective legs BOTH filled is
   * escalated (#586). REQUIRED for the same reason as `unpricedFillAlerts`.
   */
  ocoDoubleFillAlerts: OcoDoubleFillAlertChannel;
  /** How long a fill may stay unpriced before escalation. Defaults to `DEFAULT_UNPRICED_FILL_AGE_OUT_MS`. */
  unpricedFillAgeOutMs?: number;
  /** Age-out clock, injected so tests can age a fill without sleeping. Defaults to `SystemClock`. */
  clock?: Clock;
  /**
   * Where a `fetchNewFills` sweep failure becomes diagnosable (#609). REQUIRED:
   * an optional default previously let failures drop silently. Routes through
   * `logCaughtFailure`, so a throwing `Logger` cannot escape.
   */
  logger: Logger;
}

/** One by-client-order-id lookup's outcome: the venue's answer, or why there is none */
type LookedUpOrderId = { id: string | null } | { error: unknown };

export class AlpacaBrokerAdapter implements BrokerAdapter {
  /** client_order_id -> the bracket parent's Alpaca order id */
  private readonly brackets = new Map<string, string>();
  /**
   * client_order_id -> local clock read taken before `submitBracket`'s POST.
   * Proxy for `opened_at` (unavailable here, #1123) — flags but never clamps a
   * fill dated earlier. First-write-wins; unlike `brackets`, never deleted.
   */
  private readonly bracketSubmittedAt = new Map<string, Date>();
  /**
   * `${client_order_id}:${leg}` -> already logged (#1123 throttle). Keyed by
   * lot+leg, not lot alone: a lot-only key would let one leg's first warning
   * permanently suppress a genuine violation on a different leg of the same lot.
   */
  private readonly warnedSinceFloorViolations = new Set<string>();
  /**
   * client_order_id -> the flatten's own Alpaca order id (#517), in-memory only.
   * Separate from `brackets`: pruned once terminal (a flatten never rests again),
   * unlike a bracket which can keep mattering after its entry fills.
   */
  private readonly flattens = new Map<string, string>();
  /**
   * Exit's own client_order_id -> local clock read before `submitFlatten`'s
   * POST — the flatten counterpart of `bracketSubmittedAt` (#1415), on a
   * different key space since a flatten mints its own id. Pruned alongside `flattens`.
   */
  private readonly flattenSubmittedAt = new Map<string, Date>();
  /**
   * lot's `idempotency_key` -> the re-armed OCO's Alpaca order id (#525). Keyed
   * by the LOT, not the OCO's own wire id, so fills land in `ingestFills()`'s
   * ordinary bucket. In-memory only — a restart before the fill loses visibility.
   */
  private readonly rearmedLegs = new Map<string, string>();
  /**
   * Fallback for direct construction only — production always injects
   * `rateLimiter` explicitly (#299, see `DEFAULT_VENUE_PACING.alpaca`).
   */
  private readonly rateLimiter: TokenBucket;
  private readonly state: BrokerStateStore;
  private readonly clock: Clock;
  private readonly unpricedFillAgeOutMs: number;
  /**
   * Crypto path (#586): Alpaca rejects every advanced order class for crypto
   * (#550), so brackets are emulated — journalled in the same `BrokerStateStore`
   * the native index uses.
   */
  private readonly emulation: AlpacaCryptoLegEmulation;
  /** #609 — see `AlpacaBrokerAdapterInput.logger`'s doc for why this has no default */
  private readonly logger: Logger;

  constructor(private readonly input: AlpacaBrokerAdapterInput) {
    // Fallback for standalone construction (#1083); telemetry wired here too
    // so that path isn't silently worse-observed than production's.
    this.rateLimiter =
      input.rateLimiter ??
      new TokenBucket(DEFAULT_VENUE_PACING.alpaca, undefined, {
        logger: input.logger,
        name: 'alpaca',
      });
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

    // Synchronous: an empty map after restart reads as "no new fills," which
    // is indistinguishable above the adapter from a quiet market.
    for (const record of this.state.loadBrackets('alpaca')) {
      // Emulated crypto rows are rehydrated by the emulation's own constructor
      // above — polling them here too would sweep the same orders twice.
      if (record.request?.asset_class === 'crypto') continue;
      if (record.entry_order_id === null) continue;
      this.brackets.set(record.client_order_id, record.entry_order_id);
    }
  }

  /**
   * Single door to the injected client: paces, then converts errors.
   * Alpaca's REST errors quote the failed request, including the
   * `APCA-API-KEY-ID` header — `sanitizeBrokerError` strips that before it
   * reaches a logged `ExecutionResult.reason`.
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
   * Plain market order, never a bracket (#429). `ioc` is the one time_in_force
   * Alpaca accepts for a market order on both equities and crypto. Tracked only
   * in `flattens` (#517), not `this.state` — a flatten has no legs to arm.
   */
  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    // Read before the POST, not after — see `flattenSubmittedAt`'s doc comment
    const submittedAt = this.clock.now();
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
    // First-write-wins — see `flattenSubmittedAt`'s doc comment
    if (!this.flattenSubmittedAt.has(clientOrderId)) {
      this.flattenSubmittedAt.set(clientOrderId, submittedAt);
    }

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [response.id],
      order_state: mapOrderState(response.status),
    };
  }

  /**
   * Cancels the order, its bracket legs, and any re-armed residual OCO (#525) —
   * the latter lives under a derived `rearmWireId`, a different client order
   * id, so without this second lookup a re-armed OCO would stay live at the
   * venue and fire into whatever this cancel is clearing the way for (#516).
   *
   * Resolves rather than throwing when the venue has nothing under an id —
   * "never placed" and "long gone" are indistinguishable to the caller, and a
   * cancel that throws on "too late" fails in the exact race it must handle.
   * A genuine transport/auth failure still propagates: `executeExit` must not
   * send a flatten while it's unknown whether the legs it depends on are gone.
   *
   * ORDER IS LOAD-BEARING (#867): every lookup happens before any destructive
   * call, and the re-arm cancels before the original bracket — safe only
   * because the two are never both live (`rearmProtectiveLegs` is only
   * reached downstream of that bracket's own successful cancel). Anyone
   * reordering these two cancels must re-check that precondition first.
   *
   * Resolves the bracket's id through the venue, not the local `brackets` map
   * (empty after a restart — see `getOrder`). The re-armed OCO checks the
   * cheap in-process `rearmedLegs` first, falling back to the same venue
   * lookup by the derived id for one placed before a restart.
   */
  async cancel(clientOrderId: string, _instrument: string): Promise<void> {
    // Emulated crypto legs are independent plain orders only the emulation's
    // journal knows (#586) — delegated wholesale; the re-arm lookup below is
    // the equity OCO's naming scheme and doesn't apply here.
    if (this.emulation.owns(clientOrderId)) {
      await this.emulation.cancelAll(clientOrderId);
      return;
    }

    const { order, rearmedOrder } = await this.resolveCancelTargets(clientOrderId);

    if (rearmedOrder !== null) {
      await this.call('cancel', () => this.input.client.cancelOrder(rearmedOrder));
      // Deleted only after the cancel confirms — a throw above must leave
      // this map matching the venue, so a retry finds the same order again.
      this.rearmedLegs.delete(clientOrderId);
    }

    if (order !== null) {
      await this.call('cancel', () => this.input.client.cancelOrder(order));
      this.brackets.delete(clientOrderId);
    }
  }

  /**
   * Both Alpaca order ids `cancel()` may have to cancel — the original and the
   * NEWEST of its lot's re-arm wire ids (#1346: a lot that re-armed more than
   * once has spent more than one) — or `null` each where the venue has no such
   * open order.
   * Every call in here is a LOOKUP, so the whole method sits above `cancel()`'s
   * first destructive call and a throw from it leaves the lot fully protected
   * (#867).
   *
   * #1500: the by-client-order-id lookup is not the only way in. That endpoint
   * failing is precisely the state `reconcile()`'s never-confirmed flatten
   * branch exists for — it is reached BECAUSE `resumeFlatten` threw, and
   * `resumeFlatten` is the same `getOrderByClientOrderId` call — so a `cancel()`
   * that could only address the venue through it would throw for the same
   * reason every time, and that branch could never fire on Alpaca at all. The
   * open-order list is a different endpoint (`GET /v2/orders` vs
   * `GET /v2/orders:by_client_order_id`), so it answers through that outage,
   * and it answers for BOTH ids from one snapshot — the re-arm lookup would
   * otherwise throw the same way and kill the path just as dead.
   *
   * It is a FALLBACK, not the primary: the direct lookup is one small response
   * against a 500-row open-order page, and it alone can find an order that is
   * no longer open. A transport-level outage takes both down, and then `cancel()` still
   * throws — correctly: the row keeps blocking rather than release on a cancel
   * that never reached the venue.
   */
  private async resolveCancelTargets(
    clientOrderId: string,
  ): Promise<{ order: string | null; rearmedOrder: string | null }> {
    const inProcessRearm = this.rearmedLegs.get(clientOrderId) ?? null;
    const order = await this.lookupOpenOrderId(clientOrderId);
    // An id this process re-armed itself is known WITHOUT the venue, so it
    // stands even when the direct lookup just failed: re-deriving it from the
    // list can only lose it (the list is one page, and a re-armed leg past
    // that page reads as `null`), and cancelling the parent while a protective
    // leg is still live is the outcome this whole path exists to avoid. Only
    // when nothing is known in-process does a failed direct lookup carry over
    // — the same endpoint would fail the same way, and the list below answers
    // for both ids from one snapshot
    const rearmed: LookedUpOrderId =
      inProcessRearm !== null
        ? { id: inProcessRearm }
        : 'error' in order
          ? order
          : await this.lookupLatestRearmOrderId(clientOrderId);
    if (!('error' in order) && !('error' in rearmed)) {
      return { order: order.id, rearmedOrder: rearmed.id };
    }

    // Whichever lookup answered is KEPT. Only the unanswered one is re-derived
    // from the list: a re-arm lookup that failed on its own says nothing
    // about the original's id, and discarding that id would turn a partial
    // outage into a full re-derivation, with a `null` for anything the list
    // cannot see (a filled order is not open)
    const lookupError = 'error' in order ? order.error : (rearmed as { error: unknown }).error;
    let open: readonly AlpacaOrder[];
    try {
      open = await this.call('cancel', () => this.input.client.listOpenOrders());
    } catch {
      // The FIRST failure is the one rethrown: it is the cause the caller
      // and the alert should name, and a fallback that also failed says
      // nothing more than "the venue is unreachable" already did
      throw lookupError;
    }
    const idOf = (key: string): string | null =>
      open.find((candidate) => candidate.client_order_id === key)?.id ?? null;
    // The HIGHEST attempt still open, not the first row that looks like a
    // re-arm (#1346): a lot may have spent several wire ids, and only the last
    // one holds live protection. `find` would return whichever the venue
    // happened to page first and cancel the wrong order — #867's failure class
    // in a new costume. Spent ids are terminal, so they are not on this page at
    // all; picking the highest is belt-and-braces for the window where one is
    const latestRearmId = (): string | null => {
      let best: { attempt: number; id: string } | null = null;
      for (const candidate of open) {
        const attempt = rearmAttemptOf(clientOrderId, candidate.client_order_id);
        if (attempt === null) continue;
        if (best === null || attempt > best.attempt) best = { attempt, id: candidate.id };
      }
      return best?.id ?? null;
    };
    return {
      order: 'error' in order ? idOf(clientOrderId) : order.id,
      rearmedOrder: 'error' in rearmed ? latestRearmId() : rearmed.id,
    };
  }

  /**
   * The Alpaca order id of the NEWEST re-arm OCO this lot has on the venue, or
   * `id: null` when it has never been re-armed.
   *
   * Walks `rearmWireId` from attempt 0 and stops at the first id the venue has
   * nothing under. That termination is `rearmProtectiveLegs`' allocation
   * invariant, not an optimisation: attempt `k` is only ever placed once every
   * lower attempt is taken, so the first gap is the end of the sequence. It is
   * what keeps the common lot — one that never re-armed — at the single lookup
   * `cancel()` has always cost, and a re-armed one at two. Walking to
   * `MAX_REARM_ATTEMPTS` unconditionally would put three extra round trips on
   * EVERY exit.
   *
   * A mid-walk lookup failure is returned as the error rather than answered
   * with the ids found so far: a lower attempt is by construction the spent,
   * terminal one, so cancelling it while an unread higher attempt still rests
   * would leave a live OCO behind the cancelled bracket — the stray protective
   * leg firing into a closed position that #516 and `cancel()`'s whole
   * ordering exist to prevent. `resolveCancelTargets`' list fallback answers
   * for the whole sequence from one snapshot instead.
   */
  private async lookupLatestRearmOrderId(clientOrderId: string): Promise<LookedUpOrderId> {
    let latest: string | null = null;
    for (let attempt = 0; attempt < MAX_REARM_ATTEMPTS; attempt += 1) {
      const looked = await this.lookupOpenOrderId(rearmWireId(clientOrderId, attempt));
      if ('error' in looked) return looked;
      if (looked.id === null) return { id: latest };
      latest = looked.id;
    }
    return { id: latest };
  }

  /**
   * One by-client-order-id lookup, with its failure returned rather than
   * thrown so `resolveCancelTargets` can keep whichever of the two ids did
   * answer. `id: null` is the venue answering "no such open order" — an
   * ordinary result, and a different thing from the endpoint failing.
   */
  private async lookupOpenOrderId(clientOrderId: string): Promise<LookedUpOrderId> {
    try {
      const order = await this.call('cancel', () =>
        this.input.client.getOrderByClientOrderId(clientOrderId),
      );
      return { id: order?.id ?? null };
    } catch (error) {
      return { error };
    }
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

    // #983: onto the venue's price grid BEFORE anything else reads the prices
    // The stop and target are bracket multiples of the entry, so they carry
    // full float precision (766.40805334) and Alpaca refuses the whole order:
    // `422 {"code":42210000,"message":"invalid limit_price 762.335. sub-penny
    // increment does not fulfill minimum pricing criteria"}`, measured live
    //
    // Rounded into `submitted` rather than at the three call sites, because
    // the journal below MUST record what was actually sent: a restart that
    // rehydrates unrounded prices would re-place the leg off-grid, and the
    // re-arm comparison would never match the venue's own rounded copy
    const { entry, stop, target } = roundBracketToTick(
      order.side,
      order.entry,
      order.stop,
      order.target,
    );
    const submitted: NativeBracketRequest = { ...order, entry, stop, target };

    // Read before the POST, not after — see `bracketSubmittedAt`'s doc comment
    const submittedAt = this.clock.now();
    const response = await this.call('submitBracket', () =>
      this.input.client.submitOrder({
        symbol: toAlpacaSymbol(submitted.instrument, submitted.asset_class),
        side: submitted.side,
        qty: String(submitted.size),
        limit_price: formatTickPrice(submitted.entry),
        time_in_force: submitted.time_in_force,
        client_order_id: submitted.client_order_id,
        order_class: 'bracket',
        take_profit: { limit_price: formatTickPrice(submitted.target) },
        stop_loss: { stop_price: formatTickPrice(submitted.stop) },
      }),
    );

    this.brackets.set(order.client_order_id, response.id);
    // First-write-wins: a retried/idempotent resubmission under the same
    // client_order_id (`this.call`'s retry, or a venue no-op on an id it
    // already knows) reads the clock again later, which would move this
    // bound PAST fills the first, true submission already covers
    if (!this.bracketSubmittedAt.has(order.client_order_id)) {
      this.bracketSubmittedAt.set(order.client_order_id, submittedAt);
    }

    const legIds = (response.legs ?? []).map((leg) => leg.id);

    // `phase: 'armed'` — on a native-bracket venue there is no local state
    // machine to be partway through; the bracket is live from this call
    this.state.saveBracket({
      venue: 'alpaca',
      client_order_id: order.client_order_id,
      phase: 'armed',
      entry_order_id: response.id,
      ...legOrderIds(response.legs),
      request: toRequestFields(submitted),
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
  // port says to pass
  async getOrder(clientOrderId: string, _instrument: string): Promise<NormalizedOrder | null> {
    const order = await this.call('getOrder', () =>
      this.input.client.getOrderByClientOrderId(clientOrderId),
    );
    if (order === null) return null;

    // An emulated crypto bracket (#586) is already journalled and swept by
    // the emulation — re-populating the native map here would double-poll it
    // and stamp native-shaped ids over emulation state. The venue's answer
    // about the ENTRY still stands; the leg ids come from the journal, since
    // a plain crypto entry carries no `legs` for `legOrderIds` to read
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
    // them, and writing invented request values would be worse than none
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
   *
   * #1415: deliberately does NOT populate `flattenSubmittedAt` — this
   * process never submitted the flatten, so it has no same-process clock
   * read to offer, the same reason `getOrder`'s bracket-restore path leaves
   * `bracketSubmittedAt` empty for a restored bracket. A flatten resumed
   * this way stays unaudited by `auditSinceFloorInvariant` rather than
   * clamped or estimated.
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
    // Intentionally empty — see above
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
   * (`rearmWireId`), never reused verbatim — that original id already names
   * the now-cancelled bracket, and Alpaca refuses a reused `client_order_id`
   * permanently, terminal prior or not (measured 2026-09-15, #1346 —
   * docs/research/43 round 3). That same measurement is why the derived id is
   * a WALK rather than one fixed `:rearm`: every id this lot spends is spent
   * for good, so a lot that must be protected twice needs a second one. This
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
    rawStop: number,
    rawTarget: number,
  ): Promise<void> {
    // `owns` is the authoritative test (the journal knows every emulated
    // bracket, durably); the syntactic `-USD` fallback catches the crypto
    // residual whose journal row is missing, which must REFUSE loudly
    // rather than fall through to an order class the venue is verified to
    // reject — a thrown 422 here would read as a transient venue error
    if (this.emulation.owns(clientOrderId)) {
      return this.emulation.rearm(clientOrderId, instrument, side, qty, rawStop, rawTarget);
    }
    if (instrument.endsWith('-USD')) {
      throw new Error(
        `Alpaca adapter cannot re-arm crypto residual '${clientOrderId}' (${instrument}): no ` +
          'journalled emulated bracket exists for this lot, and the native OCO order class is ' +
          'rejected for crypto (verified, #550). The residual stays alert-only.',
      );
    }

    // #983, and BEFORE the adoption comparison below, not at the submit
    // `rearmOrderMatches` compares the caller's levels against what the venue
    // holds — which is the ROUNDED copy this method sent last time. Rounding
    // only at the submit would leave that comparison permanently unequal, so
    // every re-arm would take the cancel-and-replace branch: a round-trip of
    // real cost that briefly drops protection on a live position, for no
    // reason but a trailing decimal
    const { stop, target } = roundProtectiveLegsToTick(side, rawStop, rawTarget);

    // The CLOSING side, mirroring `submitFlatten`'s own convention — `side`
    // here is the lot's HELD side (the `BrokerAdapter.rearmProtectiveLegs`
    // contract), so the order that reduces it takes the opposite one
    const closingSide = side === 'buy' ? 'sell' : 'buy';

    // ADOPT-OR-PLACE (#549, the #600/#603 posture) over a WALK of this lot's
    // wire ids (#1346), lowest attempt first. Before submitting, ask the venue
    // whether a prior attempt's OCO already lives under an id this lot has
    // used — a re-arm that succeeded venue-side and then crashed (or lost its
    // journaling) before the caller could confirm it must be adopted, not
    // re-submitted by the residual-protection sweep's retry
    //
    // The walk exists because a spent id STAYS spent: reuse is refused with a
    // 422 forever, not just while the prior rests (measured — see
    // `MAX_REARM_ATTEMPTS`). A single `:rearm` id therefore protected a lot
    // exactly once. The reachable sequence is ordinary: the re-arm places its
    // OCO, the next `executeExit` cancels it (#516), that flatten partially
    // fills, the fresh residual marks the same lot, and this method is asked
    // to protect it again — under an id the venue now refuses. Every later
    // sweep pass would 422 identically, so the marker never cleared and the
    // residual was never protected: a permanent protection gap dressed as a
    // transient venue error. Advancing to an id this lot has not spent is what
    // makes the second re-arm possible at all
    //
    // ADVANCING PAST AN INDEX MEANS ITS ORDER IS NOT RESTING — that is the
    // invariant a future edit must not break, in BOTH directions. A dead prior
    // is stepped over; anything else is CANCELLED first, so two live OCOs can
    // never protect one residual (#516 from the other side: whichever fires
    // second fires into a position that is already closed and opens a reverse
    // one). And because an index is only ever allocated once every lower index
    // is taken, the first `null` ends the walk — `cancel()` relies on that to
    // find the newest OCO without probing all `MAX_REARM_ATTEMPTS` ids on
    // every exit
    //
    // THE WALK READS THE WHOLE ALLOCATED SEQUENCE BEFORE IT ADOPTS ANYTHING
    // (#1570 review). Returning at the first adoptable index instead was a
    // reachable downgrade, because a TERMINAL prior can sit below a RESTING
    // one: this method cancels a stale-sized prior before stepping past it,
    // and `cancelOrder` tolerates losing that race to the order's own fill —
    // so attempt 0 ends `filled` while attempt 1 rests. A walk that short-
    // circuited on attempt 0 then pointed `rearmedLegs` and
    // `recordBracketOrderIds` at the FILLED no-op, and the next `cancel()`
    // preferred that in-process id, retired nothing, and left attempt 1's OCO
    // live and unmanaged behind a cancelled bracket — the two-live-legs hazard
    // (#516) this whole mechanism exists to prevent, reintroduced by the
    // bookkeeping rather than by the orders
    //
    // Hence the two slots below: `live` (the highest RESTING prior that
    // matches this request) and `settled` (the highest whose own fills are
    // already closing the residual), with `live` preferred outright. A resting
    // OCO is protection that can still fire and must be what every downstream
    // id points at; a filled one only records that the episode closed itself
    // The cost is one extra lookup on the common adopt path — this runs on the
    // residual sweep's cadence, not on `cancel()`'s every-exit path, so it is
    // paid where there is room for it
    //
    // Adoption is CONDITIONAL on the prior matching THIS request (#549
    // review): a still-resting prior sized for a DIFFERENT residual (further
    // exit fills landed between the crashed attempt and this retry) must not
    // be treated as confirmed protection — an oversized stop over-closes into
    // a reverse position, the exact #516 hazard. A resting mismatch is
    // CANCELLED and the walk moves on; only `qty` can genuinely drift (the
    // contract fixes `stop`/`target` to the lot's own unchanged levels), but
    // all three are compared, and a prior whose price fields are missing fails
    // the match — replacing real protection costs a round-trip, adopting stale
    // protection costs money
    //
    // A `filled` OR `partially_filled` prior is adopted regardless of the
    // match (#549 review): an OCO's fills are EXIT fills — every share it
    // filled has already closed that much of the position — so what remains
    // resting (`qty − filled_qty`) is exactly what that episode still holds
    // The caller's `residual` is computed off the STORE, which has not
    // necessarily ingested those very fills yet (the re-arm sweep in
    // `fetchNewFills` below is what offers them), so a partially-consumed
    // prior would compare against a stale figure: cancel-and-replace sized
    // to that figure would re-arm quantity that is already closed —
    // over-protection, whose leg fires into a smaller position and opens a
    // reverse one (#516's hazard, from the other direction). Once the fills
    // DO ingest, the recomputed residual and the prior's resting remainder
    // agree by construction
    //
    // ADOPTION IS ALLOWLISTED on the RAW venue status (#549 review, round 3):
    // `mapOrderState` folds every unrecognized status — `done_for_day`,
    // `replaced`, `stopped`, `pending_cancel`... — into 'submitted', so a
    // blocklist of dead states would let a matching-but-not-resting prior be
    // adopted as protection while nothing rests at the venue: exactly the
    // naked-residual-believed-protected hazard this method exists to close
    // Only statuses that mean RESTING may satisfy the match branch; anything
    // unrecognized is cancelled before the walk advances, where `cancelOrder`'s
    // tolerance of already-terminal orders makes the defensive cancel free
    //
    // The ambiguous-lookup question #1346 also asked — what
    // `GET /v2/orders:by_client_order_id` answers when two orders share an id —
    // has no answer to handle: the venue durably refuses the second order, so
    // two rows can never carry one `client_order_id` (measured, doc 43 round 3)
    // The lookup below returns at most one row by construction
    const RESTING_STATUSES = ['new', 'accepted', 'pending_new', 'accepted_for_bidding'];
    let live: AlpacaOrder | null = null;
    let settled: AlpacaOrder | null = null;
    let freeAttempt: number | null = null;
    // The largest size this lot was observed to hold at an index ABOVE
    // `settled` — the #1573 discriminator, reset whenever `settled` moves up
    let sizedAboveSettled = 0;

    for (let attempt = 0; attempt < MAX_REARM_ATTEMPTS; attempt += 1) {
      const prior = await this.call('rearmProtectiveLegs', () =>
        this.input.client.getOrderByClientOrderId(rearmWireId(clientOrderId, attempt)),
      );
      if (prior === null) {
        freeAttempt = attempt;
        break;
      }

      const priorState = mapOrderState(prior.status);
      if (priorState === 'filled') {
        settled = prior;
        sizedAboveSettled = 0;
        continue;
      }
      sizedAboveSettled = Math.max(sizedAboveSettled, Number(prior.qty));
      // `partially_filled` belongs with the LIVE priors, not the terminal
      // ones: its remainder (`qty − filled_qty`) is still working at the
      // venue and can still fire. It needs no match check — #549 adopts a
      // partially-consumed prior regardless of size, for the reason spelled
      // out above — but it must never be treated as stale, or the walk places
      // a second leg on top of one that is still armed (#516)
      if (
        priorState === 'partially_filled' ||
        (RESTING_STATUSES.includes(prior.status) && rearmOrderMatches(prior, qty, stop, target))
      ) {
        // Two resting priors on one lot are unreachable through this walk —
        // an index is only allocated once the one below it stopped resting —
        // but the invariant is what the money depends on, so it is ENFORCED
        // here rather than assumed: whichever is older is retired
        const superseded = live;
        if (superseded !== null) {
          await this.call('rearmProtectiveLegs', () =>
            this.input.client.cancelOrder(superseded.id),
          );
        }
        live = prior;
        continue;
      }
      if (!['cancelled', 'rejected', 'expired'].includes(priorState)) {
        // Live but stale-sized, or a status that does not prove it dead:
        // retire it before the walk steps over it. `cancelOrder` resolves on
        // 404/422 (already-terminal), so losing the race to the prior's own
        // fill is not a failure here — the submit below is what would
        // surface a real problem
        await this.call('rearmProtectiveLegs', () => this.input.client.cancelOrder(prior.id));
      }
    }

    // `live` over `settled`: see the two-slot note above. Only one of these is
    // ever protection that can still fire
    //
    // `live` first because it is the only one that can still FIRE. `settled`
    // is now strictly a FULL fill (`partially_filled` routes to `live` above),
    // so its remainder — `qty − filled_qty`, the quantity #549 says an adopted
    // prior still holds — is ZERO: that episode closed itself, and the store's
    // residual follows once the fills ingest. Adopting it while nothing rests
    // is the lot being FLAT, not the lot being naked. Declining it and placing
    // would arm a fresh leg over a closed position, which fires into nothing
    // and opens a reverse one — #516 from the other direction
    //
    // That reasoning holds only while the fill COVERS every size this lot has
    // been observed to hold since (#1573). A post-re-arm ENTRY fill grows the
    // residual, so a `settled` of 4 can sit under an attempt sized 6: those
    // 6 shares existed after the 4 closed, and adopting returns success with
    // nothing resting — which clears the #549 marker over the 2 that are
    // naked
    //
    // Two independent observations bound the size, and the hazard needs both
    // because they see different halves of it. `qty` catches it while
    // `settled`'s own fills are still un-ingested (the store reads the grown
    // residual); the sizes of LATER ATTEMPTS catch it once they have ingested
    // — which is exactly when `qty` has shrunk back under the fill and the
    // `settled.filled_qty >= qty` test alone passes 4 ≥ 2 and is wrong. A
    // THIRD, below, catches the case neither half of that pair sees at all
    // (#1581): `qty` has shrunk back under the fill AND no later attempt was
    // ever allocated to carry the growth's size forward
    //
    // Neither reads the walk itself, deliberately: whether this pass RETIRED
    // those attempts (`4ea06cba`) and whether anything still sits ABOVE them
    // (`df222403`) were both tried and reverted, each answering a question
    // about the walk rather than about the position
    //
    // A fill that will not parse cannot prove flatness, so it declines —
    // placing over a flat lot is bounded (the leg fires into nothing), a lot
    // believed protected on unreadable evidence is not
    //
    // #1581: `qty` and `sizedAboveSettled` are both derived from THIS PROCESS's
    // walk and the caller's own residual estimate — and the caller's estimate
    // is the STORE's belief, which can lag the venue on either side of a
    // two-way fill-ingestion race (issue #1581's reproducer: the store has
    // ingested `settled`'s exit fill but not yet a later entry fill that grew
    // the lot past it, so the residual it passes has already been netted down
    // to exactly the naked amount, and shrinking below `settled.filled_qty`
    // reads as coverage instead of as the hazard it is). A THIRD, independent
    // bound closes that hole: `clientOrderId` is this lot's own entry bracket's
    // client_order_id (`execute.ts` sets it verbatim, `submitBracket` above
    // sends it unmodified — never a `rearmWireId` derivative), so querying it
    // directly returns THIS lot's own entry order, not a netted-across-lots
    // venue position — `getPositions()` cannot serve this role for the reason
    // `reconcile.ts`'s own comment gives: "a venue reports one netted position
    // where the store may hold several lots", so a nonzero reading there is
    // not evidence any ONE lot is naked. `filled_qty` on the entry order this
    // lot's OWN `client_order_id` names has no such ambiguity: it is the total
    // this lot has ever been bought for, read fresh from the venue at decision
    // time — no store, no ingestion race
    //
    // Only fetched when `settled !== null`: the `live` path never reaches this
    // line, and a lot that never re-armed at all has no `settled` to second-
    // guess either. One extra lookup on the adopt-by-inference path, same
    // trade the `live`/`settled` split above already makes
    //
    // A `null` or unparseable entry is treated as NO ADDITIONAL EVIDENCE, not
    // as proof of anything — it can only ever WIDEN `observedSize` (tighten
    // the adoption bar), never narrow it, so a venue that cannot answer this
    // lookup leaves every existing (tested) sequence's outcome unchanged
    // Widening unconditionally on a lookup failure would be the same
    // "unreadable evidence declines" posture the parse-failure comment above
    // already takes, but this repo's own #842 finding (`alpaca-order-
    // normalization.ts`) is that Alpaca's docs cannot even settle whether a
    // partially-filled order's fields are trustworthy mid-fill, so a missing
    // row is treated as inconclusive rather than as a decline-forcing signal
    let entryFilledQty = 0;
    if (settled !== null) {
      const entry = await this.call('rearmProtectiveLegs', () =>
        this.input.client.getOrderByClientOrderId(clientOrderId),
      );
      const parsed = entry !== null ? Number(entry.filled_qty) : NaN;
      if (Number.isFinite(parsed)) entryFilledQty = parsed;
    }
    const observedSize = Math.max(qty, sizedAboveSettled, entryFilledQty);
    const adopted =
      live ?? (settled !== null && Number(settled.filled_qty) >= observedSize ? settled : null);
    if (adopted !== null) {
      this.rearmedLegs.set(clientOrderId, adopted.id);
      // Same column semantics as the fresh-place path below — the OCO's
      // parent id IS the take-profit (see that path's `.legs` note)
      this.state.recordBracketOrderIds('alpaca', clientOrderId, {
        entry_order_id: null,
        stop_order_id: legOrderIds(adopted.legs).stop_order_id,
        target_order_id: adopted.id,
      });
      return;
    }

    if (freeAttempt === null) {
      // Every id this lot may use is owned by an order that is not protecting
      // it, and Alpaca never releases one — so NO later pass can protect this
      // residual either. That is the permanent-gap shape #1214 already has a
      // remedy for, so this throws the type that routes there
      // (`ProtectiveRearmUnsupportedError`): the callers re-flatten the
      // residual, page against the permanent-gap dedup column, and stop
      // retrying. Thrown OUTSIDE `this.call` deliberately — that wrapper's
      // `sanitizeBrokerError` would erase the discriminant (see the class's own
      // INVARIANT note). The alternative — placing under a spent id — is a
      // guaranteed 422, and inventing an unbounded id space would replace a
      // loud refusal with a quiet one
      throw new ProtectiveRearmUnsupportedError(
        'alpaca',
        `Alpaca adapter exhausted all ${MAX_REARM_ATTEMPTS} re-arm wire ids for lot ` +
          `'${clientOrderId}' (${rearmWireId(clientOrderId, 0)} .. ` +
          `${rearmWireId(clientOrderId, MAX_REARM_ATTEMPTS - 1)}): each is already owned by an ` +
          'order at the venue that is not protecting this residual, and Alpaca refuses a reused ' +
          'client_order_id permanently (measured, docs/research/43). The residual is NOT ' +
          'protected, and no retry of this call can change that.',
      );
    }

    const rearmClientOrderId = rearmWireId(clientOrderId, freeAttempt);
    const response = await this.call('rearmProtectiveLegs', () =>
      this.input.client.submitOcoOrder({
        symbol: toAlpacaSymbol(instrument),
        side: closingSide,
        qty: String(qty),
        time_in_force: 'gtc',
        client_order_id: rearmClientOrderId,
        order_class: 'oco',
        take_profit: { limit_price: formatTickPrice(target) },
        stop_loss: { stop_price: formatTickPrice(stop) },
      }),
    );

    this.rearmedLegs.set(clientOrderId, response.id);
    // NOT `...legOrderIds(response.legs)`: that helper finds the target leg
    // by scanning `.legs` for a `type: 'limit'` entry, which is where a
    // BRACKET's take-profit child lives. An OCO's take-profit is the TOP
    // LEVEL order itself (`response.id`) — `.legs` here holds only the ONE
    // stop-loss child — so `target_order_id` is set directly rather than
    // reusing that scan and silently recording `null`
    this.state.recordBracketOrderIds('alpaca', clientOrderId, {
      entry_order_id: null,
      stop_order_id: legOrderIds(response.legs).stop_order_id,
      target_order_id: response.id,
    });
  }

  /**
   * #1123: observability, not enforcement — this WARNS and never clamps. A fill
   * this flags still gets collected by `collectFill` at its venue-reported (or
   * `observedAt`-fallback) date; nothing here rewrites it. Clamping would
   * fabricate an event time on a live-money path with no evidence, from this
   * audit or otherwise, that it is ever needed — the empirically correct
   * response to a real violation is to fix the source, the way #1096 fixed
   * `SimulatedBrokerAdapter`, not to paper over it here.
   *
   * Compares against a per-key submission-time bound, NOT the global `since`
   * floor: the FILL SWEEP never prunes `brackets` (only `cancel()` does, on a
   * confirmed cancel), so an old, long-closed-but-not-cancelled bracket is
   * re-polled every sweep and would trip `filledAt < since` constantly and
   * harmlessly once `since` has moved on to newer lots — noise, not signal.
   * The bound is per-key, locally-anchored instead: silent for a restored
   * (post-restart) bracket or flatten, which has no entry in either map and
   * no local proxy for its `opened_at` to compare against.
   *
   * `submittedAt` is the CALLER's own clock (this host's), never looked up
   * here — #1415 split it out of the method so the bracket/re-arm sweeps
   * (keyed by the lot's own `idempotency_key`, `bracketSubmittedAt`) and the
   * flatten sweep (keyed by the exit's own, `flattenSubmittedAt`) can share
   * one check and one throttle set over two disjoint key spaces. `filled_at`
   * is Alpaca's server clock. The first thing to check on seeing this
   * warning is host clock skew (NTP drift), not the venue —
   * `bracketSubmittedAt`'s doc names the OTHER source of a benign trip: the
   * `[opened_at, submittedAt)` gap this bound cannot see into. Throttled to
   * first sighting per lot+LEG via `warnedSinceFloorViolations` (keyed
   * `clientOrderId:leg`, not `clientOrderId` alone — see that field's doc for
   * why a lot-only key is unsafe here) — the fill sweep never prunes
   * `brackets`, so a genuinely violating bracket is re-polled, and would
   * otherwise warn every sweep, for the life of the process (or until
   * `cancel()` removes it).
   */
  private auditSinceFloorInvariant(
    order: AlpacaOrder | AlpacaOrderLeg,
    leg: NormalizedFill['leg'],
    clientOrderId: string,
    instrument: string,
    observedAt: Date,
    submittedAt: Date | undefined,
  ): void {
    const filledQty = Number.parseFloat(order.filled_qty);
    if (!Number.isFinite(filledQty) || filledQty <= 0) return;

    if (submittedAt === undefined) return;

    const filledAt = resolveFilledAt(order, observedAt);
    if (filledAt.getTime() >= submittedAt.getTime()) return;
    // Keyed by lot AND leg, not lot alone (round-2 review): the bracket loop
    // and the re-arm loop share one `clientOrderId` per lot, so a lot-only
    // key let the entry leg's first warn permanently suppress a DIFFERENT,
    // genuine violation on the re-armed target leg of the SAME lot — masking
    // exactly the exit-leg violations #1087's wedge failure mode is about
    const warnedKey = `${clientOrderId}:${leg}`;
    if (this.warnedSinceFloorViolations.has(warnedKey)) return;
    this.warnedSinceFloorViolations.add(warnedKey);

    safeLog(this.logger, {
      trace_id: ALPACA_FILL_SWEEP_TRACE_ID,
      stage: 'execution',
      event: 'alpaca_fill_predates_bracket_submission',
      level: 'warn',
      message:
        '#1123: Alpaca fill dated before its own order was submitted — the ingest-fills since-floor invariant may be violated',
      payload: {
        client_order_id: clientOrderId,
        broker_fill_id: order.id,
        leg,
        instrument,
        filled_at: filledAt.toISOString(),
        submitted_at: submittedAt.toISOString(),
      },
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
     * #842: the date a fill the venue reports FILLED but does not DATE is
     * booked at — see `collectFill`'s `filled_at` guard for why Alpaca may
     * legitimately hand us one. Read ONCE for the whole sweep rather than per
     * `collectFill` call, so two legs of the same bracket observed in the same
     * pass cannot be ordered against each other by clock jitter alone.
     */
    const observedAt = this.clock.now();

    const bracketFailures = await this.sweepBrackets(since, observedAt, fills, failures);
    const flattenFailures = await this.sweepFlattens(since, observedAt, fills, failures);
    const rearmFailures = await this.sweepRearmedLegs(since, observedAt, fills, failures);

    // The emulated-crypto sweep (#586) — polls each emulated bracket's plain
    // entry/stop/target orders, offers their fills (tagged 'entry'/'stop'/
    // 'target' under the lot's own key, so `ingestFills()`'s ordinary
    // routing books them with no knowledge an emulation exists), and drives
    // the journalled phase machine: arm the legs on the entry fill, cancel
    // the sibling when one leg fires, resume any episode a dead process left
    // mid-transition. Isolation and UnpricedFillError bookkeeping are the
    // same as the three loops above — see the emulation module
    const emulationFailures = await this.emulation.sweep(since, fills, failures);

    // The venue caught up: this fill priced, was collected above, and is about
    // to be booked, so its anomaly row is resolved. Done here rather than in
    // `collectFill` so the normalizer stays a pure function of one order
    try {
      for (const fill of fills) {
        this.state.clearUnpricedFill('alpaca', fill.client_order_id, fill.broker_fill_id);
      }
    } catch (stateError) {
      // Same reasoning as above, and cheaper still to survive: a stale row only
      // risks one redundant alert, whereas losing the sweep loses real fills
      failures.push(stateError);
    }

    // Before the throw below, and unconditionally: escalation must not depend
    // on whether some OTHER bracket happened to produce a fill this sweep
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
    // same safe-inside-a-catch helper #573 wired onto `ExecutionInput`
    for (const failure of failures) {
      logCaughtFailure(
        this.logger,
        {
          trace_id: ALPACA_FILL_SWEEP_TRACE_ID,
          stage: 'execution',
          event: 'alpaca_fill_sweep_source_failed',
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
          // "fills.length > 0 discarded failures silently" bug this fixes
          bracket_failures: bracketFailures,
          flatten_failures: flattenFailures,
          rearm_failures: rearmFailures,
          emulation_failures: emulationFailures,
          fills_read: fills.length,
        },
      );
    }

    // Progress wins when there is any: dropping good fills to report a bad
    // bracket would re-create the account-wide stall this isolation removes
    // A wholly-failed sweep is the one case where throwing costs nothing — and
    // it must not be reported as the "no new fills" that an empty array means
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
   * The bracket half of `fetchNewFills`'s sweep. Snapshot, as #297 already
   * did for `CcxtBrokerAdapter.syncBrackets` (M3): the `getOrder` below
   * awaits inside this loop, and a Map iterator DOES visit entries inserted
   * mid-iteration — so a bracket submitted during the sweep would be drained
   * by a pass whose `since` window predates it, and its fills silently
   * dropped. The snapshot fixes each pass's worklist at entry (PR #290
   * review, deepseek). Returns the count of brackets that failed — counted
   * apart from `failures.length`, which now also collects journal and
   * alert-delivery failures (#298); reporting those as "brackets failed"
   * would send an operator reading the soak log to the venue to investigate
   * orders that were never the problem.
   */
  private async sweepBrackets(
    since: Date,
    observedAt: Date,
    fills: NormalizedFill[],
    failures: unknown[],
  ): Promise<number> {
    let bracketFailures = 0;
    for (const [clientOrderId, entryOrderId] of [...this.brackets]) {
      try {
        const entry = await this.call('fetchNewFills', () =>
          this.input.client.getOrder(entryOrderId),
        );

        const instrument = fromAlpacaSymbol(symbolOf(entry));
        const submittedAt = this.bracketSubmittedAt.get(clientOrderId);
        this.auditSinceFloorInvariant(
          entry,
          'entry',
          clientOrderId,
          instrument,
          observedAt,
          submittedAt,
        );
        collectFill(entry, 'entry', clientOrderId, instrument, since, observedAt, fills);
        for (const leg of entry.legs ?? []) {
          this.auditSinceFloorInvariant(
            leg,
            legName(leg),
            clientOrderId,
            instrument,
            observedAt,
            submittedAt,
          );
          collectFill(leg, legName(leg), clientOrderId, instrument, since, observedAt, fills);
        }
      } catch (error) {
        // Skipped, not swallowed: this bracket contributes nothing to THIS
        // sweep and is retried on the next one. That is the same shape as an
        // order the venue has not reported yet, and `ingestFills()` dedups on
        // `broker_fill_id`, so re-polling costs nothing
        if (error instanceof UnpricedFillError) {
          // Durable, and stamped with the FIRST sighting: this is the clock the
          // age-out runs on, and it has to survive the restart that a 14-day
          // unattended soak will contain several of
          //
          // Guarded, because this runs INSIDE the per-bracket catch: a throw
          // from the journal here would escape the isolation entirely and abort
          // the account's whole sweep — turning one venue anomaly into the
          // stop-outs-for-everyone starvation this loop exists to prevent
          //
          // NEITHER `failures.push(error)` NOR `bracketFailures += 1` runs for
          // an UnpricedFillError itself (#524 review, deepseek) — it is a
          // MODELLED, EXPECTED condition (#298's whole reason for existing:
          // the age-out clock just above, and the eventual alert through
          // `escalateAgedUnpricedFills` -> the `unpricedFillAlerts` port), not a
          // failure, which is exactly what this catch's OWN first comment
          // already says ("skipped, not swallowed... retried on the next
          // one"). Counting it here contradicted that: `failures.length > 0`
          // below is what decides whether a `fills`-less call THROWS, so one
          // unpriced fill — on a poll where nothing else happened to produce
          // a fill — silently caused the exact "stop-outs-for-everyone"
          // abort this isolation exists to prevent, for EVERY bracket in the
          // sweep, not just the unpriced one. A journal-write failure
          // (`stateError`, below) is a genuinely different, new failure and
          // still counts
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
    return bracketFailures;
  }

  // The flatten sweep (#517) — structurally the bracket loop above with
  // `entry.legs` dropped (a flatten has none) and `leg: 'exit'` fixed
  // rather than derived per-leg. Kept as its own loop, over its own
  // `flattens` map, rather than folded into the one above: a flatten is
  // never a bracket (`submitFlatten`'s own docstring), and merging the
  // maps would make the loop above fetch `entry.legs` for an order that
  // has none
  //
  // `flattens` IS IN-MEMORY ONLY, unlike `brackets` (which the constructor
  // warms from `this.state.loadBrackets('alpaca')`, because a bracket can
  // legitimately still be waiting on a stop/target fill days after a
  // restart). A flatten is a plain IOC market order: by the time this
  // process could poll it again, the venue has already resolved it one way
  // or another, so the ONLY window not surviving a restart costs is the
  // narrow one between `submitFlatten` returning and this sweep next
  // running
  //
  // THAT WINDOW IS NOW CLOSED, not by this map becoming durable, but by
  // `reconcile()` learning about `flatten_submissions` rows (#519/#526):
  // on startup (and whenever `reconcile()` next runs), it reads every
  // unresolved journal row and calls `resumeFlatten` for each, which
  // re-populates THIS map from the venue's own record of the order —
  // see `resumeFlatten`'s doc above. A crash inside the window still
  // empties this map exactly as before; what changed is that the map is no
  // longer the only place that memory lived
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
  // ticket exists to stop dropping
  //
  // What this does NOT wait for: confirmation that `ingestFills()`
  // actually PERSISTED the fill this call handed it. This adapter has no
  // `SharedStore` access to confirm that (`AlpacaBrokerAdapterInput.state`
  // above documents that boundary as deliberate), so there is a narrow
  // residual window — if `ingestFills()` goes on to fail, this poll, for a
  // reason unrelated to this flatten, AFTER this fill was handed off but
  // BEFORE its target lot's own advance is durably written — where the
  // fill is not re-offered on the next poll, because this entry is
  // already gone
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
  // either ticket; the mechanism here is ready for one whenever it exists
  private async sweepFlattens(
    since: Date,
    observedAt: Date,
    fills: NormalizedFill[],
    failures: unknown[],
  ): Promise<number> {
    let flattenFailures = 0;
    for (const [clientOrderId, orderId] of [...this.flattens]) {
      try {
        const order = await this.call('fetchNewFills', () => this.input.client.getOrder(orderId));
        const instrument = fromAlpacaSymbol(symbolOf(order));
        // #1415: `flattens` is keyed by the EXIT's own idempotency_key, a
        // different key space from `bracketSubmittedAt` — see
        // `flattenSubmittedAt`'s doc for why this needs its own map
        this.auditSinceFloorInvariant(
          order,
          'exit',
          clientOrderId,
          instrument,
          observedAt,
          this.flattenSubmittedAt.get(clientOrderId),
        );
        collectFill(order, 'exit', clientOrderId, instrument, since, observedAt, fills);
        if (mapOrderState(order.status) !== 'submitted') {
          this.flattens.delete(clientOrderId);
          this.flattenSubmittedAt.delete(clientOrderId);
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
        // an unpriced bracket, never pruned mid-unpriced
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
    return flattenFailures;
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
  // leg firing correctly reduces the lot and can close it
  //
  // Pruned once terminal, same asymmetry with `brackets` as `flattens`
  // documents and for the same reason: an OCO here protects a residual
  // that is either still open (worth polling again) or done (a single
  // fire-or-cancel event, never resting again after that)
  private async sweepRearmedLegs(
    since: Date,
    observedAt: Date,
    fills: NormalizedFill[],
    failures: unknown[],
  ): Promise<number> {
    let rearmFailures = 0;
    for (const [lotKey, orderId] of [...this.rearmedLegs]) {
      try {
        const order = await this.call('fetchNewFills', () => this.input.client.getOrder(orderId));
        const instrument = fromAlpacaSymbol(symbolOf(order));
        // #1123: `rearmedLegs` is keyed by the LOT's own `idempotency_key`
        // (see its doc above) — the same key space `bracketSubmittedAt` uses,
        // so the original bracket's submission-time bound still applies here
        // with no new map
        const submittedAt = this.bracketSubmittedAt.get(lotKey);
        this.auditSinceFloorInvariant(order, 'target', lotKey, instrument, observedAt, submittedAt);
        collectFill(order, 'target', lotKey, instrument, since, observedAt, fills);
        for (const leg of order.legs ?? []) {
          this.auditSinceFloorInvariant(
            leg,
            legName(leg),
            lotKey,
            instrument,
            observedAt,
            submittedAt,
          );
          collectFill(leg, legName(leg), lotKey, instrument, since, observedAt, fills);
        }
        if (mapOrderState(order.status) !== 'submitted') {
          this.rearmedLegs.delete(lotKey);
        }
      } catch (error) {
        // Same isolation and UnpricedFillError bookkeeping as the bracket
        // and flatten loops above
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
    return rearmFailures;
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
      // pass, and the rows outlive the failure, so the next sweep escalates
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
        // just as hard here: a Telegram transport failure quotes the
        // request it failed on, and that URL carries the bot token. What is
        // replaced cannot leak. The row stays unalerted, so the next sweep
        // retries delivery
        failures.push(
          new Error(
            `Alpaca unpriced-fill alert delivery failed for order ${record.broker_fill_id} ` +
              `(${record.leg} leg of '${record.client_order_id}')`,
          ),
        );
        // Unrecorded, so the next sweep tries again — the alert this fill is
        // owed has not been spent
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
        // never silent — the direction to fail in
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
 * Whether a prior re-arm OCO found under one of this lot's `rearmWireId`s
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
 * in the shape returned to the caller
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
  // The take-profit leg is a limit order; the stop-loss leg is a stop order
  return leg.type === 'limit' ? 'target' : 'stop';
}
