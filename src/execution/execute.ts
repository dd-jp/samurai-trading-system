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
import type { OpenPosition, OrderIntent } from '../shared/index.js';
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
    // shared/types/records.ts). Delegated to its own function: validating
    // against the store, cancelling the held lot's bracket, journalling the
    // flatten and submitting it is enough steps that inlining them here
    // would bury the bracket path below in an unrelated branch. See
    // `executeExit` for what PR #516's review added on top of the original
    // #508 wiring (cancel-before-flatten, the store cross-check, and the
    // `flatten_submissions` journal) and why each exists.
    if (order.intent_type === 'exit') {
      return executeExit(this.input, order, idempotencyKey, now);
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

/**
 * The `exit` branch of `execute()` (#508, hardened by PR #516's review).
 * Four steps, each answering one thing the review found genuinely missing:
 *
 * 1. **Cross-check against the store** (review comment 3). `execute()` holds
 *    the store and is the last checkpoint before funds move, so it does not
 *    forward `order.size`/`order.side` to the venue purely on trust that
 *    `buildExitIntent` (trader/decide.ts) summed the held quantity and
 *    derived the closing side correctly. It refuses on any mismatch rather
 *    than clamping — a wrong-sized exit is a bug to surface, not to
 *    silently correct into something smaller/safer-looking.
 * 2. **Journal the attempt** (review comments 2+4) — write-ahead to
 *    `flatten_submissions` BEFORE any broker call, mirroring the bracket
 *    path's `writeAheadPosition`. An exit has no bracket and no
 *    `OpenPosition` to write ahead, so without this row a replay of the
 *    same decision sailed past `findByKey` every time, and a
 *    `submitFlatten` response lost to a timeout left no durable clientOrderId
 *    for #86's reconcile to resolve against.
 * 3. **Cancel the held lot's bracket before flattening** (review comment 1).
 *    `submitFlatten` is a plain, unrelated market order — it does not touch
 *    the held lot's stop/target legs (confirmed against the Alpaca adapter:
 *    `cancel()` is the only path that reaches `cancelOrder`; `submitFlatten`
 *    never does). Left alone, those legs stay live and working at the venue
 *    after the flatten fills, and the next one to fire does not "close"
 *    anything — the position is already flat, so it OPENS A REVERSE
 *    POSITION instead. Cancelling first removes that resting order
 *    entirely; the alternative order (flatten, then cancel) leaves a real
 *    window where a leg can fire into the now-flat position before the
 *    cancel lands. If a cancel fails, the flatten is refused outright: a
 *    market order sent while it is unknown whether the legs it was meant to
 *    clear are actually gone would defeat the whole point of cancelling
 *    first.
 * 4. **Submit, then resolve the journal row** — the original #508 shape.
 */
async function executeExit(
  input: ExecutionInput,
  order: OrderIntent,
  idempotencyKey: string,
  now: Date,
): Promise<ExecutionResult> {
  const { broker, store } = input;

  const heldLots = (await store.getOpenPositions()).filter(
    (lot) => lot.instrument === order.instrument,
  );
  const heldSize = heldLots.reduce((sum, lot) => sum + lot.filled_size, 0);
  const heldSide = heldLots[0]?.side;

  if (heldLots.length === 0 || heldSide === undefined) {
    return result('error', idempotencyKey, now, {
      reason: `exit intent for '${order.instrument}' but the store holds no open lot to close`,
    });
  }

  // The closing side is the OPPOSITE of what is held — same derivation
  // `buildExitIntent` uses, re-run here rather than trusted from the order.
  const expectedClosingSide = heldSide === 'buy' ? 'sell' : 'buy';
  if (order.side !== expectedClosingSide) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent side '${order.side}' does not match the closing side ` +
        `'${expectedClosingSide}' implied by the held lot(s)' side ('${heldSide}') for ` +
        `'${order.instrument}'`,
    });
  }

  // Exact equality, not a tolerance: `heldSize` is the SAME reduce over the
  // SAME `ORDER BY opened_at` query `buildExitIntent` used, so the two sums
  // are bit-identical unless a fill genuinely landed between decide-time and
  // here — which is precisely the drift that must be refused, not smoothed
  // over with an epsilon built for a different problem (ADR-0005's tolerance
  // in ingest-fills.ts absorbs float SUMMATION-ORDER noise across two
  // reconstructions of the same total; this is a check that the total
  // itself has not moved).
  if (order.size !== heldSize) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent size ${order.size} does not match the held quantity ${heldSize} ` +
        `for '${order.instrument}'`,
    });
  }

  // Write-ahead BEFORE any broker call — see the docstring above for why
  // this row exists at all. `writeAheadFlatten` throwing (a genuine store
  // failure, not the duplicate case — `findByKey` above already excludes
  // that) is deliberately NOT caught here: swallowing it would let the
  // cancel/flatten calls below proceed with no durable record behind them,
  // the exact failure `writeAheadPosition`'s catch in the bracket path above
  // guards against.
  await store.writeAheadFlatten({
    idempotency_key: idempotencyKey,
    instrument: order.instrument,
    asset_class: order.asset_class,
    side: order.side,
    size: order.size,
    submitted_at: now,
  });

  for (const lot of heldLots) {
    try {
      await broker.cancel(lot.idempotency_key, order.instrument);
    } catch (error) {
      // Provably never reached the broker at all — unlike a `submitFlatten`
      // failure below, there is no ambiguity to leave for reconcile, so the
      // row resolves to 'error' immediately rather than sitting at
      // 'submitting' for a sweep that would find nothing to adopt.
      const reason =
        `cancelling held lot '${lot.idempotency_key}' before the flatten failed, so the ` +
        `flatten was not sent: ${error instanceof Error ? error.message : String(error)}`;
      await store.resolveFlattenError(idempotencyKey, reason, now);
      return result('error', idempotencyKey, now, { reason });
    }
  }

  let ack: Awaited<ReturnType<typeof broker.submitFlatten>>;
  try {
    ack = await broker.submitFlatten(order.instrument, order.side, order.size, idempotencyKey);
  } catch (error) {
    // Genuinely ambiguous — the venue may have seen this before the response
    // was lost — so the row is left at 'submitting' rather than resolved to
    // 'error', exactly as the bracket path leaves its `pending` record on a
    // `submitBracket` failure: only the broker can settle this, via #86's
    // `reconcile()` calling `getOrder` against the clientOrderId this row
    // journalled. Automatic resolution is filed as follow-up, not built
    // here — this PR's job was making the row exist to resolve against.
    return result('error', idempotencyKey, now, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  await store.resolveFlattenSubmitted(
    idempotencyKey,
    { order_state: ack.order_state, broker_order_ids: ack.broker_order_ids },
    now,
  );

  return result('submitted', idempotencyKey, now, {
    order_state: ack.order_state,
    broker_order_ids: ack.broker_order_ids,
  });
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
