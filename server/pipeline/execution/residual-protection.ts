
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
type RearmInput = MarkerInput &
  AlertInput &
  ResidualReflattenInput &
  Pick<ExecutionInput, 'broker'> & { store: FillReader & ResidualMarkers };

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

async function resolveResidualFillState(
  input: RearmInput,
  position: OpenPosition,
  now: Date,
): Promise<{ filledSize: number; exitQty: number } | 'handled'> {
  let recorded: Fill[];
  try {
    recorded = await input.store.getFills(position.idempotency_key);
  } catch (error) {
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
    await bestEffortMarkerWrite(input, position, now, 'mark-unprotected');
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

async function handleRearmFailure(
  input: RearmInput,
  position: OpenPosition,
  residual: number,
  now: Date,
  error: unknown,
): Promise<void> {
  const unsupported = isProtectiveRearmUnsupported(error);
  logCaughtFailure(
    input.logger,
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
  if (unsupported) {
    const reflatten = await reflattenResidual(input, position, residual, now);
    if (reflatten.kind === 'submitted') return;
    if (reflatten.kind === 'skipped' && reflatten.reason === 'own_reflatten_in_flight') return;
    if (await alreadyPagedForUnsupportedRearm(input, position)) return;
  }
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

  if (filledSize === 0) return;
  if (isFlat({ filledSize, exitQty })) {
    await bestEffortMarkerWrite(input, position, now, 'confirm-protected');
    return;
  }

  const residual = filledSize - exitQty;

  await bestEffortMarkerWrite(input, position, now, 'mark-unprotected');

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
    await bestEffortMarkerWrite(input, position, now, 'confirm-protected');
  } catch (error) {
    await handleRearmFailure(input, position, residual, now, error);
  }
}

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

export interface ResidualExposureFlags {
  residualQtyIsUpperBound?: boolean;
  rearmUnsupported?: boolean;
}

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
