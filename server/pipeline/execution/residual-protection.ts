/**
 * Residual protection (#549/#525) — the one owner of "a lot's partial-flatten
 * residual is not yet CONFIRMED protected".
 *
 * Three callers reach it: `ingestFills()` re-arms on the observing poll and
 * writes the durable marker, `executeExit` marks lots whose legs it has
 * already cancelled when a flatten is refused, and the #549 sweep
 * (residual-protection-sweep.ts) retries on cadence. They import the
 * decision from here, not the store's marker methods. Two self-scheduling
 * loops (the tick loop and fill-sync) reach this code concurrently — the
 * writes stay idempotent / first-writer-wins for exactly that reason (see
 * each store method's doc).
 *
 * Flatness and the residual quantity come from `shared/held-quantity.ts`
 * (`heldQuantityFromFills`, `isFlat`, `coversQty`) — the same module the
 * Trader and `executeExit` size exits from — so there is one tolerance
 * policy, not one per surface.
 */

import type { Fill, OpenPosition } from '../../shared/index.js';
import { heldQuantityFromFills, isFlat, logCaughtFailure, safeLog } from '../../shared/index.js';
import { isProtectiveRearmUnsupported } from './protective-rearm-unsupported.js';
import { reflattenResidual } from './residual-reflatten.js';
import type {
  ExecutionInput,
  FillReader,
  ResidualMarkers,
  ResidualReflattenInput,
} from './types.js';

type MarkerInput = Pick<ExecutionInput, 'logger' | 'trace_id'> & { store: ResidualMarkers };
type AlertInput = Pick<ExecutionInput, 'residualExposureAlerts' | 'logger' | 'trace_id'>;
// `ResidualReflattenInput` because the unsupported-re-arm branch below calls
// `reflattenResidual` (#1214) — that is what puts `sessionCalendars` and the
// flatten journal on this surface, not the re-arm itself.
type RearmInput = MarkerInput &
  AlertInput &
  ResidualReflattenInput &
  Pick<ExecutionInput, 'broker'> & { store: FillReader & ResidualMarkers };

/**
 * Durably marks several lots' residuals as observed-but-unprotected, one
 * best-effort write each — a store flake on one lot must not stop the next
 * lot's write, nor abort whatever the caller was doing (a flatten
 * redistribution that already completed, an exit refusal already decided).
 * The caller names the log entry, because what a failed write COSTS differs
 * per call site and that is what an operator grepping after an incident
 * needs to see.
 */
export async function markResidualsUnprotected(
  input: MarkerInput,
  idempotency_keys: readonly string[],
  now: Date,
  onFailure: { level: 'warn' | 'error'; message: string; payload?: Record<string, unknown> },
): Promise<void> {
  for (const key of idempotency_keys) {
    try {
      await input.store.markResidualUnprotected(key, now);
    } catch (error) {
      logCaughtFailure(
        input.logger,
        {
          trace_id: input.trace_id,
          stage: 'execution',
          event: 'residual_mark_failed',
          level: onFailure.level,
          message: onFailure.message,
        },
        error,
        { idempotency_key: key, ...(onFailure.payload ?? {}) },
      );
    }
  }
}

/**
 * Re-arms a residual left by a partial flatten (#525's recorded decision —
 * option 1), or posts the fallback alert when the re-arm itself fails or
 * cannot be attempted safely.
 *
 * On a venue that cannot arm entry-less legs AT ALL, the re-arm is not
 * retried at a later date — it is replaced: #1214's recorded decision closes
 * the residual instead (`reflattenResidual`, residual-reflatten.ts), and only
 * when that stands down or fails does this fall through to the page. That is
 * a change to what THIS caller does on that refusal, not to
 * `BrokerAdapter.rearmProtectiveLegs`, which is unchanged for every adapter
 * that supports it.
 *
 * Never throws: every failure this function can
 * observe — the store read on the `known === undefined` path, the broker
 * call rejecting, the alert channel itself failing — is swallowed here, the
 * same posture `shared/safe-log.ts`'s `safeLog()`/`logCaughtFailure()` take
 * on the logging calls this function ALSO makes now (#573) — so a flaky
 * store, a flaky re-arm, or a flaky alert transport can never escape into
 * `advanceLot` and abort `ingestFills`' per-lot loop for every OTHER lot the
 * same poll has yet to reach.
 *
 * `known` lets the caller in `advanceLot`'s main path hand over
 * `filledSize`/`exitQty` it already computed off the SAME persisted record,
 * rather than re-reading the store; the zero-new-fill branch in ingest-fills.ts has no
 * such record in hand and reads it fresh here instead.
 */
