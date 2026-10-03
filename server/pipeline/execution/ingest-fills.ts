import type { Fill, OpenPosition, OrderState } from '../../shared/index.js';
import {
  BOOK_CURRENCY,
  coversQty,
  type ExitFill,
  isBookCurrency,
  isExitFill,
  isFlat,
  logCaughtFailure,
  safeLog,
  totalQty,
  weightedAvgPrice,
} from '../../shared/index.js';
import { isWedgedZeroFillLot } from '../../shared/store/index.js';
import { closedTrade } from './closed-trade.js';
import { cumulativeIncrement } from './cumulative-feed.js';
import {
  chargeTopUpTo,
  type ModelledLegCost,
  type ModelledLotCosts,
  modelledLotCostsFor,
  prorateCostBreakdown,
} from './fill-cost.js';
import { splitFlattenFills } from './flatten-attribution.js';
import { markResidualsUnprotected, maybeRearmResidual } from './residual-protection.js';
import type {
  FillIngestInput,
  FlattenAttribution,
  NonSterlingFeeAlert,
  NormalizedFill,
} from './types.js';

export const FILLED_WITH_ZERO_SIZE = 'filled position has zero filled_size' as const;

export const FILLED_ZERO_SIZE_CLEARED =
  'a lot previously warned zero-filled-size has advanced past zero' as const;

export const FEE_CURRENCY_NOT_BOOK_CURRENCY =
  'broker reported a fill fee in a currency that is not the book currency' as const;

export const UNATTRIBUTED_FLATTEN_FILL =
  'flatten fill booked against an already-closed lot — its closed trade understates the sale' as const;

export const UNATTRIBUTED_FLATTEN_FILL_PERSIST_FAILED =
  'failed to book a flatten fill against an already-closed lot' as const;

const NO_MODELLED_LOT_COSTS: ModelledLotCosts = { entry: null, protectiveExit: null };

async function markSweptFlattens(
  input: FillIngestInput,
  flattenNamedLots: ReadonlyMap<string, ReadonlySet<string>>,
  failedLotKeys: ReadonlySet<string>,
  now: Date,
  failures: ContainedFailure[],
): Promise<void> {
  for (const [flattenKey, lotKeys] of flattenNamedLots) {
    if ([...lotKeys].some((lotKey) => failedLotKeys.has(lotKey))) continue;
    try {
      await input.store.markFlattenFillsSwept(flattenKey, now);
    } catch (error) {
      logCaughtFailure(
        input.logger,
        {
          trace_id: input.trace_id,
          stage: 'execution',
          event: 'flatten_sweep_mark_failed',
          level: 'warn',
          message:
            'markFlattenFillsSwept failed — the row stays unswept and will be found again by ' +
            "the next reconcile() pass (SharedStore.getUnresolvedFlattens()'s own designed recovery)",
        },
        error,
        { flatten_key: flattenKey },
      );
      failures.push({ scope: 'flatten-sweep-mark', key: flattenKey, instrument: null, error });
    }
  }
}

export async function ingestFills(input: FillIngestInput): Promise<void> {
  const { clock, broker, store } = input;

  const positions = await store.getOpenPositions();
  if (positions.length === 0) return;

  const since = earliest(positions.map((position) => position.opened_at));
  const fills = await broker.fetchNewFills(since.toISOString());

  const now = clock.now();

  const byLot = new Map<string, NormalizedFill[]>();
  for (const fill of fills) {
    const bucket = byLot.get(fill.client_order_id);
    if (bucket === undefined) byLot.set(fill.client_order_id, [fill]);
    else bucket.push(fill);
  }

  const failures: ContainedFailure[] = [];
  const flattenNamedLots = await redistributeFlattenFills(input, byLot, positions, failures);
  const flattenTargetedLots = new Set(
    Array.from(flattenNamedLots.values()).flatMap((lotKeys) => [...lotKeys]),
  );

  for (const position of positions) {
    try {
      await advanceLot(
        input,
        position,
        byLot.get(position.idempotency_key) ?? [],
        now,
        flattenTargetedLots.has(position.idempotency_key),
      );
    } catch (error) {
      failures.push({
        scope: 'lot-advance',
        key: position.idempotency_key,
        instrument: position.instrument,
        error,
      });
    }
  }

  const failedLotKeys = new Set(
    failures.filter((failure) => failure.scope === 'lot-advance').map((failure) => failure.key),
  );
  await markSweptFlattens(input, flattenNamedLots, failedLotKeys, now, failures);

  if (failures.some((failure) => failure.scope !== 'flatten-sweep-mark')) {
    throwContainedFailures(failures);
  }
}

