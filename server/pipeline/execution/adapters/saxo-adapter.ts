/**
 * `BrokerAdapter` over Saxo OpenAPI — the live equity venue. Same seam,
 * journal and error boundary as `AlpacaBrokerAdapter`; what differs is
 * forced by the venue:
 *
 * - No durable client-order-id idempotency: a duplicate guard refuses an
 *   identical body for a rolling 15s window with 409, then places again. So
 *   every placement is ADOPT-OR-PLACE — look `ExternalReference` up on open
 *   orders and the audit trail first, place only if absent, treat a 409 as
 *   "look again", never as failure.
 * - The bracket is an IfDone master with two related orders. The venue
 *   cancels the related orders with the master on an explicit cancel
 *   (VERIFIED); `cancel` DELETEs the master alone. What Saxo does to the
 *   related orders on unfilled EXPIRY (vs. explicit cancel) is UNVERIFIED,
 *   so `findOpen`/`lookup`/`cancel` corroborate a dormant-legs read against
 *   the audit trail rather than trusting `Status` alone, and page repeatedly
 *   on a corroboration that never resolves rather than guessing.
 * - `IsOcoOrderSupported` is false on every pool line, so an entry-less
 *   protective pair cannot be expressed; `rearmProtectiveLegs` throws a
 *   PERMANENT refusal rather than retrying forever.
 * - Amounts are whole units; prices carry `OrderDecimals` 2 on every line.
 * - Prices cross this boundary in the VENUE's unit (pence on an LSE GBX
 *   line, which settles in GBP). Everything above the adapter speaks cash;
 *   `saxo-price-unit.ts` is the only conversion point.
 */
import { createHash } from 'node:crypto';
import type { Clock, Logger } from '../../../shared/index.js';
import { escalatesAt, isBookCurrency, safeLog, toBrokerFillId } from '../../../shared/index.js';
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

/** Measured on SIM: identical placements 17s apart both landed; inside the window the second earned 409 */
const SAXO_DUPLICATE_WINDOW_MS = 15_000;

/**
 * How far back a PLACEMENT looks on the audit trail before posting. Nothing
 * older than the venue's duplicate window can be a lost reply to this same
 * attempt; the caller's own write-ahead is the durable dedup across restarts.
 */
const PLACEMENT_LOOKBACK_MS = 4 * SAXO_DUPLICATE_WINDOW_MS;

/**
 * Saxo's `ExternalReference` limit. `computeIdempotencyKey`'s 64-hex digest
 * alone overruns this, so this adapter derives a second, narrower venue
 * identity via `saxoExternalReference` and translates back via
 * `wireReferences` on every read path.
 */
const EXTERNAL_REFERENCE_MAX_CHARS = 50;
const LEG_SUFFIX_MAX_CHARS = ':target'.length;

/**
 * Fixed output width of `saxoExternalReference`, chosen so a leg reference
 * stays inside `EXTERNAL_REFERENCE_MAX_CHARS` with headroom (40 + 7 = 47 of
 * 50). Hashes the WHOLE `client_order_id` rather than truncating the
 * pre-suffix digest, so a caller's own retry suffix still produces a
 * DISTINCT venue reference.
 */
const SAXO_REFERENCE_HEX_CHARS = 40;

/**
 * The venue-side identity for a `client_order_id` — one-way. Nothing
 * recovers `client_order_id` from this alone; every reverse lookup goes
 * through `wireReferences`.
 */
export function saxoExternalReference(clientOrderId: string): string {
  return createHash('sha256')
    .update(clientOrderId)
    .digest('hex')
    .slice(0, SAXO_REFERENCE_HEX_CHARS);
}

/**
 * `OrderDecimals` observed on every pool line. Applied AFTER
 * `saxoQuotedPrice`, so on a GBX line it rounds two decimals of PENCE. That
 * this is the grid the venue accepts there is UNVERIFIED — no order was
 * ever placed on a GBX line.
 */
const ORDER_DECIMALS = 2;

/**
 * How far back `getOrder`/`resumeFlatten` read the audit trail when an id is
 * not open. Orders are DayOrder under flat-by-close, so anything older than
 * this is a restart across many sessions, not a live lot.
 */
