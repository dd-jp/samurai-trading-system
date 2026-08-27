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
import {
  heldQuantitiesFor,
  logCaughtFailure,
  type OpenPosition,
  type OrderIntent,
  totalHeldQuantity,
} from '../../shared/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { ingestFills } from './ingest-fills.js';
import { reconcile } from './reconcile.js';
import { sweepResidualProtection } from './residual-protection-sweep.js';
import { DuplicatePositionError } from './sqlite-shared-store.js';
import type {
  Execution,
  ExecutionInput,
  ExecutionResult,
  NativeBracketRequest,
  ReconcileReport,
  ResidualProtectionSweepResult,
  SharedStore,
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

  /**
   * Delegated whole, same as its siblings. The #549 sweep's standalone
   * surface — `reconcile()` above already includes a pass; this is what the
   * fill-sync loop calls on cadence (see `Execution.sweepResidualProtection`'s
   * doc for why both wirings exist).
   */
  async sweepResidualProtection(): Promise<ResidualProtectionSweepResult> {
    return sweepResidualProtection(this.input);
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
    //
    // #921: an exit is the one intent type that gets a SECOND chance here.
    // Entry/scale_in dedupe unconditionally — a replayed entry decision must
    // never re-submit under any key, fresh or otherwise, because the original
    // bracket (if it landed) is still exactly what was wanted. A mandatory
    // flatten is different: it is the flat-by-close guarantee, so a prior
    // attempt that provably never reached the broker (cancel-loop failure,
    // `resolveFlattenError`'s 'error' status) must not be allowed to stand in
    // for "the position is closed" forever. `resolveExitRetryKey` walks to a
    // fresh key ONLY over that provable case; every other case (no row, or a
    // 'submitting'/'submitted' row whose venue truth is unknown or already
    // succeeded) falls through to the same unconditional dedup entry/scale_in
    // gets, because retrying either of those risks the #516 double-flatten /
    // reverse-position hazard.
    if (await store.findByKey(idempotencyKey)) {
      if (order.intent_type !== 'exit') {
        return result('deduped', idempotencyKey, now, {
          reason: 'an order or fill already exists for this idempotency_key',
        });
      }
      const retryKey = await resolveExitRetryKey(store, idempotencyKey);
      if (retryKey === null) {
        return result('deduped', idempotencyKey, now, {
          reason: 'an order or fill already exists for this idempotency_key',
        });
      }
      return executeExit(this.input, order, retryKey, now);
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
 * Bounds how many fresh keys a single mandatory-flatten retry chain may burn
 * across the flatten window. `resolveExitRetryKey` only ever advances past a
 * PROVABLY-dead attempt (`isRetryableFlattenError`), so this is not a limit
 * on how many times the exit is allowed to genuinely fail — it exists so a
 * persistently failing cancel loop (e.g. the venue itself is unreachable)
 * cannot hammer it with a fresh clientOrderId every tick of the flatten
 * window forever. Once exhausted, `execute()` falls back to `deduped` — the
 * safe default for a mandatory exit that has demonstrably not been going
 * through — rather than retrying unbounded.
 */
const MAX_EXIT_RETRY_ATTEMPTS = 3;

/**
 * Finds a usable idempotency key for a retried exit, given `baseKey` — the
 * order's own deterministic key (`idempotency-key.ts`), unchanged across
 * retries of the same bar's mandatory flatten. Walks `baseKey`,
 * `${baseKey}:retry-1`, `${baseKey}:retry-2`, ... (mirrors the
 * `${clientOrderId}:rearm` convention `rearmProtectiveLegs` already uses in
 * the Alpaca adapter for "a fresh id derived from, but distinct from, the
 * original").
 *
 * A candidate is usable if it names NOTHING in the store yet, or names a
 * flatten row that is a RETRYABLE error (`isRetryableFlattenError`) — a
 * 'submitting'/'submitted' row at ANY candidate is not usable and stops the
 * walk immediately, because a genuinely ambiguous or already-succeeded
 * attempt must never be retried out from under (#516's reverse-position
 * hazard runs both directions: retrying over an unresolved or successful
 * attempt risks a double flatten just as surely as skipping the cancel loop
 * does). Bounded at `MAX_EXIT_RETRY_ATTEMPTS` so a persistently failing
 * cancel loop cannot hammer the venue every tick of the flatten window;
 * returns `null` once exhausted, and the caller falls back to `deduped`, the
 * safe default. Never throws, and never loops unbounded.
 */
async function resolveExitRetryKey(store: SharedStore, baseKey: string): Promise<string | null> {
  for (let attempt = 0; attempt <= MAX_EXIT_RETRY_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? baseKey : `${baseKey}:retry-${attempt}`;
    const exists = await store.findByKey(candidate);
    if (!exists) return candidate;
    const retryable = await store.isRetryableFlattenError(candidate);
    if (!retryable) return null;
    // else: candidate names a retryable error — loop tries the NEXT suffix,
    // since this exact candidate key already has a terminal row and must not
    // be written to twice.
  }
  return null;
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
 *    first. #867 kept that refusal and removed its SILENCE — see the cancel
 *    loop's own comment for what a `cancel()` throw does and does not
 *    guarantee, and for the lots this path now marks unprotected so the
 *    #549 sweep re-arms them.
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
  const heldSide = heldLots[0]?.side;

  if (heldLots.length === 0 || heldSide === undefined) {
    return result('error', idempotencyKey, now, {
      reason: `exit intent for '${order.instrument}' but the store holds no open lot to close`,
    });
  }

  // #568: what the VENUE still holds — `filled_size` minus the exit-leg fills
  // already recorded — not the lot's entry quantity, which no exit fill
  // reduces and which a partially-flattened (still open) lot therefore keeps
  // at its original value. The SAME derivation `buildExitIntent` sized this
  // order with, so the guard below compares two answers to one question.
  const perLotHeld = await heldQuantitiesFor(heldLots, (keys) => store.getExitFillSizes(keys));

  // Fail closed, per lot, BEFORE summing: more closed than ever opened on one
  // lot is the store's own record contradicting itself, and a negative there
  // would net against a positive on a sibling lot into a total that looks
  // plausible and is not. `execute()` is the last checkpoint before funds
  // move, so it refuses and names the lot rather than trading on the sum.
  //
  // A bare `< 0`, not ADR-0005's `coversQty` tolerance, and that is not an
  // oversight: a lot whose exit fills merely APPROACH its filled size is
  // marked `closed` by `ingestFills()` (`coversQty(exitQty, filledSize)`) and
  // so has already left `getOpenPositions()`. Every lot reaching this line
  // therefore holds a residual comfortably outside that epsilon, and a
  // negative here is a real contradiction rather than summation noise.
  const overExited = perLotHeld.find((lot) => lot.held < 0);
  if (overExited !== undefined) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent for '${order.instrument}' refused: lot '${overExited.idempotency_key}' ` +
        `records more closed quantity than it ever opened (held ${overExited.held})`,
    });
  }

  const heldSize = totalHeldQuantity(perLotHeld);

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

  // Exact equality, not a tolerance: `heldSize` is the SAME `heldQuantities`
  // derivation over the SAME `ORDER BY opened_at` query and the SAME
  // exit-fill sums `buildExitIntent` used (#568), so the two totals
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

  // #793: every exit intent carries `metadata.exit_reason` —
  // `buildFlattenExit` (trader/decide.ts) requires the argument, so its
  // absence here means SOME other path constructed an `intent_type: 'exit'`
  // order without going through it. That is a contract violation worth
  // refusing loudly, not defaulting past: a silently-guessed reason would
  // corrupt `flatten_submissions.exit_reason` and, downstream,
  // `closed_trades.close_reason` on the money path.
  if (order.metadata.exit_reason === undefined) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent for '${order.instrument}' carries no metadata.exit_reason — every exit ` +
        `intent must name one (ExitReason, shared/types/records.ts)`,
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
    // #793: threaded through to `closed_trades.close_reason` via
    // `flatten_submissions.exit_reason` — see `redistributeOneFlatten`.
    exit_reason: order.metadata.exit_reason,
    size: order.size,
    submitted_at: now,
    // Which lots this flatten closes AND what each of them holds, so
    // `ingestFills()` can attribute and SPLIT the fill without re-deriving
    // either from whatever is still open when it lands (migrations 0020 and
    // 0021 carry both arguments). `perLotHeld` is `heldLots` mapped
    // one-to-one, preserving `getOpenPositions()`'s `ORDER BY opened_at`,
    // which the split relies on to allocate a partial fill oldest-lot-first.
    //
    // A lot holding NOTHING — its entry fill has not landed — is still named.
    // The cancel loop below iterates `heldLots` regardless of this journal, so
    // its protective legs go either way; dropping it here would remove the
    // only thing that re-arms them (#525). Its share is then exactly zero.
    lot_held_quantities: perLotHeld,
  });

  // Lots this loop has ALREADY cancelled successfully, in order. Load-bearing
  // for the catch below (#867), which is the only thing that reads it.
  const cancelledLots: OpenPosition[] = [];
  for (const lot of heldLots) {
    try {
      await broker.cancel(lot.idempotency_key, order.instrument);
      cancelledLots.push(lot);
    } catch (error) {
      // WHAT IS GUARANTEED HERE (corrected by #867): no `submitFlatten` was
      // issued, so — unlike the `submitFlatten` failure below — no order
      // exists under this idempotency key for reconcile to adopt, and the
      // row resolves to 'error' immediately rather than sitting at
      // 'submitting' for a sweep that would find nothing.
      //
      // WHAT IS NOT GUARANTEED, and what this comment used to claim ("provably
      // never reached the broker at all"): that the broker was not reached, or
      // that the lots' protective legs survived. Two ways they may not have:
      // an EARLIER lot in this loop whose cancel returned successfully has
      // provably lost its stop and target, and even the FAILING lot's cancel
      // may have landed at the venue with only its response lost. Refusing
      // the flatten is still the right call — `cancel()` is ordered so that
      // its throw usually means nothing was destroyed (#867, see its doc), and
      // flattening while a protective leg may still be working is the #516
      // reverse-position hazard this whole cancel-first design exists to
      // prevent — but "refuse" must not also mean "say nothing".
      //
      // So the lots that are PROVABLY naked (cancel confirmed, flatten not
      // sent) get #549's durable marker, which is not a new mechanism: the
      // `sweepResidualProtection` pass the fill-sync loop already runs on
      // cadence picks the marker up, recomputes the residual from the fill
      // record (full held size here, since no exit fill landed) and re-arms
      // the lot's stop/target — and pages `ResidualExposureAlertChannel` if
      // it cannot. The failing lot itself is deliberately NOT marked: its
      // legs may still be live, and re-arming over a live bracket is
      // double protection, i.e. #516 from the other direction.
      const reason =
        `cancelling held lot '${lot.idempotency_key}' before the flatten failed, so the ` +
        `flatten was not sent: ${error instanceof Error ? error.message : String(error)}`;
      await markLotsUnprotected(input, cancelledLots, lot.idempotency_key, error, now);
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

/**
 * #867's escalation for a refused exit: record the LOCAL diagnostic and mark
 * every lot this exit already stripped of its protective legs before the
 * cancel loop failed, so the state is visible to something that acts on it
 * rather than only to a `flatten_submissions` row nobody watches.
 *
 * `markResidualUnprotected` is #549's existing durable marker, and the
 * consumer already runs: `sweepResidualProtection` (wired into the fill-sync
 * loop and into `reconcile()`) reads `getUnprotectedResidualLots()`,
 * recomputes the residual from the persisted fill record — for a lot this
 * path marks that is the FULL held quantity, since no exit fill has landed —
 * re-arms the stop/target through `broker.rearmProtectiveLegs`, and pages
 * `ResidualExposureAlertChannel` if it cannot. Nothing new is invented here;
 * this path just stops being the one hole that fed it nothing.
 *
 * Never throws, and never replaces the caller's `reason`: every write is
 * best-effort in the same shape as `bestEffortMarkerWrite` (ingest-fills.ts),
 * because losing recovery bookkeeping must not also lose the honest error the
 * caller is about to return.
 *
 * The broker's error text goes to the LOGGER only — `logCaughtFailure`
 * sanitizes it — never into an alert payload (`ResidualExposureAlert`'s
 * CREDENTIALS note: an Alpaca REST error quotes the failed request, headers
 * included).
 */
async function markLotsUnprotected(
  input: ExecutionInput,
  cancelledLots: readonly OpenPosition[],
  failedLotKey: string,
  error: unknown,
  now: Date,
): Promise<void> {
  logCaughtFailure(
    input.logger,
    {
      trace_id: input.trace_id,
      stage: 'execution',
      level: 'error',
      message:
        'executeExit: cancelling a held lot failed, so the flatten was refused — any lot ' +
        'listed in unprotected_lots had its cancel CONFIRMED before this failure, so it is ' +
        'now open with no protective legs and is being marked for the #549 sweep to re-arm. ' +
        "An empty list means nothing was confirmed cancelled. The failing lot's own legs " +
        'are of unknown state and are deliberately left unmarked (re-arming over a live ' +
        'bracket is double protection, #516 from the other direction).',
    },
    error,
    { failed_lot: failedLotKey, unprotected_lots: cancelledLots.map((lot) => lot.idempotency_key) },
  );

  for (const lot of cancelledLots) {
    try {
      await input.store.markResidualUnprotected(lot.idempotency_key, now);
    } catch (markError) {
      logCaughtFailure(
        input.logger,
        {
          trace_id: input.trace_id,
          stage: 'execution',
          level: 'error',
          message:
            'executeExit: markResidualUnprotected failed for a lot whose protective legs were ' +
            'already cancelled — the #549 sweep will not know to re-arm it, so this lot is ' +
            'open and unprotected with no automatic recovery behind it',
        },
        markError,
        { idempotency_key: lot.idempotency_key },
      );
    }
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
