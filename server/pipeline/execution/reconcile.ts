/**
 * Execution's crash-restart surface (#86): settles `pending`/`submitted` lots against the broker on startup,
 * with the venue as tie-break authority — adopt what it says, or mark `rejected` where it never received the
 * order. Scope is in-flight states only; `ingestFills()` owns fill-driven advance for `partially_filled`/`filled`.
 */

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

/** #1088: how old a terminal, size-0 row must be before `sweepTerminalPositions` deletes it — bounded to survive idempotency-key reuse from a same-bar crash-restart replay */
export const TERMINAL_SWEEP_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * #1214: how long an unconfirmed/denied flatten blocks its instrument before being forced terminal on one
 * unanswered venue check. This deliberately re-arms #516's reverse-position double-sell risk (both flattens
 * bounded to three attempts, same direction) — accepted because leaving the instrument stuck forever violates ADR-0014.
 */
export const UNRESOLVABLE_FLATTEN_MAX_AGE_MS = 5 * 60 * 1_000;

/**
 * #1500: how often one wedged flatten row may cost a venue cancel + operator page. Unthrottled, the 15s
 * poll would re-cancel/re-page ~240x/hour per row for no benefit — retrying buys nothing at poll cadence.
 * The attempt time is DURABLE (migration 0062), so a restart loop can't turn the throttle back into a per-pass cancel.
 */
export const FLATTEN_CANCEL_RETRY_EVERY_MS = 30 * 60 * 1_000;

/**
 * #1500: how long a TERMINAL flatten with unswept fills may block its instrument before reconcile judges
 * it on venue evidence. Measured from `terminal_unswept_checked_at` (migration 0063), not `submitted_at` —
 * judging too early reads a venue view that hasn't caught up yet, sending a replacement flatten at full size (#516 over-sell).
 */
export const UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS = 30 * 60 * 1_000;

/** A `broker.getOpenPositions()` answer, or why this pass has none */
type VenuePositions = { positions: readonly NormalizedPosition[] } | { error: string };

