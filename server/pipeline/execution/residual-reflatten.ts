/**
 * #1214's recorded remedy for a residual whose lot can never be re-armed —
 * the venue cannot express entry-less legs at all (Saxo), or the lot has spent
 * every re-arm wire id the venue will grant it (Alpaca, #1346): CLOSE it, do
 * not protect it.
 *
 * David's decision (2026-09-08, option 2) turns on a fact about where this
 * code runs: both `maybeRearmResidual` triggers are gated on
 * `ingestedExit || flattenTargetedThisPoll`, and `executeExit` cancels every
 * held lot's protective legs BEFORE it submits the flatten — so a residual
 * reaching this module belongs to a lot the system has already decided to be
 * rid of, whose legs are already gone. Arming a fresh stop and target on it is
 * contradictory for an intraday, flat-by-close product (ADR-0014); finishing
 * the flatten is the action that matches the intent.
 *
 * The four constraints the decision fixed, and where each one lives below:
 *
 * - **Bounded.** `MAX_RESIDUAL_REFLATTEN_ATTEMPTS`, walked over durable keys
 *   (`resolveReflattenKey`) — an unbounded re-flatten is a market-order loop.
 * - **Session-aware.** `sessionCalendars[asset_class].isOpen(now)`, the same
 *   calendar pair the daily flatten resolves its window against
 *   (`withinFlattenWindow`, trader/decide.ts).
 * - **Does not fight the daily flatten cadence.** Any unresolved
 *   `flatten_submissions` row on the instrument stands the attempt down — and
 *   symmetrically, `writeAheadFlatten` refuses the daily flatten while one of
 *   THIS path's rows is unresolved. See "One submitter at a time" below.
 * - **Never throws.** Every failure is swallowed and reported, exactly as
 *   `maybeRearmResidual`'s docblock requires of whatever replaces the re-arm
 *   call.
 *
 * ## Why not `executeExit`
 *
 * It is the wrong shape twice over: it cancels the protective legs of every
 * held lot on the instrument (pointless here — the residual's are already
 * gone, and a SIBLING lot's are live and must stay so), and it refuses any
 * order whose size is not the whole instrument's held quantity. A residual is
 * one lot's remainder, which is exactly the case that guard rejects.
 *
 * ## One submitter at a time
 *
 * The collision the decision's third constraint forbids is two live market
 * orders on one held quantity, and what prevents it is `writeAheadFlatten`
 * itself: it refuses, atomically with the insert, any flatten whose instrument
 * already has an unresolved row (see its `SharedStore` doc). That holds in BOTH
 * orderings — this path over a daily flatten, and `executeExit` over one of
 * these — which a check made by either caller before calling cannot, since they
 * run on independent timers with a window between the read and the write.
 *
 * The `getUnresolvedFlattens()` read below is therefore advisory: it turns a
 * refusal into a named skip and a log line instead of a caught throw, and it
 * lets the key walk treat any existing candidate as settled. It is not what
 * makes the invariant true.
 *
 * This is why a #867-shaped lot — full held quantity, no exit fill, marked by
 * `markLotsUnprotected` after `executeExit` cancelled its legs and then refused
 * the flatten — IS re-flattened here. An earlier version of this module stood
 * those down on `exitQty === 0`, reasoning that `execute.ts`'s
 * `resolveExitRetryKey` chain still owned them; that inference was wrong twice.
 * `exitQty` records whether any exit fill has landed, not who owns the lot's
 * closure, and the retry chain hangs off the ORDER's per-bar key, so nothing
 * derives lot-to-chain ownership from it. A lot whose legs are already gone and
 * whose flatten was refused is exactly the naked residual #1214 says to close.
 */

import type { OpenPosition } from '../../shared/index.js';
import { describeThrownSafely, logCaughtFailure, safeLog } from '../../shared/index.js';
import { UnresolvedFlattenForInstrumentError } from './sqlite-shared-store.js';
import type { ResidualReflattenInput } from './types.js';

/**
 * How many market orders this path may ever spend on one lot's residual.
 *
 * Mirrors `MAX_EXIT_RETRY_ATTEMPTS` (execute.ts) in both value and reasoning:
 * the walk only ever advances past an attempt that is already RESOLVED (an
 * `'error'` row, or a `'submitted'` one whose fills have been swept), so this
 * is not a limit on how often the residual may legitimately fail to close —
 * it is the ceiling that stops a residual the venue keeps refusing from
 * buying a fresh market order on every sweep pass, forever. Once exhausted
 * the lot falls back to the #525 page and this path stops trying, which is
 * the decision's own stated fallback.
 */
