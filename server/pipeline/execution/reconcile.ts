import type { OpenPosition, OrderState } from '../../shared/index.js';
import { coversQty, describeThrownSafely, heldQuantitiesFor, safeLog } from '../../shared/index.js';
import { IN_FLIGHT_ORDER_STATES, TERMINAL_ORDER_STATES } from '../../shared/store/index.js';
import { sweepResidualProtection } from './residual-protection-sweep.js';
import type {
  NormalizedOrder,
  NormalizedPosition,
  ReconcileDivergence,
  ReconcileEscalation,
  ReconcileInput,
  ReconcileReport,
  UnresolvedFlattenSubmission,
} from './types.js';
import { sweepWedgedZeroFillLots } from './wedged-zero-fill-sweep.js';

export const UNRESOLVABLE_FLATTEN_MAX_AGE_MS = 5 * 60 * 1_000;

export const FLATTEN_CANCEL_RETRY_EVERY_MS = 30 * 60 * 1_000;

export const UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS = 30 * 60 * 1_000;

type VenuePositions = { positions: readonly NormalizedPosition[] } | { error: string };

export async function reconcile(input: ReconcileInput): Promise<ReconcileReport> {
  const { clock, store } = input;
  const now = clock.now();

  const positions = await store.getOpenPositions();
  const inFlight = positions.filter((position) =>
    IN_FLIGHT_ORDER_STATES.includes(position.order_state),
  );

  const divergences: ReconcileDivergence[] = [];

  for (const position of inFlight) {
    const divergence = await reconcileLot(input, position);
    if (divergence !== null) divergences.push(divergence);
  }

  const unresolvedFlattens = await store.getUnresolvedFlattens();
  for (const row of unresolvedFlattens) {
    divergences.push(await reconcileFlatten(input, row, now, positions));
  }

  const residualSweep = await sweepResidualProtection(input);
  divergences.push(...residualSweep.divergences);

  const wedgedZeroFillSweep = await sweepWedgedZeroFillLots(input);
  divergences.push(...wedgedZeroFillSweep.divergences);

  const corrected = divergences.filter((divergence) => divergence.action !== 'undetermined').length;

  divergences.push(
    ...(await findUnrecordedVenuePositions(input, await readVenuePositions(input), positions, now)),
  );

  const terminalSweepAgeMs = 24 * 60 * 60 * 1_000;
  const cutoff = new Date(now.getTime() - terminalSweepAgeMs);
  const swept = await store.sweepTerminalPositions(cutoff);

  return {
    checked:
      inFlight.length +
      unresolvedFlattens.length +
      residualSweep.checked +
      wedgedZeroFillSweep.checked,
    corrected,
    divergences,
    swept,
    timestamp: now,
  };
}

type ResumedFlatten = NonNullable<Awaited<ReturnType<ReconcileInput['broker']['resumeFlatten']>>>;

export function flattenDivergence(
  row: UnresolvedFlattenSubmission,
  storeState: OrderState,
  brokerState: OrderState | null,
  action: ReconcileDivergence['action'],
  reason: string,
): ReconcileDivergence {
  return {
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: storeState,
    broker_state: brokerState,
    action,
    kind: 'flatten',
    reason,
  };
}

export function flattenStoreState(row: UnresolvedFlattenSubmission): OrderState {
  return row.status === 'submitting' ? 'pending' : 'submitted';
}

