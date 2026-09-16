/**
 * Residual protection — the one owner of "a lot's partial-flatten residual is
 * not yet CONFIRMED protected".
 *
 * Three callers reach it: `ingestFills()` re-arms on the observing poll and
 * writes the durable marker, `executeExit` marks lots whose legs it has
 * already cancelled when a flatten is refused, and the sweep
 * (residual-protection-sweep.ts) retries on cadence. Two self-scheduling
 * loops (the tick loop and fill-sync) reach this code concurrently — the
 * writes stay idempotent / first-writer-wins for exactly that reason.
 *
 * Flatness and the residual quantity come from `shared/held-quantity.ts` —
 * the same module the Trader and `executeExit` size exits from — so there is
 * one tolerance policy, not one per surface.
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
// `reflattenResidual`, which is what puts `sessionCalendars` and the flatten
// journal on this surface, not the re-arm itself
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
        { idempotency_key: key, ...onFailure.payload },
      );
    }
  }
}

/**
 * Re-arms a residual left by a partial flatten, or posts the fallback alert
 * when the re-arm itself fails or cannot be attempted safely.
 *
 * On a venue that cannot arm entry-less legs AT ALL, the re-arm is not
 * retried later — it is replaced: closes the residual instead
 * (`reflattenResidual`, residual-reflatten.ts), and only when that stands
 * down or fails does this fall through to the page.
 *
 * Never throws: every failure this function can observe — the store read on
 * the `known === undefined` path, the broker call rejecting, the alert
 * channel itself failing — is swallowed here, so a flaky store, re-arm, or
 * alert transport can never escape into `advanceLot` and abort `ingestFills`'
 * per-lot loop for every OTHER lot the same poll has yet to reach.
 *
 * `known` lets the caller in `advanceLot`'s main path hand over
 * `filledSize`/`exitQty` it already computed off the SAME persisted record,
 * rather than re-reading the store; the zero-new-fill branch in
 * ingest-fills.ts has no such record in hand and reads it fresh here instead.
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
      // This is THE local diagnostic trace `ResidualExposureAlert` cannot
      // carry — its CREDENTIALS note (below) forbids a caught error's text in
      // the alert payload, so without this the operator saw a flagged
      // upper-bound estimate with no way to tell WHY the exact figure was
      // unavailable. `logCaughtFailure`, not `safeLog`: the store's own error
      // text IS the deliverable here, and a local store-driver error carries
      // no transport-leak risk the way a downstream alert transport can
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
      // The exact residual is unknowable without the read that just failed —
      // alerting with `requested_size` (always in hand) rather than a
      // smaller, possibly-wrong guess: it can only OVER-state what is
      // genuinely at risk, the conservative direction for an operator
      // deciding whether to check the venue by hand. Flagged as an upper
      // bound rather than passed off as the exact residual: without the flag
      // a persistent store outage reads as a stream of confident alerts
      //
      // Marked BEFORE the alert — the residual cannot be recomputed right
      // now, which is exactly a "protection not confirmed" state the sweep
      // must keep retrying with a fresh read
      await bestEffortMarkerWrite(input, position, now, 'mark-unprotected');
      // The alert-dedup marker records only a delivery the channel ACCEPTED
      // — a swallowed transport failure must leave the episode un-alerted so
      // the sweep pages again on its next pass
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
  // happen on the `known` path, but the zero-new-fill path above has no such
  // guarantee — a flatten can, in principle, name a lot whose entry fill is
  // still outstanding
  if (filledSize === 0) return;
  // Flat by this fuller read even though the per-poll signal said "not
  // flat": nothing left to protect — flat IS "nothing left unprotected",
  // confirmed against the fuller persisted record
  if (isFlat({ filledSize, exitQty })) {
    await bestEffortMarkerWrite(input, position, now, 'confirm-protected');
    return;
  }

  const residual = filledSize - exitQty;

  // The durable marker, written BEFORE the re-arm attempt below: without this
  // row a crash — or a re-arm failure the process survives — between here and
  // a confirmed re-arm leaves the residual naked FOREVER, since the next
  // poll's fill dedup empties `newFills` and `advanceLot` returns early
  // indefinitely. `sweepResidualProtection` reads it back on cadence, and
  // only a CONFIRMED re-arm (or a flat read) clears it. Best-effort, never
  // throwing: a failed marker write must not stop the actual re-arm attempt
  await bestEffortMarkerWrite(input, position, now, 'mark-unprotected');

  // Fail-closed (`executeExit`'s precedent): a non-finite or non-positive
  // residual while `isFlat` says "not flat" means the store's own numbers
  // disagree in a way the epsilon tolerance was not built to absorb
  // Refusing to hand the broker a garbage quantity and alerting instead is
  // the same posture `executeExit` takes on a store/venue size mismatch
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
    // Protection is now CONFIRMED — the venue acked the re-arm (or the
    // adapter adopted legs it verified already live) — so the marker clears
    // Best-effort: if this write fails the sweep retries a re-arm that is
    // already in place, which every adapter path tolerates
    await bestEffortMarkerWrite(input, position, now, 'confirm-protected');
  } catch (error) {
    // The broker's own error is not forwarded to the ALERT — see
    // `ResidualExposureAlert`'s CREDENTIALS note: this channel carries only
    // fields chosen here, never broker error text. Safe to put in the LOCAL
    // log, though: every broker adapter converts what its client threw into
    // a curated, credential-free error before it is visible here
    //
    // Some refusals of this call are permanent, so no retry can protect this
    // residual — a venue that cannot express an entry-less protective pair
    // at all, or a lot that has spent every re-arm wire id the venue will
    // grant it. The recorded decision is to CLOSE the residual instead — see
    // residual-reflatten.ts, called below once the failure is traced
    const unsupported = isProtectiveRearmUnsupported(error);
    logCaughtFailure(
      input.logger,
      // Two whole entries rather than one with a conditional `event`: every
      // logged code must be a bare snake_case literal, greppable from the
      // source (`log-event-code.test.ts`)
      unsupported
        ? {
            trace_id: input.trace_id,
            stage: 'execution',
            event: 'residual_rearm_unsupported',
            level: 'error',
            message:
              'maybeRearmResidual: arming protective legs for this lot is permanently refused, ' +
              'so no retry can protect this residual — closing it instead (#1214)',
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
    // The recorded remedy, tried before the page: on a venue that cannot arm
    // legs at all, the residual is closed rather than protected. Only a live
    // closing order suppresses the page; every other stand-down and every
    // failure falls through to the escalation below. The marker stays set
    // either way: it clears when the lot reads flat
    if (unsupported) {
      const reflatten = await reflattenResidual(input, position, residual, now);
      if (reflatten.kind === 'submitted') return;
      // This lot's own re-flatten is already working at the venue — the
      // same state as a fresh submit, so the same suppression
      if (reflatten.kind === 'skipped' && reflatten.reason === 'own_reflatten_in_flight') return;
      // A partial fill can re-enter `advanceLot` -> `maybeRearmResidual`
      // after a reflatten was already SUBMITTED for this episode, and land on
      // the same venue refusal again. Consult the dedup BEFORE paging, not
      // only record it after. A store read failure here fails OPEN (falls
      // through to page): missing a page is the unsafe direction
      try {
        if (
          (await input.store.getResidualRearmUnsupportedAlertedAt(position.idempotency_key)) !==
          null
        ) {
          return;
        }
      } catch (error) {
        logCaughtFailure(
          input.logger,
          {
            trace_id: input.trace_id,
            stage: 'execution',
            event: 'residual_rearm_unsupported_dedup_read_failed',
            level: 'warn',
            message:
              'maybeRearmResidual: getResidualRearmUnsupportedAlertedAt failed — paging without ' +
              'the dedup check (may duplicate a page already sent, never skip one; #1447)',
          },
          error,
          { idempotency_key: position.idempotency_key },
        );
      }
    }
    // The marker stays set (protection is NOT confirmed). The episode is
    // recorded as already-alerted ONLY when the channel accepted delivery —
    // so the sweep retries the re-arm on cadence without paging again for a
    // page that actually landed, and DOES page again for one a transport
    // outage swallowed
    //
    // A CONFIRMED venue refusal records against its OWN dedup column, not
    // the general one the pre-attempt paths above use — the general column
    // already carries every OTHER reason this function pages, and letting
    // any of those consume the one page a permanent gap needs is exactly
    // the defect this split closes
    if (
      await alertResidualExposure(input, position, residual, now, {
        rearmUnsupported: unsupported,
      })
    ) {
      await bestEffortMarkerWrite(
        input,
        position,
        now,
        unsupported ? 'mark-rearm-unsupported-alerted' : 'mark-alerted',
      );
    }
  }
}

/**
 * The best-effort marker writes, one parameterized helper. Each op swallows
 * its own store failure — the marker is recovery BOOKKEEPING, and losing a
 * bookkeeping write must never abort the actual re-arm (or the poll) it
 * books. Logged with an op-specific message: what a failed write COSTS
 * differs per op, and that is what an operator grepping after an incident
 * needs to see.
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
  'mark-rearm-unsupported-alerted': {
    write: (input: MarkerInput, key: string, now: Date) =>
      input.store.markResidualRearmUnsupportedAlerted(key, now),
    failureMessage:
      'markResidualRearmUnsupportedAlerted failed — the #549 sweep may page a second time ' +
      'for a permanent gap that was already alerted (noisy, not unsafe; #1447)',
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
 * positional: both are booleans that read identically at a call site, and
 * every producer sets at most one of them.
 */
