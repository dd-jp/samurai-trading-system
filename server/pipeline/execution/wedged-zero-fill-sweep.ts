
import { describeThrownSafely, logCaughtFailure } from '../../shared/index.js';
import { isWedgedZeroFillLot } from '../../shared/store/index.js';
import type { ReconcileDivergence, WedgedSweepInput } from './types.js';

export const WEDGED_ZERO_FILL_ABANDON_AFTER_MS = 24 * 60 * 60 * 1_000;

export interface WedgedZeroFillSweepResult {
  checked: number;
  divergences: ReconcileDivergence[];
}

export async function sweepWedgedZeroFillLots(
  input: WedgedSweepInput,
): Promise<WedgedZeroFillSweepResult> {
  const { store, clock, logger, trace_id } = input;
  const now = clock.now();

  const positions = await store.getOpenPositions();
  const wedged = positions.filter(
    (position) =>
      isWedgedZeroFillLot(position) &&
      now.getTime() - position.opened_at.getTime() >= WEDGED_ZERO_FILL_ABANDON_AFTER_MS,
  );

  const divergences: ReconcileDivergence[] = [];
  for (const position of wedged) {
    const stuckMs = now.getTime() - position.opened_at.getTime();
    const reason =
      `wedged zero-fill lot: order_state '${position.order_state}' with filled_size 0 for ` +
      `${stuckMs}ms (>= the ${WEDGED_ZERO_FILL_ABANDON_AFTER_MS}ms bounded window) — no fill ` +
      'can ever land for it (ingest-fills.ts advanceLot only advances on a new fill); retired ' +
      'to a bookkeeping terminal state on store evidence alone, no venue call made (#1186)';

    try {
      const abandoned = await store.abandonWedgedZeroFillLot(position.idempotency_key, reason);
      if (!abandoned) {
        const stillWedged = (await store.getOpenPositions()).some(
          (open) => open.idempotency_key === position.idempotency_key && isWedgedZeroFillLot(open),
        );
        if (stillWedged) {
          divergences.push({
            idempotency_key: position.idempotency_key,
            instrument: position.instrument,
            store_state: position.order_state,
            broker_state: null,
            action: 'undetermined',
            kind: 'sweep',
            reason:
              `wedged-zero-fill shape mismatch: isWedgedZeroFillLot still matches ` +
              `'${position.idempotency_key}' but abandonWedgedZeroFillLot's SQL guard did not ` +
              '— the TS predicate and its SQL restatement have diverged (#1601)',
            escalation: 'sweep_shape_mismatch',
          });
        }
        continue;
      }
      divergences.push({
        idempotency_key: position.idempotency_key,
        instrument: position.instrument,
        store_state: position.order_state,
        broker_state: null,
        action: 'adopted',
        kind: 'sweep',
        reason,
      });
    } catch (error) {
      logCaughtFailure(
        logger,
        {
          trace_id,
          stage: 'execution',
          event: 'wedged_zero_fill_abandon_failed',
          level: 'error',
          message:
            'sweepWedgedZeroFillLots: abandonWedgedZeroFillLot failed for one wedged lot — it ' +
            'stays wedged and the next pass retries',
        },
        error,
        { idempotency_key: position.idempotency_key },
      );
      divergences.push({
        idempotency_key: position.idempotency_key,
        instrument: position.instrument,
        store_state: position.order_state,
        broker_state: null,
        action: 'undetermined',
        kind: 'sweep',
        reason: `wedged-zero-fill abandon failed: ${describeThrownSafely(error)}`,
        escalation: 'sweep_abandon_failed',
      });
    }
  }

  return { checked: wedged.length, divergences };
}