export async function reconcile(input: ReconcileInput): Promise<ReconcileReport> {
  const { clock, store } = input;
  const now = clock.now();

  // `getOpenPositions()` is every non-terminal lot; in-flight ones are the subset a crash can leave disagreeing with the venue
  const positions = await store.getOpenPositions();
  const inFlight = positions.filter((position) =>
    IN_FLIGHT_ORDER_STATES.includes(position.order_state),
  );

  const divergences: ReconcileDivergence[] = [];

  for (const position of inFlight) {
    const divergence = await reconcileLot(input, position);
    if (divergence !== null) divergences.push(divergence);
  }

  // #519/#526 — see the file doc's "flatten-journal sweep" section
  const unresolvedFlattens = await store.getUnresolvedFlattens();
  for (const row of unresolvedFlattens) {
    divergences.push(await reconcileFlatten(input, row, now, positions));
  }

  // #549 — residual-protection sweep, run AFTER the flatten sweep: on the crypto path `resumeFlatten`'s
  // side effect repopulates the adapter's process-local worklists a restart emptied first (same ordering
  // as `runStartupReconcile` running before `ingestFills()`)
  const residualSweep = await sweepResidualProtection(input);
  divergences.push(...residualSweep.divergences);

  // #1186 — wedged-zero-fill sweep, store-evidence-only (no broker call): a lot it retires is never one
  // `reconcileLot` needed to act on or `findUnrecordedVenuePositions` should compare against a venue read
  const wedgedZeroFillSweep = await sweepWedgedZeroFillLots(input);
  divergences.push(...wedgedZeroFillSweep.divergences);

  // `undetermined` deliberately wrote nothing, so it is not a correction
  // Snapshotted HERE, before `findUnrecordedVenuePositions` below: that scan
  // only ever REPORTS (#429's "nothing was written: adopting it would mean
  // inventing the bracket, stop and debate_id it has none of"), so its
  // 'unrecorded' rows must never inflate this count even though their action
  // is not literally 'undetermined'
  const corrected = divergences.filter((divergence) => divergence.action !== 'undetermined').length;

  // Read HERE, not hoisted above the sweeps: a snapshot taken earlier is stale by every timeout/cancel
  // those sweeps spent (#1500) — same reason `cancelNeverConfirmedFlatten` re-reads after its own cancel
  divergences.push(
    ...(await findUnrecordedVenuePositions(input, await readVenuePositions(input), positions, now)),
  );

  // #1088 — terminal-row sweep, unconditional: every pass ages out whatever crossed the cutoff since the last one
  const cutoff = new Date(now.getTime() - TERMINAL_SWEEP_AGE_MS);
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

/**
 * Settle one `flatten_submissions` row against the venue — the flatten counterpart of `reconcileLot` below.
 * Always returns a divergence (never `null`): every row handed here is, by construction, one the store
 * doesn't yet consider settled.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch below resolves a distinct venue-evidence shape (never-landed, terminally-refused, wedged-working, resolved-then-fresher-answer) and several are explicitly ordered relative to their store writes (see "on purpose, not merely after" below) — extracting a branch risks reordering a write relative to a return that hazard depends on
async function reconcileFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  now: Date,
  storePositions: readonly OpenPosition[],
): Promise<ReconcileDivergence> {
  const { broker, store } = input;
  // `'submitting'` maps onto `'pending'` — the same "written ahead, not yet confirmed" meaning it carries for a bracket's write-ahead
  const storeState: OrderState = row.status === 'submitting' ? 'pending' : 'submitted';

  let order: Awaited<ReturnType<typeof broker.resumeFlatten>>;
  try {
    order = await broker.resumeFlatten(row.idempotency_key, row.instrument);
  } catch (error) {
    // Ignorance, not evidence: the adapter could not answer, so the row is left untouched and escalated
    // (#519) rather than marked "never placed". `order_state` stays untouched (sticky once confirmed
    // WORKING); a never-confirmed row instead releases via `cancelNeverConfirmedFlatten` (#1500), never on age alone
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
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: null,
      action: 'undetermined',
      kind: 'flatten',
      reason,
    };
  }

  if (order === null) {
    if (row.status === 'submitting') {
      // The venue authoritatively has no such order — same settlement `reconcileLot` makes for a bracket's
      // `pending` record, but a flatten writes no `OpenPosition`, so the JOURNAL row carries the terminal answer
      const reason =
        'reconcile: broker has no order under this client_order_id — the write-ahead never landed';
      await store.resolveFlattenError(row.idempotency_key, reason, now);
      return {
        idempotency_key: row.idempotency_key,
        instrument: row.instrument,
        store_state: storeState,
        broker_state: null,
        action: 'rejected',
        kind: 'flatten',
        reason,
      };
    }

    // A row already `'submitted'` carries venue-given `broker_order_ids` — a later null from `resumeFlatten`
    // proves only that the adapter can't reconfirm it, not that the write-ahead never landed. Escalated and
    // left untouched up to `UNRESOLVABLE_FLATTEN_MAX_AGE_MS` (#1214); past the bound the system decides rather than freezes
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
      await store.resolveFlattenError(row.idempotency_key, reason, now);
      return {
        idempotency_key: row.idempotency_key,
        instrument: row.instrument,
        store_state: storeState,
        broker_state: null,
        action: 'rejected',
        kind: 'flatten',
        reason,
      };
    }
    const reason = `${provenance} — leaving the journal untouched; check the venue by hand`;
    await postFlattenReconcileAlert(input, row, reason, now);
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: null,
      action: 'undetermined',
      kind: 'flatten',
      reason,
    };
  }

  // The venue named an order — `resumeFlatten`'s side effect already re-populated the adapter's worklist; only the journal write remains

  // #1214: the one venue answer that must resolve the row, not just record it. `fills_swept_at` is the
  // only thing that ever bounds a `'submitted'` row, set only by `ingestFills()` for a flatten that actually
  // produced fills — so a terminally refused flatten with `filled_qty === 0` has nothing owing and nothing else to wait for
  if (TERMINAL_ORDER_STATES.includes(order.order_state) && order.filled_qty === 0) {
    const reason =
      `reconcile: the venue reports this flatten '${order.order_state}' having filled nothing — ` +
      'it closed no quantity and never will, so the journal row is resolved rather than left ' +
      'standing as an in-flight flatten on the instrument';
    await store.resolveFlattenError(row.idempotency_key, reason, now);
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

  if (row.status === 'submitting') {
    // The genuine first resolution of this write-ahead's ambiguity — `resolveFlattenSubmitted` sets `resolved_at`, the same as a clean ack
    await store.resolveFlattenSubmitted(
      row.idempotency_key,
      { order_state: order.order_state, broker_order_ids: order.broker_order_ids },
      now,
    );
  } else {
    // Already resolved once; a FRESHER answer to a settled question, not a new ambiguity — `resolved_at`/`status` stay untouched
    await store.recordFlattenOrderStateObserved(row.idempotency_key, {
      order_state: order.order_state,
      broker_order_ids: order.broker_order_ids,
    });
  }

  const adopted = `flatten journal said '${row.status}'; broker reports '${order.order_state}'`;

  // #1500: a terminal row with unswept fills (`filled_qty > 0`) that `ingestFills()` will never sweep once
  // they age past their `since` floor. Released only past `UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS`, measured
  // from the FIRST pass that saw this shape (migration 0063) — a pass inside the window does nothing at all
  if (TERMINAL_ORDER_STATES.includes(order.order_state)) {
    const firstSeen = row.terminal_unswept_checked_at;
    if (firstSeen === null) {
      await store.markFlattenTerminalUnsweptChecked(row.idempotency_key, now);
    } else if (now.getTime() - firstSeen.getTime() >= UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS) {
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
  }

  // #1500: cancel-then-replace. A working row can never be released on age (a second full-size flatten
  // against a still-confirming order is the #516/#1389 over-sell), so the way out is to cancel it and let
  // the cancel's own terminal answer resolve through the existing paths — gated on fresh `order_state`, not `row.status`
  const working = !TERMINAL_ORDER_STATES.includes(order.order_state);
  if (working && now.getTime() - row.submitted_at.getTime() >= UNRESOLVABLE_FLATTEN_MAX_AGE_MS) {
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: order.order_state,
      action: 'adopted',
      kind: 'flatten',
      reason: `${adopted}; ${await cancelWedgedFlatten(input, row, order.order_state, now)}`,
      escalation: 'wedge_cancelled',
    };
  }

  return {
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: storeState,
    broker_state: order.order_state,
    action: 'adopted',
    kind: 'flatten',
    reason: adopted,
  };
}

/**
 * The cancel half of cancel-then-replace. Fully swallowed like every other venue call in this sweep — a
 * cancel that can't be delivered leaves the row exactly as it was. Returns the sentence appended to the
 * divergence `reason`, so a pass that deliberately did not re-cancel says so rather than reading as one that never tried.
 */
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
  // Recorded BEFORE the call, for failure as well as success — the throttle must not be escapable by a cancel that throws every pass
  await input.store.markFlattenCancelAttempted(row.idempotency_key, now);
  try {
    await input.broker.cancel(row.idempotency_key, row.instrument);
  } catch (error) {
    const reason = `${provenance}. The cancel FAILED (${describeThrownSafely(error)}); retrying when due`;
    await postFlattenReconcileAlert(input, row, reason, now);
    return reason;
  }
  await postFlattenReconcileAlert(input, row, provenance, now);
  return provenance;
}