export async function maybeRearmResidual(
  input: RearmInput,
  position: OpenPosition,
  now: Date,
  known?: { filledSize: number; exitQty: number },
): Promise<void> {
  const { broker, store } = input;

  let filledSize: number;
  let exitQty: number;
  if (known === undefined) {
    let recorded: Fill[];
    try {
      recorded = await store.getFills(position.idempotency_key);
    } catch (error) {
      // #573: this is THE local diagnostic trace `ResidualExposureAlert`
      // cannot carry — its CREDENTIALS note (below) forbids a caught error's
      // text in the alert payload, so without this the operator saw a
      // flagged upper-bound estimate with no way to tell WHY the exact
      // figure was unavailable. `logCaughtFailure`, not `safeLog`: the
      // store's own error text IS the deliverable here, unlike the alert/
      // channel failures elsewhere in this file (`ResidualExposureAlert`'s
      // CREDENTIALS note is about what a downstream ALERT TRANSPORT can leak
      // — Telegram quoting the failed request — not about a local
      // store-driver error, which carries no such transport detail; #297's
      // H1 precedent `reconcileLot` (reconcile.ts) already cites applies the
      // same way here).
      logCaughtFailure(
        input.logger,
        {
          trace_id: input.trace_id,
          stage: 'execution',
          event: 'residual_size_read_failed',
          level: 'error',
          message:
            'maybeRearmResidual: store read failed while computing the exact residual after a ' +
            'partial flatten — alerting with the upper-bound requested_size instead',
        },
        error,
        { idempotency_key: position.idempotency_key },
      );
      // The exact residual is unknowable without the read that just
      // failed — alerting with `requested_size` (the lot's own, always
      // in hand, untouched by this failure) rather than a smaller,
      // possibly-wrong guess: it can only OVER-state what is genuinely at
      // risk, never under-state it, which is the conservative direction
      // for an operator deciding whether to go check the venue by hand.
      // NOT `Number.NaN` — the log-only form of this alert goes through
      // `JSON.stringify` (logger.ts), which silently
      // turns `NaN` into `null`, and a `null` quantity is less legible
      // than an honest upper bound. Never rethrown: see this function's
      // "Never throws" doc above.
      //
      // Flagged as an upper bound rather than passed off as the exact
      // residual (#569): without the flag a persistent store outage
      // reads as a stream of confident alerts, and an operator cannot tell
      // an estimate from a measurement. The caught error itself is not
      // forwarded to the ALERT — see `ResidualExposureAlert`'s CREDENTIALS
      // note — but it IS now in the local log line just above.
      //
      // #549: marked BEFORE the alert — the residual cannot be recomputed
      // right now, which is exactly a "protection not confirmed" state the
      // sweep must keep retrying with a fresh read.
      await bestEffortMarkerWrite(input, position, now, 'mark-unprotected');
      // #549: the alert-dedup marker records only a delivery the
      // channel ACCEPTED — a swallowed transport failure must leave the
      // episode un-alerted so the sweep pages again on its next pass.
      if (
        await alertResidualExposure(input, position, position.requested_size, now, {
          residualQtyIsUpperBound: true,
        })
      ) {
        await bestEffortMarkerWrite(input, position, now, 'mark-alerted');
      }
      return;
    }
    ({ filledSize, exitQty } = heldQuantityFromFills(recorded));
  } else {
    ({ filledSize, exitQty } = known);
  }

  // No entry fill on record yet: there is nothing open to protect. Cannot
  // happen on the `known` path (the caller already refused to reach here
  // with `filledSize === 0`), but the zero-new-fill path above has no such
  // guarantee — a flatten can, in principle, name a lot whose entry fill is
  // still outstanding.
  if (filledSize === 0) return;
  // Flat by this fuller read even though the per-poll signal said
  // "not flat": nothing left to protect. #549: a marker
  // `redistributeOneFlatten` set for this lot (off this poll's split
  // arithmetic) is cleared here off the fuller persisted record — flat IS
  // "nothing left unprotected", confirmed.
  if (isFlat({ filledSize, exitQty })) {
    await bestEffortMarkerWrite(input, position, now, 'confirm-protected');
    return;
  }

  const residual = filledSize - exitQty;

  // #549: the durable marker, written BEFORE the re-arm attempt below. Both
  // of this function's triggers (`ingestedExit`, `flattenTargetedThisPoll`)
  // are poll-scoped, so without this row a crash — or a re-arm failure the
  // process survives — between here and a confirmed re-arm left the residual
  // naked FOREVER: the next poll's `hasFill` dedup empties `newFills`, no
  // flatten resolves, and `advanceLot` returns early indefinitely.
  // `sweepResidualProtection` (residual-protection-sweep.ts) is what reads
  // it back, on reconcile/fill-sync cadence, and only a CONFIRMED re-arm (or
  // a flat read) clears it. Best-effort, never throwing (this function's own
  // contract): a failed marker write is logged and must not stop the actual
  // re-arm attempt, which matters more than its bookkeeping.
  await bestEffortMarkerWrite(input, position, now, 'mark-unprotected');

  // Fail-closed (`executeExit`'s precedent, execute.ts): a non-finite or
  // non-positive residual while `isFlat` (shared/held-quantity.ts) says "not flat" means the
  // store's own numbers disagree in a way `QTY_EPSILON_RELATIVE` was not
  // built to absorb. Refusing to hand the broker a garbage quantity and
  // alerting instead is the same posture `executeExit` takes on a
  // store/venue size mismatch — surface it, never guess.
  if (!(residual > 0) || !Number.isFinite(residual)) {
    if (await alertResidualExposure(input, position, residual, now)) {
      await bestEffortMarkerWrite(input, position, now, 'mark-alerted');
    }
    return;
  }

  try {
    await broker.rearmProtectiveLegs(
      position.idempotency_key,
      position.instrument,
      position.side,
      residual,
      position.stop,
      position.target,
    );
    // #549: protection is now CONFIRMED — the venue acked the re-arm (or the
    // adapter adopted legs it verified already live) — so the marker clears.
    // Best-effort: if this write fails the sweep retries a re-arm that is
    // already in place, which every adapter path tolerates (equities
    // adopt-or-place on the deterministic `:rearm` wire id; crypto emulation
    // retires stale legs before arming; Simulated re-sets the same qty).
    await bestEffortMarkerWrite(input, position, now, 'confirm-protected');
  } catch (error) {
    // The broker's own error is not forwarded to the ALERT — see
    // `ResidualExposureAlert`'s CREDENTIALS note: this channel carries only
    // fields chosen here, never broker error text. Losing the detail there
    // is fine; an operator reads the alert and checks the venue directly.
    //
    // #573: safe to put in the LOCAL log, though, same as the store-read
    // catch above — #297's H1 (cited by `reconcileLot`, reconcile.ts) makes
    // every broker adapter convert what its client threw into a curated,
    // credential-free error before it is visible here, so the credentialed
    // original never reaches this catch either.
    //
    // #1214: a venue that cannot express an entry-less protective pair at
    // all refuses this call permanently, so no retry of it can protect this
    // residual. The recorded decision (David, 2026-09-08, option 2) is to
    // CLOSE the residual instead — see residual-reflatten.ts, called below
    // once the failure is traced.
    const unsupported = isProtectiveRearmUnsupported(error);
    logCaughtFailure(
      input.logger,
      // Two whole entries rather than one with a conditional `event`: every
      // logged code must be a bare snake_case literal, greppable from the
      // source (`log-event-code.test.ts`).
      unsupported
        ? {
            trace_id: input.trace_id,
            stage: 'execution',
            event: 'residual_rearm_unsupported',
            level: 'error',
            message:
              'maybeRearmResidual: this venue cannot arm protective legs at all, so no retry ' +
              'can protect this residual — closing it instead (#1214)',
          }
        : {
            trace_id: input.trace_id,
            stage: 'execution',
            event: 'residual_rearm_failed',
            level: 'error',
            message: 'maybeRearmResidual: broker.rearmProtectiveLegs failed — alerting instead',
          },
      error,
      { idempotency_key: position.idempotency_key, residual_qty: residual },
    );
    // #1214's recorded remedy, tried before the page: on a venue that cannot
    // arm legs at all, the residual is closed rather than protected. Only a
    // live closing order suppresses the page — a fresh submit, or this lot's
    // own earlier one still working; every other stand-down and every failure
    // falls through to the existing #525 escalation below. The marker
    // stays set either way: it clears when the lot reads flat, which is what
    // a filled re-flatten makes true. Never throws (its own contract), so it
    // cannot break this function's.
    if (unsupported) {
      const reflatten = await reflattenResidual(input, position, residual, now);
      if (reflatten.kind === 'submitted') return;
      // #1214 review, finding 4: this lot's own re-flatten is already working
      // at the venue — the same state as a fresh submit, so the same
      // suppression. See `standDown` (residual-reflatten.ts).
      if (reflatten.kind === 'skipped' && reflatten.reason === 'own_reflatten_in_flight') return;
    }
    // #549: the marker stays set (protection is NOT confirmed). The episode
    // is recorded as already-alerted ONLY when the channel accepted the
    // delivery (#549) — so the sweep retries the re-arm on cadence
    // without paging again for a page that actually landed (#342), and DOES
    // page again for one a transport outage swallowed.
    if (
      await alertResidualExposure(input, position, residual, now, {
        rearmUnsupported: unsupported,
      })
    ) {
      await bestEffortMarkerWrite(input, position, now, 'mark-alerted');
    }
  }
}

