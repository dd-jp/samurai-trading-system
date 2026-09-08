/**
 * Execution's crash-restart surface — `reconcile()` (ticket #86). See
 * docs/specs/execution-spec.md ("Module: Idempotency & Crash-Restart").
 *
 * `execute()` writes the lot `pending` BEFORE calling the broker, so a crash
 * in that gap leaves a record whose truth only the venue knows: the bracket
 * may have landed, or may never have been seen. This is where that ambiguity
 * is settled, on startup, with the broker as tie-break authority — adopt what
 * the venue says, or mark the lot `rejected` where the venue authoritatively
 * never received it.
 *
 * What actually prevents the post-crash double-submit is the write-ahead
 * itself: whichever way a lot is settled here, exactly one record survives
 * under the idempotency key, so `execute()`'s `findByKey` gate turns any
 * replay of the same decision into a `deduped` that never reaches the broker.
 * Reconcile's job is to stop that surviving record from being a lie.
 *
 * Scope is the in-flight states only (`pending`/`submitted`), per the ticket.
 * A `partially_filled`/`filled` lot is `ingestFills()`'s: its `filled_size`
 * and `avg_entry_price` are reconstructed from the persisted `Fill` rows, and
 * reconcile overwriting them from a venue order summary would fight that
 * reconstruction. The two surfaces divide cleanly — reconcile owns submit
 * ambiguity, `ingestFills()` owns fill-driven advance — so a startup runs
 * reconcile first, then `ingestFills()` to pick up whatever filled while the
 * process was down.
 *
 * ## The flatten-journal sweep (#519, #526)
 *
 * `executeExit` (execute.ts) journals a flatten to `flatten_submissions`
 * write-ahead, the same way the bracket path write-aheads to `open_positions`
 * — but nothing swept that journal: a flatten stuck at `'submitting'` (the
 * venue may have seen it; the ack response was lost) sat there forever, and
 * even an ACKED flatten (`'submitted'`) was only ever polled for fills by
 * `AlpacaBrokerAdapter.flattens`, a process-local map a restart empties —
 * losing the fill, the lot's round-trip to `closed`, and its `ClosedTrade`
 * with it (#526's own finding).
 *
 * `resolveUnresolvedFlattens` below closes both: it reads
 * `SharedStore.getUnresolvedFlattens()` — bounded so the sweep does not
 * re-poll the venue for a flatten that finished closing its lot(s) long ago,
 * see migration 0023 — and asks the venue about each via
 * `BrokerAdapter.resumeFlatten`, whose side effect (re-populating a live
 * adapter's `flattens` map) is what makes the NEXT `fetchNewFills` sweep find
 * the order again after a restart. Symmetric to `reconcileLot` below in
 * every way that matters: the venue is the tie-break authority, ignorance is
 * never treated as absence, and every settled row updates the journal exactly
 * once.
 *
 * `ReconcileDivergence`/`ReconcileReport` are WIDENED to also carry a
 * flatten's outcome rather than gaining a sibling type — see
 * `ReconcileDivergence`'s own doc (types/execution.ts) for why.
 *
 * ## The terminal-row sweep (#1088)
 *
 * `getOpenPositions()` already excludes every terminal `open_positions` row
 * from every live read (crash recovery, exposure sizing, the dashboard), so
 * a `rejected`/`cancelled`/`expired` row sitting in the table is inert — but
 * before #1088 nothing ever deleted one, so the table grew without bound
 * (observed: 10 terminal rows to 1 live row). `sweepTerminalPositions`
 * (`SqliteExecutionStore`) is the fix: called unconditionally at the end of
 * every `reconcile()` pass, which — like the flatten and residual sweeps
 * above — gives it both of `reconcile()`'s existing production call sites
 * (startup, and the periodic poll per #921) for free, live and control arm
 * alike (`control-arm-wiring.ts` builds both arms' `reconcile()` off this
 * same function). See `sqlite-shared-store.ts`'s "row lifecycle" doc for the
 * full lifecycle and why `closed` rows are deliberately never swept.
 *
 * `TERMINAL_SWEEP_AGE_MS` below is the age gate: `sweepTerminalPositions`
 * only deletes a row once its `decision_timestamp` is this old. The reason
 * is idempotency-key reuse — `idempotency_key` hashes
 * `(instrument, bar, side, arm)` (`computeIdempotencyKey`), not `debate_id`,
 * specifically so a crash-restart replay of the SAME bar coordinate reuses
 * the SAME key and dedupes against the row `execute()` already wrote for it
 * (`findByKey`). Deleting a terminal row the moment it turns terminal would
 * free that key for reuse while a same-bar replay is still plausible; fixed
 * at 24h — 24x `DEBATE_BAR_TIMEFRAME_MS` (the bar grid a replay's coordinate
 * is measured against, debate-log-store.ts), comfortably past any realistic
 * crash-recovery gap.
 */

