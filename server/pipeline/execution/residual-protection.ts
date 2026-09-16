/**
 * Two self-scheduling loops (tick loop, fill-sync) can reach this
 * concurrently, so writes stay idempotent/first-writer-wins (see each store
 * method's doc). Flatness and residual math come from
 * `shared/held-quantity.ts`, the same module the Trader and `executeExit`
 * use, so there is one tolerance policy across all three.
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
// `reflattenResidual`, which needs `sessionCalendars` and the flatten
// journal — the re-arm path itself does not
type RearmInput = MarkerInput &
  AlertInput &
  ResidualReflattenInput &
  Pick<ExecutionInput, 'broker'> & { store: FillReader & ResidualMarkers };

/**
 * Marks each lot best-effort: a store flake on one must not stop the next
 * lot's write or abort work the caller already completed. The caller names
 * the log message because what a failed write costs differs per call site.
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
 * if the re-arm fails or cannot be attempted safely. On a venue that cannot
 * arm entry-less legs at all, the residual is closed instead
 * (`reflattenResidual`, residual-reflatten.ts) rather than retried.
 *
 * Never throws: every failure this function can observe — a store read, the
 * broker call rejecting, the alert channel failing — is swallowed, so a
 * flaky dependency here cannot abort `ingestFills`' per-lot loop for other
 * lots the same poll has yet to reach.
 *
 * `known` lets `advanceLot`'s main path pass in a `filledSize`/`exitQty` it
 * already computed off the same persisted record; the zero-new-fill path has
 * no such record and reads fresh here instead.
 */
/**
 * The `known === undefined` half of `maybeRearmResidual`. On a store-read
 * failure it marks the lot unprotected, alerts with the upper-bound
 * `requested_size`, and returns `'handled'` so the caller stops there
 * instead of treating the sentinel as a residual to act on.
 */
async function resolveResidualFillState(
  input: RearmInput,
  position: OpenPosition,
  now: Date,
): Promise<{ filledSize: number; exitQty: number } | 'handled'> {
  let recorded: Fill[];
  try {
    recorded = await input.store.getFills(position.idempotency_key);
  } catch (error) {
    // Logged here, not just alerted: the store's own error text is the
    // deliverable an operator needs, and `ResidualExposureAlert`'s
    // CREDENTIALS note bars a caught error's text from the alert payload
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
    // Alerts with `requested_size` (always in hand) rather than a smaller
    // guess or NaN — an upper bound can only OVER-state the exposure, never
    // under-state it, and is flagged as such (`residualQtyIsUpperBound`) so
    // an outage doesn't read as a stream of confident, exact alerts
    //
    // Marked unprotected before alerting: the residual can't be recomputed
    // right now, which is itself a "not confirmed" state the sweep retries
    await bestEffortMarkerWrite(input, position, now, 'mark-unprotected');
    // Dedup marks only a delivery the channel accepted, so a swallowed
    // transport failure leaves this episode un-alerted for the next pass
    if (
      await alertResidualExposure(input, position, position.requested_size, now, {
        residualQtyIsUpperBound: true,
      })
    ) {
      await bestEffortMarkerWrite(input, position, now, 'mark-alerted');
    }
    return 'handled';
  }
  return heldQuantityFromFills(recorded);
}

/**
 * A CONFIRMED venue refusal dedups against its own column, separate from the
 * general one `handleRearmFailure`'s final alert uses — otherwise any other
 * paging reason could consume the one page a permanent gap needs.
 * A store-read failure here fails open ("not yet paged"): a missed page is
 * the unsafe direction, a noisy duplicate is not.
 */
async function alreadyPagedForUnsupportedRearm(
  input: RearmInput,
  position: OpenPosition,
): Promise<boolean> {
  try {
    return (
      (await input.store.getResidualRearmUnsupportedAlertedAt(position.idempotency_key)) !== null
    );
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
    return false;
  }
}

/**
 * `broker.rearmProtectiveLegs`'s catch — the last thing `maybeRearmResidual`
 * does, so every early `return` here is equivalent to the caller's function
 * ending, not to skipping work the caller still had left to do
 */