export const MAX_RESIDUAL_REFLATTEN_ATTEMPTS = 3;

/** Why an attempt was not made — a bare code for the log payload and the sweep's divergence reason. */
export type ResidualReflattenSkipReason =
  /** The venue is shut — a market order must not be fired into it. */
  | 'venue_shut'
  /** The calendar could not answer, so "is the venue open" is unknown. Fail closed. */
  | 'session_unknown'
  /** Someone ELSE's flatten on this instrument is still in flight — the daily cadence's. */
  | 'flatten_in_flight'
  /**
   * THIS lot's own earlier re-flatten is still working at the venue. Distinct
   * from `flatten_in_flight` because the caller must not page for it: the
   * residual is being closed, by an order this path itself sent.
   */
  | 'own_reflatten_in_flight'
  /** The journal could not be read, so neither of the two gates above could be evaluated. */
  | 'journal_read_failed'
  /** `MAX_RESIDUAL_REFLATTEN_ATTEMPTS` already spent on this lot. */
  | 'attempts_exhausted';

export type ResidualReflattenOutcome =
  | { kind: 'submitted'; idempotency_key: string; qty: number }
  | { kind: 'skipped'; reason: ResidualReflattenSkipReason; detail: string }
  | { kind: 'failed'; detail: string };

/**
 * Submits a market order closing `residual` on `position`, or explains why it
 * did not. NEVER THROWS — `maybeRearmResidual`'s contract, inherited whole:
 * this runs inside `ingestFills`' per-lot loop and inside the #549 sweep, and
 * an escape here would abort every other lot's processing in the same pass.
 *
 * The caller decides what to do with the outcome; the only thing this returns
 * that suppresses the #525 page is `submitted`, and only until the attempt
 * budget runs out.
 */
