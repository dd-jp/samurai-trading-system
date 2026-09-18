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

export const DEFAULT_UNPRICED_FILL_AGE_OUT_MS = 15 * 60_000;

const ALPACA_FILL_SWEEP_TRACE_ID = 'alpaca-fetch-new-fills';

const MAX_REARM_ATTEMPTS = 4;

const rearmWireId = (clientOrderId: string, attempt: number): string =>
  attempt === 0 ? `${clientOrderId}:rearm` : `${clientOrderId}:rearm-${attempt}`;

const rearmAttemptOf = (clientOrderId: string, wireId: string): number | null => {
  for (let attempt = 0; attempt < MAX_REARM_ATTEMPTS; attempt += 1) {
    if (rearmWireId(clientOrderId, attempt) === wireId) return attempt;
  }
  return null;
};

export interface AlpacaBrokerAdapterInput {
  client: AlpacaBrokerClient;
  rateLimiter?: TokenBucket;
  state?: BrokerStateStore;
  unpricedFillAlerts: UnpricedFillAlertChannel;
  ocoDoubleFillAlerts: OcoDoubleFillAlertChannel;
  unpricedFillAgeOutMs?: number;
  clock?: Clock;
  logger: Logger;
}

type LookedUpOrderId = { id: string | null } | { error: unknown };

export class AlpacaBrokerAdapter implements BrokerAdapter {
  private readonly brackets = new Map<string, string>();
  private readonly bracketSubmittedAt = new Map<string, Date>();
  private readonly warnedSinceFloorViolations = new Set<string>();
  private readonly flattens = new Map<string, string>();
  private readonly flattenSubmittedAt = new Map<string, Date>();
  private readonly rearmedLegs = new Map<string, string>();
  private readonly rateLimiter: TokenBucket;
  private readonly state: BrokerStateStore;
  private readonly clock: Clock;
  private readonly unpricedFillAgeOutMs: number;
  private readonly emulation: AlpacaCryptoLegEmulation;
  private readonly logger: Logger;

