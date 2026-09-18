
import type { LotAdvance, SharedStore } from '../../../pipeline/execution/index.js';
import type { OnTradeCloseInput } from '../../../pipeline/feedback-loop/index.js';
import { onTradeClose } from '../../../pipeline/feedback-loop/index.js';
import type { Logger } from '../types.js';

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