interface ContainedFailure {
  scope: 'flatten-attribution' | 'lot-advance' | 'flatten-sweep-mark';
  key: string;
  instrument: string | null;
  error: unknown;
}

function throwContainedFailures(failures: readonly ContainedFailure[]): void {
  if (failures.length === 0) return;
  const named = failures
    .map((failure) => {
      const instrument = failure.instrument === null ? '' : ` (${failure.instrument})`;
      const reason =
        failure.error instanceof Error ? failure.error.constructor.name : typeof failure.error;
      return `${failure.scope} '${failure.key}'${instrument} [${reason}]`;
    })
    .join(', ');
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `ingestFills: ${failures.length} contained failure(s) — every other lot in this poll was ` +
      `advanced; unresolved: ${named}`,
    { cause: failures[0]?.error },
  );
}

async function redistributeFlattenFills(
  input: FillIngestInput,
  byLot: Map<string, NormalizedFill[]>,
  positions: readonly OpenPosition[],
  failures: ContainedFailure[],
): Promise<Map<string, Set<string>>> {
  const positionKeys = new Set(positions.map((position) => position.idempotency_key));
  const flattenNamedLots = new Map<string, Set<string>>();

  // oxlint-disable-next-line unicorn/no-useless-spread -- redistributeOneFlatten deletes from and adds to byLot while this loop runs
  for (const clientOrderId of [...byLot.keys()]) {
    if (positionKeys.has(clientOrderId)) continue;

    const targetedByThisFlatten = new Set<string>();
    try {
      await redistributeOneFlatten(
        input,
        byLot,
        clientOrderId,
        targetedByThisFlatten,
        positionKeys,
        failures,
      );
      if (targetedByThisFlatten.size > 0) {
        flattenNamedLots.set(clientOrderId, targetedByThisFlatten);
      }
    } catch (error) {
      failures.push({ scope: 'flatten-attribution', key: clientOrderId, instrument: null, error });
    }
  }

  return flattenNamedLots;
}

async function redistributeOneFlatten(
  input: FillIngestInput,
  byLot: Map<string, NormalizedFill[]>,
  clientOrderId: string,
  namedLots: Set<string>,
  positionKeys: ReadonlySet<string>,
  failures: ContainedFailure[],
): Promise<void> {
  const { store } = input;
  const attribution = await store.getFlattenAttribution(clientOrderId);
  if (attribution === null || attribution.lot_idempotency_keys.length === 0) return;
  const lotKeys = attribution.lot_idempotency_keys;

  for (const lotKey of lotKeys) namedLots.add(lotKey);

  const rawFills = byLot.get(clientOrderId);
  if (rawFills === undefined) return;

  const totalShare = await flattenTotalShare(store, attribution);
  const split = splitFlattenFills({ clientOrderId, rawFills, lotKeys, totalShare, attribution });
  const unattributed = mergeSplitsIntoLots(byLot, split.splits, positionKeys);
  await warnOnFlattenOverfills(input, clientOrderId, split.outcomes);

  for (const [lotKey, splitFills] of unattributed) {
    await persistUnattributedSplits(
      input,
      attribution,
      clientOrderId,
      lotKey,
      splitFills,
      failures,
    );
  }

  await markResidualsUnprotected(
    input,
    [...split.remaining].filter(([, unclosed]) => unclosed > 0).map(([lotKey]) => lotKey),
    input.clock.now(),
    {
      level: 'warn',
      message:
        'markResidualUnprotected failed during flatten redistribution — a crash before the ' +
        "re-arm confirms would leave this lot's residual invisible to the #549 sweep",
      payload: { flatten_client_order_id: clientOrderId },
    },
  );

  byLot.delete(clientOrderId);
}

async function flattenTotalShare(
  store: FillIngestInput['store'],
  attribution: FlattenAttribution,
): Promise<Map<string, number>> {
  const journalledHeld = attribution.lot_held_quantities;
  if (journalledHeld === null) return entryTotalShares(store, attribution.lot_idempotency_keys);
  return new Map(journalledHeld.map((lot) => [lot.idempotency_key, lot.held]));
}

