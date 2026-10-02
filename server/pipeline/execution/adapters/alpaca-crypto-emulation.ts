import type { Clock } from '../../../shared/index.js';
import type { BrokerBracketRecord, BrokerStateStore } from '../broker-state-store.js';
import { toRequestFields } from '../broker-state-store.js';
import type { OcoDoubleFillAlertChannel } from '../oco-double-fill-alert.js';
import type { BrokerAck, NativeBracketRequest, NormalizedFill } from '../types.js';
import type { AlpacaBrokerClient, AlpacaOrder } from './alpaca-client.js';
import {
  collectFill,
  mapOrderState,
  toAlpacaSymbol,
  UnpricedFillError,
} from './alpaca-order-normalization.js';

interface EmulatedBracket {
  request: NativeBracketRequest;
  phase: BrokerBracketRecord['phase'];
  entryOrderId: string | null;
  stopOrderId: string | null;
  targetOrderId: string | null;
  armedQty: number | null;
  armingQty: number | null;
  armAttempt: number;
  inFlight: boolean;
  doubleFillAlerted: boolean;
  donePolling: boolean;
}

export interface AlpacaCryptoLegEmulationDeps {
  client: AlpacaBrokerClient;
  state: BrokerStateStore;
  clock: Clock;
  call: <T>(operation: string, fn: () => Promise<T>) => Promise<T>;
  doubleFillAlerts: OcoDoubleFillAlertChannel;
}

export class AlpacaCryptoLegEmulation {
  private readonly brackets = new Map<string, EmulatedBracket>();

  constructor(private readonly deps: AlpacaCryptoLegEmulationDeps) {
    for (const record of deps.state.loadBrackets('alpaca')) {
      if (record.request === null || record.request.asset_class !== 'crypto') continue;
      if (record.entry_order_id === null && record.phase !== 'submitting') continue;

      this.brackets.set(record.client_order_id, {
        request: { client_order_id: record.client_order_id, ...record.request },
        phase: record.phase,
        entryOrderId: record.entry_order_id,
        stopOrderId: record.stop_order_id,
        targetOrderId: record.target_order_id,
        armedQty: record.armed_qty,
        armingQty: record.arming_qty,
        armAttempt: record.arm_attempt,
        inFlight: false,
        doubleFillAlerted: false,
        donePolling: false,
      });
    }
  }

  owns(clientOrderId: string): boolean {
    return this.brackets.has(clientOrderId);
  }