import type { OpenPosition, OrderState } from '../../shared/index.js';
import { describeThrownSafely, safeLog } from '../../shared/index.js';
import { sweepResidualProtection } from './residual-protection-sweep.js';
import type {
  ExecutionInput,
  ReconcileDivergence,
  ReconcileReport,
  UnresolvedFlattenSubmission,
} from './types.js';

/** The states a crash can strand: written ahead, or acked but not advanced. */
const IN_FLIGHT: readonly OrderState[] = ['pending', 'submitted'];

/**
 * #1088: how old a terminal, size-0 `open_positions` row's
 * `decision_timestamp` (the original write-ahead time — there is no
 * separate terminal-transition timestamp to anchor on) must be before
 * `sweepTerminalPositions` deletes it. See this file's "terminal-row sweep"
 * doc above for the idempotency-key-reuse-safety reasoning behind the value.
 */
export const TERMINAL_SWEEP_AGE_MS = 24 * 60 * 60 * 1_000;

export async function reconcile(input: ExecutionInput): Promise<ReconcileReport> {
  const { clock, store } = input;
  const now = clock.now();

  // `getOpenPositions()` is every non-terminal lot; the in-flight ones are
  // the subset a crash can have left disagreeing with the venue.
  const positions = await store.getOpenPositions();
  const inFlight = positions.filter((position) => IN_FLIGHT.includes(position.order_state));

  const divergences: ReconcileDivergence[] = [];
  let corrected = 0;

  for (const position of inFlight) {
    const divergence = await reconcileLot(input, position);
    if (divergence === null) continue;

    divergences.push(divergence);
    // `undetermined` deliberately wrote nothing, so it is not a correction.
    if (divergence.action !== 'undetermined') corrected += 1;
  }

  // #519/#526 — see the file doc's "flatten-journal sweep" section.
  const unresolvedFlattens = await store.getUnresolvedFlattens();
  for (const row of unresolvedFlattens) {
    const divergence = await reconcileFlatten(input, row, now);
    divergences.push(divergence);
    if (divergence.action !== 'undetermined') corrected += 1;
  }

  // #549 — the residual-protection sweep (residual-protection-sweep.ts):
  // every lot still durably marked "partial-flatten residual observed,
  // protection not confirmed" gets its re-arm retried idempotently, or its
  // escalation raised. AFTER the flatten sweep above, deliberately: on the
  // crypto path `resumeFlatten`'s side effect is what re-populates the
  // adapter's process-local worklists a restart emptied, the same ordering
  // reason `runStartupReconcile` runs before the first `ingestFills()`.
  // Symmetric to the flatten sweep in the report too — its markers count in
  // `checked`, its resolutions in `corrected`.
  const residualSweep = await sweepResidualProtection(input);
  for (const divergence of residualSweep.divergences) {
    divergences.push(divergence);
    if (divergence.action !== 'undetermined') corrected += 1;
  }

  divergences.push(...(await findUnrecordedVenuePositions(input, positions)));

  // #1088 — see the file doc's "terminal-row sweep" section. Unconditional:
  // every pass ages out whatever has crossed the cutoff since the last one,
  // live and control arm alike.
  const cutoff = new Date(now.getTime() - TERMINAL_SWEEP_AGE_MS);
  const swept = await store.sweepTerminalPositions(cutoff);

  return {
    checked: inFlight.length + unresolvedFlattens.length + residualSweep.checked,
    corrected,
    divergences,
    swept,
    timestamp: now,
  };
}