export function mergeSplitsIntoLots(
  byLot: Map<string, NormalizedFill[]>,
  splits: Iterable<readonly [string, readonly NormalizedFill[]]>,
  positionKeys: ReadonlySet<string>,
): [string, readonly NormalizedFill[]][] {
  const unattributed: [string, readonly NormalizedFill[]][] = [];
  for (const [lotKey, splitFills] of splits) {
    const bucket = byLot.get(lotKey);
    if (bucket === undefined) byLot.set(lotKey, [...splitFills]);
    else bucket.push(...splitFills);
    if (!positionKeys.has(lotKey)) unattributed.push([lotKey, splitFills]);
  }
  return unattributed;
}

type RecordedFillKey = Parameters<FillIngestInput['store']['hasFill']>[0];

async function warnOnFlattenOverfills(
  input: FillIngestInput,
  clientOrderId: string,
  outcomes: Iterable<{ attributed: Iterable<RecordedFillKey>; leftover: number }>,
): Promise<void> {
  for (const { attributed, leftover } of outcomes) {
    if (leftover > 0) await warnOnFlattenOverfill(input, clientOrderId, attributed, leftover);
  }
}

async function warnOnFlattenOverfill(
  input: FillIngestInput,
  clientOrderId: string,
  attributed: Iterable<RecordedFillKey>,
  leftover: number,
): Promise<void> {
  if (await anyFillRecorded(input.store, attributed)) return;
  try {
    await input.flattenOverfillAlerts.postFlattenOverfillWarning({
      trace_id: input.trace_id,
      idempotency_key: clientOrderId,
      unattributed_qty: leftover,
      observed_at: input.clock.now(),
    });
  } catch {
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'flatten_overfill_alert_send_failed',
      level: 'warn',
      message:
        'flatten-overfill alert delivery failed — the overfill itself was still dropped ' +
        'as designed; this only lost the diagnostic line about it',
      payload: { flatten_client_order_id: clientOrderId, unattributed_qty: leftover },
    });
  }
}

