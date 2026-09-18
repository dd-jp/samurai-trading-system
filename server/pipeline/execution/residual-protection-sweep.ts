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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch is a distinct settlement outcome (flat/garbage-residual/rearm-failed/etc), several fail-closed on purpose per the doc comments above them — extracting one would separate a return from the specific evidence and escalation it is paired with
async function sweepOne(
  input: ResidualSweepInput,
  row: UnprotectedResidualLot,
): Promise<ReconcileDivergence | null> {
  const { broker, store, clock } = input;
  const { position } = row;
  const key = position.idempotency_key;
  const now = clock.now();

  let filledSize: number;
  let exitQty: number;
  try {
    ({ filledSize, exitQty } = heldQuantityFromFills(await store.getFills(key)));
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
      { idempotency_key: key },
    );
    await alertResidualExposureOnce(input, row, position.requested_size, now, {
      residualQtyIsUpperBound: true,
    });
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      reason: `marked residual could not be recomputed (fill read failed): ${describeThrownSafely(
        error,
      )}`,
      escalation: 'residual_sweep_size_read_failed',
    };
  }

  if (filledSize === 0) return null;

  if (isFlat({ filledSize, exitQty })) {
    await store.confirmResidualProtected(key);
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'adopted',
      kind: 'sweep',
      reason:
        'marked lot reads flat on the persisted fill record — nothing left unprotected; ' +
        'residual-protection marker cleared',
    };
  }

  const residual = filledSize - exitQty;

  if (!(residual > 0) || !Number.isFinite(residual)) {
    await alertResidualExposureOnce(input, row, position.requested_size, now, {
      residualQtyIsUpperBound: true,
    });
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      reason:
        `marked residual recomputes to ${residual} (non-finite or non-positive) while the fill ` +
        'record reads not-flat — refusing to re-arm a garbage quantity; check the store by hand',
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
      { idempotency_key: key, residual_qty: residual },
    );

    if (unsupported) {
      const reflatten = await reflattenResidual(input, position, residual, now);
      if (reflatten.kind === 'skipped' && reflatten.reason === 'own_reflatten_in_flight') {
        return {
          idempotency_key: key,
          instrument: position.instrument,
          store_state: position.order_state,
          broker_state: null,
          action: 'undetermined',
          kind: 'sweep',
          reason: reflatten.detail,
          escalation: 'residual_sweep_reflatten_in_flight',
        };
      }
      if (reflatten.kind === 'submitted') {
        return {
          idempotency_key: key,
          instrument: position.instrument,
          store_state: position.order_state,
          broker_state: null,
          action: 'undetermined',
          kind: 'sweep',
          reason:
            `this lot can never be re-armed, so residual ${residual} was CLOSED instead ` +
            `(#1214): market order '${reflatten.idempotency_key}' is live at the venue and the ` +
            'marker clears when its fill lands',
          escalation: 'residual_sweep_reflatten_submitted',
        };
      }
    }

    await alertResidualExposureOnce(input, row, residual, now, { rearmUnsupported: unsupported });
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      reason: unsupported
        ? `this lot can never be re-armed and the residual ${residual} could not ` +
          `be closed either — see the residual_reflatten_* log line for which gate stood the ` +
          `re-flatten down: ${describeThrownSafely(error)}`
        : `re-arm retry failed for residual ${residual}: ${describeThrownSafely(error)}`,
      escalation: unsupported
        ? 'residual_sweep_rearm_unsupported'
        : 'residual_sweep_rearm_retry_failed',
    };
  }

  await store.confirmResidualProtected(key);
  return {
    idempotency_key: key,
    instrument: position.instrument,
    store_state: position.order_state,
    broker_state: null,
    action: 'adopted',
    kind: 'sweep',
    reason:
      `protective legs re-armed for residual ${residual} by the #549 sweep — ` +
      'residual-protection marker cleared',
  };
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