/**
 * The best-effort #549 marker writes, one parameterized helper. Each op
 * swallows its own store failure — `maybeRearmResidual`'s
 * "never throws" contract, and the same reasoning as this file's other
 * contained writes: the marker is recovery BOOKKEEPING, and losing a
 * bookkeeping write must never abort the actual re-arm (or the poll) it
 * books. Logged at `warn` via `logCaughtFailure` (#608) with an op-specific
 * message: what a failed write COSTS differs per op, and that is exactly
 * what an operator grepping after an incident needs to see.
 */
const MARKER_WRITES = {
  'mark-unprotected': {
    write: (input: MarkerInput, key: string, now: Date) =>
      input.store.markResidualUnprotected(key, now),
    failureMessage:
      'markResidualUnprotected failed — if this process dies before the re-arm is confirmed, ' +
      'the #549 sweep will not know to retry this lot',
  },
  'confirm-protected': {
    write: (input: MarkerInput, key: string, _now: Date) =>
      input.store.confirmResidualProtected(key),
    failureMessage:
      'confirmResidualProtected failed — the lot stays marked and the #549 sweep will ' +
      're-verify a protection that is already in place (idempotent on every adapter path)',
  },
  'mark-alerted': {
    write: (input: MarkerInput, key: string, now: Date) =>
      input.store.markResidualAlerted(key, now),
    failureMessage:
      'markResidualAlerted failed — the #549 sweep may page a second time for an episode ' +
      'that was already alerted (noisy, not unsafe)',
  },
} as const;

