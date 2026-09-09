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
 * `SharedStore.writeClosedTrade()` (server/pipeline/execution/ingest-fills.ts), on its own
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
  FlattenAttribution,
  FlattenSubmissionWriteAhead,
  LotAdvance,
  SharedStore,
  UnprotectedResidualLot,
  UnresolvedFlattenSubmission,
} from '../../../pipeline/execution/index.js';
import type { OnTradeCloseInput } from '../../../pipeline/feedback-loop/index.js';
import { onTradeClose } from '../../../pipeline/feedback-loop/index.js';
import type { Fill, OpenPosition, OrderState } from '../../../shared/index.js';
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

    hasFill: (args: Parameters<SharedStore['hasFill']>[0]): Promise<boolean> => store.hasFill(args),

    getFills: (idempotency_key: string): Promise<Fill[]> => store.getFills(idempotency_key),

    getEntryFillSizes: (idempotency_keys: readonly string[]): Promise<Map<string, number>> =>
      store.getEntryFillSizes(idempotency_keys),

    getExitFillSizes: (idempotency_keys: readonly string[]): Promise<Map<string, number>> =>
      store.getExitFillSizes(idempotency_keys),

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

    // #921: pure pass-through, same as every other read here — this
    // decorator's whole job is the `onTradeClose` side effect on
    // `applyLotAdvance`, so every unrelated method (this one included) just
    // forwards to the wrapped store unchanged.
    isRetryableFlattenError: (idempotency_key: string): Promise<boolean> =>
      store.isRetryableFlattenError(idempotency_key),

    getFlattenAttribution: (idempotency_key: string): Promise<FlattenAttribution | null> =>
      store.getFlattenAttribution(idempotency_key),

    getUnresolvedFlattens: (): Promise<UnresolvedFlattenSubmission[]> =>
      store.getUnresolvedFlattens(),

    recordFlattenOrderStateObserved: (
      idempotency_key: string,
      update: { order_state: OrderState; broker_order_ids: string[] },
    ): Promise<void> => store.recordFlattenOrderStateObserved(idempotency_key, update),

    markFlattenFillsSwept: (idempotency_key: string, swept_at: Date): Promise<void> =>
      store.markFlattenFillsSwept(idempotency_key, swept_at),

    markResidualUnprotected: (idempotency_key: string, observed_at: Date): Promise<void> =>
      store.markResidualUnprotected(idempotency_key, observed_at),

    confirmResidualProtected: (idempotency_key: string): Promise<void> =>
      store.confirmResidualProtected(idempotency_key),

    markResidualAlerted: (idempotency_key: string, alerted_at: Date): Promise<boolean> =>
      store.markResidualAlerted(idempotency_key, alerted_at),

    getUnprotectedResidualLots: (): Promise<UnprotectedResidualLot[]> =>
      store.getUnprotectedResidualLots(),

    sweepTerminalPositions: (cutoff: Date): Promise<number> => store.sweepTerminalPositions(cutoff),

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
          event: 'on_trade_close_failed',
          level: 'error',
          message: 'onTradeClose failed',
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  };
}
