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
// The shared normalization layer (PR #600 review): both this adapter and the
// crypto emulation consume it, and neither imports the other's runtime code
// back — the module split is what keeps that an acyclic graph
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

/**
 * How many wire ids one lot's protective re-arms may consume before the adapter
 * refuses. Bounded for `MAX_EXIT_RETRY_ATTEMPTS`' reason (execute.ts): each step
 * costs a lookup, and an unbounded walk would silently absorb a runaway instead
 * of surfacing it.
 *
 * MEASURED 2026-09-15 against Alpaca paper (#1346, docs/research/43 round 3):
 * a `client_order_id` is consumed PERMANENTLY. Reuse is `422` while the prior
 * rests (`code 42210000`), `422` the instant after it goes `canceled`
 * (`code 40010001`), `422` 90 s later, and `422` against a 13-day-old canceled
 * row. So each re-arm that ends up cancelled burns its id for good, and a lot
 * that re-arms more than once needs a wire id it has not spent yet.
 *
 * A COUNT OF IDS, indexed from ZERO — `4` means attempts `0..3`, whose wire ids
 * are `:rearm`, `:rearm-1`, `:rearm-2`, `:rearm-3`. `MAX_EXIT_RETRY_ATTEMPTS`
 * (execute.ts) spells the SAME four-candidate budget as `3`, because its walk
 * counts the base key as attempt zero and the constant as the last SUFFIX.
 * Nothing derives one bound from the other; the two spellings are a naming
 * inconsistency, not an arithmetic difference.
 */
const MAX_REARM_ATTEMPTS = 4;

/**
 * Attempt 0 keeps the bare `:rearm` suffix — an OCO placed by a build from
 * before #1346 must still be found by the walks below rather than orphaned —
 * and later attempts index it the way `resolveExitRetryKey` indexes `:retry-N`.
 * One colon only: a second would invite a splitter somewhere to disagree about
 * which half is the lot key.
 */
const rearmWireId = (clientOrderId: string, attempt: number): string =>
  attempt === 0 ? `${clientOrderId}:rearm` : `${clientOrderId}:rearm-${attempt}`;

/**
 * Which attempt a venue row's `client_order_id` belongs to for this lot, or
 * null if it is not one of this lot's re-arm ids. Exact match against the
 * generated ids rather than a `startsWith` prefix: a prefix also matches a
 * DIFFERENT lot whose own key happens to begin with this one, and the caller
 * uses the index to pick which order to cancel.
 */
const rearmAttemptOf = (clientOrderId: string, wireId: string): number | null => {
  for (let attempt = 0; attempt < MAX_REARM_ATTEMPTS; attempt += 1) {
    if (rearmWireId(clientOrderId, attempt) === wireId) return attempt;
  }
  return null;
};

