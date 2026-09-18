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

const SAXO_DUPLICATE_WINDOW_MS = 15_000;

const PLACEMENT_LOOKBACK_MS = 4 * SAXO_DUPLICATE_WINDOW_MS;

const EXTERNAL_REFERENCE_MAX_CHARS = 50;
const LEG_SUFFIX_MAX_CHARS = ':target'.length;

const SAXO_REFERENCE_HEX_CHARS = 40;

export function saxoExternalReference(clientOrderId: string): string {
  return createHash('sha256')
    .update(clientOrderId)
    .digest('hex')
    .slice(0, SAXO_REFERENCE_HEX_CHARS);
}

const ORDER_DECIMALS = 2;

const DEFAULT_ACTIVITY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export const DORMANT_DEFER_ALERT_AFTER = 2;

export const DORMANT_DEFER_ALERT_REPEAT_EVERY_MS = 15 * 60_000;

interface DormantDeferRecord {
  readonly consecutive: number;
  readonly firstObservedAt: Date;
  readonly masterSeenOpen: boolean;
  readonly lastAlertedAtMs: number;
}

function refusedKey(externalReference: string): string {
  return `refused:${externalReference}`;
}

function dueForDormantDeferAlert(
  consecutive: number,
  lastAlertedAtMs: number,
  nowMs: number,
): boolean {
  if (consecutive < DORMANT_DEFER_ALERT_AFTER) return false;
  if (lastAlertedAtMs === 0) return true;
  return nowMs - lastAlertedAtMs >= DORMANT_DEFER_ALERT_REPEAT_EVERY_MS;
}

export const PRICE_UNIT_ALERT_REPEAT_EVERY = 8;

const PRICE_UNIT_CADENCE = { after: 1, every: PRICE_UNIT_ALERT_REPEAT_EVERY };

export interface SaxoInstrumentRef extends SaxoQuoteUnit {
  readonly uic: number;
  readonly asset_type: SaxoAssetType;
  readonly currency: string;
  readonly price_currency: string | undefined;
}

export interface SaxoInstrumentResolver {
  resolve(lseTicker: string): SaxoInstrumentRef | undefined;
  lseTickerFor(uic: number): string | undefined;
}

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
  legResizeAlerts: LegResizeUnverifiedAlertChannel;
  dormantLegsAlerts: DormantLegsUnresolvedAlertChannel;
  priceUnitAlerts: UnresolvedPriceUnitAlertChannel;
  logger: Logger;
}

interface BracketRecord {
  instrument: string;
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
  private readonly brackets = new Map<string, BracketRecord>();
  private readonly flattens = new Map<string, FlattenRecord>();
  private readonly dormantDefer = new Map<string, DormantDeferRecord>();
  private readonly priceUnitDefer = new Map<string, number>();
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
      if (adopted !== null) throw cause;
      const latest = await this.latestActivityFor(externalReference, PLACEMENT_LOOKBACK_MS);
      if (latest === undefined) throw cause;
      return adopt(fromActivity(latest, externalReference), externalReference);
    }
  }

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

  private shouldAnnounceUnresolvedUnit(site: 'fill' | 'position', uic: number): boolean {
    const key = `${site}:${uic}`;
    const consecutive = (this.priceUnitDefer.get(key) ?? 0) + 1;
    this.priceUnitDefer.set(key, consecutive);
    return escalatesAt(consecutive, PRICE_UNIT_CADENCE);
  }

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
    const legs = legRows(open, externalReference);
    const [first] = legs;
    if (first === undefined) return null;
    if (legs.every(isNeverActivated)) return { dormant: legs };
    return activatedLegsLookup(externalReference, legs, first);
  }

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

  private clearDormantDefer(externalReference: string): void {
    this.dormantDefer.delete(externalReference);
  }

  private clearRefusedDefer(externalReference: string): void {
    this.dormantDefer.delete(refusedKey(externalReference));
  }

  private async activitiesFor(
    externalReference: string,
    lookbackMs: number,
  ): Promise<SaxoOrderActivity[]> {
    const from = new Date(this.clock.now().getTime() - lookbackMs);
    const wireReference = saxoExternalReference(externalReference);
    const activities = await this.client.listOrderActivities(from);
    return activities.filter((activity) => activity.ExternalReference === wireReference);
  }

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

  private async lookup(
    externalReference: string,
    lookbackMs: number,
    instrument?: string,
  ): Promise<LookedUpOrder | null> {
    const open = await this.findOpen(externalReference);
    if (open !== null && !isDormantLegs(open)) {
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

interface LookedUpActivatedLegsOrder {
  readonly kind: 'legs';
  ids: OrderIds;
  legs: readonly SaxoOpenOrder[];
  side: 'buy' | 'sell';
  amount: number;
  normalized: NormalizedOrder;
}

type LookedUpOrder = LookedUpMasterOrder | LookedUpActivatedLegsOrder;

interface DormantLegs {
  readonly dormant: readonly SaxoOpenOrder[];
}

function isDormantLegs(result: LookedUpOrder | DormantLegs): result is DormantLegs {
  return 'dormant' in result;
}

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

function entryFilledDuringCancel(clientOrderId: string, evidence: string): SaxoBrokerProviderError {
  const reason =
    `Saxo cancel '${clientOrderId}': ${evidence}. Its protective legs are the only cover the ` +
    'position has, so nothing was cancelled — the exit must be re-derived from a fresh read.';
  return new SaxoBrokerProviderError(reason, undefined, 'EntryFilledDuringCancel', reason);
}

function dormantLegsUncorroborated(externalReference: string): SaxoBrokerProviderError {
  const reason =
    `Saxo lookup '${externalReference}': its master left the open list inside a cancel and the ` +
    'audit trail answers nothing, so the protective legs cannot be corroborated either way — ' +
    'nothing was cancelled and no state is reported. The operator is paged while it persists.';
  return new SaxoBrokerProviderError(reason, undefined, 'DormantLegsUncorroborated', reason);
}

function legRows(open: readonly SaxoOpenOrder[], clientOrderId: string): SaxoOpenOrder[] {
  const wireReference = saxoExternalReference(clientOrderId);
  return open.filter(
    (order) =>
      order.ExternalReference === legReference(wireReference, 'stop') ||
      order.ExternalReference === legReference(wireReference, 'target'),
  );
}

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
    const reason =
      `Saxo already holds '${externalReference}' in state '${state}' (order ` +
      `${existing.normalized.broker_order_ids.join(',') || 'unknown'}); refusing to adopt a dead ` +
      'order or re-place under the same reference — the caller must issue a fresh id.';
    throw new SaxoBrokerProviderError(reason, undefined, 'DeadOrderUnderReference', reason);
  }
  return { ids: existing.ids, order_state: state };
}

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

interface QuotedFill {
  client_order_id: string;
  broker_fill_id: string;
  leg: Leg;
  qty: number;
  quoted_price: number;
  timestamp: Date;
}

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
