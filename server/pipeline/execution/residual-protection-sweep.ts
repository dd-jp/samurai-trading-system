import {
  describeThrownSafely,
  heldQuantityFromFills,
  isFlat,
  logCaughtFailure,
  safeLog,
} from '../../shared/index.js';
import { isProtectiveRearmUnsupported } from './protective-rearm-unsupported.js';
import { alertResidualExposure, type ResidualExposureFlags } from './residual-protection.js';
import { reflattenResidual } from './residual-reflatten.js';
import type {
  ReconcileDivergence,
  ResidualProtectionSweepResult,
  ResidualSweepInput,
  UnprotectedResidualLot,
} from './types.js';

export async function sweepResidualProtection(
  input: ResidualSweepInput,
): Promise<ResidualProtectionSweepResult> {
  const marked = await input.store.getUnprotectedResidualLots();
  const divergences: ReconcileDivergence[] = [];

  for (const row of marked) {
    try {
      const divergence = await sweepOne(input, row);
      if (divergence !== null) divergences.push(divergence);
    } catch (error) {
      logCaughtFailure(
        input.logger,
        {
          trace_id: input.trace_id,
          stage: 'execution',
          event: 'residual_sweep_lot_unsettled',
          level: 'error',
          message:
            'sweepResidualProtection: one marked lot could not be settled this pass — the ' +
            'marker stays and the next pass retries',
        },
        error,
        { idempotency_key: row.position.idempotency_key },
      );
      divergences.push({
        idempotency_key: row.position.idempotency_key,
        instrument: row.position.instrument,
        store_state: row.position.order_state,
        broker_state: null,
        action: 'undetermined',
        kind: 'sweep',
        reason: `residual-protection sweep failed: ${describeThrownSafely(error)}`,
        escalation: 'residual_sweep_lot_unsettled',
      });
    }
  }

  return { checked: marked.length, divergences };
}

export function sweepDivergence(
  position: UnprotectedResidualLot['position'],
  action: ReconcileDivergence['action'],
  reason: string,
): ReconcileDivergence {
  return {
    idempotency_key: position.idempotency_key,
    instrument: position.instrument,
    store_state: position.order_state,
    broker_state: null,
    action,
    kind: 'sweep',
    reason,
  };
}

async function sweepOne(
  input: ResidualSweepInput,
  row: UnprotectedResidualLot,
): Promise<ReconcileDivergence | null> {
  const { broker, store, clock } = input;
  const { position } = row;
  const key = position.idempotency_key;
  const now = clock.now();

  const totals = await readResidualFillTotals(input, row, now);
  if ('failure' in totals) return totals.failure;
  const { filledSize, exitQty } = totals;

  if (filledSize === 0) return null;

  if (isFlat({ filledSize, exitQty })) {
    await store.confirmResidualProtected(key);
    return sweepDivergence(
      position,
      'adopted',
      'marked lot reads flat on the persisted fill record — nothing left unprotected; ' +
        'residual-protection marker cleared',
    );
  }

  const residual = filledSize - exitQty;

  if (!(residual > 0) || !Number.isFinite(residual)) {
    await alertResidualExposureOnce(input, row, position.requested_size, now, {
      residualQtyIsUpperBound: true,
    });
    return {
      ...sweepDivergence(
        position,
        'undetermined',
        `marked residual recomputes to ${residual} (non-finite or non-positive) while the fill ` +
          'record reads not-flat — refusing to re-arm a garbage quantity; check the store by hand',
      ),
      escalation: 'residual_sweep_garbage_residual',
    };
  }

  try {
    await broker.rearmProtectiveLegs(
      key,
      position.instrument,
      position.side,
      residual,
      position.stop,
      position.target,
    );
  } catch (error) {
    return await settleFailedRearm(input, row, residual, now, error);
  }

  await store.confirmResidualProtected(key);
  return sweepDivergence(
    position,
    'adopted',
    `protective legs re-armed for residual ${residual} by the #549 sweep — ` +
      'residual-protection marker cleared',
  );
}

async function readResidualFillTotals(
  input: ResidualSweepInput,
  row: UnprotectedResidualLot,
  now: Date,
): Promise<{ filledSize: number; exitQty: number } | { failure: ReconcileDivergence }> {
  const { position } = row;
  try {
    return heldQuantityFromFills(await input.store.getFills(position.idempotency_key));
  } catch (error) {
    logCaughtFailure(
      input.logger,
      {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'residual_size_read_failed',
        level: 'error',
        message:
          'sweepResidualProtection: store read failed while recomputing a marked residual — ' +
          'alerting with the upper-bound requested_size instead',
      },
      error,
      { idempotency_key: position.idempotency_key },
    );
    await alertResidualExposureOnce(input, row, position.requested_size, now, {
      residualQtyIsUpperBound: true,
    });
    return {
      failure: {
        ...sweepDivergence(
          position,
          'undetermined',
          `marked residual could not be recomputed (fill read failed): ${describeThrownSafely(
            error,
          )}`,
        ),
        escalation: 'residual_sweep_size_read_failed',
      },
    };
  }
}

