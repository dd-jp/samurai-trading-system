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

import type { LotAdvance, SharedStore } from '../../../pipeline/execution/index.js';
import type { OnTradeCloseInput } from '../../../pipeline/feedback-loop/index.js';
import { onTradeClose } from '../../../pipeline/feedback-loop/index.js';
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
 *
 * The pass-throughs are spelled out rather than spread: `SqliteExecutionStore`
 * is a class, so its methods live on the prototype and `{ ...store }` would
 * copy none of them. The return type is what keeps the table exhaustive — a
 * role method added to `SharedStore` (pipeline/execution/types/store.ts)
 * fails `tsc` here until it is forwarded, rather than falling through to a
 * runtime `undefined`.
 */
export function withOnTradeClose(
  store: SharedStore,
  input: OnTradeCloseInput,
  logger: Logger,
): SharedStore {
  return {
    findByKey: (...args) => store.findByKey(...args),
    writeAheadPosition: (...args) => store.writeAheadPosition(...args),
    updatePositionState: (...args) => store.updatePositionState(...args),
    getOpenPositions: (...args) => store.getOpenPositions(...args),
    hasFill: (...args) => store.hasFill(...args),
    getFills: (...args) => store.getFills(...args),
    getEntryFillSizes: (...args) => store.getEntryFillSizes(...args),
    getExitFillSizes: (...args) => store.getExitFillSizes(...args),
    writeAheadFlatten: (...args) => store.writeAheadFlatten(...args),
    resolveFlattenSubmitted: (...args) => store.resolveFlattenSubmitted(...args),
    resolveFlattenError: (...args) => store.resolveFlattenError(...args),
    isRetryableFlattenError: (...args) => store.isRetryableFlattenError(...args),
    getFlattenAttribution: (...args) => store.getFlattenAttribution(...args),
    getUnresolvedFlattens: (...args) => store.getUnresolvedFlattens(...args),
    markFlattenCancelAttempted: (...args) => store.markFlattenCancelAttempted(...args),
    markFlattenTerminalUnsweptChecked: (...args) =>
      store.markFlattenTerminalUnsweptChecked(...args),
    recordFlattenOrderStateObserved: (...args) => store.recordFlattenOrderStateObserved(...args),
    markFlattenFillsSwept: (...args) => store.markFlattenFillsSwept(...args),
    markResidualUnprotected: (...args) => store.markResidualUnprotected(...args),
    confirmResidualProtected: (...args) => store.confirmResidualProtected(...args),
    markResidualAlerted: (...args) => store.markResidualAlerted(...args),
    markResidualRearmUnsupportedAlerted: (...args) =>
      store.markResidualRearmUnsupportedAlerted(...args),
    getResidualRearmUnsupportedAlertedAt: (...args) =>
      store.getResidualRearmUnsupportedAlertedAt(...args),
    getUnprotectedResidualLots: (...args) => store.getUnprotectedResidualLots(...args),
    sweepTerminalPositions: (...args) => store.sweepTerminalPositions(...args),
    abandonWedgedZeroFillLot: (...args) => store.abandonWedgedZeroFillLot(...args),

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