const DEFAULT_ACTIVITY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Consecutive observations of dormant legs this adapter could not resolve
 * (shared between `lookup()` and `cancel()`'s re-read, per reference),
 * before the FIRST `DormantLegsUnresolvedAlert`. Poll-count, not wall-clock:
 * this adapter is never told the poll cadence, and the grace exists only to
 * absorb one genuine race between two separate network calls (`findOpen` /
 * `listOrderActivities`) — a second consecutive occurrence rules that out.
 * A `listOrderActivities` throw neither advances nor resets the count —
 * ignorance is not evidence either way.
 */
export const DORMANT_DEFER_ALERT_AFTER = 2;

/**
 * How often the alert repeats while the master stays unresolved, in
 * wall-clock ms since the previous alert — NOT a poll count. A poll count
 * would make re-announcement frequency a silent function of the caller's
 * configured poll cadence instead of a stated interval (the defect
 * `FilledZeroSizeThrottle` was rebuilt to stop having). No cap or escalation
 * ladder, deliberately — a wedge must keep paging, audibly, for as long as
 * the audit trail stays silent.
 */
export const DORMANT_DEFER_ALERT_REPEAT_EVERY_MS = 15 * 60_000;

interface DormantDeferRecord {
  readonly consecutive: number;
  readonly firstObservedAt: Date;
  /**
   * A `cancel` on this reference read the master OPEN and its DELETE then
   * answered `OrderNotFound`. Outlives that one call so a later `lookup`
   * (no master of its own to see) doesn't strip the legs `cancel` just
   * refused to.
   */
  readonly masterSeenOpen: boolean;
  /** Epoch ms of the last `DormantLegsUnresolvedAlert`; `0` before the first */
  readonly lastAlertedAtMs: number;
}

/** `dormantDefer`'s namespace for the refusal counter — see that map's doc */
function refusedKey(externalReference: string): string {
  return `refused:${externalReference}`;
}

/** Whether THIS observation should page — grace met, and repeat interval elapsed */
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
 * How often an unresolvable quote unit re-announces, counted in consecutive
 * observations of the SAME Uic — both call sites are re-driven every poll
 * while the cause persists, so without this they'd announce at poll cadence.
 * Unlike `DORMANT_DEFER_ALERT_AFTER` there is NO grace before the first
 * announcement: a refused fill is a lot that cannot go terminal meanwhile.
 */
export const PRICE_UNIT_ALERT_REPEAT_EVERY = 8;

const PRICE_UNIT_CADENCE = { after: 1, every: PRICE_UNIT_ALERT_REPEAT_EVERY };

export interface SaxoInstrumentRef extends SaxoQuoteUnit {
  readonly uic: number;
  readonly asset_type: SaxoAssetType;
  /**
   * `CurrencyCode` — what `price x price_to_contract_factor` is denominated
   * in, which on a GBX line is NOT the unit the price is quoted in. Never
   * compute cash from this field alone.
   */
  readonly currency: string;
  /** `PriceCurrency`: `GBX` on a pence line whose `currency` is `GBP` */
  readonly price_currency: string | undefined;
}

/** LSE ticker <-> Saxo Uic, both ways: orders go out by Uic, positions come back by Uic */
export interface SaxoInstrumentResolver {
  resolve(lseTicker: string): SaxoInstrumentRef | undefined;
  lseTickerFor(uic: number): string | undefined;
}

/** The slice of an `LseEtpPoolRow` the resolver needs — structural so the pool module is not imported into the execution stage */
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
 * currency. Only a row's OWN line resolves — a `sibling_line` is a different
 * instrument and must not be traded under the row's ticker. A line whose
 * details cannot be read, or whose unit fields contradict each other, throws
 * rather than resolving without a factor.
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
 * The two unit fields must corroborate each other in BOTH directions —
 * either alone is a coin flip on a 100x pricing error. Holds only for the
 * GBP LSE-listed ETPs this adapter is restricted to; on other Saxo asset
 * types `PriceToContractFactor` is a legitimate contract multiplier. An
 * absent `PriceCurrency` corroborates nothing and is refused with the rest —
 * a gateway that omits the field fails at boot instead of mis-pricing.
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
  /** REQUIRED, no logging default: the only signal a partial entry fill leaves — see `resizeProtectiveLegs` */
  legResizeAlerts: LegResizeUnverifiedAlertChannel;
  /** REQUIRED, no default: `escalateIfStale` pages here rather than cancelling a dormant-legs wedge on suspicion or going quiet */
  dormantLegsAlerts: DormantLegsUnresolvedAlertChannel;
  /** REQUIRED, no default: a priced fill whose Uic resolves to no pool line both throws and pages — see `refuseUnresolvedPriceUnit` */
  priceUnitAlerts: UnresolvedPriceUnitAlertChannel;
  logger: Logger;
}

