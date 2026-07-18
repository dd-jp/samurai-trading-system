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
 */
import type { OpenPosition, OrderState } from '../shared/types.js';
import type { ExecutionInput, ReconcileDivergence, ReconcileReport } from './types.js';

/** The states a crash can strand: written ahead, or acked but not advanced. */
const IN_FLIGHT: readonly OrderState[] = ['pending', 'submitted'];

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

  return { checked: inFlight.length, corrected, divergences, timestamp: now };
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
      reason: error instanceof Error ? error.message : String(error),
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
