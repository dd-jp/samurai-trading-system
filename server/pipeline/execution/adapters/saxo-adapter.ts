/**
 * `BrokerAdapter` over Saxo OpenAPI (#1032 item 1) — the live equity venue
 * per ADR-0015's 2026-08-30 amendment. Same seam, journal and error boundary
 * as `AlpacaBrokerAdapter`; what differs is forced by the venue:
 *
 * - Saxo has no durable client-order-id idempotency (doc 43): a duplicate
 *   guard refuses an identical body + `x-request-id` for a rolling 15 s
 *   window with 409, then places again. `ExternalReference` is echoed but
 *   never uniqueness-checked. So every placement is ADOPT-OR-PLACE: look the
 *   `ExternalReference` up on open orders and the audit trail first, place
 *   only if absent, and treat a 409 as "look again", never as failure.
 * - The bracket is an IfDone master (Limit entry) with two related orders
 *   (`StopIfTraded` stop, `Limit` target). The venue holds the state machine
 *   and cancels the related orders with the master on an explicit cancel
 *   (VERIFIED, doc 43). `cancel` leans on exactly that: it DELETEs the
 *   master alone, so no leg is ever named from an open-orders snapshot the
 *   entry can fill out of underneath it (#1216). What Saxo does to a
 *   `DayOrder` master's own related orders when it EXPIRES unfilled at
 *   session end, rather than being cancelled, is UNVERIFIED (#1215) — this
 *   adapter defends only the branch where Saxo leaves them `NotWorking`
 *   (parked, never activated): `findOpen` / `lookup` corroborate that read
 *   against the audit trail before cancelling (#1215 round 1), and so does
 *   `cancel` now, rather than journalling a phantom fill. A
 *   corroboration that never resolves (no terminal audit row ever lands) is
 *   paged, repeatedly, rather than deferred forever or cancelled without
 *   evidence (#1215 round 2 — `escalateIfStale`). If Saxo instead ACTIVATES
 *   the legs on expiry the same way it would on a genuine fill (`Working` on
 *   the book), that read is indistinguishable from a real fill by `Status`
 *   alone — the overnight-resting risk this ticket names lives entirely on
 *   that branch and is UNCHANGED by this fix.
 * - `IsOcoOrderSupported` is false on every pool line, so an entry-less
 *   protective pair cannot be expressed; `rearmProtectiveLegs` throws
 *   `ProtectiveRearmUnsupportedError` — a PERMANENT refusal, so the #549
 *   sweep pages for manual action instead of retrying it forever (#1214).
 * - Amounts are whole units (`MinimumLotSize` 1, `OddLotsNotAllowed`) and
 *   prices carry `OrderDecimals` 2 on every pool line.
 * - Prices cross this boundary in the VENUE's unit, which on an LSE GBX line
 *   is pence while the line settles in GBP (#1302). Everything above the
 *   adapter speaks cash; `saxo-price-unit.ts` is the only place either
 *   direction is converted, and `SaxoInstrumentRef` carries the factor the
 *   venue itself publishes per instrument.
 */
import { createHash } from 'node:crypto';
import type { Clock, Logger } from '../../../shared/index.js';
import { escalatesAt, safeLog, toBrokerFillId } from '../../../shared/index.js';
import { SAXO_COMMISSION_RATE } from '../../../tools/backtest/index.js';
import { sanitizeBrokerError } from '../broker-error.js';
import {
  type BrokerStateStore,
  InMemoryBrokerStateStore,
  toRequestFields,
} from '../broker-state-store.js';
import type { DormantLegsUnresolvedAlertChannel } from '../dormant-legs-unresolved-alert.js';
import type { LegResizeUnverifiedAlertChannel } from '../leg-resize-unverified-alert.js';
import { ProtectiveRearmUnsupportedError } from '../protective-rearm-unsupported.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../types.js';
import type { UnresolvedPriceUnitAlertChannel } from '../unresolved-price-unit-alert.js';
import {
  isDuplicateRequestRefusal,
  isOrderNotFound,
  SaxoBrokerProviderError,
} from './saxo-broker-errors.js';
import type {
  SaxoAssetType,
  SaxoBuySell,
  SaxoDurationType,
  SaxoOpenApiClient,
  SaxoOpenOrder,
  SaxoOrderActivity,
  SaxoOrderPlacement,
  SaxoOrderRequest,
} from './saxo-client.js';
import { type SaxoQuoteUnit, saxoCashPerShare, saxoQuotedPrice } from './saxo-price-unit.js';

/** Measured on SIM 2026-09-05: identical placements 17 s apart both landed; inside the window the second earned 409 (doc 43). */
const SAXO_DUPLICATE_WINDOW_MS = 15_000;

/**
 * How far back a PLACEMENT looks on the audit trail before posting. Nothing
 * older than the venue's duplicate window can be a lost reply to this same
 * attempt, and the caller's own write-ahead (`open_positions`) is the durable
 * dedup across restarts — so the placement path pays for a few windows of
 * activity, not the 30-day sweep `getOrder`/`resumeFlatten` need.
 */
const PLACEMENT_LOOKBACK_MS = 4 * SAXO_DUPLICATE_WINDOW_MS;

/**
 * Saxo's `ExternalReference` limit. `:target` is the longest suffix this
 * adapter itself appends.
 *
 * `computeIdempotencyKey` returns a 64-character sha256 hex digest, which
 * alone overruns this before any suffix — `:retry-N` (execute.ts) or
 * `:residual-reflatten-N` (residual-reflatten.ts, #1214) a caller may have
 * already appended makes it worse. #1510 (David, 2026-09-14, option 1):
 * `computeIdempotencyKey` stays 64 hex — it is a documented invariant for the
 * store and Alpaca (CONTEXT.md, trader-spec.md, #1487) — and this adapter
 * alone derives a second, narrower venue identity via
 * `saxoExternalReference`, translating back to the full `client_order_id` on
 * every read path (`attribute`, via `wireReferences`). No other seam
 * shortens the key.
 */
const EXTERNAL_REFERENCE_MAX_CHARS = 50;
const LEG_SUFFIX_MAX_CHARS = ':target'.length;

/**
 * Fixed output width of `saxoExternalReference`. Chosen so a leg reference —
 * the longest suffix this adapter appends — stays inside
 * `EXTERNAL_REFERENCE_MAX_CHARS` with headroom (40 + 7 = 47 of 50).
 * Collision risk at 40 hex is 2^160, immaterial at this order rate (#1510
 * decision) — rejected the alternative of truncating `computeIdempotencyKey`'s
 * own 64-hex digest for the same reason `saxoExternalReference` hashes the
 * WHOLE `client_order_id` rather than slicing it: a caller's own retry/
 * residual-reflatten suffix must still produce a DISTINCT venue reference —
 * those suffixes exist so a retry is a genuinely new attempt (execute.ts
 * `resolveExitRetryKey`), and slicing the pre-suffix digest would collapse
 * every retry of one order onto the same `ExternalReference`.
 */
const SAXO_REFERENCE_HEX_CHARS = 40;

/**
 * The venue-side identity for a `client_order_id` (#1510) — a fixed-width
 * digest, never a truncation of `computeIdempotencyKey`'s own output (see
 * `SAXO_REFERENCE_HEX_CHARS`). One-way: nothing recovers `client_order_id`
 * from this value alone, so every caller that must go the other way reads
 * `wireReferences` instead (populated by `registerWireReference` wherever a
 * `client_order_id` first becomes known to this adapter).
 */
export function saxoExternalReference(clientOrderId: string): string {
  return createHash('sha256')
    .update(clientOrderId)
    .digest('hex')
    .slice(0, SAXO_REFERENCE_HEX_CHARS);
}

/**
 * `OrderDecimals` observed on every pool line's instrument details. Applied
 * AFTER `saxoQuotedPrice`, so on a GBX line it rounds two decimals of PENCE
 * (0.0001 GBP). That this is the grid the venue accepts there is UNVERIFIED
 * (#1302 AC3): `OrderDecimals` states precision, not the tick grid, and no
 * order was ever placed on a GBX line — see `saxoQuotedPrice`'s own doc.
 */
const ORDER_DECIMALS = 2;

/**
 * How far back `getOrder`/`resumeFlatten` read the audit trail when an id is
 * not open. Orders are DayOrder under ADR-0014's flat-by-close, so anything
 * older than this is a restart across many sessions, not a live lot.
 */