  constructor(private readonly input: AlpacaBrokerAdapterInput) {
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

    for (const record of this.state.loadBrackets('alpaca')) {
      if (record.request?.asset_class === 'crypto') continue;
      if (record.entry_order_id === null) continue;
      this.brackets.set(record.client_order_id, record.entry_order_id);
    }
  }

  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    await this.rateLimiter.acquire();
    try {
      return await fn();
    } catch (cause) {
      throw sanitizeBrokerError('alpaca', operation, cause);
    }
  }

  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
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
    if (!this.flattenSubmittedAt.has(clientOrderId)) {
      this.flattenSubmittedAt.set(clientOrderId, submittedAt);
    }

    return {
      client_order_id: clientOrderId,
      broker_order_ids: [response.id],
      order_state: mapOrderState(response.status),
    };
  }

  async cancel(clientOrderId: string, _instrument: string): Promise<void> {
    if (this.emulation.owns(clientOrderId)) {
      await this.emulation.cancelAll(clientOrderId);
      return;
    }

    const { order, rearmedOrder } = await this.resolveCancelTargets(clientOrderId);

    if (rearmedOrder !== null) {
      await this.call('cancel', () => this.input.client.cancelOrder(rearmedOrder));
      this.rearmedLegs.delete(clientOrderId);
    }

    if (order !== null) {
      await this.call('cancel', () => this.input.client.cancelOrder(order));
      this.brackets.delete(clientOrderId);
    }
  }

  private async resolveCancelTargets(
    clientOrderId: string,
  ): Promise<{ order: string | null; rearmedOrder: string | null }> {
    const inProcessRearm = this.rearmedLegs.get(clientOrderId) ?? null;
    const order = await this.lookupOpenOrderId(clientOrderId);
    const rearmed: LookedUpOrderId =
      inProcessRearm !== null
        ? { id: inProcessRearm }
        : 'error' in order
          ? order
          : await this.lookupLatestRearmOrderId(clientOrderId);
    if (!('error' in order) && !('error' in rearmed)) {
      return { order: order.id, rearmedOrder: rearmed.id };
    }

    const lookupError = 'error' in order ? order.error : (rearmed as { error: unknown }).error;
    let open: readonly AlpacaOrder[];
    try {
      open = await this.call('cancel', () => this.input.client.listOpenOrders());
    } catch {
      throw lookupError;
    }
    const idOf = (key: string): string | null =>
      open.find((candidate) => candidate.client_order_id === key)?.id ?? null;
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

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    if (order.asset_class === 'crypto') {
      return this.emulation.submitEntry(order);
    }

    const { entry, stop, target } = roundBracketToTick(
      order.side,
      order.entry,
      order.stop,
      order.target,
    );
    const submitted: NativeBracketRequest = { ...order, entry, stop, target };

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
    if (!this.bracketSubmittedAt.has(order.client_order_id)) {
      this.bracketSubmittedAt.set(order.client_order_id, submittedAt);
    }

    const legIds = (response.legs ?? []).map((leg) => leg.id);

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

  async getOrder(clientOrderId: string, _instrument: string): Promise<NormalizedOrder | null> {
    const order = await this.call('getOrder', () =>
      this.input.client.getOrderByClientOrderId(clientOrderId),
    );
    if (order === null) return null;

    if (this.emulation.owns(clientOrderId)) {
      return {
        client_order_id: clientOrderId,
        broker_order_ids: this.emulation.brokerOrderIds(clientOrderId),
        order_state: mapOrderState(order.status),
        filled_qty: Number.parseFloat(order.filled_qty),
      };
    }

    this.brackets.set(clientOrderId, order.id);
    this.state.recordBracketOrderIds('alpaca', clientOrderId, {
      entry_order_id: order.id,
      ...legOrderIds(order.legs),
    });

    return normalizeOrder(clientOrderId, order);
  }

  async resumeFlatten(clientOrderId: string, _instrument: string): Promise<NormalizedOrder | null> {
    const order = await this.call('resumeFlatten', () =>
      this.input.client.getOrderByClientOrderId(clientOrderId),
    );
    if (order === null) return null;

    this.flattens.set(clientOrderId, order.id);

    return normalizeOrder(clientOrderId, order);
  }

  async resizeProtectiveLegs(): Promise<void> {}

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the walk's advance invariant ("advancing past an index means its order is not resting", enforced in both directions), the live-preferred-over-settled adoption order, and the three independent size bounds (qty, sizedAboveSettled, entryFilledQty) are each individually documented as load-bearing — two prior restructurings (#1570 review's early-return) were tried and reverted as live-money bugs, so a fresh extraction here repeats a mistake this function's own history already made
  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    rawStop: number,
    rawTarget: number,
  ): Promise<void> {
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

    const { stop, target } = roundProtectiveLegsToTick(side, rawStop, rawTarget);

    const closingSide = side === 'buy' ? 'sell' : 'buy';

    const RESTING_STATUSES = ['new', 'accepted', 'pending_new', 'accepted_for_bidding'];
    let live: AlpacaOrder | null = null;
    let settled: AlpacaOrder | null = null;
    let freeAttempt: number | null = null;
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
      if (
        priorState === 'partially_filled' ||
        (RESTING_STATUSES.includes(prior.status) && rearmOrderMatches(prior, qty, stop, target))
      ) {
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
        await this.call('rearmProtectiveLegs', () => this.input.client.cancelOrder(prior.id));
      }
    }

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
      this.state.recordBracketOrderIds('alpaca', clientOrderId, {
        entry_order_id: null,
        stop_order_id: legOrderIds(adopted.legs).stop_order_id,
        target_order_id: adopted.id,
      });
      return;
    }

    if (freeAttempt === null) {
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
    this.state.recordBracketOrderIds('alpaca', clientOrderId, {
      entry_order_id: null,
      stop_order_id: legOrderIds(response.legs).stop_order_id,
      target_order_id: response.id,
    });
  }

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

  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const fills: NormalizedFill[] = [];
    const failures: unknown[] = [];
    const observedAt = this.clock.now();

    const bracketFailures = await this.sweepBrackets(since, observedAt, fills, failures);
    const flattenFailures = await this.sweepFlattens(since, observedAt, fills, failures);
    const rearmFailures = await this.sweepRearmedLegs(since, observedAt, fills, failures);

    const emulationFailures = await this.emulation.sweep(since, fills, failures);

    try {
      for (const fill of fills) {
        this.state.clearUnpricedFill('alpaca', fill.client_order_id, fill.broker_fill_id);
      }
    } catch (stateError) {
      failures.push(stateError);
    }

    await this.escalateAgedUnpricedFills(failures);

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
          bracket_failures: bracketFailures,
          flatten_failures: flattenFailures,
          rearm_failures: rearmFailures,
          emulation_failures: emulationFailures,
          fills_read: fills.length,
        },
      );
    }

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
        bracketFailures += this.recordSweepError(error, failures);
      }
    }
    return bracketFailures;
  }

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
        flattenFailures += this.recordSweepError(error, failures);
      }
    }
    return flattenFailures;
  }

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
        rearmFailures += this.recordSweepError(error, failures);
      }
    }
    return rearmFailures;
  }

  private async escalateAgedUnpricedFills(failures: unknown[]): Promise<void> {
    const now = this.clock.now();

    let recorded: readonly UnpricedFillRecord[];
    try {
      recorded = this.state.loadUnpricedFills('alpaca');
    } catch (stateError) {
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
        failures.push(stateError);
      }
    }
  }
}

function symbolOf(order: AlpacaOrder): string {
  return typeof order.symbol === 'string' && order.symbol.length > 0 ? order.symbol : 'unknown';
}

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