async function anyFillRecorded(
  store: FillIngestInput['store'],
  fills: Iterable<RecordedFillKey>,
): Promise<boolean> {
  try {
    for (const { idempotency_key, broker_fill_id } of fills) {
      if (await store.hasFill({ idempotency_key, broker_fill_id })) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function persistUnattributedSplits(
  input: FillIngestInput,
  attribution: FlattenAttribution,
  clientOrderId: string,
  lotKey: string,
  splitFills: readonly NormalizedFill[],
  failures: ContainedFailure[],
): Promise<void> {
  const { store } = input;
  const now = input.clock.now();
  for (const fill of splitFills) {
    if (Date.parse(fill.timestamp) > now.getTime()) continue;
    try {
      if (await store.hasFill({ idempotency_key: lotKey, broker_fill_id: fill.broker_fill_id })) {
        continue;
      }
      await store.applyLotAdvance({
        idempotency_key: lotKey,
        fills: [toFill(fill, lotKey, NO_MODELLED_LOT_COSTS)],
      });
    } catch (error) {
      logCaughtFailure(
        input.logger,
        {
          trace_id: input.trace_id,
          stage: 'execution',
          event: 'unattributed_flatten_fill_persist_failed',
          level: 'error',
          message: UNATTRIBUTED_FLATTEN_FILL_PERSIST_FAILED,
        },
        error,
        {
          flatten_client_order_id: clientOrderId,
          idempotency_key: lotKey,
          broker_fill_id: fill.broker_fill_id,
          qty: fill.qty,
        },
      );
      failures.push({ scope: 'lot-advance', key: lotKey, instrument: null, error });
      continue;
    }

    await warnOnNonSterlingFee(
      input,
      { idempotency_key: lotKey, instrument: attribution.instrument },
      fill,
    );

    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'unattributed_flatten_fill',
      level: 'error',
      message: UNATTRIBUTED_FLATTEN_FILL,
      payload: {
        flatten_client_order_id: clientOrderId,
        idempotency_key: lotKey,
        broker_fill_id: fill.broker_fill_id,
        qty: fill.qty,
      },
    });

    if (input.unattributedFlattenFillAlerts === undefined) continue;
    try {
      await input.unattributedFlattenFillAlerts.postUnattributedFlattenFillAlert({
        trace_id: input.trace_id,
        flatten_idempotency_key: clientOrderId,
        lot_idempotency_key: lotKey,
        instrument: attribution.instrument,
        side: attribution.side,
        broker_fill_id: fill.broker_fill_id,
        qty: fill.qty,
        observed_at: input.clock.now(),
      });
    } catch {
      safeLog(input.logger, {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'unattributed_flatten_fill_alert_send_failed',
        level: 'warn',
        message:
          'postUnattributedFlattenFillAlert delivery failed — see the ' +
          'unattributed_flatten_fill entry above for the fill this concerns',
        payload: { idempotency_key: lotKey, broker_fill_id: fill.broker_fill_id },
      });
    }
  }
}

async function entryTotalShares(
  store: FillIngestInput['store'],
  lotKeys: readonly string[],
): Promise<Map<string, number>> {
  const entrySizes = await store.getEntryFillSizes(lotKeys);
  return new Map(lotKeys.map((lotKey) => [lotKey, entrySizes.get(lotKey) ?? 0]));
}

async function collectNewFillsForLot(
  input: FillIngestInput,
  position: OpenPosition,
  lotFills: readonly NormalizedFill[],
): Promise<{
  newFills: Fill[];
  cumulativeReoffers: NormalizedFill[];
  ingestedEntry: boolean;
  ingestedExit: boolean;
}> {
  const { store } = input;
  const newFills: Fill[] = [];
  const cumulativeReoffers: NormalizedFill[] = [];
  const modelledLotCosts = modelledLotCostsFor(position);
  let ingestedEntry = false;
  let ingestedExit = false;
  for (const fill of lotFills) {
    if (
      await store.hasFill({
        idempotency_key: position.idempotency_key,
        broker_fill_id: fill.broker_fill_id,
      })
    ) {
      if (fill.qty_is_cumulative === true) cumulativeReoffers.push(fill);
      continue;
    }
    newFills.push(toFill(fill, position.idempotency_key, modelledLotCosts));
    await warnOnNonSterlingFee(input, position, fill);
    ingestedEntry ||= fill.leg === 'entry';
    ingestedExit ||= fill.leg === 'exit';
  }
  return { newFills, cumulativeReoffers, ingestedEntry, ingestedExit };
}

async function reconcileCumulativeReoffers(
  input: FillIngestInput,
  position: OpenPosition,
  collected: {
    newFills: Fill[];
    cumulativeReoffers: NormalizedFill[];
    ingestedEntry: boolean;
    ingestedExit: boolean;
  },
): Promise<{ persisted: Fill[] | null; ingestedEntry: boolean; ingestedExit: boolean }> {
  const { store } = input;
  const { cumulativeReoffers, newFills } = collected;
  let { ingestedEntry, ingestedExit } = collected;

  let persisted: Fill[] | null = null;
  if (cumulativeReoffers.length > 0) {
    persisted = await store.getFills(position.idempotency_key);
    for (const fill of cumulativeReoffers) {
      const topUp = await cumulativeTopUp(input, position, fill, [...persisted, ...newFills]);
      if (topUp === null) continue;
      newFills.push(topUp);
      ingestedEntry ||= topUp.leg === 'entry';
      ingestedExit ||= topUp.leg === 'exit';
    }
  }
  return { persisted, ingestedEntry, ingestedExit };
}

async function handleLotWithNoNewFills(
  input: FillIngestInput,
  position: OpenPosition,
  now: Date,
  flattenTargetedThisPoll: boolean,
): Promise<void> {
  if (flattenTargetedThisPoll) {
    await maybeRearmResidual(input, position, now);
  }

  if (isWedgedZeroFillLot(position)) {
    const { announce, consecutive } = input.filledZeroSizeThrottle.observe(
      position.idempotency_key,
      now,
    );
    if (announce !== null) {
      safeLog(input.logger, {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'fill_priced_at_zero_size',
        level: announce,
        message: FILLED_WITH_ZERO_SIZE,
        payload: {
          idempotency_key: position.idempotency_key,
          instrument: position.instrument,
          order_state: position.order_state,
          stuck_ms: now.getTime() - position.opened_at.getTime(),
          consecutive,
        },
      });
    }
  }
}

// The resizeProtectiveLegs call, the maybeRearmResidual call, and the final applyLotAdvance
// write are each gated on filledSize/flat computed just above and ordered relative to each
// other and to that write — a further split risks decoupling a broker call from the exact
// state snapshot it must act on
async function advanceLot(
  input: FillIngestInput,
  position: OpenPosition,
  fills: readonly NormalizedFill[],
  now: Date,
  flattenTargetedThisPoll: boolean,
): Promise<void> {
  const { broker, store } = input;

  const lotFills = fills.filter((fill) => Date.parse(fill.timestamp) <= now.getTime());

  const collected = await collectNewFillsForLot(input, position, lotFills);
  const { newFills } = collected;
  const { persisted, ingestedEntry, ingestedExit } = await reconcileCumulativeReoffers(
    input,
    position,
    collected,
  );

  if (newFills.length === 0) {
    await handleLotWithNoNewFills(input, position, now, flattenTargetedThisPoll);
    return;
  }

  const recorded = [
    ...(persisted ?? (await store.getFills(position.idempotency_key))),
    ...newFills,
  ];
  const filledSize = totalQty(recorded.filter((fill) => fill.leg === 'entry'));
  if (filledSize === 0) {
    await store.applyLotAdvance({ idempotency_key: position.idempotency_key, fills: newFills });
    return;
  }

  await clearFillZeroSizeWarning(input, position);

  const { entryFills, exitFills, avgEntryPrice, exitQty, flat, orderState } = computeLotState(
    position,
    recorded,
    filledSize,
  );

  if (!flat && ingestedEntry) {
    await broker.resizeProtectiveLegs(position.idempotency_key, filledSize);
  }

  if (!flat && (ingestedExit || flattenTargetedThisPoll)) {
    await maybeRearmResidual(input, position, now, { filledSize, exitQty });
  }

  await store.applyLotAdvance({
    idempotency_key: position.idempotency_key,
    fills: newFills,
    position_update: {
      filled_size: filledSize,
      avg_entry_price: avgEntryPrice,
      order_state: orderState,
    },
    ...(flat
      ? {
          closed_trade: closedTrade(position, { filledSize, avgEntryPrice, entryFills, exitFills }),
        }
      : {}),
  });
}

async function clearFillZeroSizeWarning(
  input: FillIngestInput,
  position: OpenPosition,
): Promise<void> {
  const { hadWarned } = input.filledZeroSizeThrottle.clear(position.idempotency_key);
  if (!hadWarned) return;
  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    event: 'fill_zero_size_cleared',
    level: 'info',
    message: FILLED_ZERO_SIZE_CLEARED,
    payload: { idempotency_key: position.idempotency_key, instrument: position.instrument },
  });
}