/**
 * Settle one `flatten_submissions` row against the venue — the flatten
 * counterpart of `reconcileLot` below, called for every row
 * `SharedStore.getUnresolvedFlattens()` names. Always returns a divergence
 * (unlike `reconcileLot`, which returns `null` on agreement): every row this
 * function is handed is, by construction, one the store does not yet
 * consider settled, so there is always something to report — the flatten
 * equivalent of `reconcileLot` never being called for an already-terminal
 * lot in the first place.
 */
async function reconcileFlatten(
  input: ExecutionInput,
  row: UnresolvedFlattenSubmission,
  now: Date,
): Promise<ReconcileDivergence> {
  const { broker, store } = input;
  // `'submitting'` maps onto `'pending'` — the same "written ahead, not yet
  // confirmed" meaning that value already carries for a bracket's write-ahead
  // (see `ReconcileDivergence`'s widen doc, types/execution.ts).
  const storeState: OrderState = row.status === 'submitting' ? 'pending' : 'submitted';

  let order: Awaited<ReturnType<typeof broker.resumeFlatten>>;
  try {
    order = await broker.resumeFlatten(row.idempotency_key, row.instrument);
  } catch (error) {
    // Ignorance, not evidence — `reconcileLot`'s own reasoning applies
    // unchanged: the adapter could not answer, and treating that as "never
    // placed" would mark a live, possibly-filled flatten as never having
    // reached the venue. Left exactly as it was, and escalated: unlike a
    // bracket's `pending` write-ahead, an unresolved flatten is a lot stuck
    // in genuine ambiguity about whether it is still held, which is
    // paging-worthy on its own (#519) — see `FlattenReconcileAlertChannel`'s
    // doc for why this is not treated as a background diagnostic.
    const reason = describeThrownSafely(error);
    await postFlattenReconcileAlert(input, row, reason, now);
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: null,
      action: 'undetermined',
      reason,
    };
  }

  if (order === null) {
    if (row.status === 'submitting') {
      // The venue authoritatively has no such order: this write-ahead never
      // landed, the same settlement `reconcileLot` makes for a bracket's
      // `pending` record. Unlike that path there is no lot to mark
      // `rejected` — a flatten writes no `OpenPosition` — so the JOURNAL row
      // itself is what carries the terminal answer.
      const reason =
        'reconcile: broker has no order under this client_order_id — the write-ahead never landed';
      await store.resolveFlattenError(row.idempotency_key, reason, now);
      return {
        idempotency_key: row.idempotency_key,
        instrument: row.instrument,
        store_state: storeState,
        broker_state: null,
        action: 'rejected',
        reason,
      };
    }

    // A row already at `'submitted'` carries `broker_order_ids` the venue
    // gave it once — the venue definitely acked this flatten. A LATER null
    // from `resumeFlatten` is not proof the write-ahead never landed (it
    // provably did); it is the adapter unable to reconfirm an order it
    // already told us about (aged out of a lookup window, for instance).
    // Treating this as `'rejected'` would write a false record — "the
    // write-ahead never landed" — about a flatten that may have filled and
    // closed a lot. Left untouched and escalated, the same as a genuine
    // `resumeFlatten` throw just above.
    const reason =
      `flatten '${row.idempotency_key}' was previously acked by the broker (a durable ` +
      "'submitted' journal row exists) but the venue now reports no such order — leaving the " +
      'journal untouched; check the venue by hand';
    await postFlattenReconcileAlert(input, row, reason, now);
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: null,
      action: 'undetermined',
      reason,
    };
  }

  // The venue named an order. `resumeFlatten`'s side effect already
  // re-populated the adapter's own flatten-sweep worklist; what is left is
  // updating the journal so this row eventually stops being "unresolved".
  if (row.status === 'submitting') {
    // The genuine first resolution of this write-ahead's ambiguity —
    // `resolveFlattenSubmitted` is the right write here (sets `resolved_at`,
    // the same as it does when `executeExit` itself calls it on a clean ack).
    await store.resolveFlattenSubmitted(
      row.idempotency_key,
      { order_state: order.order_state, broker_order_ids: order.broker_order_ids },
      now,
    );
  } else {
    // Already resolved once; this is a FRESHER answer to a question already
    // settled, not a new ambiguity — `recordFlattenOrderStateObserved`
    // leaves `resolved_at`/`status` alone (see its own doc, types/store.ts).
    await store.recordFlattenOrderStateObserved(row.idempotency_key, {
      order_state: order.order_state,
      broker_order_ids: order.broker_order_ids,
    });
  }

  return {
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: storeState,
    broker_state: order.order_state,
    action: 'adopted',
    reason: `flatten journal said '${row.status}'; broker reports '${order.order_state}'`,
  };
}

