/**
 * Execution core — `execute()` (ticket #82) and the `ingestFills()` entry
 * point (#83). See docs/specs/execution-spec.md ("Module: Execution Core").
 *
 * The thin, mechanical tail of the pipeline: Verdict has already decided, so
 * this re-decides nothing. Dedupe → expand the abstract bracket → write-ahead
 * → submit → persist the ack → return. It records a submission; it does not
 * block until filled — the lot's lifecycle is advanced separately by
 * `ingestFills()`, which lives in its own module.
 */
import type { OpenPosition } from '../shared/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { ingestFills } from './ingest-fills.js';
import { reconcile } from './reconcile.js';
import { DuplicatePositionError } from './sqlite-shared-store.js';
import type {
  Execution,
  ExecutionInput,
  ExecutionResult,
  NativeBracketRequest,
  ReconcileReport,
} from './types.js';

export class ExecutionImpl implements Execution {
  constructor(private readonly input: ExecutionInput) {}

  /**
   * The second surface, delegated whole: the fill lifecycle shares only the
   * injected dependencies with `execute()`, so keeping it out of this class's
   * body keeps the two surfaces independently readable.
   */
  async ingestFills(): Promise<void> {
    return ingestFills(this.input);
  }

  /**
   * Delegated whole for the same reason as `ingestFills()`. Note what this
   * class does NOT do: nothing here calls `reconcile()` on construction. A
   * restart is the caller's event to recognise, not something a constructor
   * can infer, and reconciling implicitly would fire a broker sweep every
   * time anything built an Execution.
   */
  async reconcile(): Promise<ReconcileReport> {
    return reconcile(this.input);
  }