interface LotState {
  entryFills: Fill[];
  exitFills: ExitFill[];
  avgEntryPrice: number;
  exitQty: number;
  flat: boolean;
  orderState: OrderState;
}

function computeLotState(
  position: OpenPosition,
  recorded: readonly Fill[],
  filledSize: number,
): LotState {
  const entryFills = recorded.filter((fill) => fill.leg === 'entry');
  const exitFills = recorded.filter(isExitFill);
  const avgEntryPrice = weightedAvgPrice(entryFills);
  const exitQty = totalQty(exitFills);
  const flat = isFlat({ filledSize, exitQty });
  const orderState = nextState(position, filledSize, flat);
  return { entryFills, exitFills, avgEntryPrice, exitQty, flat, orderState };
}

function nextState(position: OpenPosition, filledSize: number, flat: boolean): OrderState {
  if (flat) return 'closed';
  return coversQty(filledSize, position.requested_size) ? 'filled' : 'partially_filled';
}

async function cumulativeTopUp(
  input: FillIngestInput,
  position: OpenPosition,
  fill: NormalizedFill,
  booked: readonly Fill[],
): Promise<Fill | null> {
  const increment = cumulativeIncrement(booked, fill);
  if (increment === null) return null;

  if (increment.priceDegraded) {
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'fill_topup_price_unusable',
      level: 'warn',
      message:
        '#842: cumulative fill top-up produced an unusable increment price — booking the ' +
        "quantity at the venue's cumulative average instead, so avg_entry_price is approximate",
      payload: {
        idempotency_key: position.idempotency_key,
        broker_fill_id: fill.broker_fill_id,
        booked_qty: increment.bookedQty,
        venue_cumulative_qty: fill.qty,
        derived_price: increment.derivedPrice,
      },
    });
  }

  await warnOnNonSterlingFee(input, position, fill);

  return toFill(
    {
      ...fill,
      broker_fill_id: increment.broker_fill_id,
      qty: increment.qty,
      price: increment.price,
      fee: increment.fee,
    },
    position.idempotency_key,
    modelledLotCostsFor(position),
  );
}