/** Whether this row may cost another venue cancel and page — see `FLATTEN_CANCEL_RETRY_EVERY_MS`. A row never cancelled is always due. */
function cancelDue(row: UnresolvedFlattenSubmission, now: Date): boolean {
  if (row.cancel_attempted_at === null) return true;
  return now.getTime() - row.cancel_attempted_at.getTime() >= FLATTEN_CANCEL_RETRY_EVERY_MS;
}

/**
 * #1500: the never-confirmed row (`order_state` still null past the bound). Released ONLY on two pieces
 * of venue evidence together — `cancel` resolves (proves nothing alone about fill state) AND the venue's
 * position for the instrument still covers the store's held quantity (proves nothing filled) — never on age
 * alone, since a broken read endpoint is no reason to risk the #516/#1389 reverse-position over-sell.
 */
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

  await input.store.markFlattenCancelAttempted(row.idempotency_key, now);
  try {
    await input.broker.cancel(row.idempotency_key, row.instrument);
  } catch (error) {
    const reason = `${provenance}. The cancel FAILED (${describeThrownSafely(error)}); the row keeps blocking`;
    await postFlattenReconcileAlert(input, row, reason, now);
    return blocked(reason, 'never_confirmed_cancel_failed');
  }

  // Read AFTER the cancel resolves, never a snapshot from before it — a fill can land mid-cancel, and a
  // pre-cancel snapshot would release the row on coverage the venue no longer has (#516/#1389 over-sell)
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