  async execute(verdict: VerdictDecision): Promise<ExecutionResult> {
    const { clock, broker, store } = this.input;
    const now = clock.now();

    // Acts only on a `go`. A no_go carries no order to place.
    if (verdict.status !== 'go' || verdict.order === null) {
      return result('error', verdict.idempotency_key, now, {
        reason: `Execution.execute requires a 'go' VerdictDecision with a non-null order (got '${verdict.status}')`,
      });
    }

    const order = verdict.order;
    const idempotencyKey = order.idempotency_key;

    // Dedup layer 1 (local): a key already in the store means this decision
    // was acted on before — a crash-restart or retry replaying the same bar.
    // Never reaches the broker. Layer 2 is the client order id below. Checked
    // ahead of the intent_type branch so entry, scale_in AND exit share one
    // gate, rather than the exit branch running its own copy of this check.
    if (await store.findByKey(idempotencyKey)) {
      return result('deduped', idempotencyKey, now, {
        reason: 'an order or fill already exists for this idempotency_key',
      });
    }

    // An exit closes existing lot(s) via submitFlatten (#429) rather than
    // opening a bracketed one, so it has neither a bracket to expand nor an
    // OpenPosition to write ahead — `OpenPosition.intent_type` deliberately
    // excludes 'exit' ("exits close a lot; they never create one",
    // shared/types/records.ts). `order.size` is already the HELD quantity:
    // `buildExitIntent` (trader/decide.ts) sums `filled_size` across the
    // instrument's open lots before this ever runs, so — unlike the bracket
    // path below — nothing here re-derives a size from a risk fraction.
    //
    // The gate above is a partial guard for this branch: nothing is ever
    // written to `open_positions` under an exit's idempotency_key (by
    // design, per the paragraph above), so a genuine replay of the SAME exit
    // decision does not find a row here and reaches the broker again. What
    // makes that safe rather than merely unguarded is dedup layer 2 —
    // `submitFlatten`'s contract requires the venue to treat a repeated
    // `clientOrderId` as a no-op (types/broker.ts), the same layer that
    // backstops the bracket path's check-then-act race below.
    //
    // Known gap, not this ticket's: the flatten's own fill carries THIS
    // call's idempotency_key as its `client_order_id`, but `ingestFills()`
    // attributes fills to a lot by matching that lot's OWN idempotency_key
    // (ingest-fills.ts) — the held lot(s) this flatten closes were opened
    // under different keys, so its fill does not (yet) close them through
    // that path. The held lot's own bracket legs (stop/target) still close
    // it venue-side in the meantime; wiring the flatten's fill back to the
    // lot(s) it closes is follow-up work, not silently solved here.
    if (order.intent_type === 'exit') {
      let ack: Awaited<ReturnType<typeof broker.submitFlatten>>;
      try {
        ack = await broker.submitFlatten(order.instrument, order.side, order.size, idempotencyKey);
      } catch (error) {
        // Nothing was written above, so — unlike the bracket path's
        // broker-call failure — there is no `pending` record to leave
        // behind for #86 to reconcile. `order_state: null` is the honest
        // report: this call wrote nothing and so has no state of its own.
        return result('error', idempotencyKey, now, {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return result('submitted', idempotencyKey, now, {
        order_state: ack.order_state,
        broker_order_ids: ack.broker_order_ids,
      });
    }

    const bracket: NativeBracketRequest = {
      client_order_id: idempotencyKey,
      instrument: order.instrument,
      asset_class: order.asset_class,
      side: order.side,
      size: order.size,
      entry: order.entry,
      stop: order.stop,
      target: order.target,
      time_in_force: order.time_in_force,
    };

    const position: OpenPosition = {
      idempotency_key: idempotencyKey,
      debate_id: order.metadata.debate_id,
      instrument: order.instrument,
      asset_class: order.asset_class,
      side: order.side,
      intent_type: order.intent_type,
      requested_size: order.size,
      filled_size: 0,
      avg_entry_price: 0,
      stop: order.stop,
      target: order.target,
      order_state: 'pending',
      broker_order_ids: [],
      opened_at: now,
      decision_timestamp: order.decision_timestamp,
      conviction: order.metadata.conviction,
      converged: order.metadata.converged,
    };

    // Write-ahead: `pending` is durable BEFORE the broker call, so a crash in
    // the gap leaves a record to reconcile against the broker (#86) instead
    // of an invisible order that a restart would submit a second time.
    //
    // The `findByKey` gate above is check-then-act, so two callers replaying
    // the same decision can both pass it before either has written. The
    // primary key is what actually settles that race — and it settles it in
    // the store, meaning the loser learns it lost by catching this. Reporting
    // that as `error` would be wrong twice over: nothing failed, and a caller
    // that retries on error would keep re-losing the same race. Only the
    // typed duplicate is treated as dedup; every other store failure means
    // the write-ahead did NOT happen, and swallowing it would let the broker
    // call proceed with no durable record behind it.
    try {
      await store.writeAheadPosition(position);
    } catch (error) {
      if (error instanceof DuplicatePositionError) {
        return result('deduped', idempotencyKey, now, {
          reason: 'an order or fill already exists for this idempotency_key',
        });
      }
      throw error;
    }

    let ack: Awaited<ReturnType<typeof broker.submitBracket>>;
    try {
      ack = await broker.submitBracket(bracket);
    } catch (error) {
      // The `pending` record deliberately survives: whether the bracket
      // landed is unknown here, and only the broker can settle that. #86's
      // reconciliation adopts broker truth. Marking it terminal on the way
      // out would be a guess, and the losing guess double-submits.
      return result('error', idempotencyKey, now, {
        order_state: 'pending',
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    await store.updatePositionState(idempotencyKey, {
      order_state: ack.order_state,
      broker_order_ids: ack.broker_order_ids,
    });

    return result('submitted', idempotencyKey, now, {
      order_state: ack.order_state,
      broker_order_ids: ack.broker_order_ids,
    });
  }
}

function result(
  status: ExecutionResult['status'],
  idempotencyKey: string,
  now: Date,
  overrides: Partial<Omit<ExecutionResult, 'status' | 'idempotency_key' | 'timestamp'>> = {},
): ExecutionResult {
  return {
    status,
    idempotency_key: idempotencyKey,
    broker_order_ids: null,
    // Defaults suit the paths that wrote nothing; callers that did reach the
    // store or the broker override with what actually happened.
    order_state: null,
    reason: null,
    timestamp: now,
    ...overrides,
  };
}