async function warnOnNonSterlingFee(
  input: FillIngestInput,
  position: { idempotency_key: string; instrument: string },
  fill: NormalizedFill,
): Promise<void> {
  const currency = fill.fee_currency;
  if (currency === undefined || isBookCurrency(currency)) return;
  const alert: NonSterlingFeeAlert = {
    trace_id: input.trace_id,
    idempotency_key: position.idempotency_key,
    instrument: position.instrument,
    broker_fill_id: fill.broker_fill_id,
    fee: fill.fee,
    fee_currency: currency,
    book_currency: BOOK_CURRENCY,
  };
  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    event: 'fee_currency_not_book_currency',
    level: 'error',
    message: FEE_CURRENCY_NOT_BOOK_CURRENCY,
    payload: {
      ...alert,
      fx_rate_to_gbp: fill.fx_rate_to_gbp,
      fx_rate_to_gbp_source: fill.fx_rate_to_gbp_source,
    },
  });
  if (input.nonSterlingFeeAlerts === undefined) return;
  try {
    await input.nonSterlingFeeAlerts.postNonSterlingFeeAlert(alert);
  } catch {
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'non_sterling_fee_alert_send_failed',
      level: 'error',
      message:
        'postNonSterlingFeeAlert delivery failed — see the fee_currency_not_book_currency ' +
        'entry above for the fill this concerns',
      payload: {
        idempotency_key: position.idempotency_key,
        broker_fill_id: fill.broker_fill_id,
      },
    });
  }
}

const OPTIONAL_FILL_KEYS = [
  'exit_reason',
  'flatten_idempotency_key',
  'fee_currency',
  'fx_rate_to_gbp',
  'fx_rate_to_gbp_source',
] as const satisfies readonly (keyof NormalizedFill & keyof Fill)[];

function optionalFillFields(
  fill: NormalizedFill,
): Partial<Pick<Fill, (typeof OPTIONAL_FILL_KEYS)[number]>> {
  const entries = OPTIONAL_FILL_KEYS.map((key) => [key, fill[key]] as const).filter(
    ([, value]) => value !== undefined,
  );
  return Object.fromEntries(entries) as Partial<Pick<Fill, (typeof OPTIONAL_FILL_KEYS)[number]>>;
}

function toFill(
  fill: NormalizedFill,
  idempotencyKey: string,
  modelledLotCosts: ModelledLotCosts,
): Fill {
  const modelledLegCost = modelledLegCostFor(fill.leg, modelledLotCosts);
  const fallbackCostBreakdown =
    fill.cost_breakdown === undefined && modelledLegCost !== null
      ? prorateCostBreakdown(modelledLegCost.breakdown, fill.qty / modelledLegCost.requestedSize)
      : undefined;
  const chargedFee = chargeTopUpTo(fill.fee, fallbackCostBreakdown?.commission);
  const costBreakdown = fill.cost_breakdown ?? fallbackCostBreakdown;

  return {
    idempotency_key: idempotencyKey,
    broker_fill_id: fill.broker_fill_id,
    leg: fill.leg,
    price: fill.price,
    qty: fill.qty,
    fee: chargedFee,
    timestamp: new Date(fill.timestamp),
    ...(costBreakdown === undefined ? {} : { cost_breakdown: costBreakdown }),
    ...optionalFillFields(fill),
  };
}

function modelledLegCostFor(
  leg: NormalizedFill['leg'],
  costs: ModelledLotCosts,
): ModelledLegCost | null {
  switch (leg) {
    case 'entry':
      return costs.entry;
    case 'stop':
    case 'target':
      return costs.protectiveExit;
    case 'exit':
      return null;
  }
}

function earliest(dates: readonly Date[]): Date {
  return dates.reduce((min, date) => (date.getTime() < min.getTime() ? date : min));
}