/** Fire-and-forget, fully swallowed — the alert IS the fallback; see `FlattenReconcileAlertChannel`'s doc */
async function postFlattenReconcileAlert(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  reason: string,
  now: Date,
): Promise<void> {
  try {
    await input.flattenReconcileAlerts.postFlattenReconcileAlert({
      // #1331: this surface's own id, carrying the `control-arm-` prefix when the control arm is sweeping — the same id the send-failure log below uses
      trace_id: input.trace_id,
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      reason,
      observed_at: now,
    });
  } catch {
    // #573: traced locally — this IS the fallback failing, so without it an unresolved flatten's ambiguity
    // is invisible to a log reader. Fixed, self-authored message, never the channel's own error — a
    // transport failure can quote the request it failed on, which may carry a bot token
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

/**
 * The verdict on a row that has sat TERMINAL with unswept fills for the whole
 * `UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS` window. Released on the same evidence `cancelNeverConfirmedFlatten`
 * uses (the venue's book agrees with what the store holds), never on age — a disagreement means those
 * unbooked fills change what is held, and no venue number can say which lot they belong to, so it keeps blocking and pages.
 */
async function judgeTerminalUnsweptFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  order: NormalizedOrder,
  lastExamined: Date,
  storePositions: readonly OpenPosition[],
  storeState: OrderState,
  now: Date,
): Promise<ReconcileDivergence> {
  // Since the LAST look, not the first: this column re-arms on every look that doesn't release, so a row wedged for days reads one window, not the whole age (migration 0063)
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
    // Re-armed for the row that stays: the next look is a window away, not one 15s poll away (migration 0063)
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

/** Held quantity of one instrument's lots on one OPENING side, per lot, never netted across sides */
function sumHeld(
  lots: readonly OpenPosition[],
  side: OpenPosition['side'],
  heldByKey: ReadonlyMap<string, number>,
): number {
  return lots
    .filter((lot) => lot.side === side)
    .reduce((sum, lot) => sum + (heldByKey.get(lot.idempotency_key) ?? 0), 0);
}

/**
 * Does the venue's own book agree with everything the store thinks it holds for this instrument? The
 * single piece of evidence both #1500 release paths rest on — a shortfall means a replacement would
 * over-sell (#516/#1389), a surplus is refused too. Read per call, deliberately not hoisted: a snapshot
 * from before this sweep's cancels/timeouts may answer for a book that no longer exists.
 */
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
  // A venue reports ONE netted position, so it can corroborate the store's held quantity only while the
  // store's lots are all one way — `heldQuantitiesFor` refuses to pre-sum across sides for that reason
  // Keyed on the lots themselves, not their held sums: an over-closed lot carries a NEGATIVE held
  if (lots.some((lot) => lot.side === 'buy') && lots.some((lot) => lot.side === 'sell')) {
    return {
      covered: false,
      note:
        `the store holds ${longHeld} long and ${shortHeld} short ${row.instrument} across lots ` +
        'and the venue reports one NETTED position per instrument, so no venue number can ' +
        'corroborate both sides',
    };
  }
  // Both sides signed the same way before comparison: a venue book that crossed to the store's other side
  // (#516/#1389 over-sell) must not read as "still holds everything", which comparing magnitudes would say
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
  // A SURPLUS is not coverage either. The venue holding MORE than the store thinks means quantity the
  // store has no lot for — invisible to `findUnrecordedVenuePositions`, which compares presence only
  // An unbooked exit fill can hide inside it: no over-sell, but the released row's fills go missing from the journal, PnL and CGT record
  if (!coversQty(storeHeld, venueQty)) {
    return {
      covered: false,
      note:
        `the venue holds ${venueQty} ${row.instrument} against ${storeHeld} the store considers ` +
        'held — a surplus the store has no lot for, which an unbooked exit fill of its size ' +
        'would hide inside, so this book cannot corroborate the store',
    };
  }
  // Nothing held is coverage for the only question this answers — a replacement sized off the store
  // can't over-sell what the store doesn't hold — but the note must not claim the venue confirmed this flatten's fills
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

/**
 * The venue's own book. A failure is carried as a value rather than thrown — every consumer treats
 * "the venue could not be asked" as ignorance to report, never as evidence.
 */
async function readVenuePositions(input: ReconcileInput): Promise<VenuePositions> {
  try {
    return { positions: await input.broker.getOpenPositions() };
  } catch (error) {
    return { error: describeThrownSafely(error) };
  }
}

/**
 * The OTHER direction (#429): catches a store-invisible venue position (dead write-ahead, hand-placed
 * order, lost record) that Risk's exposure caps can't see. Nothing is written, deliberately — adopting
 * one would invent a `debate_id`/bracket/stop that never existed, inserting an unprotected position.
 * Reports and pages (#1550, throttled per instrument) instead; a venue read failure is logged, never paged, since it proves nothing.
 */
async function findUnrecordedVenuePositions(
  input: ReconcileInput,
  venue: VenuePositions,
  storePositions: readonly OpenPosition[],
  now: Date,
): Promise<ReconcileDivergence[]> {
  if ('error' in venue) {
    // Deliberately no `throttle.dueFor([])`: forgetting every standing episode on a read that proved nothing would re-page all of them the instant the endpoint recovered
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

  // Compared per INSTRUMENT, not per lot: a venue reports one netted position, so "the store has any open lot here" is the only comparison the shapes support
  const known = new Set(storePositions.map((position) => position.instrument));

  const unrecorded = venuePositions.filter((venuePosition) => !known.has(venuePosition.instrument));
  await pageUnrecordedVenuePositions(input, unrecorded, now);

  return unrecorded.map((venuePosition) => ({
    // No idempotency key exists — this lot was never written under one, which is precisely the finding
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

/**
 * #1550: the page behind `findUnrecordedVenuePositions`' divergence rows. Throttled per instrument and
 * never allowed to fail the reconcile pass — a transport that can't deliver must not cost the sweeps that already ran.
 */
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
        // This surface's own id, carrying the `control-arm-` prefix when the control arm is scanning
        trace_id: input.trace_id,
        instrument: venuePosition.instrument,
        qty: venuePosition.qty,
        side: venuePosition.side,
        observed_at: now,
      });
    } catch {
      // Fixed, self-authored message, never the channel's own error — same CREDENTIALS posture as above
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

/** Settle one lot against the venue. Null when store and broker agree. */
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
    // The adapter could not answer — not evidence of anything. Left exactly as it was and surfaced for
    // an operator, rather than guessed as "never placed" (hides real exposure) or "landed" (invents a state)
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'bracket',
      // Safe to surface verbatim ON CREDENTIALS: every adapter converts what its client threw into a
      // curated `BrokerError` (#297 H1). Not the same as "only a `BrokerError` reaches this catch" though
      // (#1262): some adapter code runs outside that wrapper, so the render stays guarded rather than trusted
      reason: describeThrownSafely(error),
    };
  }

  if (order === null) {
    // The venue authoritatively has no such order — marking it terminal frees the lot from the in-flight
    // set without resubmitting: a bracket can't be rebuilt from an `OpenPosition` (no entry price/TIF)
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

  // Broker is the tie-break authority, so its state is adopted wholesale — but only `order_state`/
  // `broker_order_ids`. `filled_size` stays at whatever the `Fill` rows say; `ingestFills()` rebuilds from those.
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

/**
 * Agreement is on state AND the venue's leg ids: a `pending` lot the venue acked carries ids the store
 * never recorded, and losing them would leave nothing to cancel the bracket by
 */
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
