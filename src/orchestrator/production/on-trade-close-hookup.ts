/**
 * Wires Feedback Loop's `onTradeClose` (#92) off `SharedStore.writeClosedTrade`
 * at the production composition point (#237).
 *
 * Corrected scope, per the issue's own comment thread: the original AC asked
 * for this hook off a tick's `execution` step / `TickOutcome.execution_result`
 * — that path never carries a closed trade. `ExecutionImpl.execute()` returns
 * a submission ack only, for every `intent_type` including `'exit'` (#508):
 * `execute()` never itself closes a lot — even now that a flatten's fill
 * attributes back to the lot(s) it closed (#517), closing is still
 * `ingestFills()`'s job, not `execute()`'s. The only place a `ClosedTrade` is
 * ever produced is `ingestFills()` calling
 * `SharedStore.writeClosedTrade()` (src/execution/ingest-fills.ts), on its own
 * polling path, independent of the per-instrument tick chain. So this module
 * decorates `writeClosedTrade` itself rather than reaching into the tick
 * chain — nothing here is a `TickSteps` member, and nothing here is called
 * from `SequentialTickRunner`.
 *
 * This hook now HAS a live caller: `orchestrator/fill-sync.ts` runs
 * `ingestFills()` on a scheduled poll (superseding the earlier note here that
 * nothing did, which was true while #234–#237 left the scheduling out of
 * scope). Every `ClosedTrade` that poll emits reaches this decoration.
 *
 * Wired onto `buildProductionComponents`' single `executionStore` instance —
 * not a second decorated instance used only by the execution step — so both
 * callers (the tick's execution step and the fill-sync poll) reach the same
 * hooked store, and `ProductionComponents` exposes exactly one `SharedStore`
 * for the whole composition root to share.
 */

import type {
  FlattenSubmissionWriteAhead,
  LotAdvance,
  SharedStore,
} from '../../execution/index.js';
import type { OnTradeCloseInput } from '../../feedback-loop/index.js';
import { onTradeClose } from '../../feedback-loop/index.js';
import type { Fill, OpenPosition, OrderState } from '../../shared/index.js';
import type { Logger } from '../types.js';

/**
 * Wraps a `SharedStore` so every successful `applyLotAdvance` that carries a
 * `closed_trade` also invokes `onTradeClose` as a side effect. Every other
 * method is a pure pass-through — the advance's own contract (atomic; the
 * close written once, on round-trip-to-flat, per `SqliteExecutionStore`'s
 * doc) is unchanged; this only adds a side effect after the underlying write
 * succeeds. If the underlying write throws (e.g. the double-close guard),
 * `onTradeClose` is never invoked.
 *
 * `onTradeClose` itself can throw (`SqliteSetupStore.labelSetup` throws when
 * there is no pending setup row for the trade's `debate_id` — expected for
 * any close whose debate was never setup-stored, or was already labelled).
 * By the time it runs, the `closed_trades` row is already committed, so a
 * bubbled throw here would fail a write that, from Execution's point of
 * view, already succeeded — the caller has no write left to retry, only a
 * labelling side effect to lose. Caught and logged rather than thrown, the
 * same posture `startTickLoop`/`runFeedbackCycle`/`Heartbeat.emit` already
 * take for a side effect that must not cost the caller its own success.
 *
 * `trade.idempotency_key` stands in for `trace_id`: `ingestFills()` polls on
 * its own schedule, independent of any tick, so there is no tick `trace_id`
 * to thread here — the same substitution `buildExecutionStep` already makes
 * for `ExecutionInput.trace_id` (production/direct-bind.ts: "a per-order
 * identifier already unique to this lot").
 */
export function withOnTradeClose(
  store: SharedStore,
  input: OnTradeCloseInput,
  logger: Logger,
): SharedStore {
  return {
    findByKey: (idempotency_key: string): Promise<boolean> => store.findByKey(idempotency_key),

    writeAheadPosition: (position: OpenPosition): Promise<void> =>
      store.writeAheadPosition(position),

    updatePositionState: (
      idempotency_key: string,
      update: { order_state: OrderState; broker_order_ids: string[] },
    ): Promise<void> => store.updatePositionState(idempotency_key, update),

    getOpenPositions: (): Promise<OpenPosition[]> => store.getOpenPositions(),

    hasFill: (broker_fill_id: string): Promise<boolean> => store.hasFill(broker_fill_id),

    getFills: (idempotency_key: string): Promise<Fill[]> => store.getFills(idempotency_key),

    writeAheadFlatten: (submission: FlattenSubmissionWriteAhead): Promise<void> =>
      store.writeAheadFlatten(submission),

    resolveFlattenSubmitted: (
      idempotency_key: string,
      update: { order_state: OrderState; broker_order_ids: string[] },
      resolved_at: Date,
    ): Promise<void> => store.resolveFlattenSubmitted(idempotency_key, update, resolved_at),

    resolveFlattenError: (
      idempotency_key: string,
      reason: string,
      resolved_at: Date,
    ): Promise<void> => store.resolveFlattenError(idempotency_key, reason, resolved_at),

    getFlattenLotKeys: (idempotency_key: string): Promise<readonly string[] | null> =>
      store.getFlattenLotKeys(idempotency_key),

    applyLotAdvance: async (advance: LotAdvance): Promise<void> => {
      await store.applyLotAdvance(advance);
      const trade = advance.closed_trade;
      if (trade === undefined) return;
      try {
        onTradeClose(trade, trade.idempotency_key, input);
      } catch (error) {
        logger.log({
          trace_id: trade.idempotency_key,
          stage: 'feedback-loop',
          level: 'error',
          message: 'onTradeClose failed',
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  };
}