export interface ResidualExposureFlags {
  /** `true` only on the path where the fill read failed and `residualQty` is therefore the lot's whole requested size rather than the exact residual */
  residualQtyIsUpperBound?: boolean;
  /**
   * `true` when the re-arm was refused PERMANENTLY rather than merely
   * failing. Only the two paths that actually attempted a re-arm can set it;
   * paths that never got that far leave it false, the conservative direction
   * for a flag that tells an operator whether waiting is an option.
   */
  rearmUnsupported?: boolean;
}

/**
 * The fallback alert, posted when a re-arm failed or could not be safely
 * attempted. Fire-and-forget and fully swallowed on failure — the alert IS
 * the fallback, so there is nothing left to fall back to if delivering it
 * also fails; the caller (`maybeRearmResidual`) must keep running either way.
 *
 * Exported for `sweepResidualProtection` (residual-protection-sweep.ts),
 * whose escalation is the SAME alert with the same CREDENTIALS boundary.
 *
 * Returns whether the channel RESOLVED: the caller's once-per-episode dedup
 * write may only be recorded against a delivery the channel accepted.
 * Marking it after a swallowed failure would let a transient transport
 * outage permanently suppress the only page for a still-naked residual.
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
    // This IS the fallback failing, the most severe blind spot this file
    // has — a residual is unprotected AND nobody was told. Traced with a
    // FIXED, self-authored message rather than the channel's own error: a
    // Telegram transport failure quotes the request it failed on, which can
    // carry a bot token
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