const DEFAULT_ACTIVITY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Consecutive observations — by `lookup()` or by `cancel()`'s re-read, which
 * share one counter per reference (`corroborateDormantLegs`) — of legs
 * dormant that this adapter could not resolve, before the FIRST
 * `DormantLegsUnresolvedAlert` — see `escalateIfStale`. Sharing means a
 * flat-by-close `cancel` and the `reconcile` poll that follows it page
 * between them where two polls were needed before #1216: intended, since the
 * wedge is a property of the reference and each answered observation is
 * equal evidence of it, whichever path made the call. That sequence is what
 * the live loop actually produces (`reconcile()` runs `getOrder` on the same
 * key every poll), so the `masterSeenOpen` fact the two share has to be
 * per-reference for the pair to add up at all — see `DormantDeferRecord`.
 * The refusal count is namespaced away from this one and bounded the same
 * way; see `dormantDefer`. A wall-clock age was
 * considered and rejected: this adapter is never told the poll cadence, but
 * every call that reaches this branch already counts one observation, the
 * same shape `FilledZeroSizeThrottle.observe` counts consecutive wedged
 * polls on. Fewer polls of grace than that throttle's `ALERT_AFTER_
 * CONSECUTIVE_ZERO_SIZE` (3) is deliberate: a resting order with no master
 * open AND no terminal audit row is already an abnormal shape (doc 43 never
 * measured it as the normal DayOrder lifecycle), unlike a legitimate fill-
 * feed propagation lag, so the grace here exists only to absorb the one
 * genuine race `findOpen` and `listOrderActivities` can produce between
 * themselves (two separate network calls, not one atomic read) — a single
 * lucky poll where the legs left the open list a beat before the audit
 * trail caught up. A second consecutive occurrence rules that out.
 *
 * "Consecutive" counts consecutive ANSWERED defer observations only: a
 * `listOrderActivities` throw reaches the caller before `escalateIfStale`
 * runs, so it neither advances nor resets the count (`reconcileLot` leaves
 * the record untouched on a throw for the same reason — ignorance is not
 * evidence either way, so it must not silently clear a wedge that outlives
 * one flaky poll).
 *
 * The wall-clock rejection above is about THIS bound only — the grace before
 * the FIRST alert, which exists to absorb one race between two network calls
 * and is equally sound however fast or slow those calls arrive. The REPEAT
 * bound once alerting has already started is a different question (how often
 * a human should be paged, not how many observations rule out a race) and is
 * wall-clock for exactly that reason — see `DORMANT_DEFER_ALERT_REPEAT_EVERY_MS`.
 */
export const DORMANT_DEFER_ALERT_AFTER = 2;

/**
 * How often the alert repeats while the master stays unresolved, in
 * wall-clock milliseconds since the previous alert — NOT a poll count.
 *
 * It used to be: 8 further consecutive defer observations, the same
 * poll-count-8 shape `ALERT_REPEAT_EVERY_DIAGNOSTICS` (trader-diagnostic-
 * alert.ts) uses. That borrowed the number without adjusting for what it
 * multiplies: `ALERT_REPEAT_EVERY_DIAGNOSTICS` counts Trader ticks, which run
 * every 15 MINUTES (ADR-0008), so its 8 lands two hours apart. This alert's
 * "poll" is `lookup()`/`cancel()`'s corroboration read, which runs on
 * `DEFAULT_FILL_POLL_INTERVAL_MS` (defaults.ts) — 15 SECONDS, a 60x faster
 * cadence — so the same "8" repeated every ~2 minutes: ~480 pages over a 12h
 * unattended overnight session, a pager-flood rate, not a warn rate.
 * `fillPollIntervalMs` is also caller-configured (`production.ts`), so any
 * poll count is only ever correct at its default — the exact defect
 * `FilledZeroSizeThrottle` was rebuilt to stop having, for the same reason
 * (#1383, `filled-zero-size-throttle.ts`): "a poll-count repeat … would make
 * re-announcement frequency a silent function of that cadence instead of a
 * stated interval." This constant takes that fix's shape instead of its
 * value — `FilledZeroSizeThrottle` warns once then drops to low-cadence
 * `info`, which does not fit here: ruling (c) (#1215 round 2) requires a
 * wedge to keep paging, audibly, for as long as the audit trail stays
 * silent, so there is deliberately no cap and no escalation ladder, only a
 * floor on how often the SAME page repeats.
 *
 * 15 minutes: frequent enough that an unattended overnight wedge is not
 * mistaken for a resolved one between pages, rare enough that even a
 * multi-hour wedge produces a page count (~48 over 12h) an operator's pager
 * app will not auto-mute. Independent of `fillPollIntervalMs` by
 * construction, so a future change to that interval cannot silently change
 * this one.
 */
export const DORMANT_DEFER_ALERT_REPEAT_EVERY_MS = 15 * 60_000;

interface DormantDeferRecord {
  readonly consecutive: number;
  readonly firstObservedAt: Date;
  /**
   * A `cancel` on this reference read the master OPEN and its DELETE then
   * answered `OrderNotFound`. It outlives that one call because the polls
   * that follow re-read the same wedge through `lookup`, which has no master
   * of its own to see and would otherwise take its cancel-on-silence verdict
   * and strip the legs `cancel` had just refused to (#1216 round 2).
   *
   * Meaningful on the bare-reference key only. The `refusedKey` namespace
   * counts a settled `Filled` answer, where nothing is corroborating and no
   * caller reads this, so it is recorded `false` there.
   */
  readonly masterSeenOpen: boolean;
  /**
   * Epoch ms of the last `DormantLegsUnresolvedAlert` this reference
   * produced; `0` before the first alert. Read back by
   * `dueForDormantDeferAlert` against `DORMANT_DEFER_ALERT_REPEAT_EVERY_MS` —
   * see that function's own doc.
   */
  readonly lastAlertedAtMs: number;
}

/** `dormantDefer`'s namespace for the refusal counter — see that map's doc. */
function refusedKey(externalReference: string): string {
  return `refused:${externalReference}`;
}

/**
 * Whether THIS observation should page: `consecutive` has reached
 * `DORMANT_DEFER_ALERT_AFTER` (the race-absorbing grace, poll-count by
 * design — see that constant's own doc) AND either no alert has fired yet
 * for this reference (`lastAlertedAtMs === 0`) or at least
 * `DORMANT_DEFER_ALERT_REPEAT_EVERY_MS` of wall-clock time has passed since
 * the last one (the pager-facing repeat, time-based by design — see that
 * constant's own doc).
 */
function dueForDormantDeferAlert(
  consecutive: number,
  lastAlertedAtMs: number,
  nowMs: number,
): boolean {
  if (consecutive < DORMANT_DEFER_ALERT_AFTER) return false;
  if (lastAlertedAtMs === 0) return true;
  return nowMs - lastAlertedAtMs >= DORMANT_DEFER_ALERT_REPEAT_EVERY_MS;
}

/**
 * How often an unresolvable quote unit re-announces — the page from
 * `refuseUnresolvedPriceUnit`, and `cashOpenPrice`'s log line — counted in
 * consecutive observations of the SAME Uic. Both sites are re-driven every
 * poll while the cause persists (`unresolved-price-unit-alert.ts`), so
 * without this they announce at the poll cadence; #1383 measured that shape
 * at ~600 identical lines over a 20h soak.
 *
 * Its own poll-count-8 warn cadence — the same shape
 * `ALERT_REPEAT_EVERY_DIAGNOSTICS` uses, for the same reason. Unlike
 * `DORMANT_DEFER_ALERT_AFTER` there is NO grace before the first
 * announcement: its bound exists to absorb a race between two network calls,
 * where a Uic either is or is not in the resolver's in-memory map on the
 * first look, and a refused fill is a lot that cannot go terminal meanwhile.
 *
 * NOT re-derived here. This is a poll count too, and #1426's final section
 * names only the dormant-legs constant, so it is flagged rather than
 * changed — whether the `refuseUnresolvedPriceUnit` (fill-sweep) and
 * `cashOpenPrice` (`getOpenPositions`) paths that read it run at a cadence
 * that makes 8 a flood, the way it did for the dormant-legs repeat, is
 * unmeasured.
 */
export const PRICE_UNIT_ALERT_REPEAT_EVERY = 8;

const PRICE_UNIT_CADENCE = { after: 1, every: PRICE_UNIT_ALERT_REPEAT_EVERY };

export interface SaxoInstrumentRef extends SaxoQuoteUnit {
  readonly uic: number;
  readonly asset_type: SaxoAssetType;
  /**
   * `CurrencyCode` — what `price x price_to_contract_factor` is denominated
   * in, which on a GBX line is NOT the unit the price is quoted in. Never
   * compute cash from this field alone (#1302, see saxo-price-unit.ts).
   */
  readonly currency: string;
  /** `PriceCurrency`: `GBX` on a pence line whose `currency` is `GBP` (doc 44 §2.1). */
  readonly price_currency: string | undefined;
}

/** LSE ticker <-> Saxo Uic, both ways: orders go out by Uic, positions come back by Uic. */
export interface SaxoInstrumentResolver {
  resolve(lseTicker: string): SaxoInstrumentRef | undefined;
  lseTickerFor(uic: number): string | undefined;
}

/** The slice of an `LseEtpPoolRow` the resolver needs — structural so the pool module is not imported into the execution stage. */
export interface SaxoResolvablePoolRow {
  readonly lse_ticker: string;
  readonly provenance: {
    readonly saxo: {
      readonly line: {
        readonly uic: number;
        readonly asset_type: SaxoAssetType;
      } | null;
    };
  };
}

/**
 * Builds the resolver from the pool's recorded Saxo evidence, joined to the
 * venue's own instrument details for each line's quote unit and settlement
 * currency (#1302). Only a row's OWN line resolves — a `sibling_line` is a
 * different instrument (`lse-etp-pool.ts`) and must not be traded under the
 * row's ticker.
 *
 * The pool supplies identity (ticker, Uic, asset type) and the VENUE supplies
 * money units: the pool's own `currency` is vendor-sourced, and Saxo's search
 * endpoint — which is where the pool's Saxo evidence came from — reports a
 * pence line as `GBP`. One `getInstrumentDetails` call per line, at build
 * time, on reference data that does not change intraday.
 *
 * A line whose details cannot be read, or whose unit fields contradict each
 * other, throws rather than resolving without a factor: an instrument that
 * quietly drops out of the resolver is an instrument the router reports as
 * "no Saxo Uic recorded", which reads as a pool gap rather than a venue
 * failure.
 */
export async function saxoInstrumentResolverFromVenue(
  rows: readonly SaxoResolvablePoolRow[],
  client: Pick<SaxoOpenApiClient, 'getInstrumentDetails'>,
): Promise<SaxoInstrumentResolver> {
  const byTicker = new Map<string, SaxoInstrumentRef>();
  const byUic = new Map<number, string>();
  for (const row of rows) {
    const line = row.provenance.saxo.line;
    if (line === null) continue;
    const details = await client.getInstrumentDetails(line.uic, line.asset_type);
    const ref: SaxoInstrumentRef = {
      uic: line.uic,
      asset_type: line.asset_type,
      currency: details.CurrencyCode,
      price_currency: details.PriceCurrency,
      price_to_contract_factor: details.PriceToContractFactor,
    };
    assertUnitIsSelfConsistent(ref, row.lse_ticker);
    byTicker.set(row.lse_ticker, ref);
    byUic.set(line.uic, row.lse_ticker);
  }
  return {
    resolve: (lseTicker) => byTicker.get(lseTicker),
    lseTickerFor: (uic) => byUic.get(uic),
  };
}

/**
 * The two unit fields must corroborate each other in BOTH directions, because
 * either one alone is a coin flip on a 100x error (#1302). A line quoted in
 * one currency and settled in another must carry a factor that converts
 * between them, and a factor other than 1 must be a quote unit some
 * `PriceCurrency` names — an uncorroborated 0.01 reads 31151 as £3.1151, so
 * an order aimed at £311.51 goes out as 31151, and ADR-0018 D5 sizes
 * cash-first, making that a 100x OVER-quantity rather than the undersize the
 * issue describes.
 *
 * The second direction holds only for the GBP LSE-listed ETPs this adapter is
 * restricted to (ADR-0015, #659). On other Saxo asset types
 * `PriceToContractFactor` is a contract multiplier that sits legitimately
 * beside `PriceCurrency === CurrencyCode`, so a future reader meeting one
 * must widen the universe, not relax this guard.
 *
 * An ABSENT `PriceCurrency` corroborates nothing and is refused with the
 * rest: doc 44 §2.1 tabulates that field's VALUES on two lines, never its
 * presence on any gateway, so reading silence as assent would be the same
 * guess. A gateway that omits the field therefore fails at boot instead of
 * mis-pricing — the intended direction, and why the #1302 follow-up's SIM
 * probe records presence and not only value.
 */
function assertUnitIsSelfConsistent(ref: SaxoInstrumentRef, lseTicker: string): void {
  const quotesInAnotherUnit =
    ref.price_currency !== undefined && ref.price_currency !== ref.currency;
  const scales = ref.price_to_contract_factor !== 1;
  if (quotesInAnotherUnit === scales) return;
  throw new Error(
    `Saxo instrument details for '${lseTicker}' (Uic ${ref.uic}) report PriceCurrency ` +
      `${ref.price_currency ?? '(absent)'} against CurrencyCode ${ref.currency} with ` +
      `PriceToContractFactor ${ref.price_to_contract_factor} — cash per share is unknowable ` +
      'from a self-contradictory pair, so the line is not tradeable.',
  );
}

export interface SaxoBrokerAdapterInput {
  client: SaxoOpenApiClient;
  instruments: SaxoInstrumentResolver;
  state?: BrokerStateStore;
  clock?: Clock;
  activityLookbackMs?: number;
  /**
   * REQUIRED, no logging default: the only signal a partial entry fill
   * leaves (see `resizeProtectiveLegs`), so a silent stand-in here would be
   * the "tested mechanism nothing calls" defect class this repo keeps
   * refiling — same reason Alpaca's `unpricedFillAlerts` refuses one.
   */
  legResizeAlerts: LegResizeUnverifiedAlertChannel;
  /**
   * REQUIRED, no default: rulings (a)/(c) on #1215 round 2 are in direct
   * tension for a dormant-legs corroboration that never reaches a terminal
   * audit row — never cancel without evidence (a), never silently defer a
   * wedge forever (c). `escalateIfStale` resolves that by paging here
   * instead of either cancelling on suspicion or going quiet — a silent
   * default would resolve the tension in ruling (c)'s favor by construction,
   * the same "tested mechanism nothing calls" gap `legResizeAlerts` above
   * refuses.
   */
  dormantLegsAlerts: DormantLegsUnresolvedAlertChannel;
  /**
   * REQUIRED, no default: a priced fill whose Uic resolves to no pool line
   * both throws and pages (#1302 round 1) — see `refuseUnresolvedPriceUnit`. The
   * throw keeps a possibly-100x price out of the journal, but on a
   * PERSISTENT cause it repeats every poll with nothing else changing, so
   * without this channel the wedge is invisible outside the log stream. Same
   * "tested mechanism nothing calls" refusal as the two channels above.
   */
  priceUnitAlerts: UnresolvedPriceUnitAlertChannel;
  logger: Logger;
}

interface BracketRecord {
  instrument: string;
  /** `undefined` for a bracket journalled without its request (ids only). */
  size: number | undefined;
}

interface FlattenRecord {
  instrument: string;
  side: 'buy' | 'sell';
  size: number;
}

type Leg = NormalizedFill['leg'];

export class SaxoBrokerAdapter implements BrokerAdapter {
  private readonly client: SaxoOpenApiClient;
  private readonly instruments: SaxoInstrumentResolver;
  private readonly state: BrokerStateStore;
  private readonly clock: Clock;
  private readonly activityLookbackMs: number;
  private readonly logger: Logger;
  private readonly legResizeAlerts: LegResizeUnverifiedAlertChannel;
  private readonly dormantLegsAlerts: DormantLegsUnresolvedAlertChannel;
  private readonly priceUnitAlerts: UnresolvedPriceUnitAlertChannel;
  /** Warmed from the journal so a restart keeps sweeping fills. */
  private readonly brackets = new Map<string, BracketRecord>();
  private readonly flattens = new Map<string, FlattenRecord>();
  /**
   * Per-reference consecutive unresolved-observation count + first-observed
   * time for `escalateIfStale`. In memory and restart-clean — same posture as
   * `FilledZeroSizeThrottle`'s own map (its doc): a process that just
   * restarted has no evidence about the previous process's polls. That
   * posture covers the counter, not `masterSeenOpen`: losing the counter
   * delays a page, losing the flag re-enables the leg deletion it guards
   * against until the next `cancel` observes the master open again. The flag
   * also drops on any non-dormant read of the reference (`lookup`), so it
   * holds only across consecutive dormant observations within one process.
   *
   * Two conditions are counted here under namespaced keys, the same shape
   * `priceUnitDefer` uses and for the same reason — they must not shift each
   * other's cadence. The bare reference counts "the audit trail has not
   * answered"; `refusedKey` counts "it answered `Filled` and `cancel` refused
   * to act on it" (#1216 round 2). A shared key would let one caller's
   * settled verdict clear the other's wedge.
   */
  private readonly dormantDefer = new Map<string, DormantDeferRecord>();
  /**
   * Consecutive observations of a Uic whose quote unit is unresolvable, one
   * namespaced key per site so the two cadences do not shift each other.
   * Keyed by Uic and not by the row that triggered the observation:
   * `fetchNewFills` refuses at the FIRST unresolved row, so a shifting venue
   * row order would otherwise open a fresh episode — and announce — every
   * poll. In memory and restart-clean, same posture as `dormantDefer`.
   *
   * No counterpart to `clearDormantDefer`: the resolver is built once, from a
   * fixed row set (`saxoInstrumentResolverFromVenue`), so a Uic it cannot
   * resolve stays unresolvable for the life of the process and no later,
   * unrelated episode can arrive under the same key. Bounded by the distinct
   * unresolvable Uics one process sees.
   */
  private readonly priceUnitDefer = new Map<string, number>();
  /**
   * `saxoExternalReference(clientOrderId)` -> `clientOrderId`, the reverse
   * direction `attribute()` needs and the one-way digest cannot supply on its
   * own. Populated wherever a `client_order_id` first becomes known to this
   * process — the constructor's journal replay and every `brackets`/
   * `flattens` write — never by inverting the hash.
   */
  private readonly wireReferences = new Map<string, string>();

  constructor(input: SaxoBrokerAdapterInput) {
    this.client = input.client;
    this.instruments = input.instruments;
    this.state = input.state ?? new InMemoryBrokerStateStore();
    this.clock = input.clock ?? { now: () => new Date() };
    this.activityLookbackMs = input.activityLookbackMs ?? DEFAULT_ACTIVITY_LOOKBACK_MS;
    this.logger = input.logger;
    this.legResizeAlerts = input.legResizeAlerts;
    this.dormantLegsAlerts = input.dormantLegsAlerts;
    this.priceUnitAlerts = input.priceUnitAlerts;
    for (const record of this.state.loadBrackets('saxo')) {
      this.brackets.set(record.client_order_id, {
        instrument: record.request?.instrument ?? '',
        size: record.request?.size,
      });
      this.registerWireReference(record.client_order_id);
    }
  }

  private registerWireReference(clientOrderId: string): void {
    this.wireReferences.set(saxoExternalReference(clientOrderId), clientOrderId);
  }

  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      throw sanitizeBrokerError('saxo', operation, cause);
    }
  }

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    const ref = this.resolveOrThrow(order.instrument);
    assertWholeUnits(order.size, order.client_order_id);
    const wireReference = saxoExternalReference(order.client_order_id);
    assertExternalReferenceFits(wireReference, LEG_SUFFIX_MAX_CHARS, order.client_order_id);

    const exitSide = toBuySell(order.side === 'buy' ? 'sell' : 'buy');
    const leg = (type: 'StopIfTraded' | 'Limit', price: number, suffix: Leg) => ({
      OrderType: type,
      OrderPrice: venueOrderPrice(ref, price),
      BuySell: exitSide,
      Amount: order.size,
      AssetType: ref.asset_type,
      Uic: ref.uic,
      // GTC, not the entry's duration: a related order only activates on the
      // entry's fill and dies with the master's cancel, so a Day leg would
      // buy nothing except a naked position if flat-by-close ever misses.
      OrderDuration: { DurationType: 'GoodTillCancel' as const },
      ManualOrder: false as const,
      ExternalReference: legReference(wireReference, suffix),
    });
    const request: SaxoOrderRequest = {
      Uic: ref.uic,
      AssetType: ref.asset_type,
      BuySell: toBuySell(order.side),
      Amount: order.size,
      OrderType: 'Limit',
      OrderPrice: venueOrderPrice(ref, order.entry),
      OrderDuration: { DurationType: toDuration(order.time_in_force) },
      ManualOrder: false,
      ExternalReference: wireReference,
      Orders: [leg('StopIfTraded', order.stop, 'stop'), leg('Limit', order.target, 'target')],
    };

    const { ids, order_state } = await this.call('submitBracket', () =>
      this.placeIdempotently(order.client_order_id, request, order.instrument),
    );
    this.registerWireReference(order.client_order_id);
    this.brackets.set(order.client_order_id, { instrument: order.instrument, size: order.size });
    this.state.saveBracket({
      venue: 'saxo',
      client_order_id: order.client_order_id,
      phase: 'armed',
      entry_order_id: ids.entry ?? null,
      stop_order_id: ids.stop ?? null,
      target_order_id: ids.target ?? null,
      request: toRequestFields(order),
      armed_qty: null,
      arming_qty: null,
      arm_attempt: 0,
    });
    return {
      client_order_id: order.client_order_id,
      broker_order_ids: orderIdList(ids),
      order_state,
    };
  }

  async getOrder(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    const order = await this.call('getOrder', () =>
      this.lookup(clientOrderId, this.activityLookbackMs, instrument),
    );
    if (order === null) return null;
    this.registerWireReference(clientOrderId);
    this.brackets.set(clientOrderId, {
      instrument,
      size: this.brackets.get(clientOrderId)?.size ?? order.amount,
    });
    this.state.recordBracketOrderIds('saxo', clientOrderId, {
      entry_order_id: order.ids.entry ?? null,
      stop_order_id: order.ids.stop ?? null,
      target_order_id: order.ids.target ?? null,
    });
    return order.normalized;
  }

  async resumeFlatten(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    const order = await this.call('resumeFlatten', () =>
      this.lookup(clientOrderId, this.activityLookbackMs, instrument),
    );
    if (order === null) return null;
    this.registerWireReference(clientOrderId);
    this.flattens.set(clientOrderId, {
      instrument,
      side: order.side,
      size: order.normalized.filled_qty > 0 ? order.normalized.filled_qty : order.amount,
    });
    return order.normalized;
  }

  /**
   * The quote unit is resolved only for a row that is already a PRICED fill
   * (#1302 round 1). An owned row that carries no price — `Placed`,
   * `Cancelled`, a still-`Working` leg — has nothing to scale, so a Uic the
   * resolver does not know must not fail the sweep for it: the lookback is
   * floored at the earliest open lot's `opened_at`, so any such row inside it
   * would refuse every lot's fills for as long as the row stays in range.
   */
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const activities = await this.call('fetchNewFills', () =>
      this.client.listOrderActivities(since),
    );
    const fills: NormalizedFill[] = [];
    for (const activity of activities) {
      const owner = this.attribute(activity.ExternalReference);
      if (owner === undefined) continue;
      const quoted = toQuotedFill(activity, owner.clientOrderId, owner.leg, since);
      if (quoted === undefined) continue;
      const ref = this.instrumentForUic(activity.Uic);
      if (ref === undefined)
        throw await this.refuseUnresolvedPriceUnit(activity, owner.clientOrderId);
      fills.push(toCashFill(quoted, ref));
    }
    return fills;
  }

  /**
   * Whether Saxo shrinks an IfDone master's related orders to the filled
   * amount on a PARTIAL entry fill is UNVERIFIED (no fill was observable on
   * SIM). The legs are placed at the bracket's size, so a fill of that size
   * needs nothing. A smaller fill leaves the doubt: if the venue did not
   * shrink the legs, a fixed-`Amount` GTC stop over-closes into a reversed
   * position. That is alerted, not thrown — `ingestFills` calls this before
   * `applyLotAdvance`, so a throw here would leave the fill un-persisted
   * (zero exposure to Risk, nothing for flat-by-close to send), which is
   * worse than the leg-size doubt.
   */
  async resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void> {
    const size = this.brackets.get(clientOrderId)?.size;
    if (size !== undefined && filledQty >= size) return;
    await this.legResizeAlerts.postLegResizeUnverifiedAlert({
      client_order_id: clientOrderId,
      instrument: this.brackets.get(clientOrderId)?.instrument ?? '',
      requested_qty: size ?? null,
      filled_qty: filledQty,
      observed_at: this.clock.now(),
    });
  }

  /**
   * Thrown OUTSIDE `this.call`, and that is load-bearing (#1214): the refusal
   * is a settled property of the venue, not an attempt that failed, and
   * `sanitizeBrokerError` would erase the discriminant the #549 sweep reads
   * to tell those two apart — see `ProtectiveRearmUnsupportedError`'s
   * INVARIANT. Nothing here talks to the venue, so there is nothing for that
   * wrapper to sanitize either.
   */
  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    _side: 'buy' | 'sell',
    _qty: number,
    _stop: number,
    _target: number,
  ): Promise<void> {
    throw new ProtectiveRearmUnsupportedError(
      'saxo',
      `Saxo cannot re-arm protective legs for '${clientOrderId}' (${instrument}): every pool ` +
        'line reports IsOcoOrderSupported false (instrument details, 2026-09-05), so an ' +
        'entry-less stop+target pair is inexpressible without a hand-emulated OCO — #525 ' +
        'fallback applies, and no retry of this call can ever clear it.',
    );
  }

  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    const ref = this.resolveOrThrow(instrument);
    assertWholeUnits(size, clientOrderId);
    const wireReference = saxoExternalReference(clientOrderId);
    assertExternalReferenceFits(wireReference, 0, clientOrderId);
    const request: SaxoOrderRequest = {
      Uic: ref.uic,
      AssetType: ref.asset_type,
      BuySell: toBuySell(side),
      Amount: size,
      OrderType: 'Market',
      OrderDuration: { DurationType: 'DayOrder' },
      ManualOrder: false,
      ExternalReference: wireReference,
    };
    const { ids, order_state } = await this.call('submitFlatten', () =>
      this.placeIdempotently(clientOrderId, request, instrument),
    );
    this.registerWireReference(clientOrderId);
    this.flattens.set(clientOrderId, { instrument, side, size });
    return { client_order_id: clientOrderId, broker_order_ids: orderIdList(ids), order_state };
  }

  /**
   * Cancels the bracket — the MASTER first and alone (#1216). The venue
   * cancels an IfDone master's related orders with it (VERIFIED, doc 43:33),
   * so no leg is ever named from the same open-orders snapshot the master
   * was read in. That snapshot is exactly what the entry can fill out of
   * between the read and the DELETE: the master leaves the open list and the
   * legs activate into the only cover the new position has.
   *
   * `OrderNotFound` on the master's own DELETE is the tell that the snapshot
   * went stale inside this call. Nothing of ours was destroyed by it, so the
   * legs are re-derived from a FRESH read rather than the stale one. That a
   * master which has ALREADY FILLED answers `404 OrderNotFound` is VERIFIED
   * (doc 43 round 2, #1216: measured twice, `{"Orders":[{"ErrorInfo":
   * {"ErrorCode":"OrderNotFound"},...}]}`) — but on `Etf`/NASDAQ, and only
   * for a settled fill: the fill took 8 ms and a round trip is 127-334 ms,
   * so a DELETE arriving DURING the fill is still unmeasured. That residue
   * fails safe: every other error rethrows, so the caller refuses its
   * flatten with the legs untouched.
   */
  async cancel(clientOrderId: string, instrument: string): Promise<void> {
    await this.call('cancel', async () => {
      const open = await this.client.listOpenOrders();
      const master = open.find(
        (order) => order.ExternalReference === saxoExternalReference(clientOrderId),
      );
      if (master === undefined) {
        await this.clearLegs(clientOrderId, legRows(open, clientOrderId), instrument, false);
        return;
      }
      try {
        await this.client.cancelOrder(master.OrderId);
        return;
      } catch (cause) {
        if (!isOrderNotFound(cause)) throw cause;
      }
      const fresh = await this.client.listOpenOrders();
      await this.clearLegs(clientOrderId, legRows(fresh, clientOrderId), instrument, true);
    });
  }

  /**
   * The leg half of `cancel()`, for a bracket with no master on the open
   * list. `masterWasOpen` says the master WAS open when this same call
   * started and its DELETE then answered `OrderNotFound` — so any evidence
   * of a fill here means the entry filled INSIDE this call, and the caller's
   * own view of what it holds predates it. Nothing reports what `ingestFills`
   * has booked, so the adapter cannot know whether the caller's flatten
   * covers that quantity; it refuses rather than guess. The throw leaves the
   * legs exactly where they are (`executeExit` then refuses its flatten and
   * #549 marks the lots it had already cancelled), where cancelling would
   * strip the only cover off a position nobody is flattening.
   *
   * A `Filled` audit row under dormant legs refuses too, `masterWasOpen` or
   * not: the audit trail knows nothing about which read of ours the fill
   * landed between, and a fill this call cannot place in time is a fill the
   * caller may have sized its exit before. Resolving instead would leave
   * legs that read `NotWorking` but may be live (the UNVERIFIED `Status`
   * read, #1215) standing against the flatten the caller then sends — #516
   * from the direction cancel-first exists to prevent — and standing after
   * it completes, on a flat book.
   *
   * Only settled state is cancelled: activated legs with no master and no
   * DELETE refusal (the entry filled long enough ago for the caller to hold
   * the lot), and dormant legs the audit trail corroborates as dead (#1215
   * ruling (a)) — never on `Status` alone, which is the same UNVERIFIED
   * read. A corroboration that says nothing yet cancels nothing and is paged
   * by `escalateIfStale` (ruling (c)) rather than refused: on the read this
   * adapter defends, the legs it leaves are parked rather than on the book,
   * so they cannot fire against a flatten the caller sends anyway, and
   * refusing would abort the flatten of every OTHER lot in the caller's loop
   * over a bracket whose entry never filled. Under `masterWasOpen` an EMPTY
   * audit answer is such a corroboration failure, not a verdict: the master
   * was on the open list milliseconds earlier, so "no row ties these legs to
   * any known order" — `lookup`'s justification for cancelling on silence —
   * is false by construction here.
   */
  private async clearLegs(
    clientOrderId: string,
    legs: readonly SaxoOpenOrder[],
    instrument: string,
    masterWasOpen: boolean,
  ): Promise<void> {
    if (legs.length === 0) {
      this.clearRefusedDefer(clientOrderId);
      return;
    }
    if (legs.every(isNeverActivated)) {
      const verdict = await this.corroborateDormantLegs(
        clientOrderId,
        this.activityLookbackMs,
        instrument,
        masterWasOpen,
      );
      if (verdict.kind === 'defer' || verdict.kind === 'uncorroborated') {
        safeLog(this.logger, {
          trace_id: 'saxo-cancel',
          stage: 'execution',
          level: 'warn',
          event: 'saxo_cancel_deferred_dormant_legs',
          message:
            verdict.kind === 'defer'
              ? 'Saxo cancel: the legs read NotWorking but the audit trail has not settled the ' +
                'master, so they were left in place rather than cancelled on Status alone'
              : 'Saxo cancel: the master left the open list inside this call and its audit trail ' +
                'answered nothing at all, so the legs were left in place — an empty answer about ' +
                'an order this call just read open is a failed corroboration, not a verdict',
          payload: { client_order_id: clientOrderId },
        });
        return;
      }
      if (verdict.kind === 'cancel') {
        this.clearRefusedDefer(clientOrderId);
        await this.cancelLegs(legs);
        return;
      }
      throw await this.refuse(
        clientOrderId,
        instrument,
        masterWasOpen ? FILL_INSIDE_CALL : FILL_UNPLACED,
      );
    }
    if (masterWasOpen) throw await this.refuse(clientOrderId, instrument, FILL_INSIDE_CALL);
    this.clearRefusedDefer(clientOrderId);
    await this.cancelLegs(legs);
  }

  /**
   * `clearLegs`' refusal, counted before it is thrown. A refusal leaves the
   * legs where they are and reports through the caller's error path only —
   * `execute.ts`'s `exit_cancel_failed` log, a `flatten_submissions` error
   * row and the tick audit row, no alert channel — so a lot wedged in the
   * shape unproven item 2 describes would refuse every exit attempt
   * indefinitely with nothing paging (#1216 round 2 finding 2). It counts on
   * its own `refusedKey` rather than sharing the defer count: the two
   * conditions resolve independently, and one caller's settled verdict must
   * not clear the other's wedge.
   */
  private async refuse(
    clientOrderId: string,
    instrument: string,
    evidence: string,
  ): Promise<SaxoBrokerProviderError> {
    await this.escalateIfStale(refusedKey(clientOrderId), clientOrderId, instrument, false);
    return entryFilledDuringCancel(clientOrderId, evidence);
  }

  async getOpenPositions(): Promise<NormalizedPosition[]> {
    const positions = await this.call('getOpenPositions', () => this.client.listNetPositions());
    const out: NormalizedPosition[] = [];
    for (const position of positions) {
      const qty = position.NetPositionBase.Amount;
      if (qty === 0) continue;
      const uic = position.NetPositionBase.Uic;
      out.push({
        instrument:
          this.instruments.lseTickerFor(uic) ?? position.DisplayAndFormat?.Symbol ?? `uic:${uic}`,
        qty,
        side: qty > 0 ? 'buy' : 'sell',
        avg_entry_price: this.cashOpenPrice(position.NetPositionView.AverageOpenPrice, uic),
      });
    }
    return out;
  }

  /**
   * Adopt-or-place (doc 43). The open list is authoritative for a resting
   * order; the recent audit trail catches one that already filled or died
   * before this retry — including one that filled between the lost reply
   * and this retry and so is already gone from the open list, not merely
   * still resting on it (#1217). A 409 means the venue's window still
   * remembers a POST whose reply this process never saw.
   *
   * An adopted order is acked in ITS state, never as `submitted`: a filled
   * one is `filled`. A dead one (rejected/cancelled/expired) is refused
   * outright — re-placing under the same reference would hide the venue's
   * verdict on the first attempt, and adopting it would journal an armed
   * bracket over nothing.
   */
  private async placeIdempotently(
    externalReference: string,
    request: SaxoOrderRequest,
    instrument: string,
  ): Promise<Placed> {
    const existing = await this.lookup(externalReference, PLACEMENT_LOOKBACK_MS, instrument);
    if (existing !== null) return adopt(existing, externalReference);
    try {
      return {
        ids: placementIds(await this.client.placeOrder(request, externalReference)),
        order_state: 'submitted',
      };
    } catch (cause) {
      if (!isDuplicateRequestRefusal(cause)) throw cause;
      const adopted = await this.findOpen(externalReference);
      if (adopted !== null && !isDormantLegs(adopted)) return adopt(adopted, externalReference);
      // A dormant-legs signal here is not acted on: this path fires only
      // right after a duplicate-request 409, and cancelling on `Status`
      // alone is exactly the UNVERIFIED read `lookup` exists to avoid
      // (#1215 round 1). Declining to adopt leaves the legs for the next
      // `reconcile()` pass (#921 runs every poll) to settle against the
      // audit trail.
      if (adopted !== null) throw cause;
      // The open list forgets an order the instant it stops being open —
      // not just on cancel, also on a fill, which for a Market flatten can
      // land inside the same duplicate window as this retry. The audit
      // trail still carries it, so it is adopted in its own state rather
      // than reported as a failed flatten (#1217).
      const latest = await this.latestActivityFor(externalReference, PLACEMENT_LOOKBACK_MS);
      if (latest === undefined) throw cause;
      return adopt(fromActivity(latest, externalReference), externalReference);
    }
  }

  /**
   * A net position's `AverageOpenPrice` in cash (#1302). A Uic no pool line
   * resolves reports `null` — the honest answer for a price whose unit is
   * unknown, and one `NormalizedPosition.avg_entry_price` already admits —
   * rather than the throw `refuseUnresolvedPriceUnit` returns: a position under an
   * unrecognised Uic is not necessarily this system's (a hand-placed trade in
   * the same account is enough), and refusing the whole sweep would blind
   * `reconcile` to every OTHER position including our own.
   */
  private cashOpenPrice(quotedPrice: number | undefined, uic: number): number | null {
    if (quotedPrice === undefined) return null;
    const ref = this.instrumentForUic(uic);
    if (ref !== undefined) return saxoCashPerShare(ref, quotedPrice);
    if (this.shouldAnnounceUnresolvedUnit('position', uic)) {
      safeLog(this.logger, {
        trace_id: 'saxo-open-positions',
        stage: 'execution',
        level: 'error',
        event: 'saxo_position_price_unit_unresolved',
        message:
          'Saxo getOpenPositions: position Uic resolves to no pool line, so its quote unit is ' +
          'unknown; avg_entry_price reported as null rather than at venue scale',
        payload: { uic },
      });
    }
    return null;
  }

  private instrumentForUic(uic: number): SaxoInstrumentRef | undefined {
    const ticker = this.instruments.lseTickerFor(uic);
    return ticker === undefined ? undefined : this.instruments.resolve(ticker);
  }

  /**
   * Records one more consecutive unresolvable-unit observation of `uic` at
   * `site`, and answers whether THIS one announces — see
   * `PRICE_UNIT_ALERT_REPEAT_EVERY`. Only the announcement is throttled:
   * every caller still nulls or refuses its own price on every poll, because
   * suppressing the refusal would book a possibly-100x fill on seven polls in
   * eight.
   */
  private shouldAnnounceUnresolvedUnit(site: 'fill' | 'position', uic: number): boolean {
    const key = `${site}:${uic}`;
    const consecutive = (this.priceUnitDefer.get(key) ?? 0) + 1;
    this.priceUnitDefer.set(key, consecutive);
    return escalatesAt(consecutive, PRICE_UNIT_CADENCE);
  }

  /**
   * Pages, then hands back the error to throw, for a PRICED fill whose Uic
   * resolves to no pool line: without a factor the price cannot be turned
   * into cash, and a raw venue price on a GBX line is 100x wrong (#1302).
   * Booking that is worse than not booking, so the sweep fails — the same
   * trade-off `toQuotedFill` makes for a `Filled` row with no
   * `FillAmount`/`AveragePrice`.
   *
   * The alert is not decoration. A transient cause clears on the next poll
   * because `ingestFills` recomputes `since` from the open lots' `opened_at`
   * rather than advancing a watermark, so the same rows are re-driven and
   * `hasFill` dedups whatever landed. A PERSISTENT one does not: the same row
   * stays in the lookback, every poll throws, the lot never goes terminal and
   * `since` never advances. Nothing else changes while that runs, which is
   * why it is paged rather than only logged — on the cadence
   * `PRICE_UNIT_ALERT_REPEAT_EVERY` sets, since that same persistence would
   * otherwise page at the poll rate. The REFUSAL is never throttled: it is
   * the safety property, and skipping it between announcements would book
   * exactly the mis-scaled price the alert exists to report.
   *
   * Delivery failure is swallowed to a log line — the throw below does not
   * depend on the alert landing.
   */
  private async refuseUnresolvedPriceUnit(
    activity: SaxoOrderActivity,
    clientOrderId: string,
  ): Promise<Error> {
    if (this.shouldAnnounceUnresolvedUnit('fill', activity.Uic)) {
      try {
        await this.priceUnitAlerts.postUnresolvedPriceUnitAlert({
          client_order_id: clientOrderId,
          broker_fill_id: activity.LogId,
          uic: activity.Uic,
          observed_at: this.clock.now(),
        });
      } catch {
        safeLog(this.logger, {
          trace_id: 'saxo-fills',
          stage: 'execution',
          level: 'error',
          event: 'saxo_price_unit_alert_send_failed',
          message:
            'postUnresolvedPriceUnitAlert delivery failed — the fill is still refused and the ' +
            'sweep still fails, but the operator was not paged; check the venue by hand',
          payload: { client_order_id: clientOrderId, uic: activity.Uic },
        });
      }
    }
    return new Error(
      `Saxo activity ${activity.LogId} for '${clientOrderId}' reports Uic ${activity.Uic}, which ` +
        "resolves to no pool line — the line's PriceToContractFactor is unknown, so its price " +
        'cannot be expressed as cash and the fill is not booked.',
    );
  }

  private async findOpen(externalReference: string): Promise<LookedUpOrder | DormantLegs | null> {
    const open = await this.client.listOpenOrders();
    const wireReference = saxoExternalReference(externalReference);
    const master = open.find((order) => order.ExternalReference === wireReference);
    if (master !== undefined) {
      const ids: OrderIds = { entry: master.OrderId };
      for (const related of master.RelatedOpenOrders ?? []) {
        if (related.OpenOrderType === 'StopIfTraded') ids.stop = related.OrderId;
        else ids.target = related.OrderId;
      }
      const filled = master.FilledAmount ?? 0;
      return {
        ids,
        side: master.BuySell === 'Buy' ? 'buy' : 'sell',
        amount: master.Amount,
        normalized: {
          client_order_id: externalReference,
          broker_order_ids: orderIdList(ids),
          order_state: filled > 0 ? 'partially_filled' : 'submitted',
          filled_qty: filled,
        },
      };
    }
    // Only the protective legs still open, no master. `Working` on a leg
    // means it ACTIVATED on the entry's fill — VERIFIED (doc 43 round 2,
    // #1216: a fill promotes both legs to top-level `Working`/`Oco` rows),
    // treated as filled below. A pair every leg reads `NotWorking` (never
    // activated) SIGNALS the entry expired unfilled, but no probe has ever
    // produced that row — a RESTING master keeps its legs nested inside
    // `RelatedOpenOrders`, not top-level here — so it is not proof; `lookup`
    // corroborates it against the audit trail before cancelling anything.
    const legs = legRows(open, externalReference);
    const [first] = legs;
    if (first === undefined) return null;
    if (legs.every(isNeverActivated)) return { dormant: legs };
    const ids: OrderIds = {};
    for (const leg of legs) {
      if (leg.OpenOrderType === 'StopIfTraded') ids.stop = leg.OrderId;
      else ids.target = leg.OrderId;
    }
    return {
      ids,
      side: first.BuySell === 'Buy' ? 'sell' : 'buy',
      amount: first.Amount,
      normalized: {
        client_order_id: externalReference,
        broker_order_ids: orderIdList(ids),
        order_state: 'filled',
        filled_qty: first.Amount,
      },
    };
  }

  /**
   * Cancels a related-order pair with no master left to cancel it for us —
   * one `lookup` or `cancel` has already decided may go. Three callers, all
   * settled state: a dormant pair whose master's audit row is terminal and
   * not `Filled` (#1215 round 1); a dormant pair with no audit row at all
   * and no master seen open, where nothing ties the legs to a known order; and,
   * from `cancel` alone, an activated pair whose lot the caller is
   * flattening. Every other shape refuses or defers in `clearLegs` — a
   * `Filled` row, or an empty answer about a master `cancel` just watched
   * leave the open list, never reaches here.
   * Every leg is attempted independently (#1215 round 2): the prior version
   * stopped at the first non-`OrderNotFound` failure, so a sibling leg could
   * be left un-attempted, not merely left cancelled while a later one fails.
   * No rebuild is ever needed after a partial cancel here — `findOpen`
   * re-derives the live leg set from the venue fresh on every poll, so a
   * retry converges against whatever the venue actually still holds, and
   * `rearmProtectiveLegs` would throw for Saxo regardless. `OrderNotFound`
   * is swallowed: the venue may have already reaped one on its own, and
   * that is success, not failure. The first other failure is thrown only
   * once every leg has been attempted — this runs inside a caller already
   * wrapped in `this.call`, so it surfaces as the caller's own sanitized
   * `BrokerError` rather than a silently-kept doubt.
   */
  private async cancelLegs(legs: readonly SaxoOpenOrder[]): Promise<void> {
    let hasFailure = false;
    let firstFailure: unknown;
    for (const leg of legs) {
      try {
        await this.client.cancelOrder(leg.OrderId);
      } catch (cause) {
        if (isOrderNotFound(cause)) continue;
        if (!hasFailure) {
          hasFailure = true;
          firstFailure = cause;
        }
      }
    }
    if (hasFailure) throw firstFailure;
  }

  /**
   * Records one more consecutive observation of a bracket this adapter could
   * not resolve — the audit trail silent or non-terminal (`deferKey` is the
   * bare reference), or answering `Filled` where `cancel` then refused
   * (`refusedKey`) — and posts `DormantLegsUnresolvedAlert` once
   * `dueForDormantDeferAlert` says it is due; see that function's own doc for
   * the grace and repeat bounds. `masterSeenOpen` is stored here and read
   * back by `corroborateDormantLegs`, which is what makes it sticky across a
   * `cancel` followed by `lookup` under the same reference.
   * Fire-and-forget, fully swallowed: same posture as
   * `postFlattenReconcileAlert` (reconcile.ts) — the poll this alert
   * reports on already completed, there is nothing here to undo on a
   * transport failure, and the failure itself is the one thing worth a log
   * line, not the alert content repeated.
   */
  private async escalateIfStale(
    deferKey: string,
    externalReference: string,
    instrument: string | undefined,
    masterSeenOpen: boolean,
  ): Promise<void> {
    const now = this.clock.now();
    const prior = this.dormantDefer.get(deferKey);
    const consecutive = (prior?.consecutive ?? 0) + 1;
    const firstObservedAt = prior?.firstObservedAt ?? now;
    const lastAlertedAtMs = prior?.lastAlertedAtMs ?? 0;
    const due = dueForDormantDeferAlert(consecutive, lastAlertedAtMs, now.getTime());
    this.dormantDefer.set(deferKey, {
      consecutive,
      firstObservedAt,
      masterSeenOpen: masterSeenOpen || prior?.masterSeenOpen === true,
      lastAlertedAtMs: due ? now.getTime() : lastAlertedAtMs,
    });
    if (!due) return;
    try {
      await this.dormantLegsAlerts.postDormantLegsUnresolvedAlert({
        client_order_id: externalReference,
        instrument: instrument ?? this.brackets.get(externalReference)?.instrument ?? '',
        stuck_ms: now.getTime() - firstObservedAt.getTime(),
        observed_at: now,
      });
    } catch {
      safeLog(this.logger, {
        trace_id: 'saxo-dormant-legs',
        stage: 'execution',
        level: 'error',
        event: 'saxo_dormant_legs_alert_send_failed',
        message:
          'postDormantLegsUnresolvedAlert delivery failed — legs stay dormant and unresolved, ' +
          'and the operator was not paged; check the venue by hand',
        payload: { client_order_id: externalReference },
      });
    }
  }

  /**
   * Clears the consecutive-defer count once `lookup` resolves this
   * reference one way or the other, so a later, unrelated dormant episode
   * under the same key starts its own grace window fresh rather than
   * inheriting a stale count — and with it the `masterSeenOpen` fact, which
   * describes the episode that just resolved, not the next one.
   *
   * The `refusedKey` count is deliberately NOT cleared here: a `Filled`
   * verdict resolves the reference for `lookup` (it adopts the fill) and does
   * not for `cancel` (it refuses), so clearing both from one verdict would
   * reset the refusal wedge every poll and it could never page (#1216 round 2
   * finding 2). `clearRefusedDefer` clears that one, from the paths where
   * `cancel` itself resolves.
   */
  private clearDormantDefer(externalReference: string): void {
    this.dormantDefer.delete(externalReference);
  }

  /** Clears the refusal count once `cancel` reaches a settled answer for this reference. */
  private clearRefusedDefer(externalReference: string): void {
    this.dormantDefer.delete(refusedKey(externalReference));
  }

  /** The most recent audit-trail row for `externalReference` inside `lookbackMs`, or none. */
  private async latestActivityFor(
    externalReference: string,
    lookbackMs: number,
  ): Promise<SaxoOrderActivity | undefined> {
    const from = new Date(this.clock.now().getTime() - lookbackMs);
    const wireReference = saxoExternalReference(externalReference);
    const activities = await this.client.listOrderActivities(from);
    let latest: SaxoOrderActivity | undefined;
    for (const activity of activities) {
      if (activity.ExternalReference !== wireReference) continue;
      if (latest === undefined || activity.ActivityTime >= latest.ActivityTime) latest = activity;
    }
    return latest;
  }

  /**
   * `findOpen`'s dormant-legs signal is never acted on by `Status` alone
   * (UNVERIFIED) — it is corroborated here against the master's own
   * audit-trail row first (#1215 round 1). A filled row (`FinalFill` on the
   * measured venue — see `activityState`): the entry
   * genuinely filled, adopted using the dormant legs' real order ids (better
   * evidence than an activity row, which carries no related-order ids). A
   * `Cancelled`/`Expired`/`Rejected` row: the master is confirmed done and
   * not filled, so the legs are cancelled and THAT state is reported, not
   * `null` — `null` reads to `reconcileLot` as "the write-ahead never
   * landed", which is false for an order the venue's own audit trail shows
   * it received. No row at all inside the lookback ties the legs to any
   * known order, so they are cancelled and `null` is the honest answer —
   * true only while no `cancel` has recorded a `masterSeenOpen` observation
   * for this reference, which is why that caller passes `masterKnownOpen`.
   * Once one has, this path throws `DormantLegsUncorroborated` instead: it
   * must not cancel legs `cancel` just refused to cancel, and it must not
   * answer `null` either, which `reconcileLot` reads as "the write-ahead
   * never landed" and acts on by marking the lot `rejected` — a lot with
   * live protective legs on the venue erased from the store. A throw is the
   * one answer `reconcileLot` treats as ignorance and leaves the record for.
   *
   * Anything else (no terminal status yet, including `partially_filled` —
   * contradictory alongside a dormant-legs read that says the entry never
   * activated at all, and not resolvable in either read's favor) is not
   * evidence either way, so nothing is cancelled here (ruling (a), #1215
   * round 2) — the next poll's `reconcile()` (#921: runs every pass, not
   * just at startup) resolves it once the audit trail catches up.
   * `escalateIfStale` counts these deferrals per reference and pages once
   * the count crosses `DORMANT_DEFER_ALERT_AFTER`, repeating while it
   * persists (ruling (c): a wedge that never gets audit-trail evidence must
   * stay visible to the operator, not silently deferred forever) — see that
   * constant's own doc for why a consecutive-poll count, not a wall-clock
   * age. Every other branch below clears that count: a reference that just
   * resolved is no longer deferred, and a later, unrelated dormant episode
   * under the same key must start its own grace window fresh.
   */
  private async lookup(
    externalReference: string,
    lookbackMs: number,
    instrument?: string,
  ): Promise<LookedUpOrder | null> {
    const open = await this.findOpen(externalReference);
    if (open !== null && !isDormantLegs(open)) {
      this.clearDormantDefer(externalReference);
      return open;
    }

    if (open === null) {
      const latest = await this.latestActivityFor(externalReference, lookbackMs);
      if (latest === undefined) return null;
      this.clearDormantDefer(externalReference);
      return fromActivity(latest, externalReference);
    }

    const verdict = await this.corroborateDormantLegs(
      externalReference,
      lookbackMs,
      instrument,
      false,
    );
    if (verdict.kind === 'filled')
      return legsFilled(open.dormant, verdict.latest, externalReference);
    if (verdict.kind === 'defer') return fromActivity(verdict.latest, externalReference);
    if (verdict.kind === 'uncorroborated') throw dormantLegsUncorroborated(externalReference);
    await this.cancelLegs(open.dormant);
    return verdict.latest === undefined ? null : fromActivity(verdict.latest, externalReference);
  }

  /**
   * What the master's own audit-trail row says about a leg pair `findOpen`
   * read as dormant — the corroboration `lookup`'s doc describes, shared
   * with `cancel` so both reach the venue's verdict the same way and from
   * one `listOrderActivities`. The defer bookkeeping lives here because it
   * is per-reference, not per-caller: whichever path observes the wedge
   * counts it, and every settled verdict clears it — on the verdict, not on
   * the caller's subsequent DELETE, because terminal audit evidence ends the
   * wedge whether or not that DELETE lands (a `cancelOrder` throw leaves the
   * legs to a later poll, which will re-derive the same terminal verdict and
   * never reach the deferral the count exists to measure).
   *
   * `masterKnownOpen` says this same call read the master on the open list
   * and its DELETE then answered `OrderNotFound`, which changes what an
   * EMPTY audit answer means. Absent that, no row inside the lookback ties
   * the legs to any known order, so `cancel` is the honest verdict. With it,
   * the silence is a corroboration failure about an order the venue was
   * serving milliseconds ago, so it defers as `uncorroborated` and counts
   * towards the page — zero information must not buy more destruction than
   * a non-terminal row does (#1215's never-on-`Status`-alone ruling, and
   * #1216's own tell that the snapshot went stale).
   *
   * The fact is remembered per reference rather than per call (#1216 round
   * 2): every poll runs `reconcile()` -> `getOrder` -> `lookup` on the same
   * key, and `lookup` never sees a master of its own, so a per-call flag
   * would have the very next poll strip the legs `cancel` had just refused
   * to strip and clear the count on its way past — a page nothing could
   * reach. `clearDormantDefer` forgets it again the moment any settled
   * verdict resolves the reference.
   */
  private async corroborateDormantLegs(
    externalReference: string,
    lookbackMs: number,
    instrument: string | undefined,
    masterKnownOpen: boolean,
  ): Promise<DormantVerdict> {
    const seenOpen =
      masterKnownOpen || this.dormantDefer.get(externalReference)?.masterSeenOpen === true;
    const latest = await this.latestActivityFor(externalReference, lookbackMs);
    if (latest === undefined) {
      if (seenOpen) {
        await this.escalateIfStale(externalReference, externalReference, instrument, true);
        return { kind: 'uncorroborated' };
      }
      this.clearDormantDefer(externalReference);
      return { kind: 'cancel', latest: undefined };
    }
    const state = activityState(latest);
    if (state === 'filled') {
      this.clearDormantDefer(externalReference);
      return { kind: 'filled', latest };
    }
    if (DEAD_STATES.has(state)) {
      this.clearDormantDefer(externalReference);
      return { kind: 'cancel', latest };
    }
    await this.escalateIfStale(externalReference, externalReference, instrument, seenOpen);
    return { kind: 'defer', latest };
  }

  /**
   * `externalReference` here is the actual wire value observed on an
   * activity row — the one place this adapter must go from a Saxo reference
   * back to a `client_order_id` (#1510), so it is the one place that reads
   * `wireReferences` rather than deriving forward with `saxoExternalReference`.
   */
  private attribute(
    externalReference: string | undefined,
  ): { clientOrderId: string; leg: Leg } | undefined {
    if (externalReference === undefined) return undefined;
    const direct = this.wireReferences.get(externalReference);
    if (direct !== undefined) {
      if (this.flattens.has(direct)) return { clientOrderId: direct, leg: 'exit' };
      if (this.brackets.has(direct)) return { clientOrderId: direct, leg: 'entry' };
    }
    for (const leg of ['stop', 'target'] as const) {
      const suffix = `:${leg}`;
      if (!externalReference.endsWith(suffix)) continue;
      const id = this.wireReferences.get(externalReference.slice(0, -suffix.length));
      if (id !== undefined && this.brackets.has(id)) return { clientOrderId: id, leg };
    }
    return undefined;
  }

  private resolveOrThrow(instrument: string): SaxoInstrumentRef {
    const ref = this.instruments.resolve(instrument);
    if (ref === undefined) {
      throw new Error(
        `Saxo: no Saxo Uic is recorded for '${instrument}' — only pool rows whose own line ` +
          'resolved on the SIM gateway (lse-etp-pool.ts provenance.saxo.line) are tradeable.',
      );
    }
    return ref;
  }
}

interface OrderIds {
  /** Absent when only the protective legs are still open — the entry is no longer a venue order. */
  entry?: string;
  stop?: string;
  target?: string;
}

interface LookedUpOrder {
  ids: OrderIds;
  side: 'buy' | 'sell';
  amount: number;
  normalized: NormalizedOrder;
}

/** `findOpen`'s signal for a related-order pair found `NotWorking` with no master — see `lookup`. */
interface DormantLegs {
  readonly dormant: readonly SaxoOpenOrder[];
}

function isDormantLegs(result: LookedUpOrder | DormantLegs): result is DormantLegs {
  return 'dormant' in result;
}

/**
 * `corroborateDormantLegs`' reading of the master's audit row: the entry
 * filled, the master died without filling (`latest` absent when no row ties
 * the legs to any known order at all), or the trail has not settled yet.
 */
type DormantVerdict =
  | { kind: 'filled'; latest: SaxoOrderActivity }
  | { kind: 'cancel'; latest: SaxoOrderActivity | undefined }
  | { kind: 'defer'; latest: SaxoOrderActivity }
  | { kind: 'uncorroborated' };

const FILL_INSIDE_CALL =
  "the entry filled between this call's open-orders read and the master's DELETE, and the " +
  'caller sized its exit before that fill';

const FILL_UNPLACED =
  "the master's audit row says Filled while the legs still read NotWorking, so nothing places " +
  'that fill against the read the caller sized its exit from';

/**
 * `cancel`'s refusal: the legs are the only cover the position has and the
 * caller cannot be shown to be flattening it, so nothing is cancelled. The
 * text is carried as `venueMessage` too, same as `adopt`'s refusal and for
 * the same reason — `sanitizeBrokerError` keeps only the curated fields, and
 * this text is composed from our own reference, never from a response body.
 */
function entryFilledDuringCancel(clientOrderId: string, evidence: string): SaxoBrokerProviderError {
  const reason =
    `Saxo cancel '${clientOrderId}': ${evidence}. Its protective legs are the only cover the ` +
    'position has, so nothing was cancelled — the exit must be re-derived from a fresh read.';
  return new SaxoBrokerProviderError(reason, undefined, 'EntryFilledDuringCancel', reason);
}

/**
 * `lookup`'s answer for dormant legs whose master a `cancel` saw open and
 * whose audit trail says nothing — see that method's doc for why neither
 * cancelling nor `null` is available here. Carried as `venueMessage` too,
 * same as `entryFilledDuringCancel` and for the same reason.
 */
function dormantLegsUncorroborated(externalReference: string): SaxoBrokerProviderError {
  const reason =
    `Saxo lookup '${externalReference}': its master left the open list inside a cancel and the ` +
    'audit trail answers nothing, so the protective legs cannot be corroborated either way — ' +
    'nothing was cancelled and no state is reported. The operator is paged while it persists.';
  return new SaxoBrokerProviderError(reason, undefined, 'DormantLegsUncorroborated', reason);
}

/** The bracket's protective legs as their own `listOpenOrders` rows, master excluded. */
function legRows(open: readonly SaxoOpenOrder[], clientOrderId: string): SaxoOpenOrder[] {
  const wireReference = saxoExternalReference(clientOrderId);
  return open.filter(
    (order) =>
      order.ExternalReference === legReference(wireReference, 'stop') ||
      order.ExternalReference === legReference(wireReference, 'target'),
  );
}

/**
 * `Status === 'NotWorking'` — still UNVERIFIED as "never activated" (see
 * `SaxoOpenOrderStatus`): doc 43 round 2 showed a fill leaves top-level legs
 * `Working`, so no fill produces the row this reads.
 */
function isNeverActivated(order: SaxoOpenOrder): boolean {
  return order.Status === 'NotWorking';
}

interface Placed {
  ids: OrderIds;
  order_state: BrokerAck['order_state'];
}

const DEAD_STATES: ReadonlySet<NormalizedOrder['order_state']> = new Set([
  'rejected',
  'cancelled',
  'expired',
]);

function adopt(existing: LookedUpOrder, externalReference: string): Placed {
  const state = existing.normalized.order_state;
  if (DEAD_STATES.has(state)) {
    // Carried as `venueMessage` so `sanitizeBrokerError` keeps it: the text
    // is composed here from our own reference and the venue's order id, not
    // copied from a response body, so the H1 boundary has nothing to strip.
    const reason =
      `Saxo already holds '${externalReference}' in state '${state}' (order ` +
      `${existing.normalized.broker_order_ids.join(',') || 'unknown'}); refusing to adopt a dead ` +
      'order or re-place under the same reference — the caller must issue a fresh id.';
    throw new SaxoBrokerProviderError(reason, undefined, 'DeadOrderUnderReference', reason);
  }
  return { ids: existing.ids, order_state: state };
}

/** Builds a `LookedUpOrder` from the master's own audit-trail row (`lookup`'s no-open-order fallback). */
function fromActivity(activity: SaxoOrderActivity, externalReference: string): LookedUpOrder {
  return {
    ids: { entry: activity.OrderId },
    side: activity.BuySell === 'Buy' ? 'buy' : 'sell',
    amount: activity.Amount,
    normalized: {
      client_order_id: externalReference,
      broker_order_ids: [activity.OrderId],
      order_state: activityState(activity),
      filled_qty: activity.FillAmount ?? 0,
    },
  };
}

/**
 * A dormant leg pair whose master audit row came back filled (`lookup`) —
 * uses the legs' real order ids, unlike `fromActivity`, which has no
 * related-order ids to offer.
 */
function legsFilled(
  legs: readonly SaxoOpenOrder[],
  master: SaxoOrderActivity,
  externalReference: string,
): LookedUpOrder {
  const [first] = legs;
  if (first === undefined) return fromActivity(master, externalReference);
  const ids: OrderIds = {};
  for (const leg of legs) {
    if (leg.OpenOrderType === 'StopIfTraded') ids.stop = leg.OrderId;
    else ids.target = leg.OrderId;
  }
  return {
    ids,
    side: first.BuySell === 'Buy' ? 'sell' : 'buy',
    amount: first.Amount,
    normalized: {
      client_order_id: externalReference,
      broker_order_ids: orderIdList(ids),
      order_state: 'filled',
      filled_qty: master.FillAmount ?? first.Amount,
    },
  };
}

function orderIdList(ids: OrderIds): string[] {
  return [ids.entry, ids.stop, ids.target].filter((id): id is string => id !== undefined);
}

function placementIds(placement: SaxoOrderPlacement): OrderIds {
  const ids: OrderIds = { entry: placement.OrderId };
  for (const related of placement.Orders ?? []) {
    if (related.ExternalReference?.endsWith(':stop')) ids.stop = related.OrderId;
    else if (related.ExternalReference?.endsWith(':target')) ids.target = related.OrderId;
  }
  return ids;
}

function legReference(clientOrderId: string, leg: Leg): string {
  return `${clientOrderId}:${leg}`;
}

function toBuySell(side: 'buy' | 'sell'): SaxoBuySell {
  return side === 'buy' ? 'Buy' : 'Sell';
}

function toDuration(timeInForce: string): SaxoDurationType {
  switch (timeInForce) {
    case 'day':
      return 'DayOrder';
    case 'gtc':
      return 'GoodTillCancel';
    case 'ioc':
      return 'ImmediateOrCancel';
    case 'fok':
      return 'FillOrKill';
    default:
      throw new Error(`Saxo has no DurationType for time_in_force '${timeInForce}'.`);
  }
}

/**
 * Cash price from the caller -> the number this venue takes on an order.
 * `ORDER_DECIMALS` applies AFTER the unit conversion because it is the
 * venue's own `OrderDecimals`, i.e. decimals of the QUOTED price.
 */
function venueOrderPrice(ref: SaxoInstrumentRef, cashPrice: number): number {
  return Number(saxoQuotedPrice(ref, cashPrice).toFixed(ORDER_DECIMALS));
}

function assertWholeUnits(size: number, clientOrderId: string): void {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(
      `Saxo order '${clientOrderId}' asks for ${size} units; LSE ETPs trade in whole units ` +
        '(MinimumLotSize 1, OddLotsNotAllowed on every pool line) — size at the caller.',
    );
  }
}

/**
 * Always passes today — `saxoExternalReference` fixes `wireReference` at
 * `SAXO_REFERENCE_HEX_CHARS`. Kept as a guard on that invariant rather than
 * on caller input, which this no longer bounds (#1510).
 */
function assertExternalReferenceFits(
  wireReference: string,
  suffixChars: number,
  clientOrderId: string,
): void {
  if (wireReference.length + suffixChars > EXTERNAL_REFERENCE_MAX_CHARS) {
    throw new Error(
      `Saxo ExternalReference '${wireReference}' (derived from '${clientOrderId}') exceeds ` +
        `${EXTERNAL_REFERENCE_MAX_CHARS} chars once the leg suffix is appended ` +
        `(${wireReference.length + suffixChars}).`,
    );
  }
}

function activityState(activity: SaxoOrderActivity): NormalizedOrder['order_state'] {
  if (activity.SubStatus === 'Rejected' || activity.Status === 'Rejected') return 'rejected';
  switch (activity.Status) {
    // MEASURED on SIM 2026-09-10 (#1216, doc 43): the venue writes
    // `FinalFill` on a full fill and never `Filled`, so `Filled` alone read
    // every real fill as `partially_filled` through the default branch.
    // `Filled` stays because nothing measures its ABSENCE from every venue
    // path — only that this one does not use it. A partial fill's own
    // status string is still unmeasured; the default branch below reads it
    // off `FillAmount`, which is measured.
    case 'FinalFill':
    case 'Filled':
      return 'filled';
    case 'Cancelled':
      return 'cancelled';
    case 'Expired':
      return 'expired';
    default:
      return (activity.FillAmount ?? 0) > 0 ? 'partially_filled' : 'submitted';
  }
}

/** A booked fill still in the VENUE's price unit — cash only after `toCashFill`. */
interface QuotedFill {
  client_order_id: string;
  broker_fill_id: string;
  leg: Leg;
  qty: number;
  quoted_price: number;
  timestamp: Date;
}

/**
 * A fill is booked only from an activity carrying a positive `FillAmount`
 * AND a finite `AveragePrice` — both VERIFIED on real fills (doc 43 round 2,
 * #1216). A row missing either is thrown so the sweep fails loudly and is
 * retried, rather than a filled position going unbooked and unprotected.
 * Both fill statuses gate that throw: the measured venue writes `FinalFill`
 * (doc 43 round 2), so keying it on `Filled` alone left the real one to be
 * dropped silently — the exact failure the guard exists to prevent.
 *
 * Deliberately unit-blind: whether the row can be priced at all is decided
 * here, and the instrument's factor is looked up only for a row that clears
 * this gate (#1302 round 1), so an unresolvable Uic on a row with no price
 * cannot refuse the caller's whole sweep.
 */
function toQuotedFill(
  activity: SaxoOrderActivity,
  clientOrderId: string,
  leg: Leg,
  since: Date,
): QuotedFill | undefined {
  const qty = activity.FillAmount;
  const quoted = activity.AveragePrice;
  const hasQty = typeof qty === 'number' && Number.isFinite(qty) && qty > 0;
  const hasPrice = typeof quoted === 'number' && Number.isFinite(quoted);
  if (!hasQty && !hasPrice) {
    if (activity.Status === 'FinalFill' || activity.Status === 'Filled') {
      throw new Error(
        `Saxo activity ${activity.LogId} for '${clientOrderId}' (${leg}) reports Status ` +
          `${activity.Status} without FillAmount/AveragePrice — both are measured on every ` +
          'real fill row (doc 43 round 2), so this row is unbookable, not empty.',
      );
    }
    return undefined;
  }
  if (!hasQty || !hasPrice) {
    throw new Error(
      `Saxo activity ${activity.LogId} for '${clientOrderId}' (${leg}) carries only one of ` +
        `FillAmount (${String(qty)}) and AveragePrice (${String(quoted)}).`,
    );
  }
  const reported = new Date(activity.ActivityTime);
  const timestamp = Number.isNaN(reported.getTime()) || reported < since ? since : reported;
  return {
    client_order_id: clientOrderId,
    broker_fill_id: activity.LogId,
    leg,
    qty,
    quoted_price: quoted,
    timestamp,
  };
}

/**
 * `AveragePrice` is the VENUE-QUOTED price, so it becomes cash through the
 * line's own factor (#1302) before anything above the adapter sees it. The
 * activity feed carries no charge field, so the fee is the published GBP-ETP
 * tariff (ADR-0015 §"Saxo", 0.08 %, no minimum) applied to that cash figure
 * and denominated in the line's `CurrencyCode` (USD on most pool lines) —
 * which `fee_currency` states rather than letting a USD figure be summed as
 * GBP. No FX rate is invented here.
 */
function toCashFill(fill: QuotedFill, ref: SaxoInstrumentRef): NormalizedFill {
  const price = saxoCashPerShare(ref, fill.quoted_price);
  return {
    client_order_id: fill.client_order_id,
    broker_fill_id: toBrokerFillId(fill.broker_fill_id),
    leg: fill.leg,
    price,
    qty: fill.qty,
    fee: price * fill.qty * SAXO_COMMISSION_RATE,
    fee_currency: ref.currency,
    timestamp: fill.timestamp,
  };
}