async function reconcileFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  now: Date,
  storePositions: readonly OpenPosition[],
): Promise<ReconcileDivergence> {
  const storeState = flattenStoreState(row);

  let order: Awaited<ReturnType<typeof input.broker.resumeFlatten>>;
  try {
    order = await input.broker.resumeFlatten(row.idempotency_key, row.instrument);
  } catch (error) {
    return await reconcileUnreadableFlatten(input, row, now, storePositions, storeState, error);
  }

  if (order === null) return await reconcileMissingFlatten(input, row, now, storeState);

  if (TERMINAL_ORDER_STATES.includes(order.order_state) && order.filled_qty === 0) {
    const reason =
      `reconcile: the venue reports this flatten '${order.order_state}' having filled nothing — ` +
      'it closed no quantity and never will, so the journal row is resolved rather than left ' +
      'standing as an in-flight flatten on the instrument';
    await input.store.resolveFlattenError(row.idempotency_key, reason, now);
    return flattenDivergence(row, storeState, order.order_state, 'rejected', reason);
  }

  await recordObservedFlattenState(input, row, order, now);
  return await reconcileObservedFlatten(input, row, order, now, storePositions, storeState);
}

async function reconcileUnreadableFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  now: Date,
  storePositions: readonly OpenPosition[],
  storeState: OrderState,
  error: unknown,
): Promise<ReconcileDivergence> {
  if (
    row.order_state === null &&
    now.getTime() - row.submitted_at.getTime() >= UNRESOLVABLE_FLATTEN_MAX_AGE_MS
  ) {
    return await cancelNeverConfirmedFlatten(input, row, now, storePositions, {
      storeState,
      resumeError: describeThrownSafely(error),
    });
  }

  const reason = describeThrownSafely(error);
  await postFlattenReconcileAlert(input, row, reason, now);
  return flattenDivergence(row, storeState, null, 'undetermined', reason);
}

async function reconcileMissingFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  now: Date,
  storeState: OrderState,
): Promise<ReconcileDivergence> {
  if (row.status === 'submitting') {
    const reason =
      'reconcile: broker has no order under this client_order_id — the write-ahead never landed';
    await input.store.resolveFlattenError(row.idempotency_key, reason, now);
    return flattenDivergence(row, storeState, null, 'rejected', reason);
  }

  const age = now.getTime() - row.submitted_at.getTime();
  const provenance =
    `flatten '${row.idempotency_key}' was previously acked by the broker (a durable ` +
    "'submitted' journal row exists) but the venue now reports no such order";
  if (age >= UNRESOLVABLE_FLATTEN_MAX_AGE_MS) {
    const reason =
      `${provenance}. The row has been unresolved for ${Math.round(age / 1_000)}s — past the ` +
      `${UNRESOLVABLE_FLATTEN_MAX_AGE_MS / 1_000}s bound, so the journal row is resolved to ` +
      'stop it blocking every later flatten on this instrument. This is a DECISION on one ' +
      'unanswered check against a row that old, not proof the flatten is dead, and not a ' +
      'record of repeated denial (nothing counts how often the venue was asked): check the ' +
      'venue by hand, and note that a fill arriving later is still attributed to the lots ' +
      'this flatten named (getFlattenAttribution does not filter on status)';
    await postFlattenReconcileAlert(input, row, reason, now);
    await input.store.resolveFlattenError(row.idempotency_key, reason, now);
    return flattenDivergence(row, storeState, null, 'rejected', reason);
  }
  const reason = `${provenance} — leaving the journal untouched; check the venue by hand`;
  await postFlattenReconcileAlert(input, row, reason, now);
  return flattenDivergence(row, storeState, null, 'undetermined', reason);
}

async function recordObservedFlattenState(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  order: ResumedFlatten,
  now: Date,
): Promise<void> {
  const observed = { order_state: order.order_state, broker_order_ids: order.broker_order_ids };
  if (row.status === 'submitting') {
    await input.store.resolveFlattenSubmitted(row.idempotency_key, observed, now);
  } else {
    await input.store.recordFlattenOrderStateObserved(row.idempotency_key, observed);
  }
}