async function settleFailedRearm(
  input: ResidualSweepInput,
  row: UnprotectedResidualLot,
  residual: number,
  now: Date,
  error: unknown,
): Promise<ReconcileDivergence> {
  const { position } = row;
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
            'sweepResidualProtection: arming protective legs for this lot is permanently ' +
            'refused, so no pass of this sweep can protect it — the marker stays and only ' +
            'manual action at the venue clears it',
        }
      : {
          trace_id: input.trace_id,
          stage: 'execution',
          event: 'residual_rearm_failed',
          level: 'error',
          message:
            'sweepResidualProtection: broker.rearmProtectiveLegs retry failed — the marker ' +
            'stays and the next pass retries',
        },
    error,
    { idempotency_key: position.idempotency_key, residual_qty: residual },
  );

  if (unsupported) {
    const closing = await reflattenUnrearmable(input, position, residual, now);
    if (closing !== undefined) return closing;
  }

  await alertResidualExposureOnce(input, row, residual, now, { rearmUnsupported: unsupported });
  return {
    ...sweepDivergence(
      position,
      'undetermined',
      unsupported
        ? `this lot can never be re-armed and the residual ${residual} could not ` +
            `be closed either — see the residual_reflatten_* log line for which gate stood the ` +
            `re-flatten down: ${describeThrownSafely(error)}`
        : `re-arm retry failed for residual ${residual}: ${describeThrownSafely(error)}`,
    ),
    escalation: unsupported
      ? 'residual_sweep_rearm_unsupported'
      : 'residual_sweep_rearm_retry_failed',
  };
}

async function reflattenUnrearmable(
  input: ResidualSweepInput,
  position: UnprotectedResidualLot['position'],
  residual: number,
  now: Date,
): Promise<ReconcileDivergence | undefined> {
  const reflatten = await reflattenResidual(input, position, residual, now);
  if (reflatten.kind === 'skipped' && reflatten.reason === 'own_reflatten_in_flight') {
    return {
      ...sweepDivergence(position, 'undetermined', reflatten.detail),
      escalation: 'residual_sweep_reflatten_in_flight',
    };
  }
  if (reflatten.kind === 'submitted') {
    return {
      ...sweepDivergence(
        position,
        'undetermined',
        `this lot can never be re-armed, so residual ${residual} was CLOSED instead ` +
          `(#1214): market order '${reflatten.idempotency_key}' is live at the venue and the ` +
          'marker clears when its fill lands',
      ),
      escalation: 'residual_sweep_reflatten_submitted',
    };
  }
  return undefined;
}

async function alertResidualExposureOnce(
  input: ResidualSweepInput,
  row: UnprotectedResidualLot,
  residualQty: number,
  now: Date,
  flags: ResidualExposureFlags,
): Promise<void> {
  const dedup = flags.rearmUnsupported
    ? {
        alreadyAlerted: row.rearm_unsupported_alerted_at !== null,
        record: (key: string, at: Date) => input.store.markResidualRearmUnsupportedAlerted(key, at),
        failureMessage:
          'markResidualRearmUnsupportedAlerted failed — the next sweep pass may page a second ' +
          'time for a permanent gap that was already alerted (noisy, not unsafe; #1447)',
      }
    : {
        alreadyAlerted: row.alerted_at !== null,
        record: (key: string, at: Date) => input.store.markResidualAlerted(key, at),
        failureMessage:
          'markResidualAlerted failed — the next sweep pass may page a second time for an ' +
          'episode that was already alerted (noisy, not unsafe)',
      };

  if (dedup.alreadyAlerted) return;
  const delivered = await alertResidualExposure(input, row.position, residualQty, now, flags);
  if (!delivered) return;
  try {
    const recorded = await dedup.record(row.position.idempotency_key, now);
    if (!recorded) {
      safeLog(input.logger, {
        trace_id: input.trace_id,
        stage: 'execution',
        level: 'info',
        message:
          "residual-exposure page dedup was already held by another surface — this pass's page " +
          'was a duplicate; the durable record stays single-writer',
        payload: { idempotency_key: row.position.idempotency_key },
      });
    }
  } catch (error) {
    logCaughtFailure(
      input.logger,
      {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'residual_alert_mark_failed',
        level: 'warn',
        message: dedup.failureMessage,
      },
      error,
      { idempotency_key: row.position.idempotency_key },
    );
  }
}