interface BracketRecord {
  instrument: string;
  /** `undefined` for a bracket journalled without its request (ids only) */
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
  /** Warmed from the journal so a restart keeps sweeping fills */
  private readonly brackets = new Map<string, BracketRecord>();
  private readonly flattens = new Map<string, FlattenRecord>();
  /**
   * Per-reference consecutive unresolved-observation count + first-observed
   * time for `escalateIfStale`. In memory and restart-clean, except
   * `masterSeenOpen`, which must survive to the next `cancel`/`lookup` pair.
   * Two conditions counted under namespaced keys (bare reference vs.
   * `refusedKey`) so a shared key can't let one caller's settled verdict
   * clear the other's wedge.
   */
  private readonly dormantDefer = new Map<string, DormantDeferRecord>();
  /**
   * Consecutive observations of a Uic whose quote unit is unresolvable, one
   * namespaced key per site. In memory and restart-clean. No counterpart to
   * `clearDormantDefer`: the resolver is built once from a fixed row set, so
   * an unresolvable Uic stays unresolvable for the life of the process.
   */
  private readonly priceUnitDefer = new Map<string, number>();
  /**
   * `saxoExternalReference(clientOrderId)` -> `clientOrderId`, the reverse
   * direction `attribute()` needs and the one-way digest cannot supply.
   * Populated wherever a `client_order_id` first becomes known.
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
      // GTC, not the entry's duration: a Day leg would buy nothing except a
      // naked position if flat-by-close ever misses
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
   * The quote unit is resolved only for a row that is already a PRICED fill.
   * A row with nothing to scale (`Placed`, `Cancelled`, a still-`Working`
   * leg) must not fail the sweep just because its Uic is unresolvable.
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
   * Whether Saxo shrinks an IfDone master's related orders on a PARTIAL
   * entry fill is UNVERIFIED. Alerted, not thrown — `ingestFills` calls this
   * before `applyLotAdvance`, so a throw here would leave the fill
   * un-persisted, worse than the leg-size doubt.
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
   * Thrown OUTSIDE `this.call`, and that is load-bearing: the refusal is a
   * settled property of the venue, not an attempt that failed, and
   * `sanitizeBrokerError` would erase the discriminant the sweep reads to
   * tell those two apart — see `ProtectiveRearmUnsupportedError`'s invariant
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
   * Cancels the bracket — the MASTER first and alone. The venue cancels an
   * IfDone master's related orders with it (VERIFIED), so no leg is ever
   * named from the same open-orders snapshot the master was read in — that
   * snapshot is exactly what the entry can fill out of between the read and
   * the DELETE. `OrderNotFound` on the DELETE is the tell that the snapshot
   * went stale inside this call, so legs are re-derived from a FRESH read.
   * Every other error rethrows, leaving the legs untouched.
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
   * list. `masterWasOpen` means the master's DELETE just answered
   * `OrderNotFound` — so any fill evidence here means the entry filled
   * INSIDE this call, predating the caller's own view. The adapter cannot
   * know whether the caller's flatten covers that quantity, so it refuses
   * rather than guess, leaving the legs as cover. Only settled state is
   * cancelled: activated legs with no DELETE refusal, or dormant legs the
   * audit trail corroborates as dead — never on `Status` alone. A
   * corroboration that says nothing pages via `escalateIfStale` rather than
   * cancelling or refusing.
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
      await this.resolveDormantClearVerdict(
        verdict,
        clientOrderId,
        legs,
        instrument,
        masterWasOpen,
      );
      return;
    }
    if (masterWasOpen) throw await this.refuse(clientOrderId, instrument, FILL_INSIDE_CALL);
    this.clearRefusedDefer(clientOrderId);
    await this.cancelOrderIds(legs.map((leg) => leg.OrderId));
  }

  private async resolveDormantClearVerdict(
    verdict: DormantVerdict,
    clientOrderId: string,
    legs: readonly SaxoOpenOrder[],
    instrument: string,
    masterWasOpen: boolean,
  ): Promise<void> {
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
      await this.cancelOrderIds(legs.map((leg) => leg.OrderId));
      return;
    }
    throw await this.refuse(
      clientOrderId,
      instrument,
      masterWasOpen ? FILL_INSIDE_CALL : FILL_UNPLACED,
    );
  }

  /**
   * `clearLegs`' refusal, counted before it is thrown — a refusal alone
   * reports through the caller's error path only, no alert channel, so a
   * wedge here would refuse every exit attempt with nothing paging. Counts
   * on its own `refusedKey` rather than sharing the defer count, since the
   * two conditions resolve independently.
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
   * Adopt-or-place. The open list is authoritative for a resting order; the
   * recent audit trail catches one that already filled or died before this
   * retry. An adopted order is acked in ITS state, never as `submitted`. A
   * dead one is refused outright — re-placing under the same reference would
   * hide the venue's verdict, and adopting it would journal an armed bracket
   * over nothing.
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
      // A dormant-legs signal here is not acted on — cancelling on `Status`
      // alone is the UNVERIFIED read `lookup` exists to avoid. Left for the
      // next `reconcile()` pass to settle against the audit trail
      if (adopted !== null) throw cause;
      // The open list forgets an order the instant it stops being open, on a
      // fill too — the audit trail still carries it, so it's adopted in its
      // own state rather than reported as a failed flatten
      const latest = await this.latestActivityFor(externalReference, PLACEMENT_LOOKBACK_MS);
      if (latest === undefined) throw cause;
      return adopt(fromActivity(latest, externalReference), externalReference);
    }
  }

  /**
   * A net position's `AverageOpenPrice` in cash. A Uic no pool line resolves
   * reports `null` rather than throwing — a position under an unrecognised
   * Uic is not necessarily this system's, and refusing the whole sweep would
   * blind `reconcile` to every OTHER position including our own.
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
   * Records one more consecutive unresolvable-unit observation and answers
   * whether THIS one announces. Only the announcement is throttled — every
   * caller still nulls or refuses its own price on every poll.
   */
  private shouldAnnounceUnresolvedUnit(site: 'fill' | 'position', uic: number): boolean {
    const key = `${site}:${uic}`;
    const consecutive = (this.priceUnitDefer.get(key) ?? 0) + 1;
    this.priceUnitDefer.set(key, consecutive);
    return escalatesAt(consecutive, PRICE_UNIT_CADENCE);
  }