async function reconcileObservedFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  order: ResumedFlatten,
  now: Date,
  storePositions: readonly OpenPosition[],
  storeState: OrderState,
): Promise<ReconcileDivergence> {
  const adopted = `flatten journal said '${row.status}'; broker reports '${order.order_state}'`;

  const judged = await judgeTerminalUnsweptWhenDue(
    input,
    row,
    order,
    now,
    storePositions,
    storeState,
  );
  if (judged !== undefined) return judged;

  const working = !TERMINAL_ORDER_STATES.includes(order.order_state);
  if (working && now.getTime() - row.submitted_at.getTime() >= UNRESOLVABLE_FLATTEN_MAX_AGE_MS) {
    return {
      ...flattenDivergence(
        row,
        storeState,
        order.order_state,
        'adopted',
        `${adopted}; ${await cancelWedgedFlatten(input, row, order.order_state, now)}`,
      ),
      escalation: 'wedge_cancelled',
    };
  }

  return flattenDivergence(row, storeState, order.order_state, 'adopted', adopted);
}

async function judgeTerminalUnsweptWhenDue(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  order: ResumedFlatten,
  now: Date,
  storePositions: readonly OpenPosition[],
  storeState: OrderState,
): Promise<ReconcileDivergence | undefined> {
  if (!TERMINAL_ORDER_STATES.includes(order.order_state)) return undefined;
  const firstSeen = row.terminal_unswept_checked_at;
  if (firstSeen === null) {
    await input.store.markFlattenTerminalUnsweptChecked(row.idempotency_key, now);
    return undefined;
  }
  if (now.getTime() - firstSeen.getTime() < UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS) return undefined;
  return await judgeTerminalUnsweptFlatten(
    input,
    row,
    order,
    firstSeen,
    storePositions,
    storeState,
    now,
  );
}

async function cancelWedgedFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  observedState: OrderState,
  now: Date,
): Promise<string> {
  const age = Math.round((now.getTime() - row.submitted_at.getTime()) / 1_000);
  if (!cancelDue(row, now)) {
    return (
      `the venue still reports this flatten '${observedState}' after ${age}s; it was already ` +
      `cancelled at the venue at ${row.cancel_attempted_at?.toISOString()} and the row keeps ` +
      'blocking until the venue reports it terminal AND its fills are swept — not re-cancelled ' +
      'or re-paged this pass (FLATTEN_CANCEL_RETRY_EVERY_MS)'
    );
  }
  const provenance =
    `the venue still reports this flatten '${observedState}' after ${age}s — past the ` +
    `${UNRESOLVABLE_FLATTEN_MAX_AGE_MS / 1_000}s bound, so it is being CANCELLED at the venue ` +
    'rather than left to block every later flatten on this instrument. The journal row is ' +
    'unchanged and keeps blocking until the venue reports the order terminal AND its fills ' +
    'are swept — nothing is re-armed on age alone';
  const failure = await markAndCancelFlatten(input, row, now, provenance, 'retrying when due');
  if (failure !== undefined) return failure;
  await postFlattenReconcileAlert(input, row, provenance, now);
  return provenance;
}

async function markAndCancelFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  now: Date,
  provenance: string,
  onFailure: string,
): Promise<string | undefined> {
  await input.store.markFlattenCancelAttempted(row.idempotency_key, now);
  try {
    await input.broker.cancel(row.idempotency_key, row.instrument);
    return undefined;
  } catch (error) {
    const reason = `${provenance}. The cancel FAILED (${describeThrownSafely(error)}); ${onFailure}`;
    await postFlattenReconcileAlert(input, row, reason, now);
    return reason;
  }
}

function cancelDue(row: UnresolvedFlattenSubmission, now: Date): boolean {
  if (row.cancel_attempted_at === null) return true;
  return now.getTime() - row.cancel_attempted_at.getTime() >= FLATTEN_CANCEL_RETRY_EVERY_MS;
}

