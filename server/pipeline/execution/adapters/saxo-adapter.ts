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
 *   (VERIFIED, doc 43). What Saxo does to a `DayOrder` master's own related
 *   orders when it EXPIRES unfilled at session end, rather than being
 *   cancelled, is UNVERIFIED (#1215) — this adapter defends only the branch
 *   where Saxo leaves them `NotWorking` (parked, never activated): `findOpen`
 *   / `lookup` corroborate that read against the audit trail before
 *   cancelling (#1215 round 1), rather than journalling a phantom fill. A
 *   corroboration that never resolves (no terminal audit row ever lands) is
 *   paged, repeatedly, rather than deferred forever or cancelled without
 *   evidence (#1215 round 2 — `escalateIfStale`). If Saxo instead ACTIVATES
 *   the legs on expiry the same way it would on a genuine fill (`Working` on
 *   the book), that read is indistinguishable from a real fill by `Status`
 *   alone — the overnight-resting risk this ticket names lives entirely on
 *   that branch and is UNCHANGED by this fix.
 * - `IsOcoOrderSupported` is false on every pool line, so an entry-less
 *   protective pair cannot be expressed; `rearmProtectiveLegs` throws.
 * - Amounts are whole units (`MinimumLotSize` 1, `OddLotsNotAllowed`) and
 *   prices carry `OrderDecimals` 2 on every pool line.
 */
import type { Clock, Logger } from '../../../shared/index.js';
import { safeLog } from '../../../shared/index.js';
import { SAXO_COMMISSION_RATE } from '../../../tools/backtest/index.js';
import { sanitizeBrokerError } from '../broker-error.js';
import {
  type BrokerStateStore,
  InMemoryBrokerStateStore,
  toRequestFields,
} from '../broker-state-store.js';
import type { DormantLegsUnresolvedAlertChannel } from '../dormant-legs-unresolved-alert.js';
import type { LegResizeUnverifiedAlertChannel } from '../leg-resize-unverified-alert.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../types.js';
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

/** Saxo's `ExternalReference` limit; the `:target` suffix is the longest this adapter appends. */
const EXTERNAL_REFERENCE_MAX_CHARS = 50;
const LEG_SUFFIX_MAX_CHARS = ':target'.length;

/** `OrderDecimals` observed on every pool line's instrument details. */
const ORDER_DECIMALS = 2;

/**
 * How far back `getOrder`/`resumeFlatten` read the audit trail when an id is
 * not open. Orders are DayOrder under ADR-0014's flat-by-close, so anything
 * older than this is a restart across many sessions, not a live lot.
 */
const DEFAULT_ACTIVITY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Consecutive `lookup()` calls that found the legs dormant (`findOpen`) but
 * the master's OWN audit-trail row not yet terminal, before the FIRST
 * `DormantLegsUnresolvedAlert` — see `escalateIfStale`. A wall-clock age was
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
 */
export const DORMANT_DEFER_ALERT_AFTER = 2;

/**
 * How often the alert repeats while the master stays unresolved, counted in
 * further consecutive defer observations after the first — the same
 * poll-count-8 warn cadence `ALERT_REPEAT_EVERY_DIAGNOSTICS`
 * (trader-diagnostic-alert.ts) uses, for the same reason: visible enough
 * that the channel is not a one-shot the operator can miss, rare enough it
 * is not an unbroken flood while the state persists (ruling (c), #1215
 * round 2: recurring, not silent — but not every poll either).
 * `FilledZeroSizeThrottle`'s own repeat used to be this same shape; #1383
 * rebuilt it into a warn-once, low-cadence-info design instead (see
 * filled-zero-size-throttle.ts) — a different problem's answer, not a
 * precedent for this one, which still wants a genuine `warn` repeat.
 */
export const DORMANT_DEFER_ALERT_REPEAT_EVERY = 8;

function shouldWarnDormantDefer(consecutive: number): boolean {
  if (consecutive < DORMANT_DEFER_ALERT_AFTER) return false;
  return (consecutive - DORMANT_DEFER_ALERT_AFTER) % DORMANT_DEFER_ALERT_REPEAT_EVERY === 0;
}

export interface SaxoInstrumentRef {
  readonly uic: number;
  readonly asset_type: SaxoAssetType;
  readonly currency: string;
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
        readonly currency: string;
      } | null;
    };
  };
}