export async function reflattenResidual(
  input: ResidualReflattenInput,
  position: OpenPosition,
  residual: number,
  now: Date,
): Promise<ResidualReflattenOutcome> {
  const { store, broker } = input;
  const lotKey = position.idempotency_key;

  // Calendar lookup INSIDE the try deliberately: a composition root that
  // handed over a partial map makes this a TypeError rather than a silent
  // `undefined.isOpen`, and both implementations' `isOpen` can throw outright
  // when they cannot answer (trading-calendar.ts). Either way the answer to
  // "is the venue open" is unknown, and firing a market order on an unknown
  // session is the one thing the decision's second constraint forbids.
  let open: boolean;
  try {
    open = input.sessionCalendars[position.asset_class].isOpen(now);
  } catch (error) {
    return skip(
      input,
      position,
      residual,
      'session_unknown',
      `the ${position.asset_class} calendar could not answer whether the venue is open: ` +
        describeThrownSafely(error),
    );
  }
  if (!open) {
    return skip(
      input,
      position,
      residual,
      'venue_shut',
      'the venue is shut at this instant — the residual stays naked until the next session, ' +
        'the same bound the daily flatten works to',
    );
  }

  let unresolved: readonly { instrument: string; idempotency_key: string }[];
  try {
    unresolved = await store.getUnresolvedFlattens();
  } catch (error) {
    return skip(
      input,
      position,
      residual,
      'journal_read_failed',
      `getUnresolvedFlattens failed, so an in-flight flatten could not be ruled out: ${describeThrownSafely(
        error,
      )}`,
    );
  }
  // Instrument-scoped, not lot-scoped, because that is the collision being
  // avoided: `UnresolvedFlattenSubmission` carries no lot identity, and the
  // daily flatten's row names the instrument's whole held quantity — this
  // lot's residual included. This same gate is also what keeps THIS path from
  // ever having two of its own attempts live at once, since its rows carry
  // the same instrument, which is why the key walk below can treat any
  // existing candidate as settled.
  //
  // Advisory, not the guarantee — see the file doc's "One submitter at a
  // time". `writeAheadFlatten` re-checks this atomically; what this read buys
  // is a named skip and a log line rather than a caught refusal, and the walk
  // invariant above.
  //
  // Which MATCHING row is handed on matters, because `standDown` splits its
  // paging decision on whether the blocker is this lot's own earlier
  // re-flatten (#1214 review round 2). With more than one unresolved row on
  // the instrument — a daily flatten and this lot's own attempt both in
  // flight, or rows left by an older build — `find` would pick by table order,
  // which is arbitrary and could report someone else's flatten while this
  // lot's own order is the one working. Prefer this lot's own key, and only
  // fall back to any other row on the instrument.
  const onInstrument = unresolved.filter((row) => row.instrument === position.instrument);
  const blocking =
    onInstrument.find((row) => isOwnReflattenKey(row.idempotency_key, lotKey)) ?? onInstrument[0];
  if (blocking !== undefined) {
    return standDown(input, position, residual, lotKey, blocking.idempotency_key);
  }

  let candidate: string | null;
  try {
    candidate = await resolveReflattenKey(input, lotKey);
  } catch (error) {
    return skip(
      input,
      position,
      residual,
      'journal_read_failed',
      `findByKey failed while counting this lot's earlier re-flatten attempts: ${describeThrownSafely(
        error,
      )}`,
    );
  }
  if (candidate === null) {
    return skip(
      input,
      position,
      residual,
      'attempts_exhausted',
      `${MAX_RESIDUAL_REFLATTEN_ATTEMPTS} re-flatten attempts have already been spent on this ` +
        'lot and the residual is still open — falling back to the page and no longer trying',
    );
  }

  // The closing side, derived from the lot's own — the same inversion
  // `buildFlattenExit` (trader/decide.ts) applies, done here because this
  // path has no `OrderIntent` to carry one.
  const closingSide = position.side === 'buy' ? 'sell' : 'buy';

  // MANDATORY, and it must precede the submit: without this row the flatten's
  // fill lands under a client_order_id that matches no open lot, and
  // `redistributeOneFlatten`'s `getFlattenAttribution` lookup (ingest-fills.ts)
  // returns null for it — the fill is never attributed to anything, and the
  // lot stays open in the store while flat at the venue. A journal write that
  // fails therefore ends the attempt HERE rather than being folded into one
  // broad try around both calls.
  try {
    await store.writeAheadFlatten({
      idempotency_key: candidate,
      instrument: position.instrument,
      asset_class: position.asset_class,
      side: closingSide,
      size: residual,
      submitted_at: now,
      // Exactly one lot, holding exactly the residual: this order closes one
      // lot's remainder, never an instrument's whole book (see the file doc's
      // "Why not executeExit").
      lot_held_quantities: [{ idempotency_key: lotKey, held: residual }],
      // Reusing 'flatten' rather than widening `ExitReason` (records.ts): this
      // IS the flat-by-close intent, finished late — and a fourth value would
      // reach `closed_trades.close_reason` and every consumer that switches on
      // it for no gain in meaning.
      exit_reason: 'flatten',
      // All null, legitimately: `captureSubmitSnapshot`'s budget belongs to
      // the decision path, and this order is not a decision — it is the
      // completion of one already taken. `FlattenSubmissionWriteAhead` types
      // these as nullable for exactly the case where no snapshot was taken.
      decision_price: null,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: null,
    });
  } catch (error) {
    // The store's own one-flatten-per-instrument refusal is not a failure —
    // it is the gate above, re-evaluated atomically and this time authoritative
    // (a flatten was journalled between that read and this write). Reported as
    // the same skip, so the outcome does not depend on which of the two reads
    // saw it.
    if (error instanceof UnresolvedFlattenForInstrumentError) {
      return standDown(input, position, residual, lotKey, error.blocking_key);
    }
    return fail(
      input,
      position,
      residual,
      `writeAheadFlatten failed, so no market order was sent: ${describeThrownSafely(error)}`,
    );
  }

  let ack: Awaited<ReturnType<typeof broker.submitFlatten>>;
  try {
    ack = await broker.submitFlatten(position.instrument, closingSide, residual, candidate);
  } catch (error) {
    // Left at 'submitting', never resolved to 'error': `resolveFlattenError`
    // asserts the order PROVABLY never reached the broker, and a thrown
    // submit proves no such thing — `executeExit`'s own submit catch takes
    // this identical posture, and `reconcile()` settles the row.
    return fail(
      input,
      position,
      residual,
      `submitFlatten failed — the journal row stays 'submitting' for reconcile() to settle: ${describeThrownSafely(
        error,
      )}`,
    );
  }

  try {
    await store.resolveFlattenSubmitted(
      candidate,
      { order_state: ack.order_state, broker_order_ids: ack.broker_order_ids },
      now,
    );
  } catch (error) {
    // The order is LIVE — this is bookkeeping on a submission that already
    // happened, so it may not turn into a `failed` outcome. The row stays
    // 'submitting' and `reconcile()` resolves it against the venue, exactly
    // as it does for a lost ack.
    logCaughtFailure(
      input.logger,
      {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'residual_reflatten_unresolved',
        level: 'warn',
        message:
          'resolveFlattenSubmitted failed after the residual re-flatten was accepted by the ' +
          "venue — the order is live and the journal row stays 'submitting' for reconcile()",
      },
      error,
      { idempotency_key: lotKey, flatten_key: candidate },
    );
  }

  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    event: 'residual_reflatten_submitted',
    level: 'warn',
    message:
      'this lot can never be re-armed, so the naked residual was CLOSED instead of ' +
      'protected (#1214) — a market order for the residual is live at the venue',
    payload: {
      idempotency_key: lotKey,
      flatten_key: candidate,
      instrument: position.instrument,
      side: closingSide,
      residual_qty: residual,
    },
  });

  return { kind: 'submitted', idempotency_key: candidate, qty: residual };
}