export interface AlpacaBrokerAdapterInput {
  client: AlpacaBrokerClient;
  /**
   * Optional so existing wiring (server/apps/orchestrator/production.ts) keeps
   * working; when absent the adapter still paces itself rather than running
   * unlimited — see the default below
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
   * Log-only is a legitimate implementation (the catalogue's log line, the
   * production default until a `TelegramClient` is wired at the composition
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

/** One by-client-order-id lookup's outcome: the venue's answer, or why there is none */
type LookedUpOrderId = { id: string | null } | { error: unknown };

export class AlpacaBrokerAdapter implements BrokerAdapter {
  /** client_order_id -> the bracket parent's Alpaca order id */
  private readonly brackets = new Map<string, string>();
  /**
   * client_order_id -> a local clock read taken before `submitBracket`'s POST.
   * #1123: this adapter has no `SharedStore` access to the lot's own
   * `opened_at`, so `fetchNewFills` uses this as a same-lot proxy bound to
   * flag (never clamp) a fill dated earlier than it. The two are NOT equal:
   * `execute.ts` reads `opened_at` BEFORE `captureSubmitSnapshot`
   * (deliberately unbounded) and `writeAheadPosition`, both of which run
   * before `submitBracket` is even called — so `opened_at <= bracketSubmittedAt`,
   * never the reverse. The check this enables is therefore a SUPERSET test:
   * it never misses a real violation on a bracket this process itself
   * submitted (`filledAt < opened_at` implies `filledAt < bracketSubmittedAt`),
   * but a BENIGN fill landing in `[opened_at, bracketSubmittedAt)` — no true
   * violation — can still trip it (see `auditSinceFloorInvariant`'s doc for
   * the likeliest real-world cause: host/venue clock skew). Reading the clock
   * right before the POST, rather than after (next to `brackets.set` below),
   * is still the tightest bound this adapter can offer without `opened_at`
   * itself: it cannot narrow the gap above, only avoid widening it further by
   * the request's own round trip.
   * Populated only from `submitBracket` (first-write-wins) and, UNLIKE
   * `brackets`, never deleted — not even by `cancel()`, which prunes
   * `brackets` on a confirmed cancel but has no reason to touch this map.
   * So after a cancel this key set is NOT a subset of `brackets`' CURRENT
   * keys — it can hold an entry `brackets` has already dropped. It IS a
   * subset of every `client_order_id` this process has ever itself
   * submitted a bracket for, cumulative across cancels (`brackets` also
   * gains entries from the constructor's `loadBrackets` restore and from
   * `getOrder`'s recovery path, neither of which has a same-process clock
   * read to offer, so those stay unaudited — see `auditSinceFloorInvariant`'s
   * doc). This is a real, if slow, growth axis distinct from `brackets`':
   * bounded by total distinct lots ever submitted over the process's life,
   * not by however many are open now.
   */
  private readonly bracketSubmittedAt = new Map<string, Date>();
  /**
   * `${client_order_id}:${leg}` -> already logged. #1123: the fill sweep
   * never prunes `brackets`, so a genuinely violating, still-tracked bracket
   * is re-polled every sweep and would otherwise warn every time — one
   * bracket, unbounded log volume. This throttles to first sighting per
   * LOT+LEG, same shape as ca8f2b9 (#1376)'s per-kind throttle.
   *
   * Keyed by lot+leg, not lot alone (round-2 review): the bracket loop
   * (entry + its legs) and the re-arm loop share one `client_order_id` per
   * lot, so a lot-only key let one leg's first warn (typically the entry,
   * polled first) permanently suppress a genuine, DIFFERENT violation on
   * another leg of the same lot — silently masking exactly the exit-leg
   * violations #1087's wedge failure mode is about.
   *
   * Same non-pruning as `bracketSubmittedAt` above, for the same reason
   * (nothing, including `cancel()`, has cause to prune it) and the same
   * growth bound: total distinct (lot, leg) pairs ever warned about over the
   * process's life, not however many lots are open now.
   */
  private readonly warnedSinceFloorViolations = new Set<string>();
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
   * client_order_id (the EXIT's own idempotency_key `submitFlatten`'s caller
   * passes — NOT the lot's) -> a local clock read taken before
   * `submitFlatten`'s POST. #1415: the flatten-sweep counterpart of
   * `bracketSubmittedAt` above. The two cannot share one map the way
   * `rearmedLegs` shares `bracketSubmittedAt`'s key space (#1123) — a
   * flatten's client_order_id is a different value from its lot's, minted by
   * `buildExitIntent` via `computeIdempotencyKey` (trader/decide.ts);
   * `executeExit` only ever derives a `:retry-N` suffix from it
   * (`resolveExitRetryKey`, execute.ts), it does not mint the base key.
   * Same first-write-wins population (a retried/idempotent resubmission
   * under the same client_order_id must not move the bound past a fill the
   * true first submission already covers) and the same accepted gap:
   * `resumeFlatten` (below) has no same-process clock read to offer, so a
   * flatten resumed after a restart has no entry here and stays unaudited —
   * the same asymmetry `bracketSubmittedAt`'s doc describes for a
   * `getOrder`-restored bracket. Pruned alongside `flattens` (below) — once
   * `flattens` drops a client_order_id on a terminal fill, this bound can
   * never be read again, so keeping it around past that point would only be
   * a leak.
   */
  private readonly flattenSubmittedAt = new Map<string, Date>();
  /**
   * lot's `idempotency_key` -> the re-armed OCO's Alpaca order id (#525).
   * Keyed by the LOT, not by the OCO's own wire `client_order_id`
   * (a derived `rearmWireId`) — `fetchNewFills`'s rearm sweep below tags fills
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
  /** #609 — see `AlpacaBrokerAdapterInput.logger`'s doc for why this has no default */
  private readonly logger: Logger;

  constructor(private readonly input: AlpacaBrokerAdapterInput) {
    // `{ logger, name: 'alpaca' }` (#1083): the production root always injects
    // `rateLimiter` (`production.ts`'s shared `alpacaBucket`, wired the same
    // way), so this default is a fallback for a caller that constructs the
    // adapter standalone — a tool or a test with no injected bucket. Telemetry
    // is wired here too so that path is not silently worse-observed than the
    // production one
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

    // Synchronous, in the constructor: the first `fetchNewFills` sweep after a
    // restart iterates this map, and an empty one reports "no new fills" —
    // indistinguishable, above the adapter, from a quiet market
    for (const record of this.state.loadBrackets('alpaca')) {
      // Emulated crypto rows belong to the emulation, which rehydrated them
      // in its own constructor above — polling them here too would sweep the
      // same orders twice and drive no state machine
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
   * Cancels the order and, on a bracket, its attached legs with it — Alpaca
   * cancels a parent's children as part of cancelling the parent. ALSO
   * cancels a re-armed residual's protective OCO (#525 follow-up), which
   * the lookup above cannot find on its own: `rearmProtectiveLegs` submits
   * that order under a derived `rearmWireId`, a DIFFERENT client order id
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
   * **ORDER IS LOAD-BEARING (#867). Every LOOKUP happens before ANY
   * destructive call, and the re-arm is cancelled BEFORE the original
   * bracket.** The fail-closed posture above is only sound while the
   * refusal leaves the position no MORE exposed than it already was, and
   * the shape this method had between #546 and #867 broke that: it
   * cancelled the bracket first and only THEN issued the re-arm lookup —
   * a lookup that runs for EVERY lot on EVERY exit, including the common
   * lot that never had a re-arm at all. A degraded venue, an auth blip, or
   * a timeout outliving the transport's retries therefore threw with the
   * lot's stop and target ALREADY GONE; `executeExit` refused the flatten,
   * and the lot sat open, naked, and un-alerted. Hoisting both lookups
   * above both cancels makes a lookup failure abort with protection fully
   * intact, which is the only state in which refusing the flatten is the
   * safer answer.
   *
   * Cancelling the re-arm FIRST then makes the ORIGINAL bracket's cancel
   * the LAST destructive act, so a throw from this method leaves at most
   * one unconfirmed cancel behind rather than one confirmed removal plus a
   * failure. That ordering is safe because a bracket and its lot's re-arm
   * are never BOTH live: `rearmProtectiveLegs` is only ever reached
   * downstream of a successful `cancel()` of that bracket
   * (`maybeRearmResidual` in residual-protection.ts, once a flatten fill lands,
   * and `sweepResidualProtection`'s retry of a lot that path already
   * marked) — so when a re-arm exists the original bracket is already
   * terminal, and the bracket cancel below is a venue no-op that
   * `cancelOrder` resolves on `404`/`422` rather than throwing
   * (alpaca-http-client.ts). **Anyone reordering these two cancels back
   * must re-check that precondition first.**
   *
   * The residual this does NOT close: a `cancelOrder` whose RESPONSE is
   * lost may have cancelled at the venue anyway, so a throw from this
   * method never PROVES protection survived — it only proves this adapter
   * could not confirm it is gone. `executeExit`'s catch owns that residue;
   * see its comment on the cancel loop.
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
    // re-arm lookup below is the EQUITY OCO's naming scheme and does not
    // apply (emulated re-arm legs are cancelled by the same journal walk)
    if (this.emulation.owns(clientOrderId)) {
      await this.emulation.cancelAll(clientOrderId);
      return;
    }

    // --- LOOKUPS (non-destructive). #867: everything that can throw while
    // the lot is still protected happens HERE, above the first cancel
    const { order, rearmedOrder } = await this.resolveCancelTargets(clientOrderId);

    // --- CANCELS (destructive). Re-arm first, original bracket last — see
    // the doc comment for why that ordering is both safe and required
    if (rearmedOrder !== null) {
      await this.call('cancel', () => this.input.client.cancelOrder(rearmedOrder));
      // Deleted only now, after the cancel is confirmed — not before, and
      // not merely on finding it: a `cancelOrder` throw above must leave
      // the map (and the venue) exactly as they were, so a retried cancel
      // finds the same order again rather than believing it already gone
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
    // entry (PR #290 review, deepseek)
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