/** Fire-and-forget, fully swallowed — the alert IS the fallback; see `FlattenReconcileAlertChannel`'s doc. */
async function postFlattenReconcileAlert(
  input: ExecutionInput,
  row: UnresolvedFlattenSubmission,
  reason: string,
  now: Date,
): Promise<void> {
  try {
    await input.flattenReconcileAlerts.postFlattenReconcileAlert({
      // #1331: this surface's own id, which carries the `control-arm-` prefix
      // when the control arm is the one sweeping — see
      // `FlattenReconcileAlert.trace_id` for what makes that hold. The same id
      // the send-failure log below uses, so a failed alert and the alert it
      // failed to deliver land under one trace.
      trace_id: input.trace_id,
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      reason,
      observed_at: now,
    });
  } catch {
    // The reconcile pass this alert reports on already completed — nothing
    // to undo here, see `ResidualExposureAlert`'s doc for the same posture.
    // #573: traced locally now — this IS the fallback failing, so without
    // this an unresolved flatten's genuine ambiguity is invisible even to
    // someone reading the log. Fixed, self-authored message, never the
    // channel's own error — the same CREDENTIALS posture
    // `alertResidualExposure`'s own channel-failure catch takes
    // (ingest-fills.ts): a Telegram/Discord transport failure quotes the
    // request it failed on, which can carry a bot token.
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
 * The OTHER direction (#429). Everything above walks the STORE's lots and asks
 * the venue about each, which can only ever find a lot the store knows about.
 * execution-spec.md's requirement is symmetric — *"store shows a position the
 * broker doesn't, **or vice-versa**"* — and the second half had no surface
 * until `BrokerAdapter.getOpenPositions` existed.
 *
 * What it catches: a write-ahead that died before persisting, an order placed
 * by hand, or a lot whose store record was lost. Such a position is invisible
 * to Risk's exposure caps indefinitely, because Risk computes exposure from
 * the store.
 *
 * **Nothing is written, deliberately.** An `OpenPosition` carries a
 * `debate_id`, an entry bracket, a conviction and a stop; a venue position
 * carries none of them. Adopting one would mean inventing all of it, and would
 * insert an UNPROTECTED position — no stop, no target — into a system whose
 * every other lot has a bracket, where `ingestFills` would then try to size
 * protective legs that do not exist. Reporting it is the honest action; what to
 * do about it is the operator's call.
 *
 * A venue that cannot answer is reported, not fatal: the store-side pass has
 * already done real work by this point, and losing it because a positions
 * endpoint was down would be the worse outcome.
 */
async function findUnrecordedVenuePositions(
  input: ExecutionInput,
  storePositions: readonly OpenPosition[],
): Promise<ReconcileDivergence[]> {
  const { broker } = input;

  let venuePositions: Awaited<ReturnType<typeof broker.getOpenPositions>>;
  try {
    venuePositions = await broker.getOpenPositions();
  } catch (error) {
    return [
      {
        idempotency_key: '',
        instrument: '',
        store_state: 'pending',
        broker_state: null,
        action: 'undetermined',
        reason:
          'broker.getOpenPositions failed, so a position the venue holds and the store does ' +
          `not would not have been seen this pass: ${describeThrownSafely(error)}`,
      },
    ];
  }

  // Compared per INSTRUMENT, not per lot: a venue reports one netted position
  // where the store may hold several lots, so "the store has any open lot for
  // this instrument" is the only comparison the two shapes support.
  const known = new Set(storePositions.map((position) => position.instrument));

  return venuePositions
    .filter((venuePosition) => !known.has(venuePosition.instrument))
    .map((venuePosition) => ({
      // No idempotency key exists — this lot was never written under one, which
      // is precisely the finding.
      idempotency_key: '',
      instrument: venuePosition.instrument,
      store_state: 'pending' as const,
      broker_state: null,
      action: 'unrecorded' as const,
      reason:
        `venue holds ${venuePosition.qty} ${venuePosition.instrument} (${venuePosition.side}) ` +
        'with no open lot in the store — this exposure is invisible to the Risk Manager. ' +
        'Nothing was written: adopting it would mean inventing the bracket, stop and debate_id ' +
        'it has none of. Reconcile it by hand.',
    }));
}

/** Settle one lot against the venue. Null when store and broker agree. */
async function reconcileLot(
  input: ExecutionInput,
  position: OpenPosition,
): Promise<ReconcileDivergence | null> {
  const { broker, store } = input;
  const key = position.idempotency_key;

  let order: Awaited<ReturnType<typeof broker.getOrder>>;
  try {
    order = await broker.getOrder(key, position.instrument);
  } catch (error) {
    // The adapter could not answer — which is NOT evidence of anything. The
    // record is left exactly as it was: treating ignorance as "never placed"
    // would mark a live, possibly filled position `rejected` and hide real
    // exposure from Risk, and treating it as "landed" invents a state the
    // venue never reported. It surfaces for an operator instead.
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      // Safe to surface verbatim ON CREDENTIALS: #297's H1 makes every adapter
      // convert what its client threw into a `BrokerError` built only from
      // curated fields. Same posture and same expression as `execute()`'s
      // submit-failure branch.
      //
      // That is NOT the same as "only a `BrokerError` reaches this catch", and
      // #1262 checked: `AlpacaBrokerAdapter.getOrder` does real work OUTSIDE
      // the `call()` wrapper H1 lives in — `state.recordBracketOrderIds`,
      // `normalizeOrder`, the emulation lookups — whose throws never pass
      // through `sanitizeBrokerError` at all; and `sanitizeBrokerError` itself
      // reads `status`/`code`/`venueMessage` off the raw thrown value, so a
      // hostile getter throws from inside `call`'s own catch and delivers
      // whatever IT threw onward. So the render is guarded rather than trusted
      // — a throw here would escape the catch that exists to report the
      // adapter's silence and would leave the lot with no divergence at all.
      reason: describeThrownSafely(error),
    };
  }

  if (order === null) {
    // The venue authoritatively has no such order: the write-ahead never
    // landed. Marking it terminal is what frees the lot from the in-flight
    // set without ever re-submitting it — the bracket cannot be rebuilt from
    // an `OpenPosition` anyway (it carries no entry price or time-in-force),
    // so a resubmit here would be fabricating an order, not recovering one.
    await store.updatePositionState(key, { order_state: 'rejected', broker_order_ids: [] });

    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'rejected',
      reason: 'broker has no order under this client_order_id — the write-ahead never landed',
    };
  }

  if (agrees(position, order)) return null;

  // Broker is the tie-break authority, so its state is adopted wholesale.
  // Only `order_state`/`broker_order_ids` though: `filled_size` stays at
  // whatever the `Fill` rows say, because those rows are the record and
  // `ingestFills()` rebuilds from them. A lot adopted as `filled` here is
  // still non-terminal, so it stays in `getOpenPositions()` and the very next
  // `ingestFills()` supplies the quantity and price to match.
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
    reason: `store said '${position.order_state}', broker says '${order.order_state}'`,
  };
}

/**
 * Agreement is on state AND the venue's leg ids: a lot the store believes is
 * `pending` but which the venue acked carries ids the store never recorded,
 * and losing them would leave nothing to cancel the bracket by.
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