async function cancelNeverConfirmedFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  now: Date,
  storePositions: readonly OpenPosition[],
  context: { storeState: OrderState; resumeError: string },
): Promise<ReconcileDivergence> {
  const age = Math.round((now.getTime() - row.submitted_at.getTime()) / 1_000);
  const provenance =
    `the venue has never once described flatten '${row.idempotency_key}' (resumeFlatten: ` +
    `${context.resumeError}) and the row is ${age}s old — past the ` +
    `${UNRESOLVABLE_FLATTEN_MAX_AGE_MS / 1_000}s bound`;
  const blocked = (reason: string, escalation: ReconcileEscalation): ReconcileDivergence => ({
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: context.storeState,
    broker_state: null,
    action: 'undetermined',
    kind: 'flatten',
    reason,
    escalation,
  });

  if (!cancelDue(row, now)) {
    return blocked(
      `${provenance}. Already cancelled at the venue at ` +
        `${row.cancel_attempted_at?.toISOString()}; still blocking, and not re-cancelled or ` +
        're-paged this pass (FLATTEN_CANCEL_RETRY_EVERY_MS)',
      'never_confirmed_throttled',
    );
  }

  const failure = await markAndCancelFlatten(input, row, now, provenance, 'the row keeps blocking');
  if (failure !== undefined) return blocked(failure, 'never_confirmed_cancel_failed');

  const coverage = await venueCoversStoreHeld(input, row, storePositions);
  if (!coverage.covered) {
    const reason =
      `${provenance}. It was CANCELLED at the venue, but ${coverage.note}, so the row keeps ` +
      'blocking rather than let a replacement be sized off a held quantity that may be too ' +
      'big. The fills cannot be ingested through an adapter that will not describe this ' +
      'order: attribute them by hand';
    await postFlattenReconcileAlert(input, row, reason, now);
    return blocked(reason, 'never_confirmed_coverage_short');
  }

  const reason =
    `${provenance}. It was CANCELLED at the venue, and ${coverage.note} — so no replacement ` +
    'can over-sell, and the journal row is resolved rather than left blocking every later ' +
    'flatten on the instrument. A fill arriving later is still attributed to the lots this ' +
    'flatten named (getFlattenAttribution does not filter on status)';
  await postFlattenReconcileAlert(input, row, reason, now);
  await input.store.resolveFlattenError(row.idempotency_key, reason, now);
  return {
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: context.storeState,
    broker_state: null,
    action: 'rejected',
    kind: 'flatten',
    reason,
  };
}

async function postFlattenReconcileAlert(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  reason: string,
  now: Date,
): Promise<void> {
  try {
    await input.flattenReconcileAlerts.postFlattenReconcileAlert({
      trace_id: input.trace_id,
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      reason,
      observed_at: now,
    });
  } catch {
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'flatten_reconcile_alert_send_failed',
      level: 'error',
      message:
        'postFlattenReconcileAlert delivery failed — an unresolved flatten stays genuinely ' +
        'ambiguous and the operator was not paged; check the venue by hand',
      payload: { idempotency_key: row.idempotency_key, instrument: row.instrument },
    });
  }
}

async function judgeTerminalUnsweptFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  order: NormalizedOrder,
  lastExamined: Date,
  storePositions: readonly OpenPosition[],
  storeState: OrderState,
  now: Date,
): Promise<ReconcileDivergence> {
  const sat = Math.round((now.getTime() - lastExamined.getTime()) / 1_000);
  const provenance =
    `the venue reports this flatten '${order.order_state}' having filled ${order.filled_qty}, ` +
    `and ${sat}s after this sweep last examined it ingestFills has still not swept its ` +
    `fills — past the ${UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS / 60_000}min bound`;
  const coverage = await venueCoversStoreHeld(input, row, storePositions);
  if (!coverage.covered) {
    const reason =
      `${provenance}. ${coverage.note}, so the fills this flatten produced are real and not ` +
      'in the store, and no venue number can say which lot each belongs to. The row keeps ' +
      'blocking: attribute them by hand';
    await input.store.markFlattenTerminalUnsweptChecked(row.idempotency_key, now);
    await postFlattenReconcileAlert(input, row, reason, now);
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: order.order_state,
      action: 'undetermined',
      kind: 'flatten',
      reason,
    };
  }
  const reason =
    `${provenance}. ${coverage.note} — so no replacement can over-sell, and the journal row ` +
    'is resolved rather than left blocking every later flatten on the instrument. Its fills ' +
    'are still unswept: this is an INFERENCE that resolving is safe, not a completed sweep, ' +
    'and not a finding that they reached the store';
  await postFlattenReconcileAlert(input, row, reason, now);
  await input.store.resolveFlattenError(row.idempotency_key, reason, now);
  return {
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: storeState,
    broker_state: order.order_state,
    action: 'rejected',
    kind: 'flatten',
    reason,
  };
}

