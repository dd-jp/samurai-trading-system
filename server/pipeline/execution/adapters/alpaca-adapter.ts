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
// the import graph acyclic (PR #600 review)
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
 * module layering
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
  /** Optional for backward compat; when absent the adapter paces itself — see default below */
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
   * `rateLimiter` explicitly (#299, see `DEFAULT_VENUE_PACING.alpaca`)
   */
  private readonly rateLimiter: TokenBucket;
  private readonly state: BrokerStateStore;
  private readonly clock: Clock;
  private readonly unpricedFillAgeOutMs: number;
  /**
   * Crypto path (#586): Alpaca rejects every advanced order class for crypto
   * (#550), so brackets are emulated — journalled in the same `BrokerStateStore`
   * the native index uses
   */
  private readonly emulation: AlpacaCryptoLegEmulation;
  /** #609 — see `AlpacaBrokerAdapterInput.logger`'s doc for why this has no default */
  private readonly logger: Logger;

  constructor(private readonly input: AlpacaBrokerAdapterInput) {
    // Fallback for standalone construction (#1083); telemetry wired here too
    // so that path isn't silently worse-observed than production's
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
    // is indistinguishable above the adapter from a quiet market
    for (const record of this.state.loadBrackets('alpaca')) {
      // Emulated crypto rows are rehydrated by the emulation's own constructor
      // above — polling them here too would sweep the same orders twice
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
    // the equity OCO's naming scheme and doesn't apply here
    if (this.emulation.owns(clientOrderId)) {
      await this.emulation.cancelAll(clientOrderId);
      return;
    }

    const { order, rearmedOrder } = await this.resolveCancelTargets(clientOrderId);

    if (rearmedOrder !== null) {
      await this.call('cancel', () => this.input.client.cancelOrder(rearmedOrder));
      // Deleted only after the cancel confirms — a throw above must leave
      // this map matching the venue, so a retry finds the same order again
      this.rearmedLegs.delete(clientOrderId);
    }

    if (order !== null) {
      await this.call('cancel', () => this.input.client.cancelOrder(order));
      this.brackets.delete(clientOrderId);
    }
  }

  /**
   * Both Alpaca order ids `cancel()` may need — the original and the newest
   * re-arm wire id — or null where the venue has none open. Pure lookups, all
   * above `cancel()`'s first destructive call (#867).
   *
   * `listOpenOrders` is a FALLBACK (#1500) for when the direct by-id lookup
   * fails: it answers through that same outage, for both ids from one
   * snapshot. A transport-wide outage takes both down, and `cancel()` still throws.
   */
  private async resolveCancelTargets(
    clientOrderId: string,
  ): Promise<{ order: string | null; rearmedOrder: string | null }> {
    const inProcessRearm = this.rearmedLegs.get(clientOrderId) ?? null;
    const order = await this.lookupOpenOrderId(clientOrderId);
    // An id this process re-armed itself is known without the venue, so it
    // stands even when the direct lookup failed — re-deriving from the list
    // could lose it (one page; a re-armed leg past it reads as `null`)
    const rearmed: LookedUpOrderId =
      inProcessRearm !== null
        ? { id: inProcessRearm }
        : 'error' in order
          ? order
          : await this.lookupLatestRearmOrderId(clientOrderId);
    if (!('error' in order) && !('error' in rearmed)) {
      return { order: order.id, rearmedOrder: rearmed.id };
    }

    // Whichever lookup answered is KEPT; only the unanswered one is re-derived
    // from the list — discarding a known id would turn a partial outage into
    // a full re-derivation
    const lookupError = 'error' in order ? order.error : (rearmed as { error: unknown }).error;
    let open: readonly AlpacaOrder[];
    try {
      open = await this.call('cancel', () => this.input.client.listOpenOrders());
    } catch {
      // The FIRST failure is rethrown — it's the cause the caller should
      // name; a fallback that also failed adds nothing
      throw lookupError;
    }
    const idOf = (key: string): string | null =>
      open.find((candidate) => candidate.client_order_id === key)?.id ?? null;
    // The HIGHEST attempt still open, not the first match (#1346): only the
    // last wire id holds live protection, and `find` could return the wrong
    // (stale) order — #867's failure class in a new costume
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
   * Newest re-arm OCO's order id, or `id: null` if never re-armed. Walks from
   * attempt 0, stopping at the first gap (attempts are allocated contiguously,
   * `rearmProtectiveLegs`' invariant). A mid-walk failure is returned as the
   * error, not answered partially — a cancelled lower attempt with an unread
   * higher one would leave a live OCO behind a cancelled bracket (#516).
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
   * One by-client-order-id lookup, with failure returned rather than thrown so
   * `resolveCancelTargets` can keep whichever id did answer. `id: null` means
   * the venue found no such open order — not the same as the endpoint failing.
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
   * Everything the venue believes it holds (#429). A row whose `qty` doesn't
   * parse is dropped, not reported as NaN — NaN compares false against
   * everything, so a poisoned row would silently read as "no divergence."
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
   * VERIFIED 2026-08-07 (#550): crypto rejects `order_class: 'bracket'`
   * outright, so a crypto instrument always routes to the emulation (#586)
   * instead of the native path below
   */
  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    if (order.asset_class === 'crypto') {
      return this.emulation.submitEntry(order);
    }

    // #983: onto the venue's price grid before anything reads the prices —
    // sub-penny precision is refused outright (422, measured live). Rounded
    // into `submitted`, not at each call site, so the journal below records
    // exactly what was sent; a restart rehydrating unrounded prices would
    // re-place the leg off-grid and never match the venue's own copy
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
    // First-write-wins: a retried resubmission under the same client_order_id
    // would otherwise move this bound past fills the first submission covers
    if (!this.bracketSubmittedAt.has(order.client_order_id)) {
      this.bracketSubmittedAt.set(order.client_order_id, submittedAt);
    }

    const legIds = (response.legs ?? []).map((leg) => leg.id);

    // `phase: 'armed'`: a native bracket has no local state machine to be
    // partway through — it's live from this call
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
   * Reconciliation lookup (#86), by OUR client order id, never the `brackets`
   * map — that map is empty after a restart. A null here is Alpaca's own
   * answer, as `BrokerAdapter.getOrder`'s contract requires before `reconcile()`
   * treats an order as "never placed."
   */
  // `_instrument` is unused: Alpaca looks up by client id alone, but a
  // symbol-keyed venue (ccxt) cannot, so the port requires the parameter
  async getOrder(clientOrderId: string, _instrument: string): Promise<NormalizedOrder | null> {
    const order = await this.call('getOrder', () =>
      this.input.client.getOrderByClientOrderId(clientOrderId),
    );
    if (order === null) return null;

    // Emulated crypto brackets (#586) are already journalled and swept by the
    // emulation — re-populating the native map would double-poll and stamp
    // native-shaped ids over emulation state
    if (this.emulation.owns(clientOrderId)) {
      return {
        client_order_id: clientOrderId,
        broker_order_ids: this.emulation.brokerOrderIds(clientOrderId),
        order_state: mapOrderState(order.status),
        filled_qty: Number.parseFloat(order.filled_qty),
      };
    }

    // Re-populates the map so a post-restart `fetchNewFills` finds this
    // bracket again. Journalled via partial-upsert: this call knows the
    // venue's order ids but not the request, and inventing one would be worse
    this.brackets.set(clientOrderId, order.id);
    this.state.recordBracketOrderIds('alpaca', clientOrderId, {
      entry_order_id: order.id,
      ...legOrderIds(order.legs),
    });

    return normalizeOrder(clientOrderId, order);
  }

  /**
   * Flatten-sweep counterpart of `getOrder` (#519, #526) — re-populates
   * `flattens`, not `brackets`, so the next `fetchNewFills` sweep polls it
   * through the ordinary flatten loop. Deliberately does NOT populate
   * `flattenSubmittedAt`: this process never submitted the flatten, so it has
   * no same-process clock read to offer — the flatten stays unaudited.
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
   * No-op on both paths: equities' native bracket keeps leg quantity in sync
   * with the parent at the venue; emulated crypto (#586) arms legs only once
   * the entry goes terminal, so there's nothing to resize before then
   */
  async resizeProtectiveLegs(): Promise<void> {
    // no-op — see doc comment above
  }

  /**
   * Re-arms a residual left by a partial flatten (#525) — `executeExit`
   * already cancelled this lot's entire bracket before the flatten (#516), so
   * there's no live native bracket left to fight over quantity.
   *
   * `order_class: 'oco'`, not another `submitBracket`: the residual is
   * already held, and a bracket's entry leg would try to buy/sell it again.
   * VERIFIED (#550, fixed #586): `take_profit` must be nested (top-level is
   * refused — `oco orders require take_profit.limit_price`), and crypto
   * rejects `order_class: 'oco'` outright, so a crypto residual takes the
   * emulated path instead.
   *
   * The wire id is a FRESH `rearmWireId`, never the original — Alpaca refuses
   * a reused `client_order_id` permanently (measured, #1346/doc 43).
   *
   * `recordBracketOrderIds` is best-effort. Because an OCO's parent order IS
   * its take-profit (no separate leg), the row it writes ends up with
   * `target_order_id` holding the OCO's own parent id, not a bracket-shaped leg id.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the walk's advance invariant ("advancing past an index means its order is not resting", enforced in both directions), the live-preferred-over-settled adoption order, and the three independent size bounds (qty, sizedAboveSettled, entryFilledQty) are each individually documented as load-bearing — two prior restructurings (#1570 review's early-return) were tried and reverted as live-money bugs, so a fresh extraction here repeats a mistake this function's own history already made
  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    rawStop: number,
    rawTarget: number,
  ): Promise<void> {
    // `owns` is authoritative; the `-USD` fallback catches a crypto residual
    // whose journal row is missing, which must REFUSE loudly rather than fall
    // through to an order class the venue is verified to reject
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

    // #983, and BEFORE the adoption comparison below, not at the submit:
    // `rearmOrderMatches` compares against the venue's ROUNDED copy from last
    // time, so rounding only at submit would leave every re-arm permanently
    // mismatched and forced onto the cancel-and-replace branch
    const { stop, target } = roundProtectiveLegsToTick(side, rawStop, rawTarget);

    // `side` is the lot's HELD side; the order that reduces it takes the opposite
    const closingSide = side === 'buy' ? 'sell' : 'buy';

    // ADOPT-OR-PLACE (#549): ask the venue whether a prior re-arm attempt
    // already lives before submitting a new one — it may have succeeded and
    // then crashed before confirmation. Walks `rearmWireId` from attempt 0,
    // since a spent id is refused forever (see `MAX_REARM_ATTEMPTS`)
    //
    // THE WALK READS THE WHOLE ALLOCATED SEQUENCE BEFORE ADOPTING ANYTHING
    // (#1570): stopping at the first adoptable index can point `rearmedLegs`
    // at a terminal no-op while a higher, still-resting attempt is left live
    // and unmanaged behind a cancelled bracket (#516)
    //
    // `live` (a still-resting match) is preferred outright over `settled` (a
    // fully-filled prior, adopted only once its own fill covers every size
    // this lot has been observed to hold since — see `observedSize` below,
    // #1573/#1581) — only one of the two can ever be real protection
    //
    // ADOPTION IS ALLOWLISTED on the raw venue status (#549 review round 3):
    // `mapOrderState` folds every unrecognized status into `'submitted'`, so a
    // blocklist of dead states would let a matching-but-not-resting prior be
    // adopted while nothing actually rests at the venue
    const RESTING_STATUSES = ['new', 'accepted', 'pending_new', 'accepted_for_bidding'];
    let live: AlpacaOrder | null = null;
    let settled: AlpacaOrder | null = null;
    let freeAttempt: number | null = null;
    // Largest size observed at an index above `settled` — the #1573
    // discriminator, reset whenever `settled` moves up
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
      // `partially_filled` belongs with LIVE, not terminal: its remainder is
      // still working at the venue and can still fire (#549) — never treat
      // it as stale, or the walk arms a second leg on top of one still armed
      if (
        priorState === 'partially_filled' ||
        (RESTING_STATUSES.includes(prior.status) && rearmOrderMatches(prior, qty, stop, target))
      ) {
        // Two resting priors on one lot are unreachable through this walk,
        // but the invariant is enforced here rather than assumed: whichever
        // is older is retired
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
        // Live but stale-sized, or a status that doesn't prove it dead:
        // retire it before stepping past. `cancelOrder` tolerates an
        // already-terminal order, so losing the race to its own fill is fine
        await this.call('rearmProtectiveLegs', () => this.input.client.cancelOrder(prior.id));
      }
    }

    // `live` beats `settled`: only a still-resting OCO can still fire; a fully
    // `settled` one already closed itself, so adopting it means the lot is
    // flat, not naked
    //
    // That holds only while the fill covers every size this lot has held
    // since (#1573/#1581): a post-re-arm entry fill can grow the residual past
    // what `settled` closed, leaving a genuinely-naked remainder behind it
    // `observedSize` therefore takes the max of `qty`, the size of any attempt
    // allocated above `settled`, and (#1581) a fresh venue read of this lot's
    // own entry `filled_qty` — three independent, sometimes-stale views, since
    // none alone covers every ingestion-race timing. `settled` is adopted only
    // once its own fill covers that max; anything less is treated as naked and
    // a fresh OCO is placed instead
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
      // parent id is the take-profit
      this.state.recordBracketOrderIds('alpaca', clientOrderId, {
        entry_order_id: null,
        stop_order_id: legOrderIds(adopted.legs).stop_order_id,
        target_order_id: adopted.id,
      });
      return;
    }

    if (freeAttempt === null) {
      // Every id is owned by an order not protecting this residual, and
      // Alpaca never releases one, so no later pass can help either —
      // `ProtectiveRearmUnsupportedError` routes callers to re-flatten instead
      // Thrown OUTSIDE `this.call`: `sanitizeBrokerError` would erase the
      // discriminant this error type exists to carry
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
    // NOT `legOrderIds(response.legs)`: an OCO's take-profit is the TOP-LEVEL
    // order itself, not a scanned `.legs` entry — `.legs` here holds only the
    // stop-loss child, so `target_order_id` is set directly
    this.state.recordBracketOrderIds('alpaca', clientOrderId, {
      entry_order_id: null,
      stop_order_id: legOrderIds(response.legs).stop_order_id,
      target_order_id: response.id,
    });
  }

  /**
   * #1123: observability, not enforcement — WARNS, never clamps. A real
   * violation should be fixed at the source, not papered over here.
   *
   * Compares against a per-key submission bound, not the global `since`
   * floor: an old, never-cancelled bracket is re-polled every sweep and would
   * otherwise trip this constantly once `since` has moved past it. Silent for
   * a post-restart bracket/flatten, which has no local proxy to compare against.
   *
   * `submittedAt` is this host's own clock; `filled_at` is the venue's — the
   * first suspect on a warning is host clock skew, not the venue. Throttled
   * to first sighting per lot+LEG (`warnedSinceFloorViolations`), not per lot
   * alone, so one leg's warning can't mask a genuine violation on another.
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
    // Keyed by lot AND leg, not lot alone (round-2 review): a lot-only key
    // would let the entry leg's first warn permanently suppress a genuine
    // violation on the re-armed target leg of the same lot (#1087)
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
   * Fill feed `ingestFills()` drains; never returns a fill dated before `since`.
   * Alpaca's `getOrder` reports cumulative `filled_qty` per order, not one
   * event per partial fill, so a leg filling in tranches between polls is
   * normalized here as a single fill carrying the cumulative quantity as of
   * first observation.
   *
   * Sweeps `brackets`, `flattens` (#517), and re-armed legs; each bracket is
   * isolated so one malformed order can't starve every bracket submitted
   * after it (`ingestFills()` awaits this as one call before advancing any lot).
   *
   * A refused unpriced fill is remembered (#298) and escalated once stuck too
   * long — see `escalateAgedUnpricedFills`.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const fills: NormalizedFill[] = [];
    const failures: unknown[] = [];
    /**
     * #842: fallback date for a fill the venue reports FILLED but doesn't
     * DATE. Read once for the whole sweep so two legs of the same bracket
     * can't be ordered against each other by clock jitter alone.
     */
    const observedAt = this.clock.now();

    const bracketFailures = await this.sweepBrackets(since, observedAt, fills, failures);
    const flattenFailures = await this.sweepFlattens(since, observedAt, fills, failures);
    const rearmFailures = await this.sweepRearmedLegs(since, observedAt, fills, failures);

    // Emulated-crypto sweep (#586) — polls each emulated bracket's plain
    // entry/stop/target orders and drives the journalled phase machine
    // Same isolation and UnpricedFillError bookkeeping as the three loops above
    const emulationFailures = await this.emulation.sweep(since, fills, failures);

    // The venue caught up: resolve the anomaly row for each fill collected
    // above. Done here, not in `collectFill`, so the normalizer stays pure.
    try {
      for (const fill of fills) {
        this.state.clearUnpricedFill('alpaca', fill.client_order_id, fill.broker_fill_id);
      }
    } catch (stateError) {
      // A stale row only risks one redundant alert; losing the sweep loses real fills
      failures.push(stateError);
    }

    // Before the throw below, and unconditionally: escalation must not depend
    // on whether some OTHER bracket happened to produce a fill this sweep
    await this.escalateAgedUnpricedFills(failures);

    // #609: log every accumulated failure BEFORE the throw/return split below
    // decides — previously, on any poll where `fills.length > 0`, `failures`
    // fell out of scope entirely unreported. Diagnosis-only: doesn't change
    // what `fetchNewFills` returns or throws
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
          // All four sweeps funnel through the same `this.call('fetchNewFills', ...)`
          // operation name; these counts restore which loop a failure came from
          bracket_failures: bracketFailures,
          flatten_failures: flattenFailures,
          rearm_failures: rearmFailures,
          emulation_failures: emulationFailures,
          fills_read: fills.length,
        },
      );
    }

    // Progress wins when there is any — dropping good fills to report a bad
    // bracket would re-create the stall this isolation removes. A wholly-failed
    // sweep must not be reported as the "no new fills" an empty array means
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
   * Shared by the bracket/flatten/rearm sweeps below: an `UnpricedFillError` is a MODELLED, EXPECTED
   * condition (#298), not a failure, so it is journaled and NOT counted unless the journal write itself
   * throws (#524 review). Returns the count to add to the caller's own failure tally (0 or 1).
   */
  private recordSweepError(error: unknown, failures: unknown[]): number {
    if (error instanceof UnpricedFillError) {
      try {
        this.state.recordUnpricedFill('alpaca', error.observation, this.clock.now());
        return 0;
      } catch (stateError) {
        failures.push(stateError);
        return 1;
      }
    }
    failures.push(error);
    return 1;
  }

  /**
   * Bracket half of the sweep. Snapshots `this.brackets` at entry (#290)
   * since a Map iterator visits entries inserted mid-iteration, and a
   * bracket submitted during this sweep must not be drained by a stale
   * `since`. Returns its own failure count, apart from `failures` (which
   * also holds journal/alert failures, #298), so the soak log doesn't
   * point at an order that was never the problem.
   */
  private async sweepBrackets(
    since: Date,
    observedAt: Date,
    fills: NormalizedFill[],
    failures: unknown[],
  ): Promise<number> {
    let bracketFailures = 0;
    // oxlint-disable-next-line unicorn/no-useless-spread -- the snapshot is the point: a bracket submitted mid-pass must not join THIS pass's worklist (PR #290 review)
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
        // Skipped, not swallowed — this bracket is retried next sweep, same
        // as an order the venue hasn't reported yet; `ingestFills()` dedups
        // on `broker_fill_id` so re-polling costs nothing
        bracketFailures += this.recordSweepError(error, failures);
      }
    }
    return bracketFailures;
  }

  /**
   * Flatten half of the sweep — structurally the bracket loop above with no
   * `.legs` and `leg: 'exit'` fixed instead of derived per-leg.
   *
   * `flattens` is in-memory only, unlike `brackets` (loaded from `state` at
   * startup): a flatten is a one-shot IOC order that fully resolves before
   * this process could poll it again, so the only restart risk is the
   * submit-to-first-poll window — closed by `reconcile()` replaying
   * unresolved `flatten_submissions` rows through `resumeFlatten` (#519/#526).
   *
   * Pruned only AFTER `collectFill` runs this poll, never before, so a
   * terminal fill can't be dropped by pruning ahead of collection — unlike
   * `brackets`, which is never pruned since a bracket keeps mattering after
   * its entry fills.
   */
  private async sweepFlattens(
    since: Date,
    observedAt: Date,
    fills: NormalizedFill[],
    failures: unknown[],
  ): Promise<number> {
    let flattenFailures = 0;
    // oxlint-disable-next-line unicorn/no-useless-spread -- the snapshot is the point: a flatten submitted mid-pass must not join THIS pass's worklist (PR #290 review)
    for (const [clientOrderId, orderId] of [...this.flattens]) {
      try {
        const order = await this.call('fetchNewFills', () => this.input.client.getOrder(orderId));
        const instrument = fromAlpacaSymbol(symbolOf(order));
        // #1415: `flattens` is keyed by the exit's own idempotency_key, a
        // different key space from `bracketSubmittedAt` — see `flattenSubmittedAt`
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
        // Same isolation/UnpricedFillError bookkeeping as the bracket loop
        // above (`recordSweepError`) — an unpriced flatten fill never reaches
        // the `mapOrderState`/`delete` line, so it's retried next poll, never
        // pruned mid-unpriced
        flattenFailures += this.recordSweepError(error, failures);
      }
    }
    return flattenFailures;
  }

  /**
   * Re-arm sweep (#525) — structurally the flatten loop above, keyed by the
   * lot's own `idempotency_key` (not the OCO's wire id, per `rearmedLegs`'
   * doc) with the top-level order tagged `'target'` since an OCO's parent
   * order IS the take-profit leg (`rearmProtectiveLegs`'s doc), not a bare
   * market order. Pruned once terminal, same asymmetry with `brackets` as
   * `flattens` documents.
   */
  private async sweepRearmedLegs(
    since: Date,
    observedAt: Date,
    fills: NormalizedFill[],
    failures: unknown[],
  ): Promise<number> {
    let rearmFailures = 0;
    // oxlint-disable-next-line unicorn/no-useless-spread -- the snapshot is the point: a rearm submitted mid-pass must not join THIS pass's worklist (PR #290 review)
    for (const [lotKey, orderId] of [...this.rearmedLegs]) {
      try {
        const order = await this.call('fetchNewFills', () => this.input.client.getOrder(orderId));
        const instrument = fromAlpacaSymbol(symbolOf(order));
        // #1123: `rearmedLegs` is keyed by the lot's own `idempotency_key`,
        // the same key space `bracketSubmittedAt` uses, so the original
        // bracket's submission-time bound still applies here
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
        // Same isolation and bookkeeping as the bracket and flatten loops
        // above (see `recordSweepError`'s doc)
        rearmFailures += this.recordSweepError(error, failures);
      }
    }
    return rearmFailures;
  }

  /**
   * The age-out (#298). Sweeps the RECORDED anomalies, not just ones this
   * pass re-observed, so escalation doesn't depend on whether the venue
   * still reports the order or it's still in the bracket index.
   *
   * Alerts ONCE per fill: `alerted_at` is written only AFTER the channel
   * accepts the alert, so a channel outage is retried next sweep instead of
   * being marked delivered.
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
        // The channel's own error is discarded, never re-thrown or attached:
        // a Telegram transport failure quotes the request it failed on, and
        // that URL carries the bot token. What is replaced cannot leak.
        failures.push(
          new Error(
            `Alpaca unpriced-fill alert delivery failed for order ${record.broker_fill_id} ` +
              `(${record.leg} leg of '${record.client_order_id}')`,
          ),
        );
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
        // Delivered but not recorded: next sweep alerts again. Noisy, never silent.
        failures.push(stateError);
      }
    }
  }
}

/**
 * `AlpacaOrder.symbol` is declared non-optional, so `'unknown'` only fires on
 * a payload that already contradicts the contract — trading a less
 * informative alert for no alert at all rather than reaching a NOT NULL column
 */
function symbolOf(order: AlpacaOrder): string {
  return typeof order.symbol === 'string' && order.symbol.length > 0 ? order.symbol : 'unknown';
}

/**
 * Whether a prior re-arm OCO found under one of this lot's `rearmWireId`s
 * protects exactly what THIS attempt would place (#549 review): same `qty`,
 * same take-profit limit (the OCO's top-level `limit_price` — an OCO's
 * take-profit is the parent order itself), same stop trigger. Comparisons are
 * `Number(...) === value` since the request stringified these exact numbers
 * on the way out and round-trips losslessly; a prior missing any price field
 * fails the match rather than adopt unverifiable protection.
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
 * Shared by `getOrder`/`resumeFlatten`, which diverge only in which
 * in-process map they warm (`brackets` vs `flattens`), never in this shape
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
  return leg.type === 'limit' ? 'target' : 'stop';
}