async function bestEffortMarkerWrite(
  input: MarkerInput,
  position: OpenPosition,
  now: Date,
  op: keyof typeof MARKER_WRITES,
): Promise<void> {
  const { write, failureMessage } = MARKER_WRITES[op];
  try {
    await write(input, position.idempotency_key, now);
  } catch (error) {
    logCaughtFailure(
      input.logger,
      {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'residual_alert_mark_failed',
        level: 'warn',
        message: failureMessage,
      },
      error,
      { idempotency_key: position.idempotency_key },
    );
  }
}

/**
 * The two qualifiers a caller can put on the page. Named rather than
 * positional (#1214): both are booleans that read identically at a call
 * site, and every producer sets at most one of them.
 */
export interface ResidualExposureFlags {
  /**
   * `true` only on the path where the fill read failed and `residualQty` is
   * therefore the lot's whole requested size rather than the exact residual
   * (#569).
   */
  residualQtyIsUpperBound?: boolean;
  /**
   * `true` when the re-arm was refused as impossible on this venue rather
   * than merely failing (#1214, `isProtectiveRearmUnsupported`) — see
   * `ResidualExposureAlert.rearm_unsupported`. Only the two paths that
   * actually attempted a re-arm can set it; the paths that never got that
   * far leave it false, which reads as "not known to be impossible", the
   * conservative direction for a flag that tells an operator whether waiting
   * is an option.
   */
  rearmUnsupported?: boolean;
}