function sumHeld(
  lots: readonly OpenPosition[],
  side: OpenPosition['side'],
  heldByKey: ReadonlyMap<string, number>,
): number {
  return lots
    .filter((lot) => lot.side === side)
    .reduce((sum, lot) => sum + (heldByKey.get(lot.idempotency_key) ?? 0), 0);
}

async function venueCoversStoreHeld(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  storePositions: readonly OpenPosition[],
): Promise<{ covered: boolean; note: string }> {
  const venue = await readVenuePositions(input);
  if ('error' in venue) {
    return {
      covered: false,
      note: `this pass could not read the venue's positions (${venue.error}) to check what it holds`,
    };
  }

  const lots = storePositions.filter((position) => position.instrument === row.instrument);
  const held = await heldQuantitiesFor(lots, (keys) => input.store.getExitFillSizes(keys));
  const heldByKey = new Map(held.map((lot) => [lot.idempotency_key, lot.held]));
  const longHeld = sumHeld(lots, 'buy', heldByKey);
  const shortHeld = sumHeld(lots, 'sell', heldByKey);
  if (lots.some((lot) => lot.side === 'buy') && lots.some((lot) => lot.side === 'sell')) {
    return {
      covered: false,
      note:
        `the store holds ${longHeld} long and ${shortHeld} short ${row.instrument} across lots ` +
        'and the venue reports one NETTED position per instrument, so no venue number can ' +
        'corroborate both sides',
    };
  }
  const direction = shortHeld > 0 ? -1 : 1;
  const storeHeld = longHeld + shortHeld;
  const venueQty =
    direction *
    venue.positions
      .filter((position) => position.instrument === row.instrument)
      .reduce((sum, position) => sum + position.qty, 0);
  if (!coversQty(venueQty, storeHeld)) {
    return {
      covered: false,
      note:
        `the venue holds ${venueQty} ${row.instrument} against ${storeHeld} the store still ` +
        'considers held, so something filled that the store has not booked',
    };
  }
  if (!coversQty(storeHeld, venueQty)) {
    return {
      covered: false,
      note:
        `the venue holds ${venueQty} ${row.instrument} against ${storeHeld} the store considers ` +
        'held — a surplus the store has no lot for, which an unbooked exit fill of its size ' +
        'would hide inside, so this book cannot corroborate the store',
    };
  }
  if (storeHeld === 0) {
    return {
      covered: true,
      note:
        `the store holds no ${row.instrument} for this flatten to close, so nothing it could ` +
        'still be owed is at risk — the venue book says nothing either way about what filled',
    };
  }
  return {
    covered: true,
    note:
      `the venue still holds ${venueQty} ${row.instrument} — everything the store considers ` +
      `held (${storeHeld})`,
  };
}

async function readVenuePositions(input: ReconcileInput): Promise<VenuePositions> {
  try {
    return { positions: await input.broker.getOpenPositions() };
  } catch (error) {
    return { error: describeThrownSafely(error) };
  }
}