/**
 * Whether `key` is one of `lotKey`'s own re-flatten attempts — the same key
 * shape `resolveReflattenKey` walks, asked as a predicate so the advisory read
 * and `standDown` cannot disagree about what "own" means.
 */
function isOwnReflattenKey(key: string, lotKey: string): boolean {
  return key.startsWith(`${lotKey}:residual-reflatten-`);
}

/**
 * The next usable re-flatten key for `lotKey`, or `null` once the budget is
 * spent. Mirrors `resolveExitRetryKey` (execute.ts): a durable walk over
 * derived keys, so the bound survives a restart with no new schema and no
 * in-memory counter to lose.
 *
 * It differs in what it does with an EXISTING candidate. `resolveExitRetryKey`
 * must ask `isRetryableFlattenError`, because it can meet a row that is still
 * in flight. This walk cannot: its caller has already established that no
 * unresolved flatten names this instrument, and every key here carries this
 * instrument. So an existing candidate is settled by construction — an
 * `'error'` row, or a `'submitted'` one whose fills are swept — and either way
 * that attempt is spent and the walk moves on.
 */
async function resolveReflattenKey(
  input: ResidualReflattenInput,
  lotKey: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RESIDUAL_REFLATTEN_ATTEMPTS; attempt++) {
    const candidate = `${lotKey}:residual-reflatten-${attempt}`;
    if (!(await input.store.findByKey(candidate))) return candidate;
  }
  return null;
}

/**
 * The stand-down for an unresolved flatten on the instrument, whichever of the
 * two gates saw it (the advisory read, or `writeAheadFlatten`'s authoritative
 * refusal).
 *
 * Splits on WHOSE flatten it is, and only for the caller's paging decision:
 * one of this lot's own earlier re-flatten keys means the residual is already
 * being closed by an order this path sent, so a "the residual could not be
 * closed" page would be false — and its documented remedy, manual action at
 * the venue, would be a third submitter on a lot that already has one working.
 * The exposure is not thereby unwatched: a re-flatten that fills clears the
 * marker, one the venue terminally refuses is resolved by `reconcile()` and
 * the walk advances to `attempts_exhausted`, which DOES page, and a row
 * reconcile cannot settle pages on `FlattenReconcileAlertChannel`.
 */
function standDown(
  input: ResidualReflattenInput,
  position: OpenPosition,
  residual: number,
  lotKey: string,
  blockingKey: string,
): ResidualReflattenOutcome {
  const own = isOwnReflattenKey(blockingKey, lotKey);
  return skip(
    input,
    position,
    residual,
    own ? 'own_reflatten_in_flight' : 'flatten_in_flight',
    own
      ? `this lot's own re-flatten '${blockingKey}' is still unresolved — the residual is already ` +
          'being closed, so this pass adds nothing and must not page'
      : `flatten '${blockingKey}' on this instrument is still unresolved — standing down rather ` +
          'than submitting a second market order against the same lot (#1214: the two paths must ' +
          'not both submit)',
  );
}

function skip(
  input: ResidualReflattenInput,
  position: OpenPosition,
  residual: number,
  reason: ResidualReflattenSkipReason,
  detail: string,
): ResidualReflattenOutcome {
  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    event: 'residual_reflatten_skipped',
    level: 'warn',
    message: `residual re-flatten stood down (${reason}) — the residual stays naked and the caller pages`,
    payload: {
      idempotency_key: position.idempotency_key,
      instrument: position.instrument,
      residual_qty: residual,
      reason,
      detail,
    },
  });
  return { kind: 'skipped', reason, detail };
}

function fail(
  input: ResidualReflattenInput,
  position: OpenPosition,
  residual: number,
  detail: string,
): ResidualReflattenOutcome {
  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    event: 'residual_reflatten_failed',
    level: 'error',
    message:
      'residual re-flatten failed — the residual is still open and unprotected, and the caller ' +
      'pages for it',
    payload: {
      idempotency_key: position.idempotency_key,
      instrument: position.instrument,
      residual_qty: residual,
      detail,
    },
  });
  return { kind: 'failed', detail };
}