/**
 * Builds the resolver from the pool's recorded Saxo evidence. Only a row's
 * OWN line resolves — a `sibling_line` is a different instrument
 * (`lse-etp-pool.ts`) and must not be traded under the row's ticker.
 */
export function saxoInstrumentResolverFromPool(
  rows: readonly SaxoResolvablePoolRow[],
): SaxoInstrumentResolver {
  const byTicker = new Map<string, SaxoInstrumentRef>();
  const byUic = new Map<number, string>();
  for (const row of rows) {
    const line = row.provenance.saxo.line;
    if (line === null) continue;
    byTicker.set(row.lse_ticker, {
      uic: line.uic,
      asset_type: line.asset_type,
      currency: line.currency,
    });
    byUic.set(line.uic, row.lse_ticker);
  }
  return {
    resolve: (lseTicker) => byTicker.get(lseTicker),
    lseTickerFor: (uic) => byUic.get(uic),
  };
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
  /** Warmed from the journal so a restart keeps sweeping fills. */
  private readonly brackets = new Map<string, BracketRecord>();
  private readonly flattens = new Map<string, FlattenRecord>();
  /**
   * Per-reference consecutive defer count + first-observed time for
   * `escalateIfStale`. In memory and restart-clean — same posture as
   * `FilledZeroSizeThrottle`'s own map (its doc): a process that just
   * restarted has no evidence about the previous process's polls.
   */
  private readonly dormantDefer = new Map<string, { consecutive: number; firstObservedAt: Date }>();

  constructor(input: SaxoBrokerAdapterInput) {
    this.client = input.client;
    this.instruments = input.instruments;
    this.state = input.state ?? new InMemoryBrokerStateStore();
    this.clock = input.clock ?? { now: () => new Date() };
    this.activityLookbackMs = input.activityLookbackMs ?? DEFAULT_ACTIVITY_LOOKBACK_MS;
    this.logger = input.logger;
    this.legResizeAlerts = input.legResizeAlerts;
    this.dormantLegsAlerts = input.dormantLegsAlerts;
    for (const record of this.state.loadBrackets('saxo')) {
      this.brackets.set(record.client_order_id, {
        instrument: record.request?.instrument ?? '',
        size: record.request?.size,
      });
    }
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
    assertExternalReferenceFits(order.client_order_id, LEG_SUFFIX_MAX_CHARS);

    const exitSide = toBuySell(order.side === 'buy' ? 'sell' : 'buy');
    const leg = (type: 'StopIfTraded' | 'Limit', price: number, suffix: Leg) => ({
      OrderType: type,
      OrderPrice: roundPrice(price),
      BuySell: exitSide,
      Amount: order.size,
      AssetType: ref.asset_type,
      Uic: ref.uic,
      // GTC, not the entry's duration: a related order only activates on the
      // entry's fill and dies with the master's cancel, so a Day leg would
      // buy nothing except a naked position if flat-by-close ever misses.
      OrderDuration: { DurationType: 'GoodTillCancel' as const },
      ManualOrder: false as const,
      ExternalReference: legReference(order.client_order_id, suffix),
    });
    const request: SaxoOrderRequest = {
      Uic: ref.uic,
      AssetType: ref.asset_type,
      BuySell: toBuySell(order.side),
      Amount: order.size,
      OrderType: 'Limit',
      OrderPrice: roundPrice(order.entry),
      OrderDuration: { DurationType: toDuration(order.time_in_force) },
      ManualOrder: false,
      ExternalReference: order.client_order_id,
      Orders: [leg('StopIfTraded', order.stop, 'stop'), leg('Limit', order.target, 'target')],
    };

    const { ids, order_state } = await this.call('submitBracket', () =>
      this.placeIdempotently(order.client_order_id, request, order.instrument),
    );
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
    this.flattens.set(clientOrderId, {
      instrument,
      side: order.side,
      size: order.normalized.filled_qty > 0 ? order.normalized.filled_qty : order.amount,
    });
    return order.normalized;
  }

  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const activities = await this.call('fetchNewFills', () =>
      this.client.listOrderActivities(since),
    );
    const fills: NormalizedFill[] = [];
    for (const activity of activities) {
      const owner = this.attribute(activity.ExternalReference);
      if (owner === undefined) continue;
      const fill = toFill(activity, owner.clientOrderId, owner.leg, since);
      if (fill === undefined) continue;
      const feeCurrency = this.feeCurrencyFor(activity);
      fills.push(feeCurrency === undefined ? fill : { ...fill, fee_currency: feeCurrency });
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

  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    _side: 'buy' | 'sell',
    _qty: number,
    _stop: number,
    _target: number,
  ): Promise<void> {
    throw new Error(
      `Saxo cannot re-arm protective legs for '${clientOrderId}' (${instrument}): every pool ` +
        'line reports IsOcoOrderSupported false (instrument details, 2026-09-05), so an ' +
        'entry-less stop+target pair is inexpressible without a hand-emulated OCO — #525 ' +
        'fallback applies.',
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
    assertExternalReferenceFits(clientOrderId, 0);
    const request: SaxoOrderRequest = {
      Uic: ref.uic,
      AssetType: ref.asset_type,
      BuySell: toBuySell(side),
      Amount: size,
      OrderType: 'Market',
      OrderDuration: { DurationType: 'DayOrder' },
      ManualOrder: false,
      ExternalReference: clientOrderId,
    };
    const { ids, order_state } = await this.call('submitFlatten', () =>
      this.placeIdempotently(clientOrderId, request, instrument),
    );
    this.flattens.set(clientOrderId, { instrument, side, size });
    return { client_order_id: clientOrderId, broker_order_ids: orderIdList(ids), order_state };
  }

  async cancel(clientOrderId: string, _instrument: string): Promise<void> {
    await this.call('cancel', async () => {
      const owned = new Set([
        clientOrderId,
        legReference(clientOrderId, 'stop'),
        legReference(clientOrderId, 'target'),
      ]);
      const open = await this.client.listOpenOrders();
      for (const order of open) {
        if (order.ExternalReference === undefined || !owned.has(order.ExternalReference)) continue;
        try {
          await this.client.cancelOrder(order.OrderId);
        } catch (cause) {
          if (!isOrderNotFound(cause)) throw cause;
        }
      }
    });
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
        avg_entry_price: position.NetPositionView.AverageOpenPrice ?? null,
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
   * The activity feed carries no charge field, so the fee is the published
   * GBP-ETP tariff (ADR-0015 §"Saxo", 0.08 %, no minimum) applied to the fill
   * — and it is denominated in the LINE's quote currency (USD on most pool
   * lines), which `NormalizedFill.fee_currency` makes explicit rather than
   * letting a USD figure be summed as GBP. No FX rate is invented here.
   *
   * A Uic no pool line resolves leaves that ONE fill's currency unset and is
   * logged at `error`; it does not fail the sweep, which would hold every
   * other fill in the same batch hostage to one attribution gap.
   */
  private feeCurrencyFor(activity: SaxoOrderActivity): string | undefined {
    const ticker = this.instruments.lseTickerFor(activity.Uic);
    const ref = ticker === undefined ? undefined : this.instruments.resolve(ticker);
    if (ref !== undefined) return ref.currency;
    safeLog(this.logger, {
      trace_id: 'saxo-fill-sweep',
      stage: 'execution',
      level: 'error',
      event: 'saxo_fill_fee_currency_unresolved',
      message: 'Saxo fetchNewFills: fill Uic resolves to no pool line; fee_currency left unset',
      payload: {
        log_id: activity.LogId,
        uic: activity.Uic,
        external_reference: activity.ExternalReference,
      },
    });
    return undefined;
  }

  private async findOpen(externalReference: string): Promise<LookedUpOrder | DormantLegs | null> {
    const open = await this.client.listOpenOrders();
    const master = open.find((order) => order.ExternalReference === externalReference);
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
    // means it ACTIVATED on the entry's fill — treated as filled below. A
    // pair every leg reads `NotWorking` (never activated) SIGNALS
    // the entry expired unfilled, but that two-value contract is UNVERIFIED
    // (#1215 round 1: doc 43 never listed a resting IfDone leg row, only
    // standalone `DayOrder` `Limit`s always `Working` — see
    // `SaxoOpenOrderStatus`), so it is not proof; `lookup` corroborates it
    // against the audit trail before cancelling anything.
    const legs = open.filter(
      (order) =>
        order.ExternalReference === legReference(externalReference, 'stop') ||
        order.ExternalReference === legReference(externalReference, 'target'),
    );
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
   * Cancels a related-order pair `lookup` confirmed dormant against the
   * audit trail (#1215 round 1) — legs from an entry that expired unfilled
   * rather than a genuine fill. Every leg is attempted independently
   * (#1215 round 2): the prior version stopped at the first non-
   * `OrderNotFound` failure, so a sibling leg could be left un-attempted,
   * not merely left cancelled while a later one fails. No rebuild is ever
   * needed after a partial cancel here — these legs are dormant (no fill
   * occurred, so no live position depends on them; `rearmProtectiveLegs`
   * would throw for Saxo regardless) and `findOpen` re-derives the live leg
   * set from the venue fresh on every poll, so a retry converges against
   * whatever the venue actually still holds. `OrderNotFound` is swallowed
   * exactly as `cancel()`'s own loop does: the venue may have already
   * reaped one on its own, and that is success, not failure. The first
   * other failure is thrown only once every leg has been attempted — this
   * runs inside a caller already wrapped in `this.call`, so it surfaces as
   * the caller's own sanitized `BrokerError` rather than a silently-kept
   * doubt.
   */
  private async cancelDormantLegs(legs: readonly SaxoOpenOrder[]): Promise<void> {
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
   * Records one more consecutive "legs dormant, master's audit row not yet
   * terminal" observation for `externalReference` and posts
   * `DormantLegsUnresolvedAlert` once `shouldWarnDormantDefer` says it is
   * due — see that function's own doc for the bound and repeat cadence.
   * Fire-and-forget, fully swallowed: same posture as
   * `postFlattenReconcileAlert` (reconcile.ts) — the poll this alert
   * reports on already completed, there is nothing here to undo on a
   * transport failure, and the failure itself is the one thing worth a log
   * line, not the alert content repeated.
   */
  private async escalateIfStale(
    externalReference: string,
    instrument: string | undefined,
  ): Promise<void> {
    const now = this.clock.now();
    const prior = this.dormantDefer.get(externalReference);
    const consecutive = (prior?.consecutive ?? 0) + 1;
    const firstObservedAt = prior?.firstObservedAt ?? now;
    this.dormantDefer.set(externalReference, { consecutive, firstObservedAt });
    if (!shouldWarnDormantDefer(consecutive)) return;
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
   * inheriting a stale count.
   */
  private clearDormantDefer(externalReference: string): void {
    this.dormantDefer.delete(externalReference);
  }

  /** The most recent audit-trail row for `externalReference` inside `lookbackMs`, or none. */
  private async latestActivityFor(
    externalReference: string,
    lookbackMs: number,
  ): Promise<SaxoOrderActivity | undefined> {
    const from = new Date(this.clock.now().getTime() - lookbackMs);
    const activities = await this.client.listOrderActivities(from);
    let latest: SaxoOrderActivity | undefined;
    for (const activity of activities) {
      if (activity.ExternalReference !== externalReference) continue;
      if (latest === undefined || activity.ActivityTime >= latest.ActivityTime) latest = activity;
    }
    return latest;
  }

  /**
   * `findOpen`'s dormant-legs signal is never acted on by `Status` alone
   * (UNVERIFIED) — it is corroborated here against the master's own
   * audit-trail row first (#1215 round 1). A `Filled` row: the entry
   * genuinely filled, adopted using the dormant legs' real order ids (better
   * evidence than an activity row, which carries no related-order ids). A
   * `Cancelled`/`Expired`/`Rejected` row: the master is confirmed done and
   * not filled, so the legs are cancelled and THAT state is reported, not
   * `null` — `null` reads to `reconcileLot` as "the write-ahead never
   * landed", which is false for an order the venue's own audit trail shows
   * it received. No row at all inside the lookback ties the legs to any
   * known order, so they are cancelled and `null` is the honest answer.
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

    const latest = await this.latestActivityFor(externalReference, lookbackMs);

    if (open === null) {
      if (latest === undefined) return null;
      this.clearDormantDefer(externalReference);
      return fromActivity(latest, externalReference);
    }
    if (latest === undefined) {
      await this.cancelDormantLegs(open.dormant);
      this.clearDormantDefer(externalReference);
      return null;
    }
    const state = activityState(latest);
    if (state === 'filled') {
      this.clearDormantDefer(externalReference);
      return legsFilled(open.dormant, latest, externalReference);
    }
    if (DEAD_STATES.has(state)) {
      await this.cancelDormantLegs(open.dormant);
      this.clearDormantDefer(externalReference);
      return fromActivity(latest, externalReference);
    }
    await this.escalateIfStale(externalReference, instrument);
    return fromActivity(latest, externalReference);
  }

  private attribute(
    externalReference: string | undefined,
  ): { clientOrderId: string; leg: Leg } | undefined {
    if (externalReference === undefined) return undefined;
    if (this.flattens.has(externalReference)) {
      return { clientOrderId: externalReference, leg: 'exit' };
    }
    if (this.brackets.has(externalReference)) {
      return { clientOrderId: externalReference, leg: 'entry' };
    }
    for (const leg of ['stop', 'target'] as const) {
      const suffix = `:${leg}`;
      if (!externalReference.endsWith(suffix)) continue;
      const id = externalReference.slice(0, -suffix.length);
      if (this.brackets.has(id)) return { clientOrderId: id, leg };
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

/** `Status === 'NotWorking'` — UNVERIFIED as "never activated" (see `SaxoOpenOrderStatus`). */
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
 * A dormant leg pair whose master audit row came back `Filled` (`lookup`) —
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

function roundPrice(price: number): number {
  return Number(price.toFixed(ORDER_DECIMALS));
}

function assertWholeUnits(size: number, clientOrderId: string): void {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(
      `Saxo order '${clientOrderId}' asks for ${size} units; LSE ETPs trade in whole units ` +
        '(MinimumLotSize 1, OddLotsNotAllowed on every pool line) — size at the caller.',
    );
  }
}

function assertExternalReferenceFits(clientOrderId: string, suffixChars: number): void {
  if (clientOrderId.length + suffixChars > EXTERNAL_REFERENCE_MAX_CHARS) {
    throw new Error(
      `Saxo ExternalReference '${clientOrderId}' exceeds ${EXTERNAL_REFERENCE_MAX_CHARS} chars ` +
        `once the leg suffix is appended (${clientOrderId.length + suffixChars}).`,
    );
  }
}

function activityState(activity: SaxoOrderActivity): NormalizedOrder['order_state'] {
  if (activity.SubStatus === 'Rejected' || activity.Status === 'Rejected') return 'rejected';
  switch (activity.Status) {
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

/**
 * A fill is booked only from an activity carrying a positive `FillAmount`
 * AND a finite `AveragePrice` — the two UNVERIFIED fields (saxo-client.ts).
 * A `Filled` row missing either is thrown so the sweep fails loudly and is
 * retried, rather than a filled position going unbooked and unprotected.
 * `fee`: see `feeCurrencyFor`.
 */
function toFill(
  activity: SaxoOrderActivity,
  clientOrderId: string,
  leg: Leg,
  since: Date,
): NormalizedFill | undefined {
  const qty = activity.FillAmount;
  const price = activity.AveragePrice;
  const hasQty = typeof qty === 'number' && Number.isFinite(qty) && qty > 0;
  const hasPrice = typeof price === 'number' && Number.isFinite(price);
  if (!hasQty && !hasPrice) {
    if (activity.Status === 'Filled') {
      throw new Error(
        `Saxo activity ${activity.LogId} for '${clientOrderId}' (${leg}) reports Status Filled ` +
          'without FillAmount/AveragePrice — fill fields unverified on SIM; see saxo-client.ts.',
      );
    }
    return undefined;
  }
  if (!hasQty || !hasPrice) {
    throw new Error(
      `Saxo activity ${activity.LogId} for '${clientOrderId}' (${leg}) carries only one of ` +
        `FillAmount (${String(qty)}) and AveragePrice (${String(price)}).`,
    );
  }
  const reported = new Date(activity.ActivityTime);
  const timestamp = Number.isNaN(reported.getTime()) || reported < since ? since : reported;
  return {
    client_order_id: clientOrderId,
    broker_fill_id: activity.LogId,
    leg,
    price,
    qty,
    fee: price * qty * SAXO_COMMISSION_RATE,
    timestamp,
  };
}