async function handleRearmFailure(
  input: RearmInput,
  position: OpenPosition,
  residual: number,
  now: Date,
  error: unknown,
): Promise<void> {
  // The broker's error isn't forwarded to the alert (same CREDENTIALS
  // boundary as elsewhere in this file) but is safe to log locally: every
  // adapter converts its client's error into a curated, credential-free one
  // before it reaches this catch
  //
  // Some refusals are permanent — a venue with no entry-less protective pair
  // (Saxo), or a lot that has spent every re-arm wire id (Alpaca) — so no
  // retry can protect this residual; `reflattenResidual` closes it instead
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
  // Tried before paging: on a venue that cannot arm legs at all, the
  // residual is closed instead of protected. Only a live closing order
  // (fresh or already in flight) suppresses the page — everything else
  // falls through to the escalation below. Never throws, so it can't
  // break this function's own contract
  if (unsupported) {
    const reflatten = await reflattenResidual(input, position, residual, now);
    if (reflatten.kind === 'submitted') return;
    // This lot's own re-flatten is already working at the venue — the same
    // state as a fresh submit, so the same suppression (see `standDown`,
    // residual-reflatten.ts)
    if (reflatten.kind === 'skipped' && reflatten.reason === 'own_reflatten_in_flight') return;
    // A partial fill can re-enter this path after a reflatten was already
    // submitted (the branch above only suppresses while it's in flight) and
    // hit the same venue refusal again — check the dedup before paging, not
    // only after, or this pages a second time for a gap already reported
    if (await alreadyPagedForUnsupportedRearm(input, position)) return;
  }
  // The marker stays set (protection not confirmed); the episode is
  // recorded as already-alerted only once the channel accepts delivery, so
  // the sweep doesn't re-page for a page that landed but does for one a
  // transport outage swallowed. A confirmed venue refusal records against
  // its own dedup column (see `alreadyPagedForUnsupportedRearm`), so it
  // can't consume the page a different failure reason needs
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

export async function maybeRearmResidual(
  input: RearmInput,
  position: OpenPosition,
  now: Date,
  known?: { filledSize: number; exitQty: number },
): Promise<void> {
  const { broker } = input;

  const resolved = known ?? (await resolveResidualFillState(input, position, now));
  if (resolved === 'handled') return;
  const { filledSize, exitQty } = resolved;

  // No entry fill on record yet, so there is nothing to protect. Can't
  // happen on the `known` path (the caller already excludes it), but the
  // fresh-read path has no such guarantee
  if (filledSize === 0) return;
  // Flat by this fuller read even though the per-poll signal said "not
  // flat": a marker set off this poll's split arithmetic is cleared here
  // against the fuller persisted record
  if (isFlat({ filledSize, exitQty })) {
    await bestEffortMarkerWrite(input, position, now, 'confirm-protected');
    return;
  }

  const residual = filledSize - exitQty;

  // Written before the re-arm attempt: without this row, a crash or a
  // survived re-arm failure here would leave the residual naked forever —
  // the next poll's fill dedup finds nothing new and never revisits it
  // `sweepResidualProtection` reads this marker back on cadence. Best-effort
  // and non-throwing: a failed write must not block the re-arm itself
  await bestEffortMarkerWrite(input, position, now, 'mark-unprotected');

  // Fail-closed: a non-finite or non-positive residual while `isFlat` says
  // "not flat" means the store's own numbers disagree beyond what
  // `QTY_EPSILON_RELATIVE` absorbs — refuse to hand the broker a garbage
  // quantity and alert instead (same posture as `executeExit`)
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
    // Protection confirmed — the venue acked the re-arm (or adopted legs
    // already live) — so the marker clears. Best-effort: if this write
    // fails, the sweep just retries a re-arm every adapter tolerates
    // (adopt-or-place, stale-leg retirement, or re-setting the same qty)
    await bestEffortMarkerWrite(input, position, now, 'confirm-protected');
  } catch (error) {
    await handleRearmFailure(input, position, residual, now, error);
  }
}

/**
 * The best-effort marker writes, one parameterized helper. Each op swallows
 * its own store failure — the marker is recovery bookkeeping, and losing a
 * bookkeeping write must never abort the re-arm (or poll) it books. Each op
 * carries its own failure message since what a failed write costs differs.
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
  /**
   * `true` only on the path where the fill read failed and `residualQty` is
   * the lot's whole requested size rather than the exact residual
   */
  residualQtyIsUpperBound?: boolean;
  /**
   * `true` when the re-arm was refused permanently, not merely failing
   * (`isProtectiveRearmUnsupported`). Only paths that attempted a re-arm
   * set it; others default to false — the conservative reading for a flag
   * that tells an operator whether waiting is an option.
   */
  rearmUnsupported?: boolean;
}

/**
 * The fallback page when a re-arm failed or could not be attempted safely.
 * Fire-and-forget and fully swallowed on failure — the alert IS the
 * fallback, so the caller (`maybeRearmResidual`) must keep running either
 * way even if delivering it also fails (same reasoning as `safeLog()`).
 *
 * Exported for `sweepResidualProtection`'s escalation, which reuses this
 * same channel and CREDENTIALS boundary rather than hand-rolling a copy.
 *
 * Returns whether the channel resolved, so the caller's once-per-episode
 * dedup write is only recorded against a delivery the channel accepted —
 * marking it after a swallowed failure would let a transient transport
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
    // This IS the fallback failing — a residual is unprotected and nobody
    // was told, not even locally. Traced with a fixed, self-authored
    // message rather than the channel's own error: a Telegram transport
    // failure quotes the request it failed on, which can carry a bot token
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