/**
 * The #525 fallback, posted when a re-arm failed or could not be safely
 * attempted. Fire-and-forget and fully swallowed on failure — the alert IS
 * the fallback, so there is nothing left to fall back to if delivering it
 * also fails; the caller (`maybeRearmResidual`) must keep running either
 * way, the same reasoning `shared/safe-log.ts`'s `safeLog()` is built around.
 *
 * Exported (#549) for `sweepResidualProtection` (residual-protection-sweep.ts),
 * whose escalation is the SAME alert with the same CREDENTIALS boundary —
 * a second hand-rolled copy of this channel's swallow/trace posture is
 * exactly the drift `shared/safe-log.ts` was extracted to prevent.
 *
 * Returns whether the channel RESOLVED (#549): the once-per-episode
 * dedup (`markResidualAlerted`) may only be recorded against a delivery the
 * channel accepted — marking it after a swallowed failure would let a
 * transient transport outage permanently suppress the only page for a
 * still-naked residual. The swallow itself is unchanged; only the caller's
 * bookkeeping branches on the answer.
 */
export async function alertResidualExposure(
  input: AlertInput,
  position: OpenPosition,
  residualQty: number,
  now: Date,
  flags: ResidualExposureFlags = {},
): Promise<boolean> {
  const residualQtyIsUpperBound = flags.residualQtyIsUpperBound ?? false;
  try {
    await input.residualExposureAlerts.postResidualExposureAlert({
      trace_id: input.trace_id,
      idempotency_key: position.idempotency_key,
      instrument: position.instrument,
      side: position.side,
      residual_qty: residualQty,
      residual_qty_is_upper_bound: residualQtyIsUpperBound,
      rearm_unsupported: flags.rearmUnsupported ?? false,
      stop: position.stop,
      target: position.target,
      observed_at: now,
    });
    return true;
  } catch {
    // The redistribution/advance this alert reports on already completed —
    // see this function's doc comment for why that must not be undone here.
    // #573: this IS the fallback failing, the most severe blind spot this
    // whole file has — a residual is unprotected AND nobody was told, not
    // even locally. Traced with a FIXED, self-authored message rather than
    // the channel's own error (same CREDENTIALS posture as the
    // flatten-overfill channel catch in ingest-fills.ts, `escalateAgedUnpricedFills`'s
    // precedent in alpaca-adapter.ts): a Telegram transport failure
    // quotes the request it failed on, which can carry a bot token.
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'residual_exposure_alert_send_failed',
      level: 'error',
      message:
        'postResidualExposureAlert delivery failed — a residual position is unprotected and ' +
        'the operator was not paged; check the venue by hand',
      payload: {
        idempotency_key: position.idempotency_key,
        residual_qty: residualQty,
        residual_qty_is_upper_bound: residualQtyIsUpperBound,
      },
    });
    return false;
  }
}