  /**
   * Pages, then hands back the error to throw, for a PRICED fill whose Uic
   * resolves to no pool line: a raw venue price on a GBX line is 100x wrong,
   * so booking it is worse than not booking. A PERSISTENT cause re-throws
   * every poll since `since` never advances past the stuck row, so the page
   * is throttled (`PRICE_UNIT_ALERT_REPEAT_EVERY`) but the REFUSAL never is.
   * Delivery failure is swallowed to a log line.
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
    if (master !== undefined) return masterLookup(master, externalReference);
    // Only the protective legs still open, no master. `Working` on a leg
    // means it ACTIVATED on the entry's fill (VERIFIED), treated as filled
    // below — but a master's legs activating the same way on EXPIRY rather
    // than a fill is UNVERIFIED, so `lookup` corroborates this reading
    // against the master's audit trail too (see `corroborateActivatedLegs`)
    const legs = legRows(open, externalReference);
    const [first] = legs;
    if (first === undefined) return null;
    if (legs.every(isNeverActivated)) return { dormant: legs };
    return activatedLegsLookup(externalReference, legs, first);
  }

  /**
   * Cancels a related-order pair with no master left to cancel it for us —
   * only settled state reaches here. Every leg is attempted independently
   * (a prior version stopped at the first non-`OrderNotFound` failure,
   * leaving siblings un-attempted); `OrderNotFound` is swallowed as success,
   * and the first other failure is thrown only once every leg has been tried.
   */
  private async cancelOrderIds(orderIds: readonly string[]): Promise<void> {
    let hasFailure = false;
    let firstFailure: unknown;
    for (const orderId of orderIds) {
      try {
        await this.client.cancelOrder(orderId);
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
   * not resolve, and posts `DormantLegsUnresolvedAlert` once
   * `dueForDormantDeferAlert` says it is due. `masterSeenOpen` is stored here
   * so it stays sticky across a `cancel` followed by `lookup` under the same
   * reference. Fire-and-forget, fully swallowed.
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
   * reference, so a later, unrelated dormant episode starts fresh rather
   * than inheriting a stale count. Deliberately does NOT clear the
   * `refusedKey` count — a `Filled` verdict resolves `lookup` but not
   * `cancel`, so clearing both here would let the refusal wedge never page.
   */
  private clearDormantDefer(externalReference: string): void {
    this.dormantDefer.delete(externalReference);
  }

  /** Clears the refusal count once `cancel` reaches a settled answer for this reference */
  private clearRefusedDefer(externalReference: string): void {
    this.dormantDefer.delete(refusedKey(externalReference));
  }

  /** Every audit-trail row for `externalReference` inside `lookbackMs`, unordered */
  private async activitiesFor(
    externalReference: string,
    lookbackMs: number,
  ): Promise<SaxoOrderActivity[]> {
    const from = new Date(this.clock.now().getTime() - lookbackMs);
    const wireReference = saxoExternalReference(externalReference);
    const activities = await this.client.listOrderActivities(from);
    return activities.filter((activity) => activity.ExternalReference === wireReference);
  }

  /**
   * The most recent audit-trail row for `externalReference` inside
   * `lookbackMs`, or none. Ties on `ActivityTime` break by array order —
   * `corroborateActivatedLegs` reads `activitiesFor` directly instead, to
   * avoid exactly that.
   */
  private async latestActivityFor(
    externalReference: string,
    lookbackMs: number,
  ): Promise<SaxoOrderActivity | undefined> {
    const rows = await this.activitiesFor(externalReference, lookbackMs);
    let latest: SaxoOrderActivity | undefined;
    for (const activity of rows) {
      if (latest === undefined || activity.ActivityTime >= latest.ActivityTime) latest = activity;
    }
    return latest;
  }

  /**
   * `findOpen`'s dormant-legs signal is never acted on by `Status` alone
   * (UNVERIFIED) — corroborated here against the master's own audit-trail
   * row first. A filled row: the entry genuinely filled, adopted using the
   * legs' real order ids. A dead-terminal row: the master is confirmed
   * done, so the legs are cancelled and THAT state is reported, not `null`.
   * No row at all: cancelled with `null`, UNLESS `cancel` has already
   * recorded `masterSeenOpen` for this reference, in which case this throws
   * `DormantLegsUncorroborated` instead — it must not cancel legs `cancel`
   * just refused to, and must not answer `null` either (which
   * `reconcileLot` reads as "never landed" and erases). Anything else
   * (no terminal status yet) defers — `escalateIfStale` pages once the
   * count crosses its threshold, repeating while the wedge persists.
   */
  private async lookup(
    externalReference: string,
    lookbackMs: number,
    instrument?: string,
  ): Promise<LookedUpOrder | null> {
    const open = await this.findOpen(externalReference);
    if (open !== null && !isDormantLegs(open)) {
      // `kind: 'legs'` is `findOpen`'s activated-legs-no-master branch (the
      // master-present branch is always `kind: 'master'`) — the read
      // `corroborateActivatedLegs` exists to check (#1215, #1426)
      if (open.kind === 'legs') {
        return this.resolveActivatedLegsLookup(open, externalReference, lookbackMs);
      }
      this.clearDormantDefer(externalReference);
      return open;
    }

    if (open === null) {
      const latest = await this.latestActivityFor(externalReference, lookbackMs);
      if (latest === undefined) return null;
      this.clearDormantDefer(externalReference);
      return fromActivity(latest, externalReference);
    }

    return this.resolveDormantLegsLookup(open, externalReference, lookbackMs, instrument);
  }

  /**
   * Cancelling off `open.legs` here — rather than the role-deduped
   * `orderIdList(open.ids)` — matches `clearLegs`' own behavior on the mirror
   * branch and does not silently drop a duplicate row under one leg's
   * reference (#1215 round 3).
   */
  private async resolveActivatedLegsLookup(
    open: LookedUpActivatedLegsOrder,
    externalReference: string,
    lookbackMs: number,
  ): Promise<LookedUpOrder> {
    const verdict = await this.corroborateActivatedLegs(externalReference, lookbackMs);
    if (verdict.kind === 'expired') {
      await this.cancelOrderIds(open.legs.map((leg) => leg.OrderId));
      this.clearDormantDefer(externalReference);
      return fromActivity(verdict.latest, externalReference);
    }
    this.clearDormantDefer(externalReference);
    // The audit trail's own fill amount replaces the leg's resting `Amount`
    // when corroboration found one — `Amount` is the order size, not
    // necessarily what actually filled (#1563). A summed `0` (a
    // filled-classified row with no `FillAmount`, e.g. a bare `FinalFill`) is
    // no better than what `open` already carries, not a genuine zero-fill,
    // so it falls through to `open`'s own `first.Amount` reading instead of
    // overriding it (#1574). The override is also clamped at the order's own
    // `Amount`: summed `FillAmount` has no cross-row idempotency behind it
    // (this adapter's ~15s retry window, doc 43), so duplicate fill rows
    // under one wire reference must not be allowed to report a fill larger
    // than the order itself (#1574)
    return verdict.filledQty === undefined || verdict.filledQty <= 0
      ? open
      : {
          ...open,
          normalized: {
            ...open.normalized,
            filled_qty: Math.min(verdict.filledQty, open.amount),
          },
        };
  }

  // The same mutually exclusive verdict shape `resolveDormantClearVerdict`
  // handles for `clearLegs`, just with `lookup`'s own return values
  private async resolveDormantLegsLookup(
    open: DormantLegs,
    externalReference: string,
    lookbackMs: number,
    instrument: string | undefined,
  ): Promise<LookedUpOrder | null> {
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
    await this.cancelOrderIds(open.dormant.map((leg) => leg.OrderId));
    return verdict.latest === undefined ? null : fromActivity(verdict.latest, externalReference);
  }

  /**
   * The dormant-legs corroboration `lookup` describes, shared with `cancel`
   * so both reach the venue's verdict the same way. `masterKnownOpen` (this
   * call just saw the master open, then `OrderNotFound` on its DELETE) makes
   * an empty audit answer a corroboration failure, not a clean `cancel` —
   * zero information must not buy more destruction than a non-terminal row
   * does. Defer state is per-reference: a per-call flag would let the very
   * next poll strip legs `cancel` just refused to strip.
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
   * Corroborates `findOpen`'s "legs Working, no master" read against the
   * master's own audit-trail row — a `Working` leg pair is indistinguishable
   * from a genuine fill by `Status` alone, same as `corroborateDormantLegs`
   * checks for a `NotWorking` pair. Deliberately ASYMMETRIC with that check:
   * here, declining to recognize a possibly-live position delays fill
   * ingestion and flat-by-close, which is worse than the phantom-fill risk
   * this catches — so only a SETTLED, TERMINAL non-`Filled` master row
   * downgrades the read, and only once no row shows fill evidence anywhere
   * in the lookback (a later `Cancelled` residual row must not shadow an
   * earlier `FinalFill` row for the same reference — scans every row, not
   * just the latest). `filledQty` can legitimately be `0` (a fill-classified
   * row with no `FillAmount` of its own) — `lookup` treats that as "no
   * override," never as a false zero.
   */
  private async corroborateActivatedLegs(
    externalReference: string,
    lookbackMs: number,
  ): Promise<
    { kind: 'confirmed'; filledQty?: number } | { kind: 'expired'; latest: SaxoOrderActivity }
  > {
    const rows = await this.activitiesFor(externalReference, lookbackMs);
    const fillRows = rows.filter(
      (row) => activityState(row) === 'filled' || (row.FillAmount ?? 0) > 0,
    );
    if (fillRows.length > 0) {
      // Summed, not read off one row — a partial fill split across several
      // activity rows would under-report at any single row's own amount
      return {
        kind: 'confirmed',
        filledQty: fillRows.reduce((sum, row) => sum + (row.FillAmount ?? 0), 0),
      };
    }
    let latest: SaxoOrderActivity | undefined;
    for (const row of rows) {
      if (latest === undefined || row.ActivityTime >= latest.ActivityTime) latest = row;
    }
    if (latest !== undefined && DEAD_STATES.has(activityState(latest))) {
      return { kind: 'expired', latest };
    }
    return { kind: 'confirmed' };
  }

  /**
   * `externalReference` here is the actual wire value observed on an
   * activity row — the one place this adapter goes reference-to-order,
   * so the one place that reads `wireReferences` rather than deriving
   * forward with `saxoExternalReference`
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
  /** Absent when only the protective legs are still open — the entry is no longer a venue order */
  entry?: string;
  stop?: string;
  target?: string;
}

interface LookedUpMasterOrder {
  readonly kind: 'master';
  ids: OrderIds;
  side: 'buy' | 'sell';
  amount: number;
  normalized: NormalizedOrder;
}

/**
 * `findOpen`'s activated-legs-no-master branch: only the protective legs are
 * open, the master itself is gone. `legs` carries the raw `listOpenOrders`
 * rows behind `ids` — `ids.stop`/`ids.target` collapse by role, so a
 * duplicate row under the same leg reference would be silently dropped from
 * `ids`; `lookup` cancels off `legs` instead, matching `clearLegs`.
 */
interface LookedUpActivatedLegsOrder {
  readonly kind: 'legs';
  ids: OrderIds;
  legs: readonly SaxoOpenOrder[];
  side: 'buy' | 'sell';
  amount: number;
  normalized: NormalizedOrder;
}

type LookedUpOrder = LookedUpMasterOrder | LookedUpActivatedLegsOrder;

/** `findOpen`'s signal for a related-order pair found `NotWorking` with no master — see `lookup` */
interface DormantLegs {
  readonly dormant: readonly SaxoOpenOrder[];
}

function isDormantLegs(result: LookedUpOrder | DormantLegs): result is DormantLegs {
  return 'dormant' in result;
}

/**
 * `corroborateDormantLegs`' reading of the master's audit row: the entry
 * filled, the master died without filling (`latest` absent when no row ties
 * the legs to any known order at all), or the trail has not settled yet
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

/** The bracket's protective legs as their own `listOpenOrders` rows, master excluded */
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
 * `Working`, so no fill produces the row this reads
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
    // copied from a response body, so the H1 boundary has nothing to strip
    const reason =
      `Saxo already holds '${externalReference}' in state '${state}' (order ` +
      `${existing.normalized.broker_order_ids.join(',') || 'unknown'}); refusing to adopt a dead ` +
      'order or re-place under the same reference — the caller must issue a fresh id.';
    throw new SaxoBrokerProviderError(reason, undefined, 'DeadOrderUnderReference', reason);
  }
  return { ids: existing.ids, order_state: state };
}

/** Builds a `LookedUpOrder` from an open master row — `findOpen`'s resting-entry case */
function masterLookup(master: SaxoOpenOrder, externalReference: string): LookedUpOrder {
  const ids: OrderIds = { entry: master.OrderId };
  for (const related of master.RelatedOpenOrders ?? []) {
    if (related.OpenOrderType === 'StopIfTraded') ids.stop = related.OrderId;
    else ids.target = related.OrderId;
  }
  const filled = master.FilledAmount ?? 0;
  return {
    kind: 'master',
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

/** Builds a `LookedUpOrder` from an activated (top-level `Working`) leg pair — `findOpen`'s no-master case */
function activatedLegsLookup(
  externalReference: string,
  legs: readonly SaxoOpenOrder[],
  first: SaxoOpenOrder,
): LookedUpOrder {
  const ids: OrderIds = {};
  for (const leg of legs) {
    if (leg.OpenOrderType === 'StopIfTraded') ids.stop = leg.OrderId;
    else ids.target = leg.OrderId;
  }
  return {
    kind: 'legs',
    ids,
    legs,
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

/** Builds a `LookedUpOrder` from the master's own audit-trail row (`lookup`'s no-open-order fallback) */
function fromActivity(activity: SaxoOrderActivity, externalReference: string): LookedUpOrder {
  return {
    kind: 'master',
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
 * related-order ids to offer
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
    kind: 'legs',
    ids,
    legs,
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
    // MEASURED: the venue writes `FinalFill` on a full fill, never `Filled`
    // `Filled` stays handled too since nothing measures its absence elsewhere
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

/** A booked fill still in the VENUE's price unit — cash only after `toCashFill` */
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
 * AND a finite `AveragePrice`. A row missing either is thrown so the sweep
 * fails loudly and is retried, rather than a filled position going unbooked
 * and unprotected. Deliberately unit-blind: the instrument's factor is
 * looked up only for a row that clears this gate, so an unresolvable Uic on
 * a row with no price cannot refuse the caller's whole sweep.
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
 * Fee is the published GBP-ETP tariff (ADR-0015 "Saxo", 0.08%, no minimum)
 * on the cash price, denominated in the line's own `CurrencyCode` (often
 * USD) via `fee_currency` — never summed as GBP. `fx_rate_to_gbp` is never
 * invented: the venue's activity feed carries no conversion-rate field, so a
 * non-book-currency fill gets an explicit `fx_rate_to_gbp_source` instead of
 * a silently missing one.
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
    ...(isBookCurrency(ref.currency) ? {} : { fx_rate_to_gbp_source: 'not_reported_by_venue' }),
    timestamp: fill.timestamp,
  };
}