  brokerOrderIds(clientOrderId: string): string[] {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) return [];
    return [bracket.entryOrderId, bracket.stopOrderId, bracket.targetOrderId].filter(
      (id): id is string => id !== null,
    );
  }

  private persist(bracket: EmulatedBracket): void {
    this.deps.state.saveBracket({
      venue: 'alpaca',
      client_order_id: bracket.request.client_order_id,
      phase: bracket.phase,
      entry_order_id: bracket.entryOrderId,
      stop_order_id: bracket.stopOrderId,
      target_order_id: bracket.targetOrderId,
      request: toRequestFields(bracket.request),
      armed_qty: bracket.armedQty,
      arming_qty: bracket.armingQty,
      arm_attempt: bracket.armAttempt,
    });
  }

  async submitEntry(order: NativeBracketRequest): Promise<BrokerAck> {
    const existing = this.brackets.get(order.client_order_id);
    if (existing !== undefined) return this.ackFor(existing);

    const bracket: EmulatedBracket = {
      request: order,
      phase: 'submitting',
      entryOrderId: null,
      stopOrderId: null,
      targetOrderId: null,
      armedQty: null,
      armingQty: null,
      armAttempt: 0,
      inFlight: false,
      doubleFillAlerted: false,
      donePolling: false,
    };
    this.brackets.set(order.client_order_id, bracket);
    this.persist(bracket);

    let entry: AlpacaOrder;
    try {
      entry = await this.deps.call('submitBracket', () =>
        this.deps.client.submitLimitOrder({
          symbol: toAlpacaSymbol(order.instrument, order.asset_class),
          side: order.side,
          qty: String(order.size),
          limit_price: String(order.entry),
          time_in_force: order.time_in_force,
          client_order_id: order.client_order_id,
        }),
      );
    } catch (cause) {
      this.brackets.delete(order.client_order_id);
      throw cause;
    }

    bracket.phase = 'pending_entry';
    bracket.entryOrderId = entry.id;
    this.persist(bracket);

    return {
      client_order_id: order.client_order_id,
      broker_order_ids: [entry.id],
      order_state: mapOrderState(entry.status),
    };
  }

  private ackFor(bracket: EmulatedBracket): BrokerAck {
    return {
      client_order_id: bracket.request.client_order_id,
      broker_order_ids: this.brokerOrderIds(bracket.request.client_order_id),
      order_state: 'submitted',
    };
  }

  async rearm(
    clientOrderId: string,
    _instrument: string,
    _side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void> {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) {
      throw new Error(
        `Alpaca crypto emulation cannot re-arm '${clientOrderId}': no journalled bracket exists ` +
          'for this lot, so the arming episode has no durable write-ahead home. The residual ' +
          "stays alert-only (ingest-fills' #525 fallback).",
      );
    }
    if (bracket.inFlight) {
      throw new Error(
        `Alpaca crypto emulation: bracket '${clientOrderId}' already has an arming episode in ` +
          'flight in this process; refusing to start a second.',
      );
    }

    bracket.request = { ...bracket.request, stop, target };
    bracket.phase = 'arming';
    bracket.armingQty = qty;
    bracket.armedQty = null;
    bracket.armAttempt += 1;
    bracket.inFlight = true;
    bracket.doubleFillAlerted = false;
    bracket.donePolling = false;
    this.persist(bracket);

    try {
      await this.retireStaleLegs(bracket);
      await this.armLegs(bracket, qty);
    } finally {
      bracket.inFlight = false;
    }
  }

  async cancelAll(clientOrderId: string): Promise<void> {
    const bracket = this.brackets.get(clientOrderId);
    if (bracket === undefined) return;

    let entryId = bracket.entryOrderId;
    if (entryId === null) {
      const order = await this.deps.call('cancel', () =>
        this.deps.client.getOrderByClientOrderId(clientOrderId),
      );
      entryId = order?.id ?? null;
    }

    for (const id of [entryId, bracket.stopOrderId, bracket.targetOrderId]) {
      if (id === null) continue;
      await this.deps.call('cancel', () => this.deps.client.cancelOrder(id));
    }

    bracket.phase = 'resolved';
    bracket.armingQty = null;
    this.persist(bracket);
  }

  async sweep(since: Date, fills: NormalizedFill[], failures: unknown[]): Promise<number> {
    let failed = 0;
    const observedAt = this.deps.clock.now();

    // oxlint-disable-next-line unicorn/no-useless-spread -- the loop awaits while submitBracket can add to or delete from this.brackets
    for (const bracket of [...this.brackets.values()]) {
      if (bracket.donePolling) continue;
      if (await this.sweepOneBracket(bracket, since, observedAt, fills, failures)) failed += 1;
    }

    return failed;
  }

  private async sweepOneBracket(
    bracket: EmulatedBracket,
    since: Date,
    observedAt: Date,
    fills: NormalizedFill[],
    failures: unknown[],
  ): Promise<boolean> {
    try {
      if (bracket.phase === 'submitting') {
        await this.resolveSubmitting(bracket);
        return false;
      }

      const entryId = bracket.entryOrderId;
      if (entryId === null) return false;
      const key = bracket.request.client_order_id;
      const instrument = bracket.request.instrument;

      const entry = await this.deps.call('fetchNewFills', () => this.deps.client.getOrder(entryId));
      collectFill(entry, 'entry', key, instrument, since, observedAt, fills);

      const stopId = bracket.stopOrderId;
      const targetId = bracket.targetOrderId;
      const stopOrder =
        stopId === null
          ? null
          : await this.deps.call('fetchNewFills', () => this.deps.client.getOrder(stopId));
      if (stopOrder !== null)
        collectFill(stopOrder, 'stop', key, instrument, since, observedAt, fills);
      const targetOrder =
        targetId === null
          ? null
          : await this.deps.call('fetchNewFills', () => this.deps.client.getOrder(targetId));
      if (targetOrder !== null)
        collectFill(targetOrder, 'target', key, instrument, since, observedAt, fills);

      await this.watchDoubleFill(bracket, stopOrder, targetOrder, failures);
      await this.advanceBracketPhase(bracket, entry, stopOrder, targetOrder);
      return false;
    } catch (error) {
      return this.recordSweepError(error, failures);
    }
  }

  private async advanceBracketPhase(
    bracket: EmulatedBracket,
    entry: AlpacaOrder,
    stopOrder: AlpacaOrder | null,
    targetOrder: AlpacaOrder | null,
  ): Promise<void> {
    switch (bracket.phase) {
      case 'pending_entry':
        return this.advanceEntry(bracket, entry);
      case 'arming':
        return this.resumeArming(bracket);
      case 'armed':
        return this.advanceExits(bracket, stopOrder, targetOrder);
      case 'cancelling_sibling':
        return this.finishSiblingCancel(bracket, stopOrder, targetOrder);
      case 'resolved':
        if (bracketFullyTerminal(entry, stopOrder, targetOrder)) bracket.donePolling = true;
        return;
      default:
        return;
    }
  }

  private recordSweepError(error: unknown, failures: unknown[]): boolean {
    if (error instanceof UnpricedFillError) {
      try {
        this.deps.state.recordUnpricedFill('alpaca', error.observation, this.deps.clock.now());
        return false;
      } catch (stateError) {
        failures.push(stateError);
        return true;
      }
    }
    failures.push(error);
    return true;
  }

  private async resolveSubmitting(bracket: EmulatedBracket): Promise<void> {
    const order = await this.deps.call('resolveSubmitting', () =>
      this.deps.client.getOrderByClientOrderId(bracket.request.client_order_id),
    );

    if (order === null) {
      bracket.phase = 'resolved';
      this.persist(bracket);
      return;
    }

    bracket.phase = 'pending_entry';
    bracket.entryOrderId = order.id;
    this.persist(bracket);
  }

  private async advanceEntry(bracket: EmulatedBracket, entry: AlpacaOrder): Promise<void> {
    if (bracket.phase !== 'pending_entry') return;

    const state = mapOrderState(entry.status);
    if (state === 'submitted' || state === 'partially_filled') return;

    const filledQty = Number.parseFloat(entry.filled_qty);
    if (!(filledQty > 0)) {
      bracket.phase = 'resolved';
      this.persist(bracket);
      return;
    }

    bracket.phase = 'arming';
    bracket.armingQty = filledQty;
    bracket.inFlight = true;
    this.persist(bracket);

    try {
      await this.armLegs(bracket, filledQty);
    } finally {
      bracket.inFlight = false;
    }
  }

  private async resumeArming(bracket: EmulatedBracket): Promise<void> {
    if (bracket.inFlight) return;

    bracket.inFlight = true;
    try {
      await this.recoverArming(bracket);
    } finally {
      bracket.inFlight = false;
    }
  }

  private async recoverArming(bracket: EmulatedBracket): Promise<void> {
    const qty = bracket.armingQty;
    if (qty === null) {
      throw new Error(
        `Alpaca crypto emulation: bracket '${bracket.request.client_order_id}' is 'arming' with ` +
          'no recorded arming quantity, so its protective legs cannot be sized. Refusing to ' +
          'guess a size for a live position; this bracket needs manual reconciliation.',
      );
    }

    await this.retireStaleLegs(bracket);

    const [stop, target] = await Promise.all([
      this.adoptOrPlaceLeg(bracket, 'stop', qty),
      this.adoptOrPlaceLeg(bracket, 'target', qty),
    ]);

    this.landArmed(bracket, stop.id, target.id, qty);
  }

  private async retireStaleLegs(bracket: EmulatedBracket): Promise<void> {
    const { stopOrderId, targetOrderId } = bracket;
    if (stopOrderId === null && targetOrderId === null) return;

    const [stale, staleTarget] = await Promise.all([
      stopOrderId === null
        ? null
        : this.deps.call('fetchStaleStopStatus', () => this.deps.client.getOrder(stopOrderId)),
      targetOrderId === null
        ? null
        : this.deps.call('fetchStaleTargetStatus', () => this.deps.client.getOrder(targetOrderId)),
    ]);

    for (const [leg, order] of [
      ['stop', stale],
      ['target', staleTarget],
    ] as const) {
      if (order !== null && isFilled(order)) {
        throw new Error(
          `Alpaca crypto emulation: bracket '${bracket.request.client_order_id}': a previous ` +
            `episode's ${leg} leg (${order.id}) filled while this bracket was mid-arm, so the ` +
            'lot has already exited. Refusing to arm a fresh protective pair; this bracket ' +
            'needs manual reconciliation against the venue.',
        );
      }
    }

    await Promise.all(
      [stopOrderId, targetOrderId]
        .filter((id): id is string => id !== null)
        .map((id) => this.deps.call('cancelStaleLeg', () => this.deps.client.cancelOrder(id))),
    );

    bracket.stopOrderId = null;
    bracket.targetOrderId = null;
    this.persist(bracket);
  }

  private async adoptOrPlaceLeg(
    bracket: EmulatedBracket,
    leg: 'stop' | 'target',
    qty: number,
  ): Promise<AlpacaOrder> {
    const legClientOrderId = this.legClientOrderId(bracket, leg);
    const existing = await this.deps.call(
      leg === 'stop' ? 'fetchStopLegByClientId' : 'fetchTargetLegByClientId',
      () => this.deps.client.getOrderByClientOrderId(legClientOrderId),
    );

    if (existing === null) return this.placeLeg(bracket, leg, qty);
    const state = mapOrderState(existing.status);
    if (state === 'submitted' || state === 'partially_filled') return existing;

    throw new Error(
      `Alpaca crypto emulation: bracket '${bracket.request.client_order_id}': the ${leg} leg ` +
        `'${legClientOrderId}' exists at the venue in terminal state '${existing.status}', so ` +
        'it can be neither adopted as live protection nor re-placed under the same client ' +
        'order id. Refusing to report this lot as armed; it needs manual reconciliation.',
    );
  }

  private async armLegs(bracket: EmulatedBracket, qty: number): Promise<void> {
    const [stop, target] = await Promise.all([
      this.placeLeg(bracket, 'stop', qty),
      this.placeLeg(bracket, 'target', qty),
    ]);

    this.landArmed(bracket, stop.id, target.id, qty);
  }

  private async placeLeg(
    bracket: EmulatedBracket,
    leg: 'stop' | 'target',
    qty: number,
  ): Promise<AlpacaOrder> {
    const { request } = bracket;
    const exitSide = request.side === 'buy' ? 'sell' : 'buy';
    const symbol = toAlpacaSymbol(request.instrument, request.asset_class);
    const clientOrderId = this.legClientOrderId(bracket, leg);

    if (leg === 'stop') {
      return this.deps.call('armStopLeg', () =>
        this.deps.client.submitStopLimitOrder({
          symbol,
          side: exitSide,
          qty: String(qty),
          stop_price: String(request.stop),
          limit_price: String(request.stop),
          time_in_force: 'gtc',
          client_order_id: clientOrderId,
        }),
      );
    }

    return this.deps.call('armTargetLeg', () =>
      this.deps.client.submitLimitOrder({
        symbol,
        side: exitSide,
        qty: String(qty),
        limit_price: String(request.target),
        time_in_force: 'gtc',
        client_order_id: clientOrderId,
      }),
    );
  }

  private legClientOrderId(bracket: EmulatedBracket, leg: 'stop' | 'target'): string {
    const suffix = bracket.armAttempt === 0 ? '' : `:r${bracket.armAttempt}`;
    return `${bracket.request.client_order_id}:${leg}${suffix}`;
  }

  private landArmed(
    bracket: EmulatedBracket,
    stopOrderId: string,
    targetOrderId: string,
    qty: number,
  ): void {
    bracket.stopOrderId = stopOrderId;
    bracket.targetOrderId = targetOrderId;
    bracket.armedQty = qty;
    bracket.armingQty = null;
    bracket.phase = 'armed';
    this.persist(bracket);
  }

  private async advanceExits(
    bracket: EmulatedBracket,
    stopOrder: AlpacaOrder | null,
    targetOrder: AlpacaOrder | null,
  ): Promise<void> {
    if (bracket.phase !== 'armed') return;
    const outcome = exitOutcome(stopOrder, targetOrder);
    if (outcome === 'none') return;

    if (outcome === 'both') {
      bracket.phase = 'resolved';
      this.persist(bracket);
      return;
    }

    const siblingId = outcome === 'stop' ? bracket.targetOrderId : bracket.stopOrderId;
    bracket.phase = 'cancelling_sibling';
    this.persist(bracket);

    if (siblingId !== null) {
      await this.deps.call('cancelSibling', () => this.deps.client.cancelOrder(siblingId));
    }

    bracket.phase = 'resolved';
    this.persist(bracket);
  }

  private async finishSiblingCancel(
    bracket: EmulatedBracket,
    stopOrder: AlpacaOrder | null,
    targetOrder: AlpacaOrder | null,
  ): Promise<void> {
    if (bracket.phase !== 'cancelling_sibling') return;

    for (const [id, order] of [
      [bracket.stopOrderId, stopOrder],
      [bracket.targetOrderId, targetOrder],
    ] as const) {
      if (id === null) continue;
      if (order !== null && isFilled(order)) continue;
      await this.deps.call('cancelSibling', () => this.deps.client.cancelOrder(id));
    }

    bracket.phase = 'resolved';
    this.persist(bracket);
  }

  private async watchDoubleFill(
    bracket: EmulatedBracket,
    stopOrder: AlpacaOrder | null,
    targetOrder: AlpacaOrder | null,
    failures: unknown[],
  ): Promise<void> {
    if (bracket.doubleFillAlerted) return;
    if (stopOrder === null || targetOrder === null) return;
    if (!isFilled(stopOrder) || !isFilled(targetOrder)) return;

    try {
      await this.deps.doubleFillAlerts.postOcoDoubleFillAlert({
        client_order_id: bracket.request.client_order_id,
        instrument: bracket.request.instrument,
        stop_order_id: stopOrder.id,
        target_order_id: targetOrder.id,
        observed_at: this.deps.clock.now(),
      });
      bracket.doubleFillAlerted = true;
    } catch {
      failures.push(
        new Error(
          `Alpaca crypto emulation: double-fill alert delivery failed for ` +
            `'${bracket.request.client_order_id}' — both protective legs report filled and the ` +
            'operator has not been told; delivery will be retried next sweep',
        ),
      );
    }
  }
}

function isFilled(order: AlpacaOrder): boolean {
  return mapOrderState(order.status) === 'filled' && Number.parseFloat(order.filled_qty) > 0;
}

function exitOutcome(
  stopOrder: AlpacaOrder | null,
  targetOrder: AlpacaOrder | null,
): 'none' | 'stop' | 'target' | 'both' {
  const stopFilled = stopOrder !== null && isFilled(stopOrder);
  const targetFilled = targetOrder !== null && isFilled(targetOrder);
  if (stopFilled && targetFilled) return 'both';
  if (stopFilled) return 'stop';
  if (targetFilled) return 'target';
  return 'none';
}

function isTerminal(order: AlpacaOrder): boolean {
  const state = mapOrderState(order.status);
  return state !== 'submitted' && state !== 'partially_filled';
}

function bracketFullyTerminal(
  entry: AlpacaOrder,
  stopOrder: AlpacaOrder | null,
  targetOrder: AlpacaOrder | null,
): boolean {
  return (
    isTerminal(entry) &&
    (stopOrder === null || isTerminal(stopOrder)) &&
    (targetOrder === null || isTerminal(targetOrder))
  );
}