async function findUnrecordedVenuePositions(
  input: ReconcileInput,
  venue: VenuePositions,
  storePositions: readonly OpenPosition[],
  now: Date,
): Promise<ReconcileDivergence[]> {
  if ('error' in venue) {
    return [
      {
        idempotency_key: '',
        instrument: '',
        store_state: 'pending',
        broker_state: null,
        action: 'undetermined',
        kind: 'unrecorded',
        reason:
          'broker.getOpenPositions failed, so a position the venue holds and the store does ' +
          `not would not have been seen this pass: ${venue.error}`,
      },
    ];
  }
  const venuePositions = venue.positions;

  const known = new Set(storePositions.map((position) => position.instrument));

  const unrecorded = venuePositions.filter((venuePosition) => !known.has(venuePosition.instrument));
  await pageUnrecordedVenuePositions(input, unrecorded, now);

  return unrecorded.map((venuePosition) => ({
    idempotency_key: '',
    instrument: venuePosition.instrument,
    store_state: 'pending' as const,
    broker_state: null,
    action: 'unrecorded' as const,
    kind: 'unrecorded' as const,
    reason:
      `venue holds ${venuePosition.qty} ${venuePosition.instrument} (${venuePosition.side}) ` +
      'with no open lot in the store — this exposure is invisible to the Risk Manager. ' +
      'Nothing was written: adopting it would mean inventing the bracket, stop and debate_id ' +
      'it has none of. Reconcile it by hand.',
  }));
}

async function pageUnrecordedVenuePositions(
  input: ReconcileInput,
  unrecorded: readonly NormalizedPosition[],
  now: Date,
): Promise<void> {
  const due = new Set(
    input.unrecordedVenuePositionThrottle.dueFor(
      unrecorded.map((venuePosition) => venuePosition.instrument),
      now,
    ),
  );

  for (const venuePosition of unrecorded) {
    if (!due.has(venuePosition.instrument)) continue;
    try {
      await input.unrecordedVenuePositionAlerts.postUnrecordedVenuePositionAlert({
        trace_id: input.trace_id,
        instrument: venuePosition.instrument,
        qty: venuePosition.qty,
        side: venuePosition.side,
        observed_at: now,
      });
    } catch {
      safeLog(input.logger, {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'unrecorded_venue_position_alert_send_failed',
        level: 'error',
        message:
          'postUnrecordedVenuePositionAlert delivery failed — a venue position no open lot ' +
          'explains stays invisible to the Risk Manager and the operator was not paged; ' +
          'see the unrecorded divergence line for this instrument',
        payload: { instrument: venuePosition.instrument },
      });
    }
  }
}

async function reconcileLot(
  input: ReconcileInput,
  position: OpenPosition,
): Promise<ReconcileDivergence | null> {
  const { broker, store } = input;
  const key = position.idempotency_key;

  let order: Awaited<ReturnType<typeof broker.getOrder>>;
  try {
    order = await broker.getOrder(key, position.instrument);
  } catch (error) {
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'bracket',
      reason: describeThrownSafely(error),
    };
  }

  if (order === null) {
    await store.updatePositionState(key, { order_state: 'rejected', broker_order_ids: [] });

    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'rejected',
      kind: 'bracket',
      reason: 'broker has no order under this client_order_id — the write-ahead never landed',
    };
  }

  if (agrees(position, order)) return null;

  await store.updatePositionState(key, {
    order_state: order.order_state,
    broker_order_ids: order.broker_order_ids,
  });

  return {
    idempotency_key: key,
    instrument: position.instrument,
    store_state: position.order_state,
    broker_state: order.order_state,
    action: 'adopted',
    kind: 'bracket',
    reason: `store said '${position.order_state}', broker says '${order.order_state}'`,
  };
}

function agrees(
  position: OpenPosition,
  order: { order_state: OrderState; broker_order_ids: string[] },
): boolean {
  return (
    position.order_state === order.order_state &&
    sameIds(position.broker_order_ids, order.broker_order_ids)
  );
}

function sameIds(stored: readonly string[], broker: readonly string[]): boolean {
  return stored.length === broker.length && stored.every((id, index) => id === broker[index]);
}
